import { describe, it, expect } from "bun:test";
import { runObserver, runReflector } from "../agents.js";
import type { ObservationGroup } from "../types.js";
import { serializeObservations } from "../observer.js";

// ─── Mock observation data ───────────────────────────────────────────────────

const MOCK_OBSERVER_RESULT = {
  observations: [
    {
      date: "Jan 1, 2026",
      entries: [
        {
          priority: "high" as const,
          time: "14:30",
          text: "User decided to use Bun runtime",
        },
        {
          priority: "medium" as const,
          time: "14:31",
          text: "Created src/index.ts with main function",
        },
      ],
    },
  ],
  currentTask: "Implement the main entry point",
  suggestedResponse: "Continue with src/index.ts implementation",
};

const MOCK_REFLECTOR_RESULT = {
  observations: [
    {
      date: "Jan 1, 2026",
      entries: [
        {
          priority: "high" as const,
          time: "14:30",
          text: "Merged: User wants Bun + TypeScript",
        },
      ],
    },
  ],
  suggestedResponse: "Continue with the implementation",
};

// ─── Mock client factory ─────────────────────────────────────────────────────

function mockAgentInput(structuredResponse: unknown) {
  const client = {
    session: {
      create: async () => ({ data: { id: "mock-session-id" } }),
      prompt: async () => ({
        data: {
          info: {
            structured: structuredResponse,
          },
          parts: [],
        },
      }),
      delete: async () => {},
    },
  };
  return {
    client: client as unknown as Parameters<typeof runObserver>[0]["client"],
    directory: "/tmp",
    parentSessionID: "parent-session-id",
  };
}

// ─── Minimal message fixture ─────────────────────────────────────────────────

function makeMsg(role: "user" | "assistant", text: string) {
  return {
    info: {
      id: `msg-${role}`,
      sessionID: "sess-1",
      role,
      time: { created: Date.now() },
    },
    parts: [{ type: "text" as const, text }],
  } as unknown as Parameters<typeof runObserver>[1][number];
}

// ─── runObserver tests ───────────────────────────────────────────────────────

describe("runObserver", () => {
  it("returns structured observations from LLM", async () => {
    const input = mockAgentInput(MOCK_OBSERVER_RESULT);
    const msgs = [
      makeMsg("user", "Use Bun"),
      makeMsg("assistant", "Created index.ts"),
    ];
    const result = await runObserver(input, msgs, undefined);

    expect(result.observations.length).toBe(1);
    expect(result.observations[0].date).toBe("Jan 1, 2026");
    expect(result.observations[0].entries.length).toBe(2);
    expect(result.observations[0].entries[0].text).toContain("Bun runtime");
    expect(result.currentTask).toBe("Implement the main entry point");
    expect(result.suggestedResponse).toContain("src/index.ts");
    expect(result.degenerate).toBeUndefined();
  });

  it("returns empty observations when structured output is null", async () => {
    const input = mockAgentInput(null);
    const result = await runObserver(input, [makeMsg("user", "hi")], undefined);
    expect(result.degenerate).toBe(true);
    expect(result.observations).toEqual([]);
  });

  it("handles empty observations array", async () => {
    const input = mockAgentInput({ observations: [] });
    const result = await runObserver(
      input,
      [makeMsg("user", "test")],
      undefined,
    );
    expect(result.observations).toEqual([]);
    // Empty observations should not be treated as degenerate
  });

  it("passes existing observations to the prompt", async () => {
    const existing: ObservationGroup[] = [
      {
        date: "Jan 1, 2026",
        entries: [
          { priority: "high", time: "09:00", text: "User wants Postgres" },
        ],
      },
    ];
    const input = mockAgentInput({
      observations: [
        {
          date: "Jan 1, 2026",
          entries: [
            {
              priority: "high",
              time: "14:30",
              text: "User added Redis for caching",
            },
          ],
        },
      ],
    });
    const result = await runObserver(
      input,
      [makeMsg("assistant", "Added Redis")],
      existing,
    );
    expect(result.observations[0].entries[0].text).toContain("Redis");
  });
});

// ─── runReflector tests ──────────────────────────────────────────────────────

describe("runReflector", () => {
  it("returns condensed observations", async () => {
    const input = mockAgentInput(MOCK_REFLECTOR_RESULT);
    const observations: ObservationGroup[] = [
      {
        date: "Jan 1, 2026",
        entries: [
          { priority: "high", time: "14:30", text: "User wants Bun" },
          { priority: "high", time: "14:31", text: "User wants TypeScript" },
        ],
      },
    ];
    const result = await runReflector(input, observations, 40_000);
    expect(result.observations[0].entries[0].text).toContain("Bun + TypeScript");
    expect(result.suggestedResponse).toContain("implementation");
    expect(result.degenerate).toBeUndefined();
  });

  it("returns original when structured output fails", async () => {
    const input = mockAgentInput(null);
    const observations: ObservationGroup[] = [
      {
        date: "Jan 1, 2026",
        entries: [
          { priority: "high", time: "09:00", text: "Some observation" },
        ],
      },
    ];
    const result = await runReflector(input, observations, 40_000);
    // Should fall back to returning original observations
    expect(result.observations.length).toBeGreaterThan(0);
  });
});
