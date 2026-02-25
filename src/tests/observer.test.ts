import { describe, it, expect } from "bun:test";
import {
  parseObserverOutput,
  detectDegenerateRepetition,
  optimizeForContext,
  formatMessagesForObserver,
  buildObserverPrompt,
} from "../observer.js";

// ─── Minimal message fixture ─────────────────────────────────────────────────

function makeMsg(
  role: "user" | "assistant",
  text: string,
  createdAt = Date.now(),
) {
  return {
    info: {
      id: `msg-${role}`,
      sessionID: "sess-1",
      role,
      time: { created: createdAt },
    },
    parts: [{ type: "text" as const, text }],
  } as Parameters<typeof formatMessagesForObserver>[0][number];
}

function makeToolMsg(tool: string, input: unknown, output: string) {
  return {
    info: {
      id: "msg-asst-tool",
      sessionID: "sess-1",
      role: "assistant" as const,
      time: { created: Date.now() },
    },
    parts: [
      {
        type: "tool" as const,
        tool,
        callID: "call-1",
        state: {
          status: "completed" as const,
          input,
          output,
          title: tool,
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ],
  } as Parameters<typeof formatMessagesForObserver>[0][number];
}

// ─── parseObserverOutput tests ───────────────────────────────────────────────

describe("parseObserverOutput", () => {
  it("extracts observations from XML block", () => {
    const raw = `
<observations>
Date: Jan 1, 2026
* 🔴 (14:30) User decided to use Bun runtime.
* 🟡 (14:31) Created src/index.ts.
</observations>
<current-task>
Implement main entry point
</current-task>
<suggested-response>
Continue with index.ts
</suggested-response>
`;
    const result = parseObserverOutput(raw);
    expect(result.observations).toContain("User decided to use Bun runtime");
    expect(result.observations).toContain("Created src/index.ts");
    expect(result.currentTask).toBe("Implement main entry point");
    expect(result.suggestedResponse).toBe("Continue with index.ts");
  });

  it("falls back to list items when XML tags absent", () => {
    const raw =
      "* 🔴 (09:00) User prefers TypeScript\n* 🟡 (09:01) Set up tsconfig";
    const result = parseObserverOutput(raw);
    expect(result.observations).toContain("User prefers TypeScript");
    expect(result.observations).toContain("tsconfig");
    expect(result.currentTask).toBeUndefined();
    expect(result.suggestedResponse).toBeUndefined();
  });

  it("returns empty when no recognizable content", () => {
    const result = parseObserverOutput("I cannot extract anything useful.");
    expect(result.observations).toBe("");
  });

  it("handles multiple observation blocks by joining them", () => {
    const raw = `
<observations>
Date: Jan 1, 2026
* 🔴 (09:00) First block
</observations>
Some text in between
<observations>
Date: Jan 2, 2026
* 🔴 (10:00) Second block
</observations>
`;
    const result = parseObserverOutput(raw);
    expect(result.observations).toContain("First block");
    expect(result.observations).toContain("Second block");
  });

  it("truncates lines exceeding 10k chars", () => {
    const longLine = "* 🔴 (09:00) " + "x".repeat(11_000);
    const raw = `<observations>\n${longLine}\n</observations>`;
    const result = parseObserverOutput(raw);
    const line = result.observations
      .split("\n")
      .find((l) => l.startsWith("* 🔴"));
    expect(line).toBeDefined();
    expect(line!.length).toBeLessThan(11_000);
    expect(line).toContain("[truncated]");
  });
});

// ─── detectDegenerateRepetition tests ────────────────────────────────────────

describe("detectDegenerateRepetition", () => {
  it("returns false for short text", () => {
    expect(detectDegenerateRepetition("short text")).toBe(false);
  });

  it("returns false for normal observations", () => {
    const normal = [
      "Date: Jan 1, 2026",
      "* 🔴 (09:00) User decided to use Bun runtime for the project.",
      "* 🟡 (09:05) Created src/index.ts with the main entry point function.",
      "* 🔴 (09:10) User prefers short and direct answers without lengthy explanations.",
      "* 🟡 (09:15) Ran bun install to add dependencies including zod and hono.",
      "* 🔴 (09:20) User wants to deploy to Fly.io using Docker containers.",
    ]
      .join("\n")
      .repeat(5);
    expect(detectDegenerateRepetition(normal)).toBe(false);
  });

  it("detects repetition loops", () => {
    // A classic LLM repetition loop: same 200-char chunk over and over
    const repeated = "* 🔴 (09:00) User wants something. ".repeat(200);
    expect(detectDegenerateRepetition(repeated)).toBe(true);
  });

  it("detects single extremely long lines", () => {
    const giant = "x".repeat(55_000);
    expect(detectDegenerateRepetition(giant)).toBe(true);
  });
});

// ─── optimizeForContext tests ─────────────────────────────────────────────────

describe("optimizeForContext", () => {
  it("removes 🟡 and 🟢 but keeps 🔴", () => {
    const obs = "* 🔴 (09:00) Critical\n* 🟡 (09:01) Medium\n* 🟢 (09:02) Low";
    const result = optimizeForContext(obs);
    expect(result).toContain("🔴");
    expect(result).not.toContain("🟡");
    expect(result).not.toContain("🟢");
  });

  it("replaces arrow indicators with spaces", () => {
    const obs =
      "* 🔴 (09:00) Agent browsed files\n  * -> viewed auth.ts — found logic";
    const result = optimizeForContext(obs);
    expect(result).not.toContain("->");
    expect(result).toContain("viewed auth.ts");
  });

  it("collapses multiple blank lines", () => {
    const obs = "line1\n\n\n\nline2";
    const result = optimizeForContext(obs);
    expect(result).toBe("line1\n\nline2");
  });

  it("trims leading and trailing whitespace", () => {
    expect(optimizeForContext("  hello  ")).toBe("hello");
  });
});

// ─── formatMessagesForObserver tests ─────────────────────────────────────────

describe("formatMessagesForObserver", () => {
  it("returns empty string for empty array", () => {
    expect(formatMessagesForObserver([])).toBe("");
  });

  it("formats user messages with role header", () => {
    const result = formatMessagesForObserver([
      makeMsg("user", "Please help me"),
    ]);
    expect(result).toContain("**User");
    expect(result).toContain("Please help me");
  });

  it("formats assistant messages with role header", () => {
    const result = formatMessagesForObserver([
      makeMsg("assistant", "Here is the answer"),
    ]);
    expect(result).toContain("**Assistant");
    expect(result).toContain("Here is the answer");
  });

  it("includes timestamp in header", () => {
    const ts = new Date("2026-01-15T14:30:00Z").getTime();
    const result = formatMessagesForObserver([makeMsg("user", "hi", ts)]);
    // Should contain some time indication
    expect(result).toContain("**User (");
  });

  it("formats completed tool calls with input and output", () => {
    const result = formatMessagesForObserver([
      makeToolMsg(
        "read",
        { filePath: "/src/index.ts" },
        "export function main() {}",
      ),
    ]);
    expect(result).toContain("[Tool Call: read]");
    expect(result).toContain("/src/index.ts");
    expect(result).toContain("export function main()");
  });

  it("truncates very long tool outputs", () => {
    const longOut = "x".repeat(5_000);
    const result = formatMessagesForObserver([
      makeToolMsg("bash", { cmd: "ls" }, longOut),
    ]);
    expect(result).toContain("[truncated");
    expect(result.length).toBeLessThan(longOut.length + 500);
  });

  it("skips messages with no visible content", () => {
    const emptyMsg = {
      info: {
        id: "m",
        sessionID: "s",
        role: "assistant" as const,
        time: { created: 1 },
      },
      parts: [{ type: "step-finish" as const }],
    } as Parameters<typeof formatMessagesForObserver>[0][number];
    expect(formatMessagesForObserver([emptyMsg])).toBe("");
  });
});

// ─── buildObserverPrompt tests ────────────────────────────────────────────────

describe("buildObserverPrompt", () => {
  it("includes new messages section", () => {
    const msgs = [makeMsg("user", "Use Bun")];
    const prompt = buildObserverPrompt(undefined, msgs);
    expect(prompt).toContain("New Message History to Observe");
    expect(prompt).toContain("Use Bun");
  });

  it("includes existing observations when provided", () => {
    const existing = "Date: Jan 1, 2026\n* 🔴 (09:00) Previous observation";
    const prompt = buildObserverPrompt(existing, [makeMsg("user", "continue")]);
    expect(prompt).toContain("Previous Observations");
    expect(prompt).toContain("Previous observation");
    expect(prompt).toContain("Do not repeat these existing observations");
  });

  it("omits previous observations section when undefined", () => {
    const prompt = buildObserverPrompt(undefined, [makeMsg("user", "start")]);
    expect(prompt).not.toContain("Previous Observations");
  });
});
