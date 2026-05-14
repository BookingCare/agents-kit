# ContextManager — token budget and context window management - Product Spec

## Summary

Introduce a `ContextManager` that proactively tracks token usage against a configurable budget, and automatically trims the message history before the context window overflows. This replaces the current behavior of accumulating messages indefinitely and relying on the LLM provider to return context-overflow errors.

## Problem

The `Agent` class accumulates messages in its transcript without bound. There is no token counting before an LLM call, and no strategy for gracefully reducing context when the budget is exhausted. This leads to:

- Provider-side errors on long conversations
- Wasted API calls that predictably fail
- No visibility into remaining budget for consumers

## Goals

1. Track estimated token usage for each LLM call against a configurable per-call budget
2. Estimate per-message token counts (approximation acceptable) before each call
3. Automatically trim message history when estimated tokens exceed budget
4. Expose `ContextManager.tokenCount` and `ContextManager.remainingBudget`
5. Provide a `ContextStrategy` interface for pluggable trimming strategies
6. Emit a `context_trimmed` event when messages are dropped
7. Preserve the system prompt and recent messages during trimming
8. Zero breaking changes to existing `Agent` behavior when no ContextManager is configured

## Non-goals

- Exact tokenization matching each provider's tokenizer (approximation is sufficient)
- Automatic summarization of dropped messages (strategy interface only; no built-in summarizer)
- Image token counting (text-only for initial implementation)
- Pre-flight context estimation independent of actual LLM calls
- Persisting token history across process restarts

## Figma / design references

Not applicable — developer-facing API with no UI components.

## User experience

### Default behavior (no changes)

When no `ContextManager` is provided, the agent behaves exactly as today:

```typescript
const agent = new Agent({ model: claudeModel, tools });
await agent.prompt("Hello");
// Messages accumulate indefinitely
```

### Enabling context management

Create a `ContextManager` with a strategy and attach it to the agent:

```typescript
import { Agent, ContextManager, slidingWindowStrategy } from "@bookingcare/agent";

const contextManager = new ContextManager({
  budget: 100_000, // tokens
  strategy: slidingWindowStrategy,
});

const agent = new Agent({
  model: claudeModel,
  tools,
  contextManager,
});

await agent.prompt("Hello");
// Long conversation automatically trimmed
```

### Budget from model metadata

Use the model's own context window as the budget:

```typescript
const contextManager = new ContextManager({
  budget: model.contextWindow - model.maxTokens, // reserve space for output
});
```

### Inspecting token state

```typescript
console.log(`Used: ${contextManager.tokenCount}`);
console.log(`Remaining: ${contextManager.remainingBudget}`);
console.log(`Trimmed in session: ${contextManager.trimCount}`);
```

### Listening for trims

```typescript
agent.subscribe(async (event) => {
  if (event.type === "context_trimmed") {
    console.log(`Dropped ${event.droppedMessages} messages to stay under budget`);
  }
});
```

### Custom strategy

```typescript
const myStrategy: ContextStrategy = {
  name: "keep_first_and_last",
  apply(messages, budget, tokenCounter) {
    // Keep first system message + first 2 turns + most recent 5 turns
    const system = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");
    const recent = nonSystem.slice(-10);
    const kept = [...system, ...recent];

    // Verify budget compliance with tokenCounter
    if (tokenCounter.count(kept) > budget) {
      // Aggressively trim recent if still over budget
      return kept.slice(-5);
    }
    return kept;
  },
};

const contextManager = new ContextManager({
  budget: 200_000,
  strategy: myStrategy,
});
```

### Sliding window strategy

The built-in `slidingWindowStrategy` behaves as follows:

1. Preserve all `system` role messages (system prompts)
2. From the remaining `user`/`assistant`/`toolResult` messages, keep the most recent pairs
3. Drop oldest pairs one at a time until estimated token count is below budget
4. Always keep at least one user-assistant pair if possible
5. Emit `context_trimmed` event with count of dropped messages

## Success criteria

### Core functionality

1. `ContextManager` accepts a `budget` (positive integer) and a `strategy` in its constructor
2. `ContextManager.tokenCount` returns the estimated tokens of the current message list
3. `ContextManager.remainingBudget` returns `budget - tokenCount`
4. `ContextManager.trimCount` counts how many trim operations occurred in the current session
5. Before each LLM call, the context is checked against budget
6. If estimated tokens exceed budget, the strategy's `apply()` is invoked
7. After trimming, the loop proceeds with the reduced message list
8. Messages remain in the agent's internal transcript even if dropped from the LLM context

### Strategy correctness

9. `slidingWindowStrategy` preserves all system prompt messages
10. `slidingWindowStrategy` drops oldest non-system message pairs first
11. `slidingWindowStrategy` never drops all messages (keeps at least one meaningful pair)
12. `slidingWindowStrategy` respects the budget after trimming
13. Custom strategies receive correct arguments (`messages`, `budget`, `tokenCounter`)

### Events and debugging

14. `context_trimmed` event is emitted with `droppedMessages: number`
15. `contextManager.tokenCount` reflects messages _after_ the most recent trim operation (i.e., the count of messages that will be sent to the LLM)

### Edge cases

16. Single non-system message exceeding budget: trimmed to system prompt only, LLM call goes ahead with just system prompt
17. System prompt exceeds budget on its own: kept as the sole message in the context (the strategy may truncate, but exact summarization is out of scope)
18. Empty messages array: no trimming needed, token count is 0
19. Budget === token count exactly: no trimming
20. After a trim, the token count still exceeds budget: strategy is responsible for reducing to the minimal viable context (system prompt only if necessary)

## Validation

### Unit tests (packages/agent/test/)

Add `context-manager.test.ts`:

- `tokenCount` approximates text messages correctly (naive char count / 4)
- `remainingBudget` returns correct value
- `slidingWindowStrategy` preserves system prompts
- `slidingWindowStrategy` drops oldest pairs when over budget
- `slidingWindowStrategy` keeps at least one pair when possible
- Custom strategy receives correct arguments and its return value is used
- `trimCount` incremented on each trim operation
- `context_trimmed` event emitted with correct `droppedMessages`
- Messages removed from LLM context remain in `agent.state.messages`
- No trim when messages are under budget
- System prompt exceeding budget results in system-prompt-only context

### Integration tests (agents/test/)

- Agent with ContextManager runs a 20-turn conversation without errors
- Token count grows across turns
- Trim occurs predictably when budget is exceeded
- Final transcript contains all messages (none lost from internal state)

### Regression tests

- Agent without ContextManager behaves identically to baseline
- `agent-loop.test.ts` passes without modification
- `agent.test.ts` passes without modification

### Manual validation

1. Create agent with ContextManager budget = 2000 tokens
2. Run multi-turn conversation
3. Verify `context_trimmed` fires when messages approach budget
4. Verify all messages preserved in `agent.state.messages`
5. Verify only trimmed messages are dropped from LLM context

## Open questions

1. **Token estimation algorithm**: Is the naive `Math.ceil(charCount / 4)` approximation sufficient for all providers, or should we allow the strategy to provide its own estimator?

2. **Should trimmed messages be summarized and injected back?** The strategy interface could support a `summary` field, but summarization requires an LLM call — is this in scope or a future follow-up?

3. **Per-message metadata**: Should we attach `estimatedTokens` metadata to each message for debugging? This adds a field to `AgentMessage` that doesn't exist today.

4. **Budget model**: The budget is per-call (per LLM request), not cumulative across the session. This aligns with the `prepareMessages` design where the strategy trims the current context before each turn.
