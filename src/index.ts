import path from "path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type {
  ObservationalMemoryConfig,
  SessionMemory,
  ObserverResult,
} from "./types.js";
import { readMemory, writeMemory, estimateTokens } from "./storage.js";
import { optimizeForContext } from "./observer.js";
import {
  runObserver,
  runReflector,
  childSessions,
  type AgentCallInput,
} from "./agents.js";

export type { ObservationalMemoryConfig } from "./types.js";

const OBSERVER_THRESHOLD_DEFAULT = 30_000;
const REFLECTOR_THRESHOLD_DEFAULT = 40_000;

/**
 * The fraction of the observer threshold at which background pre-fetching begins.
 * At 20% of threshold, we start an Observer run in the background so results
 * are ready (or nearly so) when the message list hits 100% of threshold.
 * Directly mirrors Mastra's async buffering strategy.
 */
const PREFETCH_FRACTION = 0.2;

/**
 * Injected after observed messages are removed. Tells the LLM why the
 * conversation history is shorter than expected and how to continue naturally.
 * Directly adapted from Mastra's OBSERVATION_CONTINUATION_HINT.
 */
const CONTINUATION_HINT = `This message is not from the user. The conversation history grew too long and the oldest messages have been compressed into your memory observations above.

Please continue from where the observations left off. Do not refer to your "memory observations" directly — the user does not know about them, they are simply your memories. Just respond naturally as if you remember the conversation (you do!).

Do not say "Hi there!" or "based on our previous conversation" as if the conversation is just starting — this is an ongoing conversation. Do not say "I understand. I've reviewed my memory observations" or "I remember [...]". Answer naturally.

IMPORTANT: This system reminder is NOT from the user. The system placed it here as part of your memory system. Any messages following this reminder are newer than your memories.`;

/**
 * Creates an observational memory plugin for opencode.
 *
 * Implements the Mastra observational memory pattern:
 * - Observer pre-fetches in the background at 20% of threshold
 * - Observer activates (and drops messages) at 100% of threshold
 * - Observed messages are DROPPED from the context window (spliced out of output.messages)
 * - Observation log is injected into the system prompt as a stable cacheable prefix
 * - A continuation hint is injected after the drop so the LLM doesn't lose context
 * - Reflector condenses the observation log when it exceeds its own threshold
 * - Compaction hook injects observations so native opencode compaction is observation-aware
 */
export function observationalMemory(config: ObservationalMemoryConfig = {}) {
  const observerThreshold =
    config.observerThreshold ?? OBSERVER_THRESHOLD_DEFAULT;
  const reflectorThreshold =
    config.reflectorThreshold ?? REFLECTOR_THRESHOLD_DEFAULT;
  const fraction = config.prefetchFraction ?? PREFETCH_FRACTION;
  const prefetchThreshold = Math.floor(observerThreshold * fraction);
  const debug = config.debug ?? false;

  // In-memory cache: sessionID -> memory, populated from disk on first access
  const cache = new Map<string, SessionMemory>();

  // Prevent concurrent Observer/Reflector activation runs per session
  const running = new Set<string>();

  /**
   * Background pre-fetch state per session.
   * At prefetchThreshold we start the Observer in the background; the result
   * promise sits here until the session hits observerThreshold, at which point
   * we await the already-in-flight result instead of starting a fresh call.
   * After the result is consumed the slot is cleared for the next cycle.
   */
  const prefetch = new Map<string, Promise<ObserverResult>>();

  function log(...args: unknown[]) {
    if (debug) console.log("[observational-memory]", ...args);
  }

  async function getMemory(
    storageDir: string,
    sessionID: string,
  ): Promise<SessionMemory> {
    if (!cache.has(sessionID)) {
      cache.set(sessionID, await readMemory(storageDir, sessionID));
    }
    return cache.get(sessionID)!;
  }

  async function saveMemory(
    storageDir: string,
    sessionID: string,
    memory: SessionMemory,
  ) {
    cache.set(sessionID, memory);
    await writeMemory(storageDir, sessionID, memory);
  }

  return async (input: PluginInput): Promise<Hooks> => {
    const storageDir = config.storageDir
      ? path.resolve(config.storageDir)
      : path.join(input.directory, ".opencode", "observations");

    const modelOverride = config.model
      ? (() => {
          const [providerID, ...rest] = config.model.split("/");
          return { providerID, modelID: rest.join("/") };
        })()
      : undefined;

    if (!config.model) {
      console.warn(
        "[observational-memory] WARNING: No model configured. Observer/Reflector will use the session's main model, which may be expensive. Consider setting `model` to a cheap model like 'anthropic/claude-haiku-4-5-20251001' or 'openai/gpt-4o-mini'.",
      );
    }

    log("initialized", {
      storageDir,
      observerThreshold,
      reflectorThreshold,
      prefetchThreshold,
      modelOverride,
    });

    return {
      /**
       * Inject the observation log into the system prompt as a stable cacheable prefix.
       *
       * The observation block goes at the start of system[0]. Anthropic and OpenAI
       * prompt caching will hit on this every turn that observations haven't changed,
       * which is the key cost-reduction mechanism.
       *
       * We inject a context-optimized version (🟡/🟢 stripped) to save tokens on
       * every turn while keeping the full rich format on disk.
       */
      "experimental.chat.system.transform": async ({ sessionID }, output) => {
        if (!sessionID) return;
        if (childSessions.has(sessionID)) return;
        const memory = await getMemory(storageDir, sessionID);
        if (!memory.observations) return;

        const optimized = optimizeForContext(memory.observations);
        if (!optimized) return;

        const block = [
          "The following observations block contains your memory of past interactions in this session.",
          "",
          "<observations>",
          optimized,
          "</observations>",
          "",
          "IMPORTANT: When responding, reference specific details from these observations. Personalize your response based on what you know about this session's context, decisions, and progress.",
          "",
          "KNOWLEDGE UPDATES: When asked about current state, prefer the MOST RECENT information. If you see conflicting information, the newer observation supersedes the older one.",
        ].join("\n");

        output.system[0] = block + "\n\n" + (output.system[0] ?? "");
        log("injected observations into system prompt", {
          sessionID,
          chars: optimized.length,
        });
      },

      /**
       * Core observational memory logic. Called before every LLM request.
       *
       * Flow:
       * 1. Count unobserved message tokens (chars/4 estimate on text content)
       * 2. If above prefetch threshold but below observer threshold: kick off
       *    background Observer run and return (LLM request proceeds normally)
       * 3. If above observer threshold: await the pre-fetched result (or start
       *    a fresh Observer run if pre-fetch wasn't triggered)
       * 4. Splice observed messages OUT of output.messages
       * 5. Inject a continuation hint so the LLM knows why history is shorter
       * 6. Persist new observations; run Reflector if observation log is too large
       */
      "experimental.chat.messages.transform": async (_input, output) => {
        const sessionID = output.messages[0]?.info.sessionID;
        if (!sessionID) return;
        if (childSessions.has(sessionID)) return;
        if (running.has(sessionID)) return;

        const memory = await getMemory(storageDir, sessionID);

        // Find the first message after the last observed index
        const firstUnobservedIdx = memory.lastObservedMessageIndex + 1;
        const unobserved = output.messages.slice(firstUnobservedIdx);

        // Estimate tokens in the unobserved slice (char/4 heuristic on text content)
        const unobservedTokens = estimateMessageTokens(unobserved);

        log("token check", {
          sessionID,
          firstUnobservedIdx,
          unobservedCount: unobserved.length,
          unobservedTokens,
          prefetchThreshold,
          observerThreshold,
        });

        const agentInput: AgentCallInput = {
          client: input.client,
          directory: input.directory,
          parentSessionID: sessionID,
          model: modelOverride,
        };

        // ── Pre-fetch zone ──────────────────────────────────────────────────
        // At 20% of threshold, start Observer in background so its result is
        // ready (or nearly ready) by the time we reach 100% threshold.
        if (
          unobservedTokens >= prefetchThreshold &&
          unobservedTokens < observerThreshold &&
          !prefetch.has(sessionID)
        ) {
          log("starting background Observer pre-fetch", {
            sessionID,
            unobservedTokens,
          });
          // Fire-and-forget: store the promise, do not await
          prefetch.set(
            sessionID,
            runObserver(
              agentInput,
              unobserved,
              memory.observations || undefined,
              config.observerInstruction,
            ).catch((err) => {
              log("background Observer pre-fetch error", err);
              prefetch.delete(sessionID);
              return { observations: "", degenerate: true } as ObserverResult;
            }),
          );
          return; // Let this turn proceed normally
        }

        // Below both thresholds — nothing to do yet
        if (unobservedTokens < observerThreshold) return;

        // ── Activation zone ─────────────────────────────────────────────────
        running.add(sessionID);
        try {
          log("activating Observer", { sessionID, unobservedTokens });

          // Consume the pre-fetched promise if it exists, otherwise run fresh
          const pending = prefetch.get(sessionID);
          prefetch.delete(sessionID);

          const result = await (pending ??
            runObserver(
              agentInput,
              unobserved,
              memory.observations || undefined,
              config.observerInstruction,
            ));

          if (result.degenerate || !result.observations) {
            log("Observer returned degenerate/empty output, skipping", {
              sessionID,
            });
            return;
          }

          log("Observer produced observations", {
            sessionID,
            chars: result.observations.length,
            fromPrefetch: !!pending,
          });

          // Append new observations to existing ones
          const newObservations = memory.observations
            ? memory.observations + "\n\n" + result.observations
            : result.observations;

          let updatedMemory: SessionMemory = {
            ...memory,
            observations: newObservations,
            currentTask: result.currentTask,
            suggestedResponse: result.suggestedResponse,
            lastObservedMessageIndex:
              firstUnobservedIdx + unobserved.length - 1,
            lastObservedTokens: unobservedTokens,
            lastObservedAt: Date.now(),
          };

          // Run Reflector if observation log is now too large
          const obsTokens = estimateTokens(newObservations);
          if (obsTokens >= reflectorThreshold) {
            log("running Reflector", { sessionID, obsTokens });
            const reflected = await runReflector(
              agentInput,
              newObservations,
              reflectorThreshold,
              config.reflectorInstruction,
            );
            if (!reflected.degenerate && reflected.observations) {
              updatedMemory = {
                ...updatedMemory,
                observations: reflected.observations,
                suggestedResponse:
                  reflected.suggestedResponse ??
                  updatedMemory.suggestedResponse,
                lastReflectedAt: Date.now(),
              };
              log("Reflector condensed observations", {
                sessionID,
                before: obsTokens,
                after: estimateTokens(reflected.observations),
              });
            }
          }

          await saveMemory(storageDir, sessionID, updatedMemory);

          // ── Drop observed messages from the context window ──────────────────
          // This is the core Mastra mechanism: observed messages are removed and
          // replaced by the observation log in the system prompt. The LLM sees
          // the structured memory instead of raw token-heavy history.
          const observedCount = unobserved.length;
          output.messages.splice(firstUnobservedIdx, observedCount);

          // ── Inject continuation hint ────────────────────────────────────────
          // After dropping messages, inject a synthetic message explaining the gap.
          // Without this the LLM gets confused by the sudden history shortening.
          // Insert it at firstUnobservedIdx (right after the retained messages).
          const hint = {
            info: {
              ...output.messages[firstUnobservedIdx - 1]?.info,
              role: "user" as const,
              id: "om-continuation-hint",
            },
            parts: [
              {
                type: "text" as const,
                text: buildContinuationMessage(updatedMemory),
              },
            ],
          };
          output.messages.splice(
            firstUnobservedIdx,
            0,
            hint as (typeof output.messages)[number],
          );

          log("dropped observed messages and injected continuation hint", {
            sessionID,
            dropped: observedCount,
            remaining: output.messages.length,
          });
        } catch (err) {
          log("Observer/Reflector error", err);
        } finally {
          running.delete(sessionID);
        }
      },

      /**
       * Inform opencode's native compaction about the observation log.
       * When the context window overflows and compaction triggers, inject our
       * observations as additional context so the compaction summary is aware
       * of the full session history — not just whatever raw messages remain.
       */
      "experimental.session.compacting": async ({ sessionID }, output) => {
        if (childSessions.has(sessionID)) return;
        const memory = await getMemory(storageDir, sessionID);
        if (!memory.observations) return;

        output.context.push(
          `\n<observation-log>\n${memory.observations}\n</observation-log>\n\n` +
            "The observation log above contains the compressed history of this session. " +
            "When writing the compaction summary, reference it rather than re-deriving history from the raw messages.",
        );

        log("injected observations into compaction context", { sessionID });
      },
    };
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Estimates token count of a message slice by summing text content lengths.
 * Uses the 4-chars-per-token heuristic — fast and provider-agnostic.
 * We count BEFORE the LLM call (like Mastra), not after via StepFinishPart.
 */
function estimateMessageTokens(
  messages: { parts: { type: string; [k: string]: unknown }[] }[],
): number {
  let chars = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "text")
        chars += (part as unknown as { text: string }).text.length;
      else if (part.type === "tool") {
        const s = part.state as {
          status: string;
          input?: unknown;
          output?: string;
        };
        if (s.input) chars += JSON.stringify(s.input).length;
        if (s.output) chars += s.output.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * Builds the continuation hint message injected after observed messages are dropped.
 * Includes the current task and suggested response from the Observer if available.
 */
function buildContinuationMessage(memory: SessionMemory): string {
  const parts = [`<system-reminder>\n${CONTINUATION_HINT}`];

  if (memory.currentTask) {
    parts.push(`\n\nCurrent task:\n${memory.currentTask}`);
  }
  if (memory.suggestedResponse) {
    parts.push(`\n\nSuggested next response:\n${memory.suggestedResponse}`);
  }

  parts.push("\n</system-reminder>");
  return parts.join("");
}

/**
 * Default export: a pre-configured plugin instance with default settings.
 * For custom configuration, import `observationalMemory` instead:
 * ```ts
 * import { observationalMemory } from "opencode-observational-memory"
 * export default observationalMemory({ observerThreshold: 20_000 })
 * ```
 */
export default observationalMemory();
