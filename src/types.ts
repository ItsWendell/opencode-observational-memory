// ─── Structured observation types ────────────────────────────────────────────

/**
 * A single observation entry — one bullet point in the observation log.
 *
 * Examples:
 *   { priority: "high", time: "14:30", text: "User decided to use Bun runtime" }
 *   { priority: "medium", time: "14:32", text: "Agent browsed auth source files",
 *     children: [{ text: "viewed src/auth.ts — found token validation logic" }] }
 */
export type ObservationEntry = {
  priority: "high" | "medium" | "low";
  time: string;
  text: string;
  children?: { text: string }[];
};

/**
 * A group of observations under a single date header.
 *
 * Example:
 *   { date: "Dec 4, 2025", entries: [ ... ] }
 */
export type ObservationGroup = {
  date: string;
  entries: ObservationEntry[];
};

// ─── Session memory ──────────────────────────────────────────────────────────

/**
 * Persisted state for a single opencode session.
 *
 * observations: structured array of date-grouped observation entries,
 * accumulated by the Observer and condensed by the Reflector.
 *
 * suggestedResponse: last suggested-response extracted from the Observer.
 * Injected as a hint after the continuation reminder so the agent picks up
 * naturally.
 *
 * currentTask: last current-task extracted from the Observer. Injected
 * alongside suggestedResponse for continuity after message history is
 * truncated.
 *
 * lastObservedMessageIndex: index into the message array at which the last
 * observation run completed. Messages at and below this index are "observed"
 * and may be dropped.
 *
 * lastObservedTokens: estimated input token count at the time of the last
 * Observer run. Used to compute the delta since last observation.
 *
 * lastObservedAt: unix ms timestamp of the last Observer run.
 * lastReflectedAt: unix ms timestamp of the last Reflector run.
 */
export type SessionMemory = {
  observations: ObservationGroup[];
  suggestedResponse?: string;
  currentTask?: string;
  lastObservedMessageIndex: number;
  lastObservedTokens: number;
  lastObservedAt: number;
  lastReflectedAt: number;
};

/**
 * Plugin configuration options.
 */
export type ObservationalMemoryConfig = {
  /**
   * Token threshold for triggering the Observer agent.
   * When unobserved message tokens exceed this value, Observer runs.
   * Default: 30_000
   */
  observerThreshold?: number;

  /**
   * Token threshold for triggering the Reflector agent.
   * When the observation log exceeds this size (char/4 estimate), Reflector runs.
   * Default: 40_000
   */
  reflectorThreshold?: number;

  /**
   * The AI model to use for Observer and Reflector agents.
   * Format: "providerID/modelID", e.g. "anthropic/claude-haiku-4-5-20251001"
   * Default: inherits the session's current model.
   */
  model?: string;

  /**
   * Directory where observation logs are persisted.
   * Default: <project>/.opencode/observations/
   */
  storageDir?: string;

  /**
   * Custom instructions appended to the Observer system prompt.
   */
  observerInstruction?: string;

  /**
   * Custom instructions appended to the Reflector system prompt.
   */
  reflectorInstruction?: string;

  /**
   * Fraction of observerThreshold at which background pre-fetching starts.
   * At this fraction the Observer runs in the background so results are ready
   * by the time the session hits 100% of threshold.
   * Must be between 0 and 1. Default: 0.2 (20%)
   */
  prefetchFraction?: number;

  /**
   * Enable verbose logging for debugging.
   * Default: false
   */
  debug?: boolean;
};

/** Result from the Observer agent call */
export type ObserverResult = {
  observations: ObservationGroup[];
  currentTask?: string;
  suggestedResponse?: string;
  degenerate?: boolean;
};

/** Result from the Reflector agent call */
export type ReflectorResult = {
  observations: ObservationGroup[];
  suggestedResponse?: string;
  degenerate?: boolean;
};
