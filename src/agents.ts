import type { PluginInput } from "@opencode-ai/plugin";
import type { ObserverResult, ReflectorResult } from "./types.js";
import type { WithParts } from "./observer.js";
import {
  buildObserverSystemPrompt,
  buildObserverPrompt,
  parseObserverOutput,
  detectDegenerateRepetition,
} from "./observer.js";
import {
  buildReflectorSystemPrompt,
  buildReflectorPrompt,
  parseReflectorOutput,
  validateCompression,
} from "./reflector.js";
import { estimateTokens } from "./storage.js";

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
 * Routes the LLM call through opencode's own session API so no separate
 * API keys or AI SDK packages are needed.
 *
 * Retries up to MAX_DEGENERATE_RETRIES times if the output is degenerate
 * (repetition loop detected).
 */
export async function runObserver(
  input: AgentCallInput,
  messages: WithParts[],
  existingObservations: string | undefined,
  observerInstruction?: string,
): Promise<ObserverResult> {
  const system = buildObserverSystemPrompt(observerInstruction);
  const prompt = buildObserverPrompt(existingObservations, messages);

  for (let attempt = 0; attempt <= MAX_DEGENERATE_RETRIES; attempt++) {
    const raw = await callViaOpencode(input, system, prompt);
    if (!detectDegenerateRepetition(raw)) {
      const parsed = parseObserverOutput(raw);
      return {
        observations: parsed.observations,
        currentTask: parsed.currentTask,
        suggestedResponse: parsed.suggestedResponse,
      };
    }
    // Degenerate output — retry unless this was the last attempt
    if (attempt === MAX_DEGENERATE_RETRIES) {
      return { observations: "", degenerate: true };
    }
  }

  return { observations: "", degenerate: true };
}

// ─── Reflector ───────────────────────────────────────────────────────────────

/**
 * Runs the Reflector agent to condense an oversized observation log.
 * Uses escalating compression guidance (up to 4 levels) if the output
 * keeps coming back larger than the input.
 */
export async function runReflector(
  input: AgentCallInput,
  observations: string,
  reflectorThreshold: number,
  reflectorInstruction?: string,
): Promise<ReflectorResult> {
  const system = buildReflectorSystemPrompt(reflectorInstruction);
  const inputTokens = estimateTokens(observations);

  for (let level = 0; level <= MAX_COMPRESSION_RETRIES; level++) {
    const compressionLevel = Math.min(level, 3) as 0 | 1 | 2 | 3;
    const prompt = buildReflectorPrompt(observations, compressionLevel);
    const raw = await callViaOpencode(input, system, prompt);

    if (detectDegenerateRepetition(raw)) {
      if (level === MAX_COMPRESSION_RETRIES)
        return { observations, degenerate: true };
      continue;
    }

    const parsed = parseReflectorOutput(raw);
    if (!parsed.observations) {
      if (level === MAX_COMPRESSION_RETRIES) return { observations };
      continue;
    }

    const outputTokens = estimateTokens(parsed.observations);

    // Validate compression actually reduced size
    if (validateCompression(outputTokens, inputTokens)) {
      return {
        observations: parsed.observations,
        suggestedResponse: parsed.suggestedResponse,
      };
    }

    // Didn't compress enough — escalate on next iteration
    if (level === MAX_COMPRESSION_RETRIES) {
      // Accept whatever we got rather than losing all memory
      return {
        observations: parsed.observations,
        suggestedResponse: parsed.suggestedResponse,
      };
    }
  }

  return { observations };
}

// ─── opencode client call ────────────────────────────────────────────────────

/**
 * Makes a single LLM call routed through opencode's server:
 * 1. Creates a short-lived child session parented to the current session
 * 2. Sends the prompt with the given system prompt
 * 3. Extracts the assistant's text reply
 * 4. Deletes the child session to clean up
 *
 * The call uses opencode's already-configured provider, auth tokens, model
 * config and headers — no separate credentials needed.
 */
async function callViaOpencode(
  { client, directory, parentSessionID, model }: AgentCallInput,
  system: string,
  prompt: string,
): Promise<string> {
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
    const reply = await client.session.prompt({
      path: { id },
      query: { directory },
      body: {
        system,
        ...(model && { model }),
        parts: [{ type: "text", text: prompt }],
      },
      throwOnError: true,
    });

    return reply.data.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("");
  } finally {
    childSessions.delete(id);
    await client.session
      .delete({ path: { id }, query: { directory } })
      .catch(() => {});
  }
}
