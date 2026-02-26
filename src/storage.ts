import path from "path";
import fs from "fs/promises";
import type { SessionMemory, ObservationGroup } from "./types.js";
import { serializeObservations } from "./observer.js";

const DEFAULT_MEMORY: SessionMemory = {
  observations: [],
  lastObservedMessageIndex: -1,
  lastObservedTokens: 0,
  lastObservedAt: 0,
  lastReflectedAt: 0,
};

/**
 * Reads the persisted memory for a session from disk.
 * Returns a fresh default if no file exists yet.
 * 
 * Handles migration: if observations is a string (legacy format),
 * it's treated as empty for structured output mode.
 */
export async function readMemory(
  storageDir: string,
  sessionID: string,
): Promise<SessionMemory> {
  const file = memoryPath(storageDir, sessionID);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const data = JSON.parse(raw) as SessionMemory;
    
    // Migration: if observations is still a string, convert to empty array
    if (typeof data.observations === "string") {
      console.warn(
        `[observational-memory] Migrating legacy string observations for session ${sessionID}`
      );
      return {
        ...data,
        observations: [],
      };
    }
    
    return data;
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

/**
 * Writes the memory for a session to disk atomically (write-then-rename).
 */
export async function writeMemory(
  storageDir: string,
  sessionID: string,
  memory: SessionMemory,
): Promise<void> {
  const file = memoryPath(storageDir, sessionID);
  const tmp = file + ".tmp";
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(memory, null, 2), "utf-8");
  await fs.rename(tmp, file);
}

/**
 * Estimates the token count of an observations string.
 * Uses the 4-chars-per-token heuristic — fast and provider-agnostic.
 * Mastra uses tiktoken; we keep it simple since we only use this for
 * the reflector threshold check, not for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimates the token count of structured observation groups.
 * Serializes to text and applies the 4-chars-per-token heuristic.
 */
export function estimateObservationTokens(
  groups: ObservationGroup[],
): number {
  const text = serializeObservations(groups);
  return estimateTokens(text);
}

function memoryPath(storageDir: string, sessionID: string) {
  return path.join(storageDir, sessionID + ".json");
}
