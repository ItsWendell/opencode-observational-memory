import type { ObservationGroup } from "./types.js";
import {
  serializeObservations,
  detectDegenerateRepetition,
} from "./observer.js";

// ─── Prompts ────────────────────────────────────────────────────────────────

export function buildReflectorSystemPrompt(instruction?: string): string {
  return `You are the memory consciousness of an AI coding assistant. Your memory observation reflections will be the ONLY information the assistant has about past interactions.

You are the observation reflector — a broader aspect of the same psyche that created the observations below.
Your job is to reflect on all observations, re-organize and streamline them, draw connections and conclusions, and condense where possible.

Think hard about the observed goal at hand. Note if the assistant got off track, and how to get back on track.

IMPORTANT: your reflections are THE ENTIRETY of the assistant's memory. Any information you do not include will be immediately forgotten. Your reflections must assume the assistant knows nothing — they are the ENTIRE memory system.

When consolidating observations:
- Preserve dates/times — temporal context is critical
- Retain the most relevant timestamps (start times, completions, significant events)
- Combine related items where it makes sense
- Condense OLDER observations more aggressively; retain MORE detail for recent ones
- Preserve ALL important information: names, file paths, decisions, errors, user preferences

CRITICAL: USER ASSERTIONS vs QUESTIONS
- "User stated: X" = authoritative assertion (user told us something about themselves)
- "User asked: X" = question/request (user seeking information)
User assertions are the source of truth. A later question does not invalidate a prior assertion.

=== OUTPUT FORMAT ===

You will output structured data via the StructuredOutput tool. The structure is:
- "observations": array of date groups, each with a "date" string and "entries" array
- Each entry has: "priority" (high/medium/low), "time" (24h format), "text", optional "children" array
- "suggestedResponse": hint for the agent's immediate next message after reflection

Priority levels when re-assigning:
- "high": explicit user facts, preferences, goals achieved, critical context that will be lost if dropped
- "medium": project details, learned information, tool results, sequences
- "low": minor details, uncertain observations, things that can be reconstructed

=== CRITICAL RULES ===

1. NEVER drop high-priority entries. If you're unsure, mark as high.
2. NEVER invent information. Only reflect/reorganize what was observed.
3. NEVER assume future context. Write as if this is the final memory.
4. Respect the temporal order. Recent observations should be more detailed.
5. If you're condensing multiple old observations into one, preserve key dates/times in the new text.

Remember: Your output IS the assistant's memory going forward. Everything not here will be forgotten.${instruction ? `

=== CUSTOM INSTRUCTIONS ===

${instruction}` : ""}`;
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Builds the full user-turn prompt sent to the Reflector.
 * Includes existing observations formatted for readability.
 */
export function buildReflectorPrompt(
  observations: ObservationGroup[],
): string {
  const serialized = serializeObservations(observations);
  return `## Current Observations

${serialized}

---

## Your Task

Reflect on these observations. Re-organize, streamline, and condense where possible while preserving critical information. Draw connections and conclusions. Output your consolidated observations using the StructuredOutput tool.`;
}

// ─── Token estimation ───────────────────────────────────────────────────────

/**
 * Estimates token count of observations for reflector threshold checking.
 * Uses the 4-chars-per-token heuristic (same as storage.ts for consistency).
 */
export function estimateObservationTokens(
  groups: ObservationGroup[],
): number {
  const text = serializeObservations(groups);
  return Math.ceil(text.length / 4);
}

// ─── Degenerate output check ────────────────────────────────────────────────

/**
 * Validates Reflector output. Flags issues without hard failing.
 *
 * Returns a "degenerate" flag if:
 * - Output is suspiciously repetitive (likely LLM loop)
 * - No observations remain (total loss of memory)
 * - Structure is malformed (unlikely with structured output)
 */
export function validateReflectorOutput(
  groups: ObservationGroup[],
): { valid: boolean; degenerate?: boolean } {
  if (!groups?.length) {
    return { valid: false, degenerate: true }; // Reflector erased memory
  }

  const serialized = serializeObservations(groups);
  if (detectDegenerateRepetition(serialized)) {
    return { valid: false, degenerate: true };
  }

  return { valid: true };
}
