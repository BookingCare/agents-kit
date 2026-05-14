import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { stream, collectStream, streamSimple, complete, completeSimple } from "../src/stream.js";
import { Conversation } from "../src/context.js";
import { getModel, listModels, getModelsByProvider } from "../src/models.generated.js";
import { calculateCost } from "../src/utils/costs.js";
import { getApiProviders } from "../src/api-registry.js";
import type {
  Model,
  Usage,
  Tool,
  StreamOptions,
  Context,
  ImageContent,
  ToolResultMessage,
} from "../src/types.js";
import { Type } from "@sinclair/typebox";
import { applyAuth } from "./helpers/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const auth = applyAuth();

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

function userMsg(content: string) {
  return { role: "user" as const, content, timestamp: Date.now() };
}

// Calculator tool definition (standard Typebox schema)
const calculatorSchema = Type.Object({
  a: Type.Number({ description: "First number" }),
  b: Type.Number({ description: "Second number" }),
  operation: Type.Union(
    [
      Type.Literal("add"),
      Type.Literal("subtract"),
      Type.Literal("multiply"),
      Type.Literal("divide"),
    ],
    { description: "The operation to perform" },
  ),
});

const calculatorTool: Tool<typeof calculatorSchema> = {
  name: "math_operation",
  description: "Perform basic arithmetic operations",
  parameters: calculatorSchema,
};

// === Helper functions for common test scenarios ===

async function basicTextGeneration<TApi extends string>(
  model: Model<TApi>,
  options?: StreamOptionsWithExtras,
) {
  const context: Context = {
    systemPrompt: "You are a helpful assistant. Be concise.",
    messages: [userMsg("Reply with exactly: 'Hello test successful'")],
  };
  const s = await stream(model, context, options);
  const response = await s.result();

  expect(response.role).toBe("assistant");
  expect(response.content).toBeTruthy();
  expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
  expect(response.usage.output).toBeGreaterThan(0);
  expect(response.errorMessage).toBeFalsy();
  expect(response.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain(
    "Hello test successful",
  );

  context.messages.push(response);
  context.messages.push(userMsg("Now say 'Goodbye test successful'"));

  const s2 = await stream(model, context, options);
  const secondResponse = await s2.result();

  expect(secondResponse.role).toBe("assistant");
  expect(secondResponse.content).toBeTruthy();
  expect(secondResponse.usage.input + secondResponse.usage.cacheRead).toBeGreaterThan(0);
  expect(secondResponse.usage.output).toBeGreaterThan(0);
  expect(secondResponse.errorMessage).toBeFalsy();
  expect(secondResponse.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain(
    "Goodbye test successful",
  );
}

async function handleToolCall<TApi extends string>(
  model: Model<TApi>,
  options?: StreamOptionsWithExtras,
) {
  const context: Context = {
    systemPrompt: "You are a helpful assistant that uses tools when asked.",
    messages: [
      {
        role: "user",
        content: "Calculate 15 + 27 using the math_operation tool.",
        timestamp: Date.now(),
      },
    ],
    tools: [calculatorTool],
  };

  const s = await stream(model, context, options);
  let hasToolStart = false;
  let hasToolDelta = false;
  let hasToolEnd = false;
  let accumulatedToolArgs = "";
  let lastContentIndex = -1;
  for await (const event of s) {
    if (event.type === "toolcall_start") {
      hasToolStart = true;
      lastContentIndex = event.contentIndex;
    }
    if (event.type === "toolcall_delta") {
      hasToolDelta = true;
      expect(event.contentIndex).toBe(lastContentIndex);
      accumulatedToolArgs += event.delta;
    }
    if (event.type === "toolcall_end") {
      hasToolEnd = true;
      expect(event.contentIndex).toBe(lastContentIndex);
      // The toolcall_end event provides the final ToolCall with object arguments
      const toolCall = event.toolCall;
      expect(toolCall.name).toBe("math_operation");
      expect(toolCall.arguments).not.toBeUndefined();
      expect(toolCall.arguments).toHaveProperty("a");
      expect(toolCall.arguments).toHaveProperty("b");
      expect(toolCall.arguments).toHaveProperty("operation");
      expect(typeof toolCall.arguments.a).toBe("number");
      expect(typeof toolCall.arguments.b).toBe("number");
      expect(typeof toolCall.arguments.operation).toBe("string");
    }
  }

  expect(hasToolStart).toBe(true);
  expect(hasToolDelta).toBe(true);
  expect(hasToolEnd).toBe(true);

  const response = await s.result();
  expect(response.stopReason).toBe("toolUse");
  expect(response.content.some((b) => b.type === "toolCall")).toBeTruthy();
  const toolCall = response.content.find((b) => b.type === "toolCall");
  if (toolCall && toolCall.type === "toolCall") {
    expect(toolCall.name).toBe("math_operation");
    expect(toolCall.id).toBeTruthy();
  } else {
    throw new Error("No tool call found in response");
  }
}

async function handleStreaming<TApi extends string>(
  model: Model<TApi>,
  options?: StreamOptionsWithExtras,
) {
  let textStarted = false;
  let textChunks = "";
  let textCompleted = false;

  const context: Context = {
    messages: [userMsg("Count from 1 to 3")],
    systemPrompt: "You are a helpful assistant.",
  };

  const s = stream(model, context, options);

  for await (const event of s) {
    if (event.type === "text_start") {
      textStarted = true;
    } else if (event.type === "text_delta") {
      textChunks += event.delta;
    } else if (event.type === "text_end") {
      textCompleted = true;
    }
  }

  const response = await s.result();

  expect(textStarted).toBe(true);
  expect(textChunks.length).toBeGreaterThan(0);
  expect(textCompleted).toBe(true);
  expect(response.content.some((b) => b.type === "text")).toBeTruthy();
}

async function handleImage<TApi extends string>(
  model: Model<TApi>,
  options?: StreamOptionsWithExtras,
) {
  // Check if the model supports images
  if (!model.input.includes("image")) {
    console.log(`Skipping image test - model ${model.id} doesn't support images`);
    return;
  }

  // Read the test image
  const imagePath = join(__dirname, "data", "red-circle.png");
  let imageBuffer: Buffer;
  try {
    imageBuffer = readFileSync(imagePath);
  } catch {
    console.log("Skipping image test - test image not found");
    return;
  }
  const base64Image = imageBuffer.toString("base64");

  const imageContent: ImageContent = {
    type: "image",
    image: base64Image,
    mimeType: "image/png",
  };

  const context: Context = {
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "What do you see in this image? Please describe the shape (circle, rectangle, square, triangle, ...) and color (red, blue, green, ...). You MUST reply in English.",
          },
          imageContent,
        ],
        timestamp: Date.now(),
      },
    ],
    systemPrompt: "You are a helpful assistant.",
  };

  const s = await stream(model, context, options);
  const response = await s.result();

  // Check the response mentions red and circle
  expect(response.content.length > 0).toBeTruthy();
  const textContent = response.content.find((b) => b.type === "text");
  if (textContent && textContent.type === "text") {
    const lowerContent = textContent.text.toLowerCase();
    expect(lowerContent).toContain("red");
    expect(lowerContent).toContain("circle");
  }
}

async function multiTurn<TApi extends string>(
  model: Model<TApi>,
  options?: StreamOptionsWithExtras,
) {
  const context: Context = {
    systemPrompt: "You are a helpful assistant that can use tools to answer questions.",
    messages: [
      {
        role: "user",
        content: "Calculate 42 * 17 using the math_operation tool. Just that one calculation.",
        timestamp: Date.now(),
      },
    ],
    tools: [calculatorTool],
  };

  // Collect all text content from all assistant responses
  let allTextContent = "";
  let hasSeenToolCalls = false;
  const maxTurns = 3; // Prevent infinite loops

  for (let turn = 0; turn < maxTurns; turn++) {
    const s = await stream(model, context, options);
    const response = await s.result();

    // Add the assistant response to context
    context.messages.push(response);

    // Process content blocks
    const results: ToolResultMessage[] = [];
    for (const block of response.content) {
      if (block.type === "text") {
        allTextContent += block.text;
      } else if (block.type === "toolCall") {
        hasSeenToolCalls = true;

        // Process the tool call
        expect(block.name).toBe("math_operation");
        expect(block.id).toBeTruthy();
        expect(block.arguments).toBeTruthy();

        const { a, b, operation } = block.arguments;
        let result: number;
        if (operation === "add" || operation === "+") {
          result = a + b;
        } else if (operation === "multiply" || operation === "*") {
          result = a * b;
        } else {
          result = 0;
        }

        // Add tool result to context
        results.push({
          role: "toolResult",
          toolCallId: block.id,
          toolName: block.name,
          content: [{ type: "text", text: `${result}` }],
          isError: false,
          timestamp: Date.now(),
        });
      }
    }
    context.messages.push(...results);

    // If we got a stop response with text content, we're likely done
    expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
    if (response.stopReason === "stop") {
      break;
    }
  }

  // Verify we got tool calls and the final answer
  expect(hasSeenToolCalls).toBe(true);
  expect(allTextContent).toBeTruthy();
  expect(allTextContent.includes("714")).toBe(true);
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
    const usage: Usage = {
      input: 1_000_000,
      output: 500_000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1_500_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    const cost = calculateCost(usage, model);
    expect(cost.input).toBeCloseTo(3.0);
    expect(cost.output).toBeCloseTo(3.0);
    expect(cost.cacheRead).toBeCloseTo(0.0);
    expect(cost.cacheWrite).toBeCloseTo(0.0);
    expect(cost.total).toBeCloseTo(6.0);
  });
});

describe("API Registry", () => {
  it("has azure-openai-completions API registered", () => {
    const providers = getApiProviders();
    const apis = providers.map((p) => p.api);
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
    const usage: Usage = {
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
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

    const ctxWithTools = conv.toContext([{ name: "my_tool", parameters: Type.Object({}) }]);
    expect(ctxWithTools.tools).toHaveLength(1);
  });
});

// === E2E tests (real API calls) ===

describe.skipIf(!auth)("Azure OpenAI Provider (gpt-5.4-nano)", () => {
  const model = () => getModel("gpt-5.4-nano")!;

  it("should complete basic text generation", { retry: 3 }, async () => {
    await basicTextGeneration(model());
  });

  it("should handle tool calling", { retry: 3 }, async () => {
    await handleToolCall(model());
  });

  it("should handle streaming", { retry: 3 }, async () => {
    await handleStreaming(model());
  });

  it("should handle image input", { retry: 3 }, async () => {
    await handleImage(model());
  });

  it("should handle multi-turn with tools", { retry: 3 }, async () => {
    await multiTurn(model());
  });
});

describe.skipIf(!auth)("streamSimple API", () => {
  const model = () => getModel("gpt-5.4-nano")!;

  it("should send prompt with system message", { retry: 3 }, async () => {
    const eventStream = streamSimple(model(), {
      messages: [
        { role: "system", content: "Reply with exactly the word 'pong'." },
        userMsg("ping"),
      ],
    });
    const result = await collectStream(eventStream, model());

    expect(result.text.toLowerCase().trim()).toBe("pong");
    expect(result.usage.input).toBeGreaterThan(0);
  });
});

describe.skipIf(!auth)("complete API", () => {
  const model = () => getModel("gpt-5.4-nano")!;

  it("should return text completion", { retry: 3 }, async () => {
    const result = await complete(model(), {
      messages: [userMsg("What is 2+2? Reply with just the number.")],
    });

    expect(result.text).toContain("4");
    expect(result.usage.input).toBeGreaterThan(0);
    expect(result.usage.output).toBeGreaterThan(0);
    expect(result.stopReason).toBe("stop");
    expect(result.usage.cost.total).toBeGreaterThan(0);
  });

  it("should return cost from model pricing", { retry: 3 }, async () => {
    const result = await complete(model(), {
      messages: [userMsg("Say hello.")],
    });

    expect(result.usage.cost.input).toBeGreaterThan(0);
    expect(result.usage.cost.output).toBeGreaterThan(0);
    expect(result.usage.cost.total).toBeCloseTo(result.usage.cost.input + result.usage.cost.output);
  });
});

describe.skipIf(!auth)("completeSimple API", () => {
  const model = () => getModel("gpt-5.4-nano")!;

  it("should return text result with system message", { retry: 3 }, async () => {
    const result = await completeSimple(model(), {
      messages: [
        { role: "system", content: "Reply with exactly the word 'pong'." },
        userMsg("ping"),
      ],
    });

    expect(result.text.toLowerCase().trim()).toBe("pong");
    expect(result.usage.input).toBeGreaterThan(0);
    expect(result.usage.cost).toBeDefined();
  });
});
