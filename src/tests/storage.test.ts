import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { readMemory, writeMemory, estimateTokens } from "../storage.js";
import type { SessionMemory } from "../types.js";

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
    expect(mem.observations).toBe("");
    expect(mem.lastObservedTokens).toBe(0);
    expect(mem.lastObservedAt).toBe(0);
    expect(mem.lastReflectedAt).toBe(0);
    expect(mem.lastObservedMessageIndex).toBe(-1);
  });

  it("round-trips memory through write and read", async () => {
    const memory: SessionMemory = {
      observations:
        "Date: Jan 1, 2026\n* 🔴 (12:00) User wants PostgreSQL\n* 🟡 (12:05) Created schema.ts",
      currentTask: "Set up the database schema",
      suggestedResponse: "Continue with migrations",
      lastObservedMessageIndex: 5,
      lastObservedTokens: 15000,
      lastObservedAt: 1000000,
      lastReflectedAt: 0,
    };

    await writeMemory(tmpDir, "session-abc", memory);
    const loaded = await readMemory(tmpDir, "session-abc");

    expect(loaded.observations).toContain("User wants PostgreSQL");
    expect(loaded.observations).toContain("Created schema.ts");
    expect(loaded.currentTask).toBe("Set up the database schema");
    expect(loaded.suggestedResponse).toBe("Continue with migrations");
    expect(loaded.lastObservedMessageIndex).toBe(5);
    expect(loaded.lastObservedTokens).toBe(15000);
  });

  it("creates nested directories automatically", async () => {
    const nested = path.join(tmpDir, "a", "b", "c");
    const memory: SessionMemory = {
      observations: "",
      lastObservedMessageIndex: -1,
      lastObservedTokens: 0,
      lastObservedAt: 0,
      lastReflectedAt: 0,
    };
    await writeMemory(nested, "session-xyz", memory);
    const loaded = await readMemory(nested, "session-xyz");
    expect(loaded.observations).toBe("");
  });

  it("overwrites existing memory correctly", async () => {
    const first: SessionMemory = {
      observations: "Date: Jan 1, 2026\n* 🔴 (00:00) First observation",
      lastObservedMessageIndex: 2,
      lastObservedTokens: 100,
      lastObservedAt: 1,
      lastReflectedAt: 0,
    };
    const second: SessionMemory = {
      observations: "Date: Jan 2, 2026\n* 🔴 (00:00) Updated observation",
      lastObservedMessageIndex: 4,
      lastObservedTokens: 200,
      lastObservedAt: 2,
      lastReflectedAt: 1,
    };

    await writeMemory(tmpDir, "session-overwrite", first);
    await writeMemory(tmpDir, "session-overwrite", second);

    const loaded = await readMemory(tmpDir, "session-overwrite");
    expect(loaded.observations).toContain("Updated observation");
    expect(loaded.observations).not.toContain("First observation");
    expect(loaded.lastObservedTokens).toBe(200);
    expect(loaded.lastObservedMessageIndex).toBe(4);
  });

  it("preserves undefined optional fields", async () => {
    const memory: SessionMemory = {
      observations: "",
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
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates tokens at ~4 chars per token", () => {
    // 400 chars → 100 tokens
    expect(estimateTokens("A".repeat(400))).toBe(100);
  });

  it("rounds up partial tokens", () => {
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens("hello")).toBe(2);
  });

  it("scales with string length", () => {
    const short = estimateTokens("short text");
    const long = estimateTokens("short text".repeat(10));
    expect(long).toBeGreaterThan(short);
  });
});
