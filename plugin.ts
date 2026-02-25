import { observationalMemory } from "/Users/wmisiedjan/Projects/opencode-observational-memory/src/index.ts";

export default observationalMemory({
  debug: true,
  // Use a cheap small model for Observer/Reflector to save costs
  model: "anthropic/claude-haiku-4-5-20251001",
  // Lower thresholds for quick manual testing (default is 30k/40k)
  // observerThreshold: 5_000,
});
