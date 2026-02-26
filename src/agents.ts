import type { PluginInput } from "@opencode-ai/plugin";
import type {
  ObservationGroup,
  ObserverResult,
  ReflectorResult,
} from "./types.js";
import type { WithParts } from "./observer.js";
import {
  buildObserverSystemPrompt,
  buildObserverPrompt,
  OBSERVER_OUTPUT_SCHEMA,
  REFLECTOR_OUTPUT_SCHEMA,
  detectDegenerateRepetition,
  serializeObservations,
} from "./observer.js";
import {
  buildReflectorSystemPrompt,
  buildReflectorPrompt,
} from "./reflector.js";
import { estimateTokens, estimateObservationTokens } from "./storage.js";

export type AgentCallInput = {
  client: PluginInput["client"];
  directory: string;
  parentSessionID: string;
  model?: { providerID: string; modelID: string };
};

/**
 * Session IDs of child sessions created by callViaOpencode.
 * The plugin hooks check this set and skip any session that appears here,
 * preventing the infinite loop where the Observer's own child session
 * triggers the messages.transform hook recursively.
 */
export const childSessions = new Set<string>();

const MAX_DEGENERATE_RETRIES = 2;
const MAX_COMPRESSION_RETRIES = 3;

// ─── Observer ────────────────────────────────────────────────────────────────

/**
 * Runs the Observer agent on a slice of unobserved messages.
 * Uses opencode's structured output API to get schema-validated results.
 *
 * Retries up to MAX_DEGENERATE_RETRIES times if the output is degenerate
 * (repetition loop detected).
 */
export async function runObserver(
  input: AgentCallInput,
  messages: WithParts[],
  existingObservations: ObservationGroup[] | undefined,
  observerInstruction?: string,
): Promise<ObserverResult> {
  const system = buildObserverSystemPrompt(observerInstruction);
  const prompt = buildObserverPrompt(existingObservations, messages);

  for (let attempt = 0; attempt <= MAX_DEGENERATE_RETRIES; attempt++) {
    const result = await callStructured<{
      observations: ObservationGroup[];
      currentTask?: string;
      suggestedResponse?: string;
    }>(input, system, prompt, OBSERVER_OUTPUT_SCHEMA);

    if (!result) {
      // Structured output failed or returned null — retry
      if (attempt === MAX_DEGENERATE_RETRIES) {
        return { observations: [], degenerate: true };
      }
      continue;
    }

    // Check for degenerate repetition on the serialized form
    const serialized = serializeObservations(result.observations ?? []);
    if (detectDegenerateRepetition(serialized)) {
      if (attempt === MAX_DEGENERATE_RETRIES) {
        return { observations: [], degenerate: true };
      }
      continue;
    }

    return {
      observations: result.observations ?? [],
      currentTask: result.currentTask,
      suggestedResponse: result.suggestedResponse,
    };
  }

  return { observations: [], degenerate: true };
}

// ─── Reflector ───────────────────────────────────────────────────────────────

/**
 * Runs the Reflector agent to condense an oversized observation log.
 * Uses opencode's structured output API for schema-validated results.
 * Uses escalating compression guidance (up to 4 levels) if the output
 * keeps coming back larger than the input.
 */
export async function runReflector(
  input: AgentCallInput,
  observations: ObservationGroup[],
  reflectorThreshold: number,
  reflectorInstruction?: string,
): Promise<ReflectorResult> {
  const system = buildReflectorSystemPrompt(reflectorInstruction);
  const inputTokens = estimateTokens(serializeObservations(observations));

  for (let level = 0; level <= MAX_COMPRESSION_RETRIES; level++) {
     const prompt = buildReflectorPrompt(observations);

    const result = await callStructured<{
      observations: ObservationGroup[];
      suggestedResponse?: string;
    }>(input, system, prompt, REFLECTOR_OUTPUT_SCHEMA);

    if (!result || !result.observations?.length) {
      if (level === MAX_COMPRESSION_RETRIES)
        return { observations, degenerate: true };
      continue;
    }

    // Check for degenerate repetition
    const serialized = serializeObservations(result.observations);
    if (detectDegenerateRepetition(serialized)) {
      if (level === MAX_COMPRESSION_RETRIES)
        return { observations, degenerate: true };
      continue;
    }

    const outputTokens = estimateTokens(serialized);

     // Validate compression actually reduced size
     if (outputTokens < inputTokens) {
       return {
         observations: result.observations,
         suggestedResponse: result.suggestedResponse,
       };
     }

    // Didn't compress enough — escalate on next iteration
    if (level === MAX_COMPRESSION_RETRIES) {
      // Accept whatever we got rather than losing all memory
      return {
        observations: result.observations,
        suggestedResponse: result.suggestedResponse,
      };
    }
  }

  return { observations };
}

// ─── opencode client call ────────────────────────────────────────────────────

/**
 * Makes a single LLM call routed through opencode's server with structured
 * output enabled:
 * 1. Creates a short-lived child session parented to the current session
 * 2. Sends the prompt with the given system prompt and JSON schema
 * 3. Extracts the structured output from the response
 * 4. Deletes the child session to clean up
 *
 * Uses opencode's structured output API (`format: { type: "json_schema" }`)
 * which auto-injects a StructuredOutput tool, validates against the schema,
 * and retries on validation failure.
 */
async function callStructured<T>(
  { client, directory, parentSessionID, model }: AgentCallInput,
  system: string,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<T | null> {
  const session = await client.session.create({
    body: {
      parentID: parentSessionID,
      title: "observational-memory (internal)",
    },
    query: { directory },
    throwOnError: true,
  });

  const id = session.data.id;
  childSessions.add(id);

  try {
    // SDK types don't include structured output 'format' parameter yet, but runtime supports it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reply = await (client.session.prompt as any)({
      path: { id },
      query: { directory },
      body: {
        system,
        ...(model && { model }),
        format: {
          type: "json_schema" as const,
          schema,
          retryCount: 2,
        },
        parts: [{ type: "text", text: prompt }],
      },
      throwOnError: true,
    });

    // Structured output is on the info.structured field
    const structured = (reply.data as { info?: { structured?: unknown } })
      ?.info?.structured;
    if (structured != null) {
      return structured as T;
    }

    // Fallback: if structured output wasn't captured (e.g. model doesn't
    // support it), return null and let the caller handle it
    return null;
  } finally {
    childSessions.delete(id);
    await client.session
      .delete({ path: { id }, query: { directory } })
      .catch(() => {});
  }
}
