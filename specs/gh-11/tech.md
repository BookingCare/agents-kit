# ContextManager — token budget and context window management - Tech Spec

## Problem

The agent loop accumulates `messages` without limit. Before each LLM call, there is no token estimation or budget checking. When the context window overflows, the LLM provider returns a 4xx error, wasting the API call. We need to:

1. Approximate token count from the message list before each stream call
2. Compare against a configurable budget
3. Trim messages via a pluggable strategy when over budget
4. Emit an event notifying consumers about the trim

## Relevant code

### packages/agent/src/types.ts

- `AgentMessage` (line ~148): Alias for `Message` from `@bookingcare/ai` — has `role`, `content`, optional `timestamp`
- `AgentContext` (line ~178): `{ systemPrompt: string; messages: AgentMessage[]; tools: AgentTool[] }`
- `AgentLoopConfig` (line ~81): Loop configuration including `convertToLlm`, `transformContext`, `maxTokens`
- `AgentEvent` (line ~169): Current events — need to add `context_trimmed`

### packages/agent/src/agent-loop.ts

- `loop()` (line ~234): Core loop that builds `llmMessages` and calls `streamFn()`
- Line ~264: `llmMessages` assembly — `messages` are converted via `convertToLlm` and system prompt is prepended
- Line ~288: `streamFn(config.model, { messages: llmMessages, tools }, options)` — the actual LLM call
- `executeToolCalls()`: Appends tool result messages to `messages`
- `transformContext` (line ~102 in AgentLoopConfig): Optional context transformation hook existing on AgentLoopConfig

### packages/agent/src/agent.ts

- `Agent` class (line ~185-end): Main class
- `subscribe()` (line ~338): Event listener registration — will need to emit new `context_trimmed` event
- `processEvents` (line ~627): Event type handling — add `context_trimmed` case
- `createContextSnapshot()` (line ~526): Builds `AgentContext` from current state

### packages/ai/src/types.ts

- `Message` / `UserMessage` / `AssistantMessage` / `ToolResultMessage` / `SystemMessage`: Content structures

## Current state

### Message accumulation

The loop appends to `messages` at three points:

1. `message_end`: adds assistant message (line ~214 in agent-loop.ts)
2. `toolResults`: adds tool result messages per tool call (loop line ~226-228)
3. `steering` / `followUp` queues: adds injected user messages (loop line ~237-244)

The `messages` array grows monotonically across iterations.

### Context transformation

`AgentLoopConfig.transformContext` exists on the config type (types.ts line ~102) but is **not currently invoked** in `agent-loop.ts`. The spec proposes adding this call as part of the ContextManager integration, running it after `prepareMessages` and before `convertToLlm`.

### No token tracking

No token counting happens before LLM calls. After each call, the `usage` field on the assistant message tracks `inputTokens`/`outputTokens`, but there's no proactive budget management.

## Proposed changes

### New types (packages/agent/src/types.ts)

Add after `AgentEvent` definition:

```typescript
export interface ContextStrategy {
  name: string;
  apply(messages: AgentMessage[], budget: number, tokenCounter: TokenCounter): AgentMessage[];
}

export interface TokenCounter {
  count(messages: AgentMessage[]): number;
}

export interface ContextTrimmedEvent {
  type: "context_trimmed";
  droppedMessages: number;
  remainingMessages: number;
  budget: number;
  tokenCountBefore: number;
  tokenCountAfter: number;
  strategyName: string;
}
```

Update `AgentEvent` union to include `ContextTrimmedEvent`.

### Config (packages/agent/src/types.ts)

Add `contextManager` to `AgentLoopConfig` so the loop can access it during each iteration.

### ContextManager class (packages/agent/src/context-manager.ts)

```typescript
import type { AgentMessage, ContextStrategy, TokenCounter } from "./types.js";

export class ContextManager implements TokenCounter {
  private _tokenCount = 0;
  private _trimCount = 0;

  constructor(
    private readonly options: {
      budget: number;
      strategy: ContextStrategy;
    },
  ) {}

  get budget(): number {
    return this.options.budget;
  }

  get tokenCount(): number {
    return this._tokenCount;
  }

  get remainingBudget(): number {
    return Math.max(0, this.options.budget - this._tokenCount);
  }

  get trimCount(): number {
    return this._trimCount;
  }

  /**
   * Estimate token count for a single message.
   * Naive approximation: characters / 4, rounded up.
   */
  private estimateTokensForMessage(message: AgentMessage): number {
    let chars = 0;
    if (typeof message.content === "string") {
      chars = message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (typeof part === "object" && "text" in part) {
          chars += (part as { text: string }).text.length;
        } else {
          // image or other: estimate fixed overhead
          chars += 200;
        }
      }
    }
    // Base overhead per message (role, formatting)
    return Math.ceil(chars / 4) + 3;
  }

  count(messages: AgentMessage[]): number {
    return messages.reduce((sum, m) => sum + this.estimateTokensForMessage(m), 0);
  }

  /**
   * Name of the currently active strategy.
   */
  get strategyName(): string {
    return this.options.strategy.name;
  }

  /**
   * Analyze messages and trim if over budget, accounting for an optional
   * system prompt that will be prepended to the LLM context.
   *
   * Returns the message list to send to the LLM.
   * Also returns metadata about what was trimmed.
   *
   * `tokenCount` reflects the prepared (trimmed) message list, including
   * the estimated system prompt tokens if one is provided.
   */
  prepareMessages(
    messages: AgentMessage[],
    systemPrompt?: string,
  ): {
    prepared: AgentMessage[];
    dropped: number;
    tokenCountBefore: number;
    tokenCountAfter: number;
    strategyName: string;
  } {
    // Reserve budget for system prompt, if present
    const systemPromptTokens = systemPrompt ? Math.ceil(systemPrompt.length / 4) + 3 : 0;
    const effectiveBudget = Math.max(0, this.options.budget - systemPromptTokens);

    const tokenCountBefore = this.count(messages);

    if (tokenCountBefore <= effectiveBudget) {
      const totalBefore = tokenCountBefore + systemPromptTokens;
      const totalAfter = totalBefore;
      this._tokenCount = totalAfter;
      return {
        prepared: messages,
        dropped: 0,
        tokenCountBefore: totalBefore,
        tokenCountAfter: totalAfter,
        strategyName: this.strategyName,
      };
    }

    // Apply strategy with reduced budget (accounting for system prompt)
    const prepared = this.options.strategy.apply(messages, effectiveBudget, this);
    const trimmedTokens = this.count(prepared);
    const tokenCountAfter = trimmedTokens + systemPromptTokens;
    const dropped = messages.length - prepared.length;
    this._tokenCount = tokenCountAfter;
    this._trimCount++;

    return {
      prepared,
      dropped,
      tokenCountBefore: tokenCountBefore + systemPromptTokens,
      tokenCountAfter,
      strategyName: this.strategyName,
    };
  }
}
```

### Sliding window strategy (packages/agent/src/context-manager.ts or strategies/sliding-window.ts)

Include as a named export:

```typescript
export const slidingWindowStrategy: ContextStrategy = {
  name: "slidingWindow",
  apply(messages, budget, tokenCounter) {
    // Separate system prompts
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    // Start with all messages
    let kept = [...systemMessages, ...nonSystemMessages];
    let dropIndex = 0;

    // Drop oldest non-system messages one at a time until under budget
    // or all non-system messages have been dropped.
    // Complexity: O(n²) token counting due to re-counting from scratch each iteration.
    while (tokenCounter.count(kept) > budget && dropIndex < nonSystemMessages.length) {
      dropIndex++;
      kept = [...systemMessages, ...nonSystemMessages.slice(dropIndex)];
    }

    // If still over budget, progressively reduce to the minimal viable context
    if (tokenCounter.count(kept) > budget) {
      const systemOnlyTokens = tokenCounter.count(systemMessages);
      if (systemOnlyTokens > budget) {
        // System prompt alone exceeds budget — keep just the first system message
        kept = systemMessages.length > 0 ? [systemMessages[0]] : [];
      } else {
        // Find the smallest suffix of non-system messages that still fits within budget,
        // preferring recent messages.
        let bestKept = systemMessages;
        for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
          const candidate = [...systemMessages, ...nonSystemMessages.slice(i)];
          if (tokenCounter.count(candidate) <= budget) {
            bestKept = candidate;
            break;
          }
        }
        kept = bestKept;
      }
    }

    return kept;
  },
};
```

### Agent loop integration (packages/agent/src/agent-loop.ts)

Modify `loop()` to run context management before building `llmMessages`.

The integration point is inside `loop()`, after message accumulation but before `convertToLlm`. Currently the flow is:

```typescript
const llmMessages = await config.convertToLlm(messages);
```

We insert a trim step. Since `ContextManager` should operate on `AgentMessage[]`, it goes before `convertToLlm`. However, `convertToLlm` may filter messages, and that filtering could reduce tokens further. The manager should run on the _input_ to `convertToLlm`.

Add to `AgentLoopConfig` (optional):

```typescript
// packages/agent/src/types.ts in AgentLoopConfig
contextManager?: ContextManager;
```

Then in `loop()` (before `convertToLlm` call):

```typescript
// === Context budget check and trim ===
if (config.contextManager) {
  const { prepared, dropped, tokenCountBefore, tokenCountAfter, strategyName } =
    config.contextManager.prepareMessages(messages, context.systemPrompt);

  if (dropped > 0) {
    const trimEvent: AgentEvent = {
      type: "context_trimmed" as const,
      droppedMessages: dropped,
      remainingMessages: prepared.length,
      budget: config.contextManager.budget,
      tokenCountBefore,
      tokenCountAfter,
      strategyName,
    };
    await emit(trimEvent);
  }

  // Replace messages with prepared for this turn only
  // But wait — we don't want to modify the persistent messages array!
  // The loop's messages array is the source of truth.
  // We need a separate variable for "messages to send to LLM".
}
```

Ah — here's an important design decision. The `messages` array in `loop()` serves two purposes:

1. Persistent internal transcript (accumulates forever for state/completeness)
2. The actual list sent to `convertToLlm` for the LLM

Currently these are the same array. For `ContextManager`, we need to separate them so the _internal_ history is preserved while the _LLM_ list is trimmed.

Refactor `loop()` to track `contextMessages` (for the LLM) separately:

```typescript
async function loop(
  messages: AgentMessage[], // persistent history (grows forever)
  context: { systemPrompt: string; tools: AgentTool[] },
  config: AgentLoopConfig,
  emit: (event: AgentEvent) => Promise<void>,
  signal: AbortSignal,
  streamFn: StreamFn,
  maxIterations?: number,
): Promise<void> {
  // ... existing setup ...

  for (;;) {
    // ... iteration setup ...

    // Build the LLM context from persistent messages (with optional trim)
    let contextMessages = messages.slice();

    if (config.contextManager) {
      const result = config.contextManager.prepareMessages(contextMessages, context.systemPrompt);
      if (result.dropped > 0) {
        await emit({
          type: "context_trimmed",
          droppedMessages: result.dropped,
          remainingMessages: result.prepared.length,
          budget: config.contextManager.budget,
          tokenCountBefore: result.tokenCountBefore,
          tokenCountAfter: result.tokenCountAfter,
          strategyName: result.strategyName,
        });
      }
      contextMessages = result.prepared;
    }

    // Apply context transformation (existing hook)
    // Note: transformContext is expected not to grow the context. If it does,
    // the result may exceed budget. Budget enforcement happens before this step.
    if (config.transformContext) {
      contextMessages = await config.transformContext(contextMessages, signal);
    }

    // Convert to LLM messages
    const llmMessages = await config.convertToLlm(contextMessages);
    if (context.systemPrompt) {
      llmMessages.unshift({ role: "system", content: context.systemPrompt });
    }

    // ... rest of stream setup and call remains unchanged ...
    const eventStream = streamFn(config.model, { messages: llmMessages, tools }, options);

    // ... rest of loop remains the same ...
  }
}
```

Wait — there's a subtlety. `convertToLlm` currently receives `messages` (the persistent array). If we pass `contextMessages` (trimmed) to `convertToLlm`, does that break anything?

Looking at the default `convertToLlm`:

```typescript
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === "user" || message.role === "assistant" || message.role === "toolResult",
  ) as Message[];
}
```

This just filters by role. Passing a trimmed list is safe.

And in `Agent` class (agent.ts), `createLoopConfig()` builds `convertToLlm`. No issues there.

### Agent class changes (packages/agent/src/agent.ts)

**1. Add `contextManager` to `AgentOptions`:**

```typescript
export interface AgentOptions {
  // ... existing ...
  contextManager?: ContextManager;
}
```

**2. Add `contextManager` to `Agent` class:**

```typescript
class Agent {
  public contextManager?: ContextManager;
  // ...
  constructor(options: AgentOptions = {}) {
    // ... existing ...
    this.contextManager = options.contextManager;
  }
}
```

**3. Pass `contextManager` to loop config:**

Update `createLoopConfig()`:

```typescript
private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
  // ... existing ...
  return {
    // ... existing fields ...
    contextManager: this.contextManager,
  };
}
```

**4. Handle `context_trimmed` event in `processEvents()`:**

```typescript
private async processEvents(event: AgentEvent): Promise<void> {
  switch (event.type) {
    // ... existing cases ...
    case "context_trimmed":
      // No internal state change needed; event is forwarded to listeners
      break;
  }
  // ... listener invocation ...
}
```

Actually, `processEvents` doesn't need a new case — the `agent_end` case is the only one with internal state work. All other events are just forwarded to listeners. The default fallthrough in the switch already handles this correctly. We just need to make TypeScript happy.

Verify: In the current `processEvents`, the switch has cases for `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, `turn_end`, and `agent_end`. Events not in the list fall through to the listener loop. Adding `context_trimmed` to `AgentEvent` union means we need to handle it in the switch or add a default:

```typescript
// After agent_end case, add:
default:
  // No internal state change for other event types
  break;
```

Or just handle it explicitly:

```typescript
case "context_trimmed":
  break;
```

### Export changes (packages/agent/src/index.ts)

Export new types and the `ContextManager`:

```typescript
export type {
  // ... existing ...
  ContextStrategy,
  TokenCounter,
} from "./types.js";

export { ContextManager, slidingWindowStrategy } from "./context-manager.js";
```

## End-to-end flow

### Normal execution with ContextManager

```
User: new Agent({ model, tools, contextManager: new ContextManager({ budget: 10000, strategy: slidingWindowStrategy }) })
User: agent.prompt("Long running task")
  → runAgentLoop → loop()
  → for (;;) {
    → contextManager.prepareMessages(messages, context.systemPrompt)
      → count tokens: 1200 (under budget)
      → returns { prepared: messages, dropped: 0, strategyName: "slidingWindow" }
    → convertToLlm(prepared)
    → streamFn → normal turn
    → tool results back, messages now has 15 items
    → next iteration:
      → prepareMessages(messages, context.systemPrompt)
      → count: 10_500 (over budget: 10000, accounting for system prompt)
      → strategy.apply() → drops oldest 2 pairs
      → count after trim: 9_200
      → emit context_trimmed event (includes strategyName: "slidingWindow")
      → prepared messages sent to LLM
    → loop continues
  }
```

### Execution without ContextManager

```
User: new Agent({ model, tools }) // no contextManager
  → loop()
  → config.contextManager is undefined
  → original messages array used directly
  → behavior identical to pre-feature baseline
```

## Risks and mitigations

### Risk 1: Breaking `convertToLlm` expectation

**Problem**: `convertToLlm` currently receives the persistent `messages` array. If we pass a trimmed copy, consumers with custom `convertToLlm` implementations that rely on accessing the full history will receive fewer messages.

**Mitigation**: This is by design — the purpose of `ContextManager` is to reduce what the LLM sees. Document that custom `convertToLlm` receives the already-trimmed message list. The persistent `messages` array is still accessible via `agent.state.messages`.

### Risk 2: Token estimation inaccuracy

**Problem**: Naive character-count / 4 approximation differs from provider tokenizers (e.g., GPT-4 uses tiktoken, Claude uses its own tokenizer).

**Mitigation**: Document that estimation is approximate and conservative. The budget should be set with margin (e.g., use `model.contextWindow * 0.9` instead of exact context window). The built-in `slidingWindowStrategy` includes a fallback that progressively reduces to system-prompt-only when needed.

### Risk 3: Strategy fails to reduce below budget

**Problem**: A custom strategy may return a message list that still exceeds budget.

**Mitigation**: The strategy is the sole authority for trimming. The built-in `slidingWindowStrategy` includes a fallback path that reduces to system-prompt-only if needed. Custom strategies should document their budget-compliance guarantees. The LLM provider will return an error if the final context still exceeds its actual limit.

### Risk 4: Context transformation order

**Problem**: Both `transformContext` and `ContextManager` transform messages. Which runs first?

**Mitigation**: `ContextManager` runs first (budget enforcement is a lower-level concern), then `transformContext` runs on the trimmed result. This ordering is intuitive: trim to budget first, then apply business-logic transformations.

### Risk 5: `context_trimmed` event type collision

**Problem**: Adding a new event type to `AgentEvent` requires updating all switch statements and type guards across the codebase.

**Mitigation**: Add `context_trimmed` to the `AgentEvent` union. Ensure `processEvents` has an explicit or default case. Check test files for event type assertions that may need updating.

## Testing and validation

### Unit tests (packages/agent/test/context-manager.test.ts)

- `ContextManager.count()` returns approximate token count for text messages
- `ContextManager.count()` handles array content (text parts)
- `slidingWindowStrategy` preserves all system messages
- `slidingWindowStrategy` drops oldest non-system messages first
- `slidingWindowStrategy` keeps at least one non-system message when possible
- After over-budget trim, token count is below budget
- `prepareMessages` returns `{ dropped: 0, strategyName }` when under budget
- `trimCount` increments only when trimming occurs
- Custom strategy receives correct arguments
- Empty message list returns empty prepared list with 0 token count

### Integration tests

- Agent with ContextManager runs a 20-turn conversation without errors
- `context_trimmed` event fires at expected trim boundary
- `agent.state.messages` contains all original messages (no data loss)
- Agent without ContextManager runs identically to baseline

### Regression tests

- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification

## Follow-ups

1. **Summarization strategy**: A `summaryStrategy` that calls an LLM to summarize dropped messages and injects the summary as a system message.
2. **Exact tokenizers**: Integrate provider-specific tokenizers (tiktoken, @anthropic-ai/tokenizer) for more precise counting.
3. **Per-provider default strategies**: Automatically select a strategy based on the model's context window and tokenizer characteristics.
4. **Token usage analytics**: Track cumulative token usage across sessions for cost analysis.
