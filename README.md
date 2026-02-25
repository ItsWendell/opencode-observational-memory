# opencode-observational-memory

**Status: EXPERIMENTAL**

Persistent, cost-efficient memory for [opencode](https://opencode.ai) using the **observational memory** pattern from [Mastra](https://mastra.ai/docs/memory/observational-memory).

Instead of letting conversations grow until context overflow triggers a full compaction, this plugin runs two lightweight background agents that continuously compress history into a dated, prioritized event log. The log stays stable across turns, which means Anthropic and OpenAI prompt caching hits on every request, cutting costs by **4-10x** for long-running sessions.

Benchmark: **94.87% on LongMemEval** with GPT-4o-mini (Mastra's implementation, same architecture).

## How it works

Two background agents manage the compression pipeline:

**Observer** runs when unobserved message tokens exceed a threshold (default: 30,000). It reads the new messages and produces a compact, dated, emoji-prioritized event log:

```
## 2026-01-15

🔴 User decided to use PostgreSQL for the database layer, ruling out SQLite due to multi-user requirements.
🟡 Created /src/db/schema.ts with User and Post tables using Drizzle ORM.
🟢 Ran bun install to add drizzle-orm and postgres packages.
```

After the Observer runs, the observed messages are **spliced out of the context window** and replaced by the structured memory in the system prompt. A continuation hint is injected so the LLM picks up naturally without noticing the history gap.

**Reflector** runs when the observation log itself gets large (default: 40,000 estimated tokens). It reorganizes the log: merging related entries, removing superseded ones, elevating priority where context demands. The event-based structure is preserved throughout. The Reflector uses 4 escalating compression levels (10/10 detail down to 4/10) and retries if its output is not actually smaller than its input.

The observation log is injected at the top of the system prompt as a **stable cacheable prefix**. Because it only changes when the Observer runs (which is infrequent), prompt caching hits on almost every turn.

### Degenerate output detection

Both agents sample 40% of 200-character windows to detect repetitive output, and check for any single line exceeding 50,000 characters. Degenerate output is discarded; the Observer retries once automatically.

### Why this outperforms compaction

opencode's built-in compaction fires once, at context overflow, and produces a prose summary of the whole conversation. Observational memory:

- Runs earlier and more frequently, at a configurable token threshold
- Produces a structured event log (specific decisions, files, outcomes) rather than a prose summary
- Keeps the context window much smaller on average
- Enables prompt caching on the stable observation prefix (compaction invalidates the cache every time it runs)

## Installation

```bash
npm install opencode-observational-memory
# or
bun add opencode-observational-memory
```

Peer dependency (usually already installed with opencode):

```bash
npm install @opencode-ai/plugin
```

## Usage

### Recommended setup (with cost control)

Create a plugin file, e.g. `~/.config/opencode/memory.ts`:

```ts
import { observationalMemory } from "opencode-observational-memory";

export default observationalMemory({
  // IMPORTANT: Use a cheap small model to avoid expensive Observer/Reflector runs
  model: "anthropic/claude-haiku-4-5-20251001",
  // or "openai/gpt-4o-mini", "google/gemini-2.0-flash-exp", etc.
});
```

Then reference it in your opencode config:

```json
{
  "plugin": ["file:///Users/you/.config/opencode/memory.ts"]
}
```

**Without the `model` config, Observer/Reflector will inherit your session's main model** (e.g., Sonnet 4), which can burn through tokens quickly on long conversations.

### Custom configuration

Create a plugin file, e.g. `~/.config/opencode/memory.ts`:

```ts
import { observationalMemory } from "opencode-observational-memory";

export default observationalMemory({
  // Use a cheap small model for Observer/Reflector (recommended)
  model: "anthropic/claude-haiku-4-5-20251001",

  // Trigger Observer when 20k new tokens accumulate (default: 30k)
  observerThreshold: 20_000,

  // Trigger Reflector when observation log exceeds 30k tokens (default: 40k)
  reflectorThreshold: 30_000,

  // Enable verbose logging
  debug: true,
});
```

Then reference it in your opencode config:

```json
{
  "plugin": ["file:///Users/you/.config/opencode/memory.ts"]
}
```

### Development / local install

Clone and point opencode at the source directly:

```json
{
  "plugin": ["file:///path/to/opencode-observational-memory/src/index.ts"]
}
```

## Configuration reference

```ts
type ObservationalMemoryConfig = {
  /**
   * Token threshold for triggering the Observer agent.
   * When unobserved message tokens exceed this value, Observer runs.
   * Default: 30_000
   */
  observerThreshold?: number;

  /**
   * Token threshold for triggering the Reflector agent.
   * When the observation log exceeds this size (char/4 estimate), Reflector runs.
   * Default: 40_000
   */
  reflectorThreshold?: number;

  /**
   * AI model for Observer and Reflector agents.
   * Format: "<providerID>:<modelID>", e.g. "openai:gpt-4o-mini"
   * Default: inherits the session's current model.
   */
  model?: string;

  /**
   * Fraction of observerThreshold at which background pre-fetching starts.
   * At this fraction the Observer runs in the background so results are ready
   * by the time the session hits 100% of threshold. Must be between 0 and 1.
   * Default: 0.2 (20%)
   */
  prefetchFraction?: number;

  /**
   * Directory where observation logs are persisted per session.
   * Default: <project>/.opencode/observations/
   */
  storageDir?: string;

  /**
   * Custom instructions appended to the Observer system prompt.
   * Use this to tune what the Observer focuses on for your domain.
   */
  observerInstruction?: string;

  /**
   * Custom instructions appended to the Reflector system prompt.
   */
  reflectorInstruction?: string;

  /**
   * Enable verbose debug logging to stdout.
   * Default: false
   */
  debug?: boolean;
};
```

## How observations are stored

Each session gets a JSON file at `.opencode/observations/<sessionID>.json`. The file holds:

- `observations` (string): the raw markdown event log in date-grouped, emoji-prioritized format
- `currentTask` (string, optional): the last `<current-task>` extracted from the Observer, re-injected on next turn for continuity
- `suggestedResponse` (string, optional): the last `<suggested-response>` from the Observer
- `lastObservedMessageIndex` (number): tracks which messages have already been observed
- `lastObservedAt`, `lastReflectedAt` (unix ms): timestamps of last agent runs

Observations persist across opencode restarts. You can commit `.opencode/observations/` to share session memory across machines, or add it to `.gitignore` to keep it local.

## Plugin hooks used

| Hook                                   | Purpose                                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `experimental.chat.system.transform`   | Injects a context-optimized observation log as a stable cacheable system prompt prefix                                            |
| `experimental.chat.messages.transform` | Counts unobserved tokens, runs Observer, splices observed messages out, injects continuation hint, runs Reflector if log is large |
| `experimental.session.compacting`      | Injects the observation log into opencode's native compaction context so the compaction summary is observation-aware              |

The context-optimized version injected into the system prompt strips `🟡`/`🟢` lines and `->` arrows to reduce tokens on each turn, while the full rich format is kept on disk.

## Project structure

```
src/
  index.ts     Plugin factory and hook implementations
  agents.ts    runObserver / runReflector orchestration; callViaOpencode routing
  observer.ts  Observer prompts, message formatting, XML parsing, degenerate detection
  reflector.ts Reflector prompts (4-level compression), XML parsing, compression validation
  storage.ts   Disk persistence (readMemory, writeMemory, estimateTokens)
  types.ts     Shared TypeScript types
  tests/
    agents.test.ts    Observer/Reflector orchestration with mock client
    observer.test.ts  Prompt building, parsing, degenerate detection, context optimization
    storage.test.ts   Disk read/write, token estimation
```

## Development

```bash
git clone https://github.com/wmisiedjan/opencode-observational-memory
cd opencode-observational-memory
bun install
bun test
```

## Credits

This plugin is closely based on the **observational memory** pattern from [Mastra](https://mastra.ai/docs/memory/observational-memory). We adapted their architecture, prompts, and compression strategy for opencode's plugin system.

## Prior art and references

- [Mastra observational memory docs](https://mastra.ai/docs/memory/observational-memory) — the foundational architecture and design
- [Mastra source on GitHub](https://github.com/mastra-ai/mastra/tree/main/packages/memory/src/processors/observational-memory) — reference implementation
- [VentureBeat: "Observational memory cuts AI agent costs 10x"](https://venturebeat.com/data/observational-memory-cuts-ai-agent-costs-10x-and-outscores-rag-on-long) — research and benchmarks
- [opencode plugin API](https://github.com/sst/opencode/tree/dev/packages/plugin) — opencode plugin system

## License

MIT
