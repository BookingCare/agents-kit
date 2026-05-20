# Production Serving with AgentPool

`AgentPool` is a thin in-memory manager. It is useful when one process serves many long-lived `Agent` instances keyed by request or conversation ID.

Use it when:

- a single process owns the agent lifecycle
- you want to keep agents warm between HTTP requests
- you do not need cross-process coordination

Do not use it as persistence. If the process restarts, the pool is empty again. Session recovery still belongs to `Agent` and its store integration.

## Recommended shape

- keep one pool per process
- create agents lazily per conversation ID
- reuse the same agent for follow-up messages
- shut the pool down on process exit
- keep `sessionId` separate from the pool ID

## HTTP example

If you want live events, keep the SSE connection open while the prompt runs.

```typescript
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getModel } from "@bookingcare/ai";
import { AgentPool, type AgentOptions } from "@bookingcare/agent";

const app = new Hono();
const pool = new AgentPool({ maxAgents: 50 });
const model = getModel("gpt-5.4-nano")!;

function createAgentOptions(): AgentOptions {
  return {
    initialState: {
      model,
      systemPrompt: "You are a helpful coding agent.",
      thinkingLevel: "off",
      tools: [],
      messages: [],
    },
  };
}

app.post("/api/agents/:id/message", async (c) => {
  const id = c.req.param("id");
  const { message } = await c.req.json<{ message: string }>();

  const agent = pool.get(id) ?? pool.create(id, createAgentOptions());

  return streamSSE(c, async (stream) => {
    const write = async (event: unknown) => {
      await stream.writeSSE({ data: JSON.stringify(event) });
    };

    const unsubscribeStreaming = agent.eventBus.on("streaming", write);
    const unsubscribeTools = agent.eventBus.on("tools", write);
    const unsubscribeLifecycle = agent.eventBus.on("lifecycle", async (event) => {
      await write(event);
      if (event.type === "agent_end") {
        unsubscribeStreaming();
        unsubscribeTools();
        unsubscribeLifecycle();
      }
    });

    try {
      await agent.prompt(message);
      await agent.waitForIdle();
    } finally {
      unsubscribeStreaming();
      unsubscribeTools();
      unsubscribeLifecycle();
    }
  });
});
```

## Shutdown

Call `pool.shutdown()` during process shutdown so every agent gets a chance to clean up its own resources.

```typescript
process.on("SIGTERM", async () => {
  await pool.shutdown();
  process.exit(0);
});
```

## Notes

- `AgentPool` does not implement `resume()`, `status()`, or `fork()`.
- `pool.list()` returns the active `Agent` instances.
- Deleting a missing agent is a no-op.
