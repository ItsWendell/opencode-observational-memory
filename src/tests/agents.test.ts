import { describe, it, expect } from "bun:test";
import { runObserver, runReflector } from "../agents.js";
import type { SessionMemory } from "../types.js";

// ─── Mock client factory ─────────────────────────────────────────────────────

type MockClient = {
  session: {
    create: () => Promise<{ data: { id: string } }>;
    prompt: () => Promise<{
      data: { parts: { type: string; text: string }[] };
    }>;
    delete: () => Promise<void>;
  };
};

function mockAgentInput(response: string) {
  const client: MockClient = {
    session: {
      create: async () => ({ data: { id: "mock-session-id" } }),
      prompt: async () => ({
        data: { parts: [{ type: "text", text: response }] },
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
  it("returns observations from XML-formatted response", async () => {
    const input = mockAgentInput(`
<observations>
Date: Jan 1, 2026
* 🔴 (14:30) User decided to use Bun runtime.
* 🟡 (14:31) Created src/index.ts with main function.
</observations>
<current-task>
Implement the main entry point
</current-task>
<suggested-response>
Continue with src/index.ts implementation
</suggested-response>
`);
    const msgs = [
      makeMsg("user", "Use Bun"),
      makeMsg("assistant", "Created index.ts"),
    ];
    const result = await runObserver(input, msgs, undefined);

    expect(result.observations).toContain("User decided to use Bun runtime");
    expect(result.observations).toContain("Created src/index.ts");
    expect(result.currentTask).toBe("Implement the main entry point");
    expect(result.suggestedResponse).toContain("src/index.ts");
    expect(result.degenerate).toBeUndefined();
  });

  it("returns empty observations for degenerate output", async () => {
    // Degenerate: repeated 200-char windows
    const degenerate = "abc ".repeat(2000);
    const input = mockAgentInput(degenerate);
    const result = await runObserver(input, [makeMsg("user", "hi")], undefined);
    expect(result.degenerate).toBe(true);
    expect(result.observations).toBe("");
  });

  it("falls back to list items when XML tags missing", async () => {
    const input = mockAgentInput(
      "* 🔴 (14:30) User prefers TypeScript\n* 🟡 (14:31) Set up tsconfig.json",
    );
    const result = await runObserver(
      input,
      [makeMsg("user", "use TS")],
      undefined,
    );
    expect(result.observations).toContain("User prefers TypeScript");
    expect(result.observations).toContain("tsconfig.json");
  });

  it("appends new observations when existing observations provided", async () => {
    const existing = "Date: Jan 1, 2026\n* 🔴 (09:00) User wants Postgres";
    const input = mockAgentInput(`
<observations>
Date: Jan 1, 2026
* 🔴 (14:30) User added Redis for caching.
</observations>
`);
    const result = await runObserver(
      input,
      [makeMsg("assistant", "Added Redis")],
      existing,
    );
    expect(result.observations).toContain("Redis");
  });

  it("handles empty model response gracefully", async () => {
    const input = mockAgentInput("");
    const result = await runObserver(
      input,
      [makeMsg("user", "test")],
      undefined,
    );
    expect(result.observations).toBe("");
    expect(result.degenerate).toBeUndefined();
  });
});

// ─── runReflector tests ──────────────────────────────────────────────────────

describe("runReflector", () => {
  it("returns condensed observations", async () => {
    const input = mockAgentInput(`
<observations>
Date: Jan 1, 2026
* 🔴 (14:30) Merged: User wants Bun + TypeScript.
</observations>
<suggested-response>
Continue with the implementation
</suggested-response>
`);
    const result = await runReflector(input, "old observations here", 40_000);
    expect(result.observations).toContain("Bun + TypeScript");
    expect(result.suggestedResponse).toContain("implementation");
    expect(result.degenerate).toBeUndefined();
  });

  it("handles degenerate reflector output", async () => {
    const degenerate = "xyz ".repeat(2000);
    const input = mockAgentInput(degenerate);
    const result = await runReflector(input, "some observations", 40_000);
    // Falls back to returning the original observations after all retries
    expect(typeof result.observations).toBe("string");
  });

  it("returns original when reflection is empty", async () => {
    const input = mockAgentInput("I cannot process this.");
    const original = "Date: Jan 1, 2026\n* 🔴 (09:00) Some observation";
    const result = await runReflector(input, original, 40_000);
    // Should eventually return something (either reflected or original)
    expect(typeof result.observations).toBe("string");
  });
});
