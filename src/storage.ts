import path from "path";
import fs from "fs/promises";
import type {
  SessionMemory,
  ObservationGroup,
  ObservationEntry,
} from "./types.js";
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
 * Transparently migrates legacy string-format observations to the new
 * structured ObservationGroup[] format.
 */
export async function readMemory(
  storageDir: string,
  sessionID: string,
): Promise<SessionMemory> {
  const file = memoryPath(storageDir, sessionID);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const data = JSON.parse(raw);

    // ── Migration: string observations → structured array ──
    if (typeof data.observations === "string") {
      data.observations = data.observations.trim()
        ? parseLegacyObservations(data.observations)
        : [];
    } else if (!Array.isArray(data.observations)) {
      data.observations = [];
    }

    return data as SessionMemory;
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
 * Estimates the token count of a text string.
 * Uses the 4-chars-per-token heuristic — fast and provider-agnostic.
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
  return estimateTokens(serializeObservations(groups));
}

function memoryPath(storageDir: string, sessionID: string) {
  return path.join(storageDir, sessionID + ".json");
}

// ─── Legacy migration ────────────────────────────────────────────────────────

/**
 * Parses legacy markdown-format observations into structured ObservationGroup[].
 *
 * Handles the format:
 *   Date: Dec 4, 2025
 *   * 🔴 (14:30) User prefers direct answers
 *   * 🟡 (14:32) Agent browsed auth source files
 *     * -> viewed src/auth.ts — found token validation logic
 *
 * Best-effort: entries that don't match the expected pattern are captured
 * as high-priority text entries to avoid losing information.
 */
export function parseLegacyObservations(text: string): ObservationGroup[] {
  const groups: ObservationGroup[] = [];
  let currentGroup: ObservationGroup | null = null;

  for (const line of text.split("\n")) {
    // Date header
    const dateMatch = line.match(/^Date:\s*(.+)/);
    if (dateMatch) {
      currentGroup = { date: dateMatch[1].trim(), entries: [] };
      groups.push(currentGroup);
      continue;
    }

    // Observation entry: * 🔴 (14:30) text...
    const entryMatch = line.match(
      /^\*\s*(🔴|🟡|🟢)\s*\((\d{1,2}:\d{2})\)\s*(.*)/,
    );
    if (entryMatch) {
      if (!currentGroup) {
        currentGroup = { date: "Unknown", entries: [] };
        groups.push(currentGroup);
      }
      const priority: ObservationEntry["priority"] =
        entryMatch[1] === "🔴"
          ? "high"
          : entryMatch[1] === "🟡"
            ? "medium"
            : "low";
      currentGroup.entries.push({
        priority,
        time: entryMatch[2],
        text: entryMatch[3].trim(),
      });
      continue;
    }

    // Child entry:   * -> text...  or   * text...
    const childMatch = line.match(/^\s+\*\s*(?:->)?\s*(.*)/);
    if (childMatch && currentGroup?.entries.length) {
      const lastEntry =
        currentGroup.entries[currentGroup.entries.length - 1];
      if (!lastEntry.children) lastEntry.children = [];
      lastEntry.children.push({ text: childMatch[1].trim() });
      continue;
    }

    // Non-empty unrecognized lines — capture as entry to avoid data loss
    const trimmed = line.trim();
    if (trimmed && trimmed !== "---") {
      if (!currentGroup) {
        currentGroup = { date: "Unknown", entries: [] };
        groups.push(currentGroup);
      }
      currentGroup.entries.push({
        priority: "high",
        time: "00:00",
        text: trimmed,
      });
    }
  }

  return groups;
}
