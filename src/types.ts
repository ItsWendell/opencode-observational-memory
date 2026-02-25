/**
 * Persisted state for a single opencode session.
 *
 * observations: raw markdown string in the Mastra XML format, accumulated over
 * the session. Stored as a string (not structured) because the Observer/Reflector
 * produce and consume prose markdown, not JSON arrays.
 *
 * suggestedResponse: last <suggested-response> extracted from the Observer. Injected
 * as a hint after the continuation reminder so the agent picks up naturally.
 *
 * currentTask: last <current-task> extracted from the Observer. Injected alongside
 * suggestedResponse for continuity after message history is truncated.
 *
 * lastObservedMessageIndex: index into the message array at which the last observation
 * run completed. Messages at and below this index are "observed" and may be dropped.
 *
 * lastObservedTokens: estimated input token count at the time of the last Observer run.
 * Used to compute the delta since last observation.
 *
 * lastObservedAt: unix ms timestamp of the last Observer run.
 * lastReflectedAt: unix ms timestamp of the last Reflector run.
 */
export type SessionMemory = {
  observations: string;
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
   * Format: "providerID:modelID", e.g. "anthropic:claude-haiku-3-5"
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
  observations: string;
  currentTask?: string;
  suggestedResponse?: string;
  degenerate?: boolean;
};

/** Result from the Reflector agent call */
export type ReflectorResult = {
  observations: string;
  suggestedResponse?: string;
  degenerate?: boolean;
};
