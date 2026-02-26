import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  readMemory,
  writeMemory,
  estimateTokens,
  parseLegacyObservations,
} from "../storage.js";
import type { SessionMemory, ObservationGroup } from "../types.js";

// ─── Mock observation data ───────────────────────────────────────────────────

const MOCK_OBSERVATIONS: ObservationGroup[] = [
  {
    date: "Jan 1, 2026",
    entries: [
      {
        priority: "high",
        time: "12:00",
        text: "User wants PostgreSQL",
      },
      {
        priority: "medium",
        time: "12:05",
        text: "Created schema.ts",
      },
    ],
  },
];

describe("storage", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "obs-memory-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns default memory when no file exists", async () => {
    const mem = await readMemory(tmpDir, "session-123");
    expect(mem.observations).toEqual([]);
    expect(mem.lastObservedTokens).toBe(0);
    expect(mem.lastObservedAt).toBe(0);
    expect(mem.lastReflectedAt).toBe(0);
    expect(mem.lastObservedMessageIndex).toBe(-1);
  });

  it("round-trips memory through write and read", async () => {
    const memory: SessionMemory = {
      observations: MOCK_OBSERVATIONS,
      currentTask: "Set up the database schema",
      suggestedResponse: "Continue with migrations",
      lastObservedMessageIndex: 5,
      lastObservedTokens: 15000,
      lastObservedAt: 1000000,
      lastReflectedAt: 0,
    };

    await writeMemory(tmpDir, "session-abc", memory);
    const loaded = await readMemory(tmpDir, "session-abc");

    expect(loaded.observations.length).toBe(1);
    expect(loaded.observations[0].date).toBe("Jan 1, 2026");
    expect(loaded.observations[0].entries[0].text).toContain("PostgreSQL");
    expect(loaded.observations[0].entries[1].text).toContain("schema.ts");
    expect(loaded.currentTask).toBe("Set up the database schema");
    expect(loaded.suggestedResponse).toBe("Continue with migrations");
    expect(loaded.lastObservedMessageIndex).toBe(5);
    expect(loaded.lastObservedTokens).toBe(15000);
  });

  it("creates nested directories automatically", async () => {
    const nested = path.join(tmpDir, "a", "b", "c");
    const memory: SessionMemory = {
      observations: [],
      lastObservedMessageIndex: -1,
      lastObservedTokens: 0,
      lastObservedAt: 0,
      lastReflectedAt: 0,
    };
    await writeMemory(nested, "session-xyz", memory);
    const loaded = await readMemory(nested, "session-xyz");
    expect(loaded.observations).toEqual([]);
  });

  it("overwrites existing memory correctly", async () => {
    const first: SessionMemory = {
      observations: [
        {
          date: "Jan 1, 2026",
          entries: [
            { priority: "high", time: "00:00", text: "First observation" },
          ],
        },
      ],
      lastObservedMessageIndex: 2,
      lastObservedTokens: 100,
      lastObservedAt: 1,
      lastReflectedAt: 0,
    };
    const second: SessionMemory = {
      observations: [
        {
          date: "Jan 2, 2026",
          entries: [
            { priority: "high", time: "00:00", text: "Updated observation" },
          ],
        },
      ],
      lastObservedMessageIndex: 4,
      lastObservedTokens: 200,
      lastObservedAt: 2,
      lastReflectedAt: 1,
    };

    await writeMemory(tmpDir, "session-overwrite", first);
    await writeMemory(tmpDir, "session-overwrite", second);

    const loaded = await readMemory(tmpDir, "session-overwrite");
    expect(loaded.observations[0].entries[0].text).toContain("Updated");
    expect(loaded.observations.length).toBe(1);
    expect(loaded.lastObservedTokens).toBe(200);
    expect(loaded.lastObservedMessageIndex).toBe(4);
  });

  it("preserves undefined optional fields", async () => {
    const memory: SessionMemory = {
      observations: [],
      lastObservedMessageIndex: -1,
      lastObservedTokens: 0,
      lastObservedAt: 0,
      lastReflectedAt: 0,
    };
    await writeMemory(tmpDir, "session-optional", memory);
    const loaded = await readMemory(tmpDir, "session-optional");
    expect(loaded.currentTask).toBeUndefined();
    expect(loaded.suggestedResponse).toBeUndefined();
  });

  it("migrates legacy string observations to structured format", async () => {
    // Write a legacy-format memory file (observations as string)
    const legacyMemory = {
      observations:
        "Date: Jan 1, 2026\n* 🔴 (12:00) User wants PostgreSQL\n* 🟡 (12:05) Created schema.ts",
      lastObservedMessageIndex: 5,
      lastObservedTokens: 15000,
      lastObservedAt: 1000000,
      lastReflectedAt: 0,
    };
    const file = path.join(tmpDir, "session-legacy.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(legacyMemory), "utf-8");

    const loaded = await readMemory(tmpDir, "session-legacy");
    expect(Array.isArray(loaded.observations)).toBe(true);
    expect(loaded.observations.length).toBe(1);
    expect(loaded.observations[0].date).toBe("Jan 1, 2026");
    expect(loaded.observations[0].entries[0].priority).toBe("high");
    expect(loaded.observations[0].entries[0].text).toContain("PostgreSQL");
    expect(loaded.observations[0].entries[1].priority).toBe("medium");
    expect(loaded.observations[0].entries[1].text).toContain("schema.ts");
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates tokens at ~4 chars per token", () => {
    expect(estimateTokens("A".repeat(400))).toBe(100);
  });

  it("rounds up partial tokens", () => {
    expect(estimateTokens("hello")).toBe(2);
  });

  it("scales with string length", () => {
    const short = estimateTokens("short text");
    const long = estimateTokens("short text".repeat(10));
    expect(long).toBeGreaterThan(short);
  });
});

describe("parseLegacyObservations", () => {
  it("parses date-grouped observations", () => {
    const text =
      "Date: Jan 1, 2026\n* 🔴 (14:30) User prefers Bun\n* 🟡 (14:31) Created index.ts";
    const groups = parseLegacyObservations(text);
    expect(groups.length).toBe(1);
    expect(groups[0].date).toBe("Jan 1, 2026");
    expect(groups[0].entries.length).toBe(2);
    expect(groups[0].entries[0].priority).toBe("high");
    expect(groups[0].entries[0].time).toBe("14:30");
    expect(groups[0].entries[1].priority).toBe("medium");
  });

  it("parses child entries", () => {
    const text =
      "Date: Jan 1, 2026\n* 🟡 (14:30) Agent browsed files\n  * -> viewed auth.ts\n  * -> viewed users.ts";
    const groups = parseLegacyObservations(text);
    expect(groups[0].entries[0].children?.length).toBe(2);
    expect(groups[0].entries[0].children?.[0].text).toContain("auth.ts");
  });

  it("handles multiple date groups", () => {
    const text =
      "Date: Jan 1, 2026\n* 🔴 (09:00) Day 1\n\nDate: Jan 2, 2026\n* 🔴 (09:00) Day 2";
    const groups = parseLegacyObservations(text);
    expect(groups.length).toBe(2);
    expect(groups[0].date).toBe("Jan 1, 2026");
    expect(groups[1].date).toBe("Jan 2, 2026");
  });

  it("handles green emoji as low priority", () => {
    const text = "Date: Jan 1, 2026\n* 🟢 (09:00) Minor detail";
    const groups = parseLegacyObservations(text);
    expect(groups[0].entries[0].priority).toBe("low");
  });

  it("captures unrecognized lines as high-priority entries", () => {
    const text = "Some random text without emojis";
    const groups = parseLegacyObservations(text);
    expect(groups.length).toBe(1);
    expect(groups[0].entries[0].priority).toBe("high");
    expect(groups[0].entries[0].text).toContain("Some random text");
  });

  it("returns empty array for empty string", () => {
    expect(parseLegacyObservations("")).toEqual([]);
  });
});
