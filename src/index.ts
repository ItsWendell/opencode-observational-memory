import path from "path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { ObservationalMemoryConfig, SessionMemory, ObservationGroup } from "./types.js";
import { readMemory, writeMemory, estimateTokens, estimateObservationTokens } from "./storage.js";
import { optimizeForContext, mergeObservationGroups, serializeObservations } from "./observer.js";
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
 */
const PREFETCH_FRACTION = 0.2;

/**
 * Injected after observed messages are removed. Tells the LLM why the
 * conversation history is shorter than expected and how to continue naturally.
 */
const CONTINUATION_HINT = `This message is not from the user. The conversation history grew too long and the oldest messages have been compressed into your memory observations above.

Continue the conversation naturally. Your memory observations provide background context, but any messages that follow this reminder are the CURRENT state of the conversation and take priority.

Do not refer to your "memory observations" directly — the user does not know about them, they are simply your memories. Just respond naturally as if you remember the conversation (you do!).

Do not say "Hi there!" or "based on our previous conversation" as if the conversation is just starting — this is an ongoing conversation. Do not say "I understand. I've reviewed my memory observations" or "I remember [...]". Answer naturally.

IMPORTANT: This system reminder is NOT from the user. The system placed it here as part of your memory system. Any messages following this reminder are newer than your memories and should be prioritized.`;

/**
 * Cached result from a completed background Observer (and optional Reflector)
 * run, waiting to be applied on the next hook invocation.
 */
type CompletedObservation = {
  /** The new memory state (observations merged, reflector applied if needed) */
  memory: SessionMemory;
  /** Index into the message array where the observed slice started */
  firstUnobservedIdx: number;
  /** Number of messages that were observed (to splice out) */
  observedCount: number;
};

/**
 * Creates an observational memory plugin for opencode.
 *
 * Fully non-blocking implementation:
 * - Observer and Reflector run entirely in the background (fire-and-forget)
 * - Results are cached and applied on the NEXT hook invocation (instant splice)
 * - The conversation is NEVER blocked by LLM calls from this plugin
 *
 * Flow:
 * - At prefetchThreshold (20% of observerThreshold): kick off background Observer
 * - Observer result is cached when complete
 * - At observerThreshold (100%): if cached result exists, apply instantly (splice
 *   messages, inject continuation hint, persist memory). If not, start Observer
 *   and apply on the next turn.
 * - Observation log is injected into the system prompt as a stable cacheable prefix
 * - Reflector runs in background (chained after Observer) when observations are too large
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

  /**
   * Completed Observer results waiting to be applied on the next hook call.
   * The background worker stores results here; the hook consumes them.
   * Memory is NOT updated until the result is applied (keeps indices stable).
   */
  const completedObservation = new Map<string, CompletedObservation>();

  /**
   * Sessions that currently have a background Observer (+ optional Reflector)
   * in flight. Prevents concurrent runs for the same session.
   */
  const observerInFlight = new Set<string>();

  // ── Leveled logger ──────────────────────────────────────────────────────
  // - debug: noisy per-turn details (token checks, injections) — only when config.debug=true
  // - info:  lifecycle events (observer start/complete, apply) — only when config.debug=true
  // - warn:  degenerate outputs, missing config — always visible
  // - error: failures — always visible
  const PREFIX = "[observational-memory]";

  /** Truncate session ID for readable logs: ses_36987ccd7ffe... → ses_3698..7ffe */
  function shortID(sessionID: string): string {
    if (sessionID.length <= 16) return sessionID;
    return sessionID.slice(0, 8) + ".." + sessionID.slice(-4);
  }

  /** Format token count as "15.0k (50%)" relative to the observer threshold */
  function fmtTokens(tokens: number): string {
    const pct = Math.round((tokens / observerThreshold) * 100);
    return tokens >= 1000
      ? `${(tokens / 1000).toFixed(1)}k (${pct}%)`
      : `${tokens} (${pct}%)`;
  }

  const log = {
    debug(...args: unknown[]) {
      if (debug) console.log(PREFIX, ...args);
    },
    info(...args: unknown[]) {
      if (debug) console.log(PREFIX, ...args);
    },
    warn(...args: unknown[]) {
      console.warn(PREFIX, ...args);
    },
    error(...args: unknown[]) {
      console.error(PREFIX, ...args);
    },
  };

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
      log.warn(
        "No model configured — Observer/Reflector will use the session's main model, which may be expensive.",
        "Set `model` to e.g. 'anthropic/claude-haiku-4-5-20251001'.",
      );
    }

    log.info("initialized", {
      storageDir,
      observerThreshold,
      reflectorThreshold,
      prefetchThreshold,
      model: modelOverride
        ? `${modelOverride.providerID}/${modelOverride.modelID}`
        : "(session default)",
    });

    /**
     * Starts the Observer (and optional Reflector) in the background.
     * Never blocks — the result is stored in completedObservation for the
     * next hook invocation to apply.
     *
     * NOTE: runObserver synchronously formats the messages into a prompt
     * string before its first `await`, so message references are consumed
     * immediately and safe from later mutation.
     */
    function startBackgroundObserver(
      sessionID: string,
      agentInput: AgentCallInput,
      unobserved: Parameters<
        NonNullable<Hooks["experimental.chat.messages.transform"]>
      >[1]["messages"],
      currentMemory: SessionMemory,
      firstUnobservedIdx: number,
      unobservedTokens: number,
    ) {
      observerInFlight.add(sessionID);
      const sid = shortID(sessionID);

      (async () => {
        try {
          const t0 = performance.now();
          const result = await runObserver(
            agentInput,
            unobserved,
            currentMemory.observations || undefined,
            config.observerInstruction,
          );
          const observerMs = performance.now() - t0;

          if (result.degenerate || !result.observations) {
            log.warn(
              `[${sid}] Observer returned ${result.degenerate ? "degenerate" : "empty"} output after ${(observerMs / 1000).toFixed(1)}s — skipping`,
            );
            return;
          }

          log.info(
            `[${sid}] Observer completed in ${(observerMs / 1000).toFixed(1)}s — ${result.observations.length} chars of new observations`,
          );

          // Merge new observations with existing ones (both are structured arrays)
          const newObservations = mergeObservationGroups(
            currentMemory.observations,
            result.observations,
          );

          let newMemory: SessionMemory = {
            ...currentMemory,
            observations: newObservations,
            currentTask: result.currentTask,
            suggestedResponse: result.suggestedResponse,
            lastObservedMessageIndex:
              firstUnobservedIdx + unobserved.length - 1,
            lastObservedTokens: unobservedTokens,
            lastObservedAt: Date.now(),
          };

          // Run Reflector in the same background pipeline if observations are too large
          const obsTokens = estimateObservationTokens(newObservations);
          if (obsTokens >= reflectorThreshold) {
            log.info(
              `[${sid}] Reflector started — observations at ${fmtTokens(obsTokens)} exceed reflector threshold`,
            );
            const t1 = performance.now();
            const reflected = await runReflector(
              agentInput,
              newObservations,
              reflectorThreshold,
              config.reflectorInstruction,
            );
            const reflectorMs = performance.now() - t1;

            if (!reflected.degenerate && reflected.observations) {
              const afterTokens = estimateObservationTokens(reflected.observations);
              newMemory = {
                ...newMemory,
                observations: reflected.observations,
                suggestedResponse:
                  reflected.suggestedResponse ?? newMemory.suggestedResponse,
                lastReflectedAt: Date.now(),
              };
              log.info(
                `[${sid}] Reflector completed in ${(reflectorMs / 1000).toFixed(1)}s — condensed ${fmtTokens(obsTokens)} → ${fmtTokens(afterTokens)}`,
              );
            } else {
              log.warn(
                `[${sid}] Reflector returned ${reflected.degenerate ? "degenerate" : "empty"} output after ${(reflectorMs / 1000).toFixed(1)}s`,
              );
            }
          }

          // Cache the result for the next hook invocation to apply.
          // Memory is NOT saved to cache/disk yet — that happens at apply time
          // so that memory.lastObservedMessageIndex stays stable for token
          // calculations in the hook.
          completedObservation.set(sessionID, {
            memory: newMemory,
            firstUnobservedIdx,
            observedCount: unobserved.length,
          });

          log.info(`[${sid}] result cached, will apply on next turn`);
        } catch (err) {
          log.error(`[${sid}] background Observer/Reflector failed:`, err);
        } finally {
          observerInFlight.delete(sessionID);
        }
      })();
    }

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
        log.debug(
          `[${shortID(sessionID)}] injected ${optimized.length} chars of observations into system prompt`,
        );
      },

      /**
       * Core observational memory logic — fully non-blocking.
       *
       * Called before every LLM request. Never awaits LLM calls; all Observer
       * and Reflector work happens in the background.
       *
       * Flow:
       * 1. If a completed background result exists AND tokens >= observerThreshold:
       *    apply it instantly (splice messages, inject hint, persist memory)
       * 2. If tokens >= prefetchThreshold and no Observer is running: start
       *    background Observer (fire-and-forget)
       * 3. Otherwise: return immediately, no work to do
       */
      "experimental.chat.messages.transform": async (_input, output) => {
        const sessionID = output.messages[0]?.info.sessionID;
        if (!sessionID) return;
        if (childSessions.has(sessionID)) return;

        const memory = await getMemory(storageDir, sessionID);
        const sid = shortID(sessionID);

        // Find the first message after the last observed index
        const firstUnobservedIdx = memory.lastObservedMessageIndex + 1;
        const unobserved = output.messages.slice(firstUnobservedIdx);

        // Estimate tokens in the unobserved slice (char/4 heuristic on text content)
        const unobservedTokens = estimateMessageTokens(unobserved);

        // Only log the full token breakdown when something interesting is
        // happening (above prefetch threshold or state to report). Avoids
        // flooding the console on every idle turn.
        if (
          unobservedTokens >= prefetchThreshold ||
          completedObservation.has(sessionID) ||
          observerInFlight.has(sessionID)
        ) {
          log.debug(
            `[${sid}] tokens: ${fmtTokens(unobservedTokens)}, ${unobserved.length} msgs unobserved` +
              (observerInFlight.has(sessionID) ? " [observer running]" : "") +
              (completedObservation.has(sessionID) ? " [result cached]" : ""),
          );
        }

        const agentInput: AgentCallInput = {
          client: input.client,
          directory: input.directory,
          parentSessionID: sessionID,
          model: modelOverride,
        };

        // ── Apply zone ──────────────────────────────────────────────────────
        // If a background Observer has completed and context is large enough,
        // apply the cached result instantly. This is pure array manipulation —
        // no LLM calls, no blocking.
        const completed = completedObservation.get(sessionID);
        if (completed && unobservedTokens >= observerThreshold) {
          // Guard: validate that cached indices still make sense.
          // After native compaction the message array may be shorter than
          // when the Observer was launched, making the splice invalid.
          if (
            completed.firstUnobservedIdx + completed.observedCount >
            output.messages.length
          ) {
            log.warn(
              `[${sid}] discarding stale observation — message array is shorter than expected ` +
                `(need ${completed.firstUnobservedIdx + completed.observedCount}, have ${output.messages.length}). ` +
                `Likely caused by native compaction.`,
            );
            completedObservation.delete(sessionID);
            // Fall through to the background observer zone so a fresh run
            // can be started with the current message array.
          } else {
            completedObservation.delete(sessionID);

            // Detect messages that arrived AFTER the Observer's snapshot.
            // These were never observed and their content is more recent than
            // the Observer's currentTask / suggestedResponse.
            const messagesAfterObserved =
              output.messages.length -
              (completed.firstUnobservedIdx + completed.observedCount);
            const hasRecentMessages = messagesAfterObserved > 0;

            if (hasRecentMessages) {
              log.info(
                `[${sid}] ${messagesAfterObserved} messages arrived after Observer snapshot — suppressing stale hints`,
              );
            }

            // Persist the new memory state
            await saveMemory(storageDir, sessionID, completed.memory);

            // Drop observed messages from the context window
            output.messages.splice(
              completed.firstUnobservedIdx,
              completed.observedCount,
            );

            // Inject continuation hint after the splice point
            const hint = {
              info: {
                ...output.messages[completed.firstUnobservedIdx - 1]?.info,
                role: "user" as const,
                id: "om-continuation-hint",
              },
              parts: [
                {
                  type: "text" as const,
                  text: buildContinuationMessage(
                    completed.memory,
                    hasRecentMessages,
                  ),
                },
              ],
            };
            output.messages.splice(
              completed.firstUnobservedIdx,
              0,
              hint as (typeof output.messages)[number],
            );

            log.info(
              `[${sid}] applied observations — dropped ${completed.observedCount} msgs, ${output.messages.length} remaining` +
                (hasRecentMessages
                  ? ` (${messagesAfterObserved} recent msgs preserved)`
                  : ""),
            );
            return;
          }
        }

        // ── Background Observer zone ────────────────────────────────────────
        // At prefetchThreshold (20% of observer threshold), start the Observer
        // in the background. The result will be cached and applied on the next
        // hook invocation when tokens reach observerThreshold.
        // Also covers the case where tokens jump straight past observerThreshold
        // (e.g. large paste) — the Observer starts immediately and the result
        // is applied on the next turn (one turn of slightly oversized context).
        if (
          unobservedTokens >= prefetchThreshold &&
          !observerInFlight.has(sessionID) &&
          !completedObservation.has(sessionID)
        ) {
          log.info(
            `[${sid}] starting background Observer at ${fmtTokens(unobservedTokens)} — ${unobserved.length} msgs to observe`,
          );
          startBackgroundObserver(
            sessionID,
            agentInput,
            unobserved,
            memory,
            firstUnobservedIdx,
            unobservedTokens,
          );
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

        log.debug(
          `[${shortID(sessionID)}] injected observations into compaction context`,
        );
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
 *
 * When `hasRecentMessages` is false (the Observer saw everything up to the current
 * turn), the hint includes the full currentTask and suggestedResponse — these are
 * fresh and help the LLM pick up exactly where it left off.
 *
 * When `hasRecentMessages` is true, new user/assistant messages arrived between
 * the Observer snapshot and the apply point. In that case:
 * - suggestedResponse is dropped entirely (it would tell the LLM to do
 *   something that no longer matches the conversation state)
 * - currentTask is included as background context but explicitly marked as
 *   potentially outdated
 * - An extra directive tells the LLM to prioritize the recent messages
 */
function buildContinuationMessage(
  memory: SessionMemory,
  hasRecentMessages: boolean,
): string {
  const parts = [`<system-reminder>\n${CONTINUATION_HINT}`];

  if (hasRecentMessages) {
    // Recent messages exist that the Observer never saw.
    // The LLM MUST prioritize those over the stale hints.
    parts.push(
      `\n\nIMPORTANT: Messages follow this reminder that occurred AFTER your memories were captured. ` +
        `These messages represent the CURRENT state of the conversation. ` +
        `Prioritize them over your memory observations when determining what the user needs right now.`,
    );
    if (memory.currentTask) {
      parts.push(
        `\n\nPrevious task context (may have changed — check recent messages):\n${memory.currentTask}`,
      );
    }
    // Deliberately omit suggestedResponse — it would directly mislead the LLM
    // about what to say next when the conversation has moved on.
  } else {
    // Observer saw everything — hints are fresh, include them fully.
    if (memory.currentTask) {
      parts.push(`\n\nCurrent task:\n${memory.currentTask}`);
    }
    if (memory.suggestedResponse) {
      parts.push(`\n\nSuggested next response:\n${memory.suggestedResponse}`);
    }
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
