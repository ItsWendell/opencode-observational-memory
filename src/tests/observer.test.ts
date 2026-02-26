import { describe, it, expect } from "bun:test";
import {
  detectDegenerateRepetition,
  optimizeForContext,
  formatMessagesForObserver,
  buildObserverPrompt,
  serializeObservations,
  mergeObservationGroups,
} from "../observer.js";
import type { ObservationGroup } from "../types.js";

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

// ─── Mock observation data ───────────────────────────────────────────────────

const MOCK_GROUPS: ObservationGroup[] = [
  {
    date: "Jan 1, 2026",
    entries: [
      {
        priority: "high",
        time: "14:30",
        text: "User decided to use Bun runtime",
      },
      {
        priority: "medium",
        time: "14:31",
        text: "Created src/index.ts with main function",
      },
    ],
  },
];

const MOCK_GROUPS_WITH_CHILDREN: ObservationGroup[] = [
  {
    date: "Jan 1, 2026",
    entries: [
      {
        priority: "medium",
        time: "14:32",
        text: "Agent browsed auth source files",
        children: [
          { text: "viewed src/auth.ts — found token validation logic" },
          { text: "viewed src/users.ts — found user lookup by email" },
        ],
      },
    ],
  },
];

// ─── serializeObservations tests ─────────────────────────────────────────────

describe("serializeObservations", () => {
  it("returns empty string for empty array", () => {
    expect(serializeObservations([])).toBe("");
  });

  it("serializes basic observations with priority emojis", () => {
    const result = serializeObservations(MOCK_GROUPS);
    expect(result).toContain("Date: Jan 1, 2026");
    expect(result).toContain("🔴 (14:30) User decided to use Bun runtime");
    expect(result).toContain("🟡 (14:31) Created src/index.ts");
  });

  it("serializes children with arrow indicators", () => {
    const result = serializeObservations(MOCK_GROUPS_WITH_CHILDREN);
    expect(result).toContain("Agent browsed auth source files");
    expect(result).toContain("  * -> viewed src/auth.ts");
    expect(result).toContain("  * -> viewed src/users.ts");
  });

  it("serializes low priority with green emoji", () => {
    const groups: ObservationGroup[] = [
      {
        date: "Jan 1, 2026",
        entries: [{ priority: "low", time: "09:00", text: "Minor detail" }],
      },
    ];
    const result = serializeObservations(groups);
    expect(result).toContain("🟢 (09:00) Minor detail");
  });
});

// ─── optimizeForContext tests ─────────────────────────────────────────────────

describe("optimizeForContext", () => {
  it("removes 🟡 and 🟢 but keeps 🔴", () => {
    const groups: ObservationGroup[] = [
      {
        date: "Jan 1, 2026",
        entries: [
          { priority: "high", time: "09:00", text: "Critical" },
          { priority: "medium", time: "09:01", text: "Medium" },
          { priority: "low", time: "09:02", text: "Low" },
        ],
      },
    ];
    const result = optimizeForContext(groups);
    expect(result).toContain("🔴");
    expect(result).not.toContain("🟡");
    expect(result).not.toContain("🟢");
  });

  it("replaces arrow indicators with spaces", () => {
    const result = optimizeForContext(MOCK_GROUPS_WITH_CHILDREN);
    expect(result).not.toContain("->");
    expect(result).toContain("viewed src/auth.ts");
  });

  it("returns empty string for empty observations", () => {
    expect(optimizeForContext([])).toBe("");
  });
});

// ─── mergeObservationGroups tests ────────────────────────────────────────────

describe("mergeObservationGroups", () => {
  it("merges entries from the same date", () => {
    const a: ObservationGroup[] = [
      {
        date: "Jan 1, 2026",
        entries: [{ priority: "high", time: "09:00", text: "First" }],
      },
    ];
    const b: ObservationGroup[] = [
      {
        date: "Jan 1, 2026",
        entries: [{ priority: "high", time: "10:00", text: "Second" }],
      },
    ];
    const merged = mergeObservationGroups(a, b);
    expect(merged.length).toBe(1);
    expect(merged[0].entries.length).toBe(2);
    expect(merged[0].entries[0].text).toBe("First");
    expect(merged[0].entries[1].text).toBe("Second");
  });

  it("preserves separate dates", () => {
    const a: ObservationGroup[] = [
      {
        date: "Jan 1, 2026",
        entries: [{ priority: "high", time: "09:00", text: "Day 1" }],
      },
    ];
    const b: ObservationGroup[] = [
      {
        date: "Jan 2, 2026",
        entries: [{ priority: "high", time: "09:00", text: "Day 2" }],
      },
    ];
    const merged = mergeObservationGroups(a, b);
    expect(merged.length).toBe(2);
    expect(merged[0].date).toBe("Jan 1, 2026");
    expect(merged[1].date).toBe("Jan 2, 2026");
  });

  it("handles empty arrays", () => {
    expect(mergeObservationGroups([], []).length).toBe(0);
    expect(mergeObservationGroups(MOCK_GROUPS, []).length).toBe(1);
    expect(mergeObservationGroups([], MOCK_GROUPS).length).toBe(1);
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
    const repeated = "* 🔴 (09:00) User wants something. ".repeat(200);
    expect(detectDegenerateRepetition(repeated)).toBe(true);
  });

  it("detects single extremely long lines", () => {
    const giant = "x".repeat(55_000);
    expect(detectDegenerateRepetition(giant)).toBe(true);
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
    const prompt = buildObserverPrompt(MOCK_GROUPS, [
      makeMsg("user", "continue"),
    ]);
    expect(prompt).toContain("Previous Observations");
    expect(prompt).toContain("User decided to use Bun runtime");
    expect(prompt).toContain("Do not repeat these existing observations");
  });

  it("omits previous observations section when undefined", () => {
    const prompt = buildObserverPrompt(undefined, [makeMsg("user", "start")]);
    expect(prompt).not.toContain("Previous Observations");
  });

  it("omits previous observations section when empty array", () => {
    const prompt = buildObserverPrompt([], [makeMsg("user", "start")]);
    expect(prompt).not.toContain("Previous Observations");
  });
});
