import type { Hooks } from "@opencode-ai/plugin";

// Extract message/part types from the plugin Hooks type
type MessagesTransformOutput = Parameters<
  NonNullable<Hooks["experimental.chat.messages.transform"]>
>[1];
export type WithParts = MessagesTransformOutput["messages"][number];

// ─── Prompts ────────────────────────────────────────────────────────────────

const EXTRACTION_INSTRUCTIONS = `CRITICAL: DISTINGUISH USER ASSERTIONS FROM QUESTIONS

When the user TELLS you something, mark it as an assertion:
- "I have two kids" → 🔴 (14:30) User stated they have two kids
- "I work at Acme Corp" → 🔴 (14:31) User stated they work at Acme Corp

When the user ASKS about something, mark it as a question/request:
- "Can you help me with X?" → 🔴 (15:00) User asked for help with X

STATE CHANGES AND UPDATES:
When a user indicates they are changing something, frame it as a state change:
- "I'm switching from A to B" → "User is switching from A to B (replacing A)"

TEMPORAL ANCHORING:
Each observation has TWO potential timestamps:
1. The time the statement was made (from message timestamp) - ALWAYS include as (HH:MM)
2. The time being REFERENCED, if different - ONLY when you can provide an actual date

FORMAT:
- With time reference: (HH:MM) [observation]. (meaning DATE)
- Without time reference: (HH:MM) [observation].

PRESERVING DETAILS:
- Capture specific names, numbers, identifiers, file paths, decisions, errors
- When the agent uses tools, note: what tool, why, and what was learned
- Short/medium user messages: capture near-verbatim in your own words
- Long user messages: summarize with key quotes preserved

AVOIDING REPETITION:
- Do NOT repeat observations already present in previous observations
- Group repeated similar actions (tool calls, file browsing) under one parent:
  🟡 (14:30) Agent browsed auth source files
    * -> viewed src/auth.ts — found token validation logic
    * -> viewed src/users.ts — found user lookup by email

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
- Add 1 to 5 observations per exchange
- Use terse language — sentences should be dense without unnecessary words
- Make sure you start each observation with a priority emoji (🔴, 🟡, 🟢)
- User messages are always 🔴 priority, as are completions of tasks
- 🔴 High: explicit user facts, preferences, goals, critical decisions
- 🟡 Medium: project details, tool results, discoveries
- 🟢 Low: minor details, uncertain observations`;

export function buildObserverSystemPrompt(instruction?: string): string {
  return `You are the memory consciousness of an AI coding assistant. Your observations will be the ONLY information the assistant has about past interactions.

Extract observations that will help the assistant remember:

${EXTRACTION_INSTRUCTIONS}

=== OUTPUT FORMAT ===

Your output MUST use XML tags. This allows the system to properly parse and manage memory over time.

Use priority levels:
- 🔴 High: explicit user facts, preferences, goals achieved, critical context
- 🟡 Medium: project details, learned information, tool results
- 🟢 Low: minor details, uncertain observations

Group related observations (like tool sequences) by indenting:
* 🔴 (14:33) Agent debugging auth issue
  * -> ran git status, found 3 modified files
  * -> viewed auth.ts:45-60, found missing null check
  * -> applied fix, tests now pass

Group observations by date, then list each with 24-hour time.

<observations>
Date: Dec 4, 2025
* 🔴 (14:30) User prefers direct answers
* 🔴 (14:31) Working on feature X
* 🟡 (14:32) User might prefer dark mode

Date: Dec 5, 2025
* 🔴 (09:15) Continued work on feature X
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

=== GUIDELINES ===

${GUIDELINES}

Remember: These observations are the assistant's ONLY memory. Make them count.

User messages are extremely important. If the user asks a question or gives a new task, make it clear in <current-task> that this is the priority.${instruction ? `\n\n=== CUSTOM INSTRUCTIONS ===\n\n${instruction}` : ""}`;
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

// ─── Output parser ───────────────────────────────────────────────────────────

export type ParsedObserver = {
  observations: string;
  currentTask?: string;
  suggestedResponse?: string;
};

/**
 * Parses the Observer's XML-structured output.
 * Extracts <observations>, <current-task>, and <suggested-response> blocks.
 * Falls back to extracting list items if XML tags are missing.
 */
export function parseObserverOutput(raw: string): ParsedObserver {
  const obs = extractXmlBlock(raw, "observations");
  const currentTask = extractXmlTag(raw, "current-task");
  const suggestedResponse = extractXmlTag(raw, "suggested-response");

  const observations = sanitizeLines(obs ?? extractListItems(raw));

  return { observations, currentTask, suggestedResponse };
}

function extractXmlBlock(text: string, tag: string): string | undefined {
  const re = new RegExp(
    `^[ \\t]*<${tag}>([\\s\\S]*?)^[ \\t]*<\\/${tag}>`,
    "gim",
  );
  const matches = [...text.matchAll(re)];
  if (matches.length === 0) return undefined;
  return matches
    .map((m) => m[1]?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

function extractXmlTag(text: string, tag: string): string | undefined {
  const re = new RegExp(
    `^[ \\t]*<${tag}>([\\s\\S]*?)^[ \\t]*<\\/${tag}>`,
    "im",
  );
  const m = text.match(re);
  return m?.[1]?.trim() || undefined;
}

function extractListItems(text: string): string {
  return text
    .split("\n")
    .filter((l) => /^\s*[-*]\s/.test(l) || /^\s*\d+\.\s/.test(l))
    .join("\n")
    .trim();
}

const MAX_LINE_CHARS = 10_000;

export function sanitizeLines(text: string): string {
  if (!text) return text;
  return text
    .split("\n")
    .map((l) =>
      l.length > MAX_LINE_CHARS
        ? l.slice(0, MAX_LINE_CHARS) + " … [truncated]"
        : l,
    )
    .join("\n");
}

// ─── Degenerate output detection ─────────────────────────────────────────────

/**
 * Detects LLM repetition loops (a real failure mode with some models).
 * Samples ~50 windows of 200 chars; if >40% are duplicates, output is degenerate.
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

// ─── Context optimization ────────────────────────────────────────────────────

/**
 * Strips noise from observations before injecting into the agent's context.
 * The full rich format is stored on disk; this leaner version saves tokens.
 * - Removes 🟡 and 🟢 emojis (keep 🔴 for critical items)
 * - Removes arrow indicators (->)
 * - Collapses extra whitespace
 */
export function optimizeForContext(observations: string): string {
  return observations
    .replace(/🟡\s*/g, "")
    .replace(/🟢\s*/g, "")
    .replace(/\s*->\s*/g, " ")
    .replace(/  +/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Builds the full user-turn prompt sent to the Observer.
 * Includes existing observations so the Observer doesn't repeat them.
 */
export function buildObserverPrompt(
  existingObservations: string | undefined,
  messagesToObserve: WithParts[],
): string {
  const transcript = formatMessagesForObserver(messagesToObserve);
  let prompt = "";

  if (existingObservations?.trim()) {
    prompt += `## Previous Observations\n\n${existingObservations}\n\n---\n\n`;
    prompt +=
      "Do not repeat these existing observations. Your new observations will be appended.\n\n";
  }

  prompt += `## New Message History to Observe\n\n${transcript}\n\n---\n\n`;
  prompt +=
    "## Your Task\n\nExtract new observations from the message history above. Do not repeat observations already in the previous observations. Add your new observations in the format specified in your instructions.";

  return prompt;
}
