import { detectDegenerateRepetition, sanitizeLines } from "./observer.js";

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

Your output MUST use XML tags:

<observations>
Put all consolidated observations here using the date-grouped format with priority emojis (🔴, 🟡, 🟢).
Group related observations with indentation.
</observations>

<current-task>
State the current task(s) explicitly:
- Primary: What the agent is currently working on
- Secondary: Other pending tasks (mark as "waiting for user" if appropriate)
</current-task>

<suggested-response>
Hint for the agent's immediate next message. Examples:
- "I've updated the navigation model. Let me walk you through the changes..."
- "The assistant should wait for the user to respond before continuing."
- Call the view tool on src/example.ts to continue debugging.
</suggested-response>

User messages are extremely important. If the user asks a question or gives a new task, make it clear in <current-task> that this is the priority.${instruction ? `\n\n=== CUSTOM INSTRUCTIONS ===\n\n${instruction}` : ""}`;
}

// ─── Compression guidance ────────────────────────────────────────────────────

/**
 * Escalating compression prompts appended when the Reflector's output is too large.
 * Level 0 = no guidance (first attempt). Levels 1-3 push progressively harder.
 */
const COMPRESSION_GUIDANCE: Record<0 | 1 | 2 | 3, string> = {
  0: "",
  1: `
## COMPRESSION REQUIRED

Your previous reflection was the same size or larger than the original observations.

Please re-process with slightly more compression:
- Condense older observations into higher-level reflections
- Closer to the end, retain more fine details (recent context matters more)
- Combine related items more aggressively but do not lose important specifics (names, places, events)
- If there are long nested lists about repeated tool calls, combine into a single line with outcome

Your current detail level was a 10/10, aim for a 8/10.
`,
  2: `
## AGGRESSIVE COMPRESSION REQUIRED

Your previous reflection was still too large after compression guidance.

Please re-process with much more aggressive compression:
- Heavily condense older observations into high-level summaries
- Closer to the end, retain fine details (recent context matters more)
- Combine related items aggressively but do not lose important specifics
- Remove redundant information and merge overlapping observations

Your current detail level was a 10/10, aim for a 6/10.
`,
  3: `
## CRITICAL COMPRESSION REQUIRED

Multiple compression attempts have failed to reduce sufficiently.

Please re-process with maximum compression:
- Summarize the oldest observations (first 50-70%) into brief high-level paragraphs — only key facts, decisions, and outcomes
- For the most recent observations (last 30-50%), retain important details but use a condensed style
- Ruthlessly merge related observations — if 10 observations are about the same topic, combine into 1-2 lines
- Drop procedural details (tool calls, retries, intermediate steps) — keep only final outcomes
- Preserve: names, dates, decisions, errors, user preferences, architectural choices

Your current detail level was a 10/10, aim for a 4/10.
`,
};

/**
 * Builds the user-turn prompt sent to the Reflector.
 */
export function buildReflectorPrompt(
  observations: string,
  compressionLevel: 0 | 1 | 2 | 3 = 0,
  manualPrompt?: string,
): string {
  let prompt = `## OBSERVATIONS TO REFLECT ON

${observations}

---

Please analyze these observations and produce a refined, condensed version that will become the assistant's entire memory going forward.`;

  if (manualPrompt) {
    prompt += `\n\n## SPECIFIC GUIDANCE\n\n${manualPrompt}`;
  }

  const guidance = COMPRESSION_GUIDANCE[compressionLevel];
  if (guidance) prompt += `\n\n${guidance}`;

  return prompt;
}

// ─── Output parser ───────────────────────────────────────────────────────────

export type ParsedReflector = {
  observations: string;
  suggestedResponse?: string;
  degenerate?: boolean;
};

/**
 * Parses the Reflector's XML-structured output.
 */
export function parseReflectorOutput(raw: string): ParsedReflector {
  if (detectDegenerateRepetition(raw)) {
    return { observations: "", degenerate: true };
  }

  const obsMatch = raw.match(
    /^[ \t]*<observations>([\s\S]*?)^[ \t]*<\/observations>/im,
  );
  const suggestedMatch = raw.match(
    /^[ \t]*<suggested-response>([\s\S]*?)^[ \t]*<\/suggested-response>/im,
  );

  const rawObs = obsMatch?.[1]?.trim() ?? extractListItems(raw);
  const observations = sanitizeLines(rawObs);
  const suggestedResponse = suggestedMatch?.[1]?.trim() || undefined;

  return { observations, suggestedResponse };
}

function extractListItems(text: string): string {
  return text
    .split("\n")
    .filter((l) => /^\s*[-*]\s/.test(l) || /^\s*\d+\.\s/.test(l))
    .join("\n")
    .trim();
}

/**
 * Validates that reflection actually compressed the observations.
 * Returns true if the reflected output is smaller than the input.
 */
export function validateCompression(
  reflectedTokens: number,
  inputTokens: number,
): boolean {
  return reflectedTokens < inputTokens;
}

// Re-export sanitizeLines for use in observer.ts (avoids circular dep)
export { sanitizeLines } from "./observer.js";
