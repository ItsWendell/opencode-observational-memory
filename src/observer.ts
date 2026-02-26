import type { Hooks } from "@opencode-ai/plugin";
import type { ObservationEntry, ObservationGroup } from "./types.js";

// Extract message/part types from the plugin Hooks type
type MessagesTransformOutput = Parameters<
  NonNullable<Hooks["experimental.chat.messages.transform"]>
>[1];
export type WithParts = MessagesTransformOutput["messages"][number];

// ─── JSON Schemas ───────────────────────────────────────────────────────────

/** Reusable schema fragment for an observation entry. */
const OBSERVATION_ENTRY_SCHEMA = {
  type: "object" as const,
  properties: {
    priority: {
      type: "string" as const,
      enum: ["high", "medium", "low"],
      description:
        "high = user facts/preferences/goals/critical decisions, medium = project details/tool results/discoveries, low = minor details/uncertain observations",
    },
    time: {
      type: "string" as const,
      description: "24-hour time when the observation occurred, e.g. '14:30'",
    },
    text: {
      type: "string" as const,
      description: "The observation text — dense, specific, actionable",
    },
    children: {
      type: "array" as const,
      description:
        "Sub-observations grouped under this entry (e.g. a sequence of tool calls)",
      items: {
        type: "object" as const,
        properties: {
          text: { type: "string" as const },
        },
        required: ["text"],
      },
    },
  },
  required: ["priority", "time", "text"],
};

/** Reusable schema fragment for a date-grouped set of observations. */
const OBSERVATION_GROUP_SCHEMA = {
  type: "object" as const,
  properties: {
    date: {
      type: "string" as const,
      description: "Date header in 'Mon DD, YYYY' format, e.g. 'Feb 26, 2026'",
    },
    entries: {
      type: "array" as const,
      description: "Observations for this date, ordered chronologically",
      items: OBSERVATION_ENTRY_SCHEMA,
    },
  },
  required: ["date", "entries"],
};

/**
 * JSON schema passed to opencode's structured output API for the Observer.
 */
export const OBSERVER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    observations: {
      type: "array",
      description: "Array of date-grouped observation sets",
      items: OBSERVATION_GROUP_SCHEMA,
    },
    currentTask: {
      type: "string",
      description:
        "Current task(s) the agent is working on. State primary task first, then secondary/waiting tasks.",
    },
    suggestedResponse: {
      type: "string",
      description:
        'Hint for the agent\'s immediate next message, e.g. "Continue debugging the auth issue" or "Wait for user to respond"',
    },
  },
  required: ["observations"],
};

/**
 * JSON schema for the Reflector output. Same observation structure, no
 * currentTask (the reflector condenses — it doesn't track task state).
 */
export const REFLECTOR_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    observations: {
      type: "array",
      description:
        "Condensed, consolidated observations — the assistant's entire memory going forward",
      items: OBSERVATION_GROUP_SCHEMA,
    },
    suggestedResponse: {
      type: "string",
      description:
        "Updated hint for the agent's immediate next message after reflection",
    },
  },
  required: ["observations"],
};

// ─── Prompts ────────────────────────────────────────────────────────────────

const EXTRACTION_INSTRUCTIONS = `CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS

When the user TELLS you something, mark it as an assertion:
- "I have two kids" → priority "high", text "User stated they have two kids"
- "I work at Acme Corp" → priority "high", text "User stated they work at Acme Corp"

When the user ASKS about something, mark it as a question/request:
- "Can you help me with X?" → priority "high", text "User asked for help with X"

STATE CHANGES AND UPDATES:
When a user indicates they are changing something, frame it as a state change:
- "I'm switching from A to B" → "User is switching from A to B (replacing A)"

TEMPORAL ANCHORING:
Each observation has a "time" field (24-hour format, e.g. "14:30") from the message timestamp.
If the observation references a different date/time, note it in the "text" field.

PRESERVING DETAILS:
- Capture specific names, numbers, identifiers, file paths, decisions, errors
- When the agent uses tools, note: what tool, why, and what was learned
- Short/medium user messages: capture near-verbatim in your own words
- Long user messages: summarize with key quotes preserved

GROUPING & CHILDREN:
- Group repeated similar actions (tool calls, file browsing) under one parent entry using the "children" array:
  { priority: "medium", time: "14:30", text: "Agent browsed auth source files",
    children: [
      { text: "viewed src/auth.ts — found token validation logic" },
      { text: "viewed src/users.ts — found user lookup by email" }
    ] }

AVOIDING REPETITION:
- Do NOT repeat observations already present in previous observations

CONVERSATION CONTEXT to capture:
- Decisions made (architectural, tooling, approach)
- Files created, modified, or deleted with purpose
- Tool executions: what ran, outcome, errors
- User preferences, constraints, requirements
- Problems encountered and how resolved
- Goals established or changed
- Code snippets, sequences, specific data that may need reproducing`;

const GUIDELINES = `- Be specific enough for the assistant to act on
- Good: "User prefers short, direct answers without lengthy explanations"
- Bad: "User stated a preference" (too vague)
- Add 1 to 5 observation entries per exchange
- Use terse language — text should be dense without unnecessary words
- User messages are always "high" priority, as are completions of tasks
- "high": explicit user facts, preferences, goals achieved, critical context
- "medium": project details, learned information, tool results
- "low": minor details, uncertain observations`;

export function buildObserverSystemPrompt(instruction?: string): string {
  return `You are the memory consciousness of an AI coding assistant. Your observations will be the ONLY information the assistant has about past interactions.

Extract observations that will help the assistant remember:

${EXTRACTION_INSTRUCTIONS}

=== OUTPUT FORMAT ===

You will output structured data via the StructuredOutput tool. The structure is:
- "observations": array of date groups, each with a "date" string and "entries" array
- Each entry has: "priority" (high/medium/low), "time" (24h format), "text", optional "children" array
- "currentTask": describe the current task(s) — primary first, then secondary/waiting
- "suggestedResponse": hint for the agent's immediate next message

Priority levels:
- "high": explicit user facts, preferences, goals achieved, critical context
- "medium": project details, learned information, tool results
- "low": minor details, uncertain observations

=== GUIDELINES ===

${GUIDELINES}

Remember: These observations are the assistant's ONLY memory. Make them count.

User messages are extremely important. If the user asks a question or gives a new task, make it clear in "currentTask" that this is the priority.${instruction ? `\n\n=== CUSTOM INSTRUCTIONS ===\n\n${instruction}` : ""}`;
}

// ─── Message formatter ───────────────────────────────────────────────────────

const MAX_TOOL_OUTPUT = 2_000;

/**
 * Formats opencode WithParts messages into a transcript string for the Observer.
 * Includes wall-clock timestamps from message metadata for temporal anchoring.
 */
export function formatMessagesForObserver(messages: WithParts[]): string {
  return messages
    .map((msg) => {
      const role =
        msg.info.role === "user"
          ? "User"
          : msg.info.role === "assistant"
            ? "Assistant"
            : "System";

      // Use message creation time for temporal anchoring
      const ts =
        "time" in msg.info && msg.info.time?.created
          ? new Date(msg.info.time.created).toLocaleString("en-US", {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            })
          : "";

      const header = ts ? `**${role} (${ts}):**` : `**${role}:**`;

      const parts: string[] = [];
      for (const part of msg.parts) {
        if (part.type === "text" && part.text.trim()) {
          parts.push(part.text.trim());
        } else if (part.type === "tool") {
          const name = part.tool;
          if (part.state.status === "completed") {
            const input = JSON.stringify(part.state.input);
            const out =
              part.state.output.length > MAX_TOOL_OUTPUT
                ? part.state.output.slice(0, MAX_TOOL_OUTPUT) +
                  `\n... [truncated ${part.state.output.length - MAX_TOOL_OUTPUT} chars]`
                : part.state.output;
            parts.push(`[Tool Call: ${name}]\nInput: ${input}\nOutput: ${out}`);
          } else if (part.state.status === "error") {
            parts.push(`[Tool Call: ${name}] ERROR: ${part.state.error}`);
          }
        }
      }

      if (parts.length === 0) return null;
      return `${header}\n${parts.join("\n")}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

// ─── Serialization ───────────────────────────────────────────────────────────

/**
 * Serializes structured observations to a human-readable text format for
 * injection into the system prompt or for passing as context to the Observer
 * and Reflector.
 *
 * Output looks like:
 *   Date: Feb 26, 2026
 *   * 🔴 (14:30) User prefers direct answers
 *   * 🟡 (14:32) Agent browsed auth source files
 *     * -> viewed src/auth.ts — found token validation logic
 */
export function serializeObservations(groups: ObservationGroup[]): string {
  if (!groups.length) return "";
  return groups
    .map((group) => {
      const header = `Date: ${group.date}`;
      const entries = group.entries
        .map((entry) => {
          const emoji =
            entry.priority === "high"
              ? "🔴"
              : entry.priority === "medium"
                ? "🟡"
                : "🟢";
          const line = `* ${emoji} (${entry.time}) ${entry.text}`;
          if (entry.children?.length) {
            const childLines = entry.children
              .map((c) => `  * -> ${c.text}`)
              .join("\n");
            return `${line}\n${childLines}`;
          }
          return line;
        })
        .join("\n");
      return `${header}\n${entries}`;
    })
    .join("\n\n");
}

/**
 * Strips noise from serialized observations before injecting into the agent's
 * context. The full structured data is stored on disk; this leaner text
 * version saves tokens on every turn.
 *
 * - Removes 🟡 and 🟢 emojis (keeps 🔴 for critical items)
 * - Removes arrow indicators (->)
 * - Collapses extra whitespace
 */
export function optimizeForContext(groups: ObservationGroup[]): string {
  const text = serializeObservations(groups);
  if (!text) return "";
  return text
    .replace(/🟡\s*/g, "")
    .replace(/🟢\s*/g, "")
    .replace(/\s*->\s*/g, " ")
    .replace(/  +/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Degenerate output detection ─────────────────────────────────────────────

/**
 * Detects LLM repetition loops (a real failure mode with some models).
 * Samples ~50 windows of 200 chars; if >40% are duplicates, output is degenerate.
 *
 * With structured output this is less likely, but we run it on the serialized
 * form as a safety net.
 */
export function detectDegenerateRepetition(text: string): boolean {
  if (!text || text.length < 2_000) return false;

  const windowSize = 200;
  const step = Math.max(1, Math.floor(text.length / 50));
  const seen = new Map<string, number>();
  let duplicates = 0;
  let total = 0;

  for (let i = 0; i + windowSize <= text.length; i += step) {
    const w = text.slice(i, i + windowSize);
    total++;
    const count = (seen.get(w) ?? 0) + 1;
    seen.set(w, count);
    if (count > 1) duplicates++;
  }

  if (total > 5 && duplicates / total > 0.4) return true;

  // Single line >50k chars is almost certainly degenerate enumeration
  for (const line of text.split("\n")) {
    if (line.length > 50_000) return true;
  }

  return false;
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Builds the full user-turn prompt sent to the Observer.
 * Includes existing observations (serialized to text) so the Observer doesn't
 * repeat them.
 */
export function buildObserverPrompt(
  existingObservations: ObservationGroup[] | undefined,
  messagesToObserve: WithParts[],
): string {
  const transcript = formatMessagesForObserver(messagesToObserve);
  let prompt = "";

  if (existingObservations?.length) {
    const serialized = serializeObservations(existingObservations);
    prompt += `## Previous Observations\n\n${serialized}\n\n---\n\n`;
    prompt +=
      "Do not repeat these existing observations. Your new observations will be appended.\n\n";
  }

  prompt += `## New Message History to Observe\n\n${transcript}\n\n---\n\n`;
  prompt +=
    "## Your Task\n\nExtract new observations from the message history above. Do not repeat observations already in the previous observations. Output your structured observations using the StructuredOutput tool.";

  return prompt;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Merges two observation arrays, combining entries for the same date group.
 */
export function mergeObservationGroups(
  existing: ObservationGroup[],
  incoming: ObservationGroup[],
): ObservationGroup[] {
  // Build a map of date -> entries from existing
  const byDate = new Map<string, ObservationEntry[]>();
  for (const g of existing) {
    byDate.set(g.date, [...(byDate.get(g.date) ?? []), ...g.entries]);
  }
  // Merge incoming
  for (const g of incoming) {
    byDate.set(g.date, [...(byDate.get(g.date) ?? []), ...g.entries]);
  }
  // Rebuild array preserving date order (existing first, then new dates)
  const seenDates = new Set<string>();
  const result: ObservationGroup[] = [];
  for (const g of [...existing, ...incoming]) {
    if (seenDates.has(g.date)) continue;
    seenDates.add(g.date);
    result.push({ date: g.date, entries: byDate.get(g.date) ?? [] });
  }
  return result;
}
