import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stream, collectStream, streamSimple, withParsedToolCalls } from "../src/stream.js";
import { Conversation } from "../src/context.js";
import { getModel, listModels, getModelsByProvider } from "../src/models.generated.js";
import { calculateCost } from "../src/utils/costs.js";
import { listApis } from "../src/provider-registry.js";
import { AIError } from "../src/utils/error.js";
import type { Model, Usage, StreamEvent, Context } from "../src/types.js";
import { _resetClient } from "../src/providers/azure-openai.js";

// === Helpers to build mock ChatCompletionChunk objects ===

function makeTextDelta(content: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk" as const,
    created: 0,
    model: "gpt-4o",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
}

function makeToolCallDelta(
  index: number,
  opts: { id?: string; name?: string; arguments?: string },
) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk" as const,
    created: 0,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              ...(opts.id && { id: opts.id, type: "function" as const }),
              function: {
                ...(opts.name && { name: opts.name }),
                arguments: opts.arguments ?? "",
              },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
}

function makeFinishChunk(reason: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk" as const,
    created: 0,
    model: "gpt-4o",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  };
}

function makeUsageChunk(promptTokens: number, completionTokens: number) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk" as const,
    created: 0,
    model: "gpt-4o",
    choices: [],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

/** Create a mock async iterable that yields chunks, simulating the SDK Stream */
function mockStream(chunks: object[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

// === Mock the openai/azure module ===

const mockCreate = vi.fn();

vi.mock("openai/azure", () => {
  const MockAzureOpenAI = vi.fn(function (this: object) {
    this.chat = { completions: { create: mockCreate } };
    return this;
  });
  return { AzureOpenAI: MockAzureOpenAI };
});

// Reset the provider-registry module cache so registerBuiltinProviders re-runs
beforeEach(async () => {
  vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://test.openai.azure.com");
  vi.stubEnv("AZURE_OPENAI_API_KEY", "test-key");
  vi.stubEnv("AZURE_OPENAI_API_VERSION", "2024-12-01-preview");
  mockCreate.mockReset();
  _resetClient();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// === Tests ===

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
    const gpt4o = getModel("gpt-4o");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.name).toBe("GPT-4o");
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
    const model: Model = {
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

describe("Azure OpenAI Provider", () => {
  const gpt4o = () => getModel("gpt-4o")!;

  it("streams text events", async () => {
    mockCreate.mockResolvedValue(
      mockStream([makeTextDelta("Hello"), makeTextDelta(" world"), makeFinishChunk("stop"), makeUsageChunk(10, 5)]),
    );

    const events = stream(gpt4o(), { messages: [{ role: "user", content: "Hi" }] });
    const result = await collectStream(events, gpt4o());

    expect(result.text).toBe("Hello world");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(result.stopReason).toBe("end_turn");

    // Verify the SDK was called correctly
    expect(mockCreate).toHaveBeenCalledOnce();
    const [params] = mockCreate.mock.calls[0];
    expect(params.model).toBe("gpt-4o");
    expect(params.stream).toBe(true);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0].role).toBe("user");
  });

  it("streams tool call events", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        makeToolCallDelta(0, { id: "call_1", name: "get_weather", arguments: '{"ci' }),
        makeToolCallDelta(0, { arguments: 'ty":' }),
        makeToolCallDelta(0, { arguments: '"Tokyo"}' }),
        makeFinishChunk("tool_calls"),
        makeUsageChunk(20, 15),
      ]),
    );

    const events = stream(gpt4o(), {
      messages: [{ role: "user", content: "Weather in Tokyo?" }],
      tools: [{ name: "get_weather", parameters: { type: "object" } }],
    });

    const result = await collectStream(events, gpt4o());

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].id).toBe("call_1");
    expect(result.toolCalls[0].name).toBe("get_weather");
    expect(result.toolCalls[0].arguments).toBe('{"city":"Tokyo"}');
    expect(result.stopReason).toBe("tool_use");
  });

  it("emits parsed tool call events with partial JSON", async () => {
    mockCreate.mockResolvedValue(
      mockStream([
        makeToolCallDelta(0, { id: "call_1", name: "get_weather", arguments: '{"ci' }),
        makeToolCallDelta(0, { arguments: 'ty":' }),
        makeToolCallDelta(0, { arguments: '"Tokyo"}' }),
        makeFinishChunk("tool_calls"),
        makeUsageChunk(20, 15),
      ]),
    );

    const events = stream(gpt4o(), {
      messages: [{ role: "user", content: "Weather in Tokyo?" }],
      tools: [{ name: "get_weather", parameters: { type: "object" } }],
    });

    const parsedStream = withParsedToolCalls(events);
    const allEvents: StreamEvent[] = [];
    const parsedToolCallEvents: any[] = [];

    for await (const event of parsedStream) {
      allEvents.push(event);
      if (event.type === "tool_call_parsed") {
        parsedToolCallEvents.push(event);
      }
    }

    // Should have parsed tool call events
    expect(parsedToolCallEvents.length).toBeGreaterThan(0);

    // Last parsed event should be complete
    const lastParsed = parsedToolCallEvents[parsedToolCallEvents.length - 1];
    expect(lastParsed.id).toBe("call_1");
    expect(lastParsed.name).toBe("get_weather");
    expect(lastParsed.arguments).toEqual({ city: "Tokyo" });
    expect(lastParsed.isComplete).toBe(true);

    // Earlier parsed events should be partial
    const firstParsed = parsedToolCallEvents[0];
    expect(firstParsed.isComplete).toBe(false);
  });

  it("throws on API error", async () => {
    mockCreate.mockRejectedValue(new Error("429 Too Many Requests"));

    const events = stream(gpt4o(), { messages: [{ role: "user", content: "Hi" }] });

    await expect(collectStream(events)).rejects.toThrow(/429/);
  });

  it("sends tools in correct format", async () => {
    mockCreate.mockResolvedValue(mockStream([makeUsageChunk(5, 2)]));

    const tools = [
      {
        name: "my_tool",
        description: "A test tool",
        parameters: { type: "object", properties: { x: { type: "number" } } },
      },
    ];

    const eventStream = stream(gpt4o(), {
      messages: [{ role: "user", content: "test" }],
      tools,
    });
    await collectStream(eventStream);

    const [params] = mockCreate.mock.calls[mockCreate.mock.calls.length - 1];
    expect(params.tools).toHaveLength(1);
    expect(params.tools[0].type).toBe("function");
    expect(params.tools[0].function.name).toBe("my_tool");
  });

  it("passes transport options to provider", async () => {
    mockCreate.mockResolvedValue(mockStream([makeUsageChunk(5, 2)]));

    const eventStream = stream(gpt4o(), {
      messages: [{ role: "user", content: "test" }],
    }, {
      temperature: 0.5,
      maxTokens: 100,
      topP: 0.9,
      stopSequences: ["\n"],
    });
    await collectStream(eventStream);

    const [params] = mockCreate.mock.calls[0];
    expect(params.temperature).toBe(0.5);
    expect(params.max_output_tokens).toBe(100);
    expect(params.top_p).toBe(0.9);
    expect(params.stop).toEqual(["\n"]);
  });
});

describe("streamSimple", () => {
  const gpt4o = () => getModel("gpt-4o")!;

  it("sends prompt and returns stream", async () => {
    mockCreate.mockResolvedValue(
      mockStream([makeTextDelta("42"), makeFinishChunk("stop"), makeUsageChunk(15, 3)]),
    );

    const eventStream = streamSimple(gpt4o(), {
      messages: [
        { role: "system", content: "Answer concisely." },
        { role: "user", content: "What is 2+2?" },
      ],
    });
    const result = await collectStream(eventStream, gpt4o());

    expect(result.text).toBe("42");
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(3);

    // Verify system message was included
    const [params] = mockCreate.mock.calls[0];
    expect(params.messages).toHaveLength(2);
    expect(params.messages[0].role).toBe("system");
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
    const model = getModel("gpt-4o")!;
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
