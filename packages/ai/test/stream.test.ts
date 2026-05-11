import { describe, it, expect } from "vitest";
import { stream, collectStream, streamSimple, withParsedToolCalls, complete, completeSimple } from "../src/stream.js";
import { Conversation } from "../src/context.js";
import { getModel, listModels, getModelsByProvider } from "../src/models.generated.js";
import { calculateCost } from "../src/utils/costs.js";
import { listApis } from "../src/provider-registry.js";
import type { Model, Usage, ToolCallParsedEvent } from "../src/types.js";
import { applyAuth } from "./helpers/auth.js";

const auth = applyAuth();

function userMsg(content: string) {
  return { role: "user" as const, content, timestamp: Date.now() };
}

// === Pure unit tests (no API calls) ===

describe("Model Registry", () => {
  it("lists all models", () => {
    const models = listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.id).toBeTruthy();
      expect(m.provider).toBe("azure-openai");
      expect(m.input).toContain("text");
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  });

  it("looks up a model by id", () => {
    const model = getModel("gpt-5.4-nano");
    expect(model).toBeDefined();
    expect(model!.name).toBe("GPT-5.4 Nano");
  });

  it("returns undefined for unknown model", () => {
    expect(getModel("nonexistent")).toBeUndefined();
  });

  it("filters models by provider", () => {
    const azure = getModelsByProvider("azure-openai");
    expect(azure.length).toBeGreaterThan(0);
    const other = getModelsByProvider("other");
    expect(other.length).toBe(0);
  });
});

describe("Cost Calculation", () => {
  it("calculates cost from usage and model", () => {
    const model: Model<"azure-openai-completions"> = {
      id: "test",
      name: "Test",
      api: "azure-openai-completions",
      provider: "test",
      baseUrl: "",
      reasoning: false,
      input: ["text"],
      cost: {
        input: 3.0,
        output: 6.0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: 1000,
      maxTokens: 100,
    };
    const usage: Usage = { inputTokens: 1_000_000, outputTokens: 500_000 };

    const cost = calculateCost(usage, model);
    expect(cost.input).toBeCloseTo(3.0);
    expect(cost.output).toBeCloseTo(3.0);
    expect(cost.total).toBeCloseTo(6.0);
  });
});

describe("Provider Registry", () => {
  it("has azure-openai-completions API registered", () => {
    const apis = listApis();
    expect(apis).toContain("azure-openai-completions");
  });
});

describe("Conversation", () => {
  it("manages message history", () => {
    const conv = new Conversation();
    conv.addSystemMessage("Be helpful.");
    conv.addUserMessage("Hello!");

    expect(conv.length).toBe(2);
    expect(conv.getMessages()[0].role).toBe("system");
    expect(conv.getMessages()[1].role).toBe("user");
  });

  it("serializes and restores", () => {
    const conv = new Conversation();
    conv.addSystemMessage("Test");
    conv.addUserMessage("Hi");

    const json = conv.toJSON();
    const restored = Conversation.fromJSON(json);

    expect(restored.length).toBe(2);
    expect(restored.getMessages()).toEqual(conv.getMessages());
  });

  it("calculates total cost", () => {
    const model = getModel("gpt-5.4-nano")!;
    const usage: Usage = { inputTokens: 1000, outputTokens: 500 };
    const cost = calculateCost(usage, model);
    expect(cost.total).toBeGreaterThan(0);
  });

  it("produces a Context for streaming", () => {
    const conv = new Conversation();
    conv.addSystemMessage("Be helpful.");
    conv.addUserMessage("Hello!");

    const ctx = conv.toContext();
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.tools).toBeUndefined();

    const ctxWithTools = conv.toContext([{ name: "my_tool", parameters: { type: "object" } }]);
    expect(ctxWithTools.tools).toHaveLength(1);
  });
});

// === E2E tests (real API calls) ===

describe.skipIf(!auth)("stream", () => {
  const model = () => getModel("gpt-5.4-nano")!;

  it("streams text events", async () => {
    const events = stream(model(), { messages: [userMsg("What is 2+2? Reply with just the number.")] });
    const result = await collectStream(events, model());

    expect(result.text).toContain("4");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.stopReason).toBe("end_turn");
  });

  it("streams tool call events", async () => {
    const events = stream(model(), {
      messages: [userMsg("What is the weather in Tokyo?")],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather in a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    });

    const result = await collectStream(events, model());

    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(result.toolCalls[0].id).toBeTruthy();
    const args = JSON.parse(result.toolCalls[0].arguments);
    expect(args.city).toBeTruthy();
    expect(result.stopReason).toBe("tool_use");
  });

  it("emits parsed tool call events", async () => {
    const events = stream(model(), {
      messages: [userMsg("What is the weather in Tokyo?")],
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather in a city",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
    });

    const parsedStream = withParsedToolCalls(events);
    const parsedToolCallEvents: ToolCallParsedEvent[] = [];

    for await (const event of parsedStream) {
      if (event.type === "tool_call_parsed") {
        parsedToolCallEvents.push(event);
      }
    }

    expect(parsedToolCallEvents.length).toBeGreaterThan(0);
    const last = parsedToolCallEvents[parsedToolCallEvents.length - 1];
    expect(last.name).toBe("get_weather");
    expect(last.arguments).toBeDefined();
    expect(last.isComplete).toBe(true);
  });

  it("sends tools in correct format", async () => {
    const result = await complete(model(), {
      messages: [userMsg("Use my_tool with x=5")],
      tools: [
        {
          name: "my_tool",
          description: "A test tool",
          parameters: {
            type: "object",
            properties: { x: { type: "number" } },
            required: ["x"],
          },
        },
      ],
    });

    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.toolCalls[0].name).toBe("my_tool");
    const args = JSON.parse(result.toolCalls[0].arguments);
    expect(args.x).toBe(5);
  });

  it("passes transport options to provider", async () => {
    const result = await complete(
      model(),
      { messages: [userMsg("Write a long essay about computing.")] },
      { maxTokens: 10 },
    );

    expect(result.text).toBeTruthy();
    expect(result.usage.outputTokens).toBeLessThanOrEqual(10);
    expect(result.stopReason).toBe("max_tokens");
  });
});

describe.skipIf(!auth)("streamSimple", () => {
  const model = () => getModel("gpt-5.4-nano")!;

  it("sends prompt with system message", async () => {
    const eventStream = streamSimple(model(), {
      messages: [
        { role: "system", content: "Reply with exactly the word 'pong'." },
        userMsg("ping"),
      ],
    });
    const result = await collectStream(eventStream, model());

    expect(result.text.toLowerCase().trim()).toBe("pong");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });
});

describe.skipIf(!auth)("generate", () => {
  const model = () => getModel("gpt-5.4-nano")!;

  it("returns text completion", async () => {
    const result = await complete(model(), {
      messages: [userMsg("What is 2+2? Reply with just the number.")],
    });

    expect(result.text).toContain("4");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.stopReason).toBe("end_turn");
    expect(result.cost).toBeDefined();
    expect(result.cost!.total).toBeGreaterThan(0);
  });

  it("returns cost from model pricing", async () => {
    const result = await complete(model(), {
      messages: [userMsg("Say hello.")],
    });

    expect(result.cost).toBeDefined();
    expect(result.cost!.input).toBeGreaterThan(0);
    expect(result.cost!.output).toBeGreaterThan(0);
    expect(result.cost!.total).toBeCloseTo(result.cost!.input + result.cost!.output);
  });
});

describe.skipIf(!auth)("generateSimple", () => {
  const model = () => getModel("gpt-5.4-nano")!;

  it("returns text result with system message", async () => {
    const result = await completeSimple(model(), {
      messages: [
        { role: "system", content: "Reply with exactly the word 'pong'." },
        userMsg("ping"),
      ],
    });

    expect(result.text.toLowerCase().trim()).toBe("pong");
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.cost).toBeDefined();
  });
});
