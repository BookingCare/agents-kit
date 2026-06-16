import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const azureOpenAIMock = vi.hoisted(() => {
  const mock = {
    configs: [] as unknown[],
    streamCalls: [] as unknown[],
    events: [] as unknown[],
    AzureOpenAI: vi.fn(function AzureOpenAIMock(config: unknown) {
      mock.configs.push(config);
      return {
        responses: {
          stream: vi.fn(async (params: unknown) => {
            mock.streamCalls.push(params);
            return (async function* () {
              for (const event of mock.events) {
                yield event;
              }
            })();
          }),
        },
      };
    }),
  };
  return mock;
});

vi.mock("openai/azure", () => ({ AzureOpenAI: azureOpenAIMock.AzureOpenAI }));

import {
  _resetResponsesClient,
  buildResponsesParams,
  streamAzureOpenAIResponses,
} from "../src/providers/azure-openai-responses.js";
import type { Context, Model } from "../src/types.js";

const testModel: Model<"azure-openai-responses"> = {
  id: "gpt-5.4-nano",
  name: "GPT-5.4 Nano",
  api: "azure-openai-responses",
  provider: "azure-openai",
  baseUrl: "",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  contextWindow: 400000,
  maxTokens: 128000,
};

const originalAzureEndpoint = process.env["AZURE_OPENAI_ENDPOINT"];
const originalAzureApiKey = process.env["AZURE_OPENAI_API_KEY"];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeContext(overrides: Partial<Context> = {}): Context {
  return {
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    ...overrides,
  };
}

function makeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp_1",
    status: "completed",
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 3 },
      total_tokens: 15,
    },
    ...overrides,
  };
}

function completedEvent(): Record<string, unknown> {
  return {
    type: "response.completed",
    sequence_number: 1,
    response: makeResponse(),
  };
}

beforeEach(() => {
  _resetResponsesClient();
  azureOpenAIMock.AzureOpenAI.mockClear();
  azureOpenAIMock.configs.length = 0;
  azureOpenAIMock.streamCalls.length = 0;
  azureOpenAIMock.events.length = 0;
});

afterEach(() => {
  _resetResponsesClient();
  restoreEnv("AZURE_OPENAI_ENDPOINT", originalAzureEndpoint);
  restoreEnv("AZURE_OPENAI_API_KEY", originalAzureApiKey);
});

describe("buildResponsesParams", () => {
  it("uses the Responses API input shape", () => {
    const params = buildResponsesParams(testModel, makeContext({ systemPrompt: "Be concise." }));

    expect(params.model).toBe("gpt-5.4-nano");
    expect(params.stream).toBe(true);
    expect(params.input).toEqual([
      { role: "developer", content: "Be concise." },
      { role: "user", content: [{ type: "input_text", text: "Hello" }] },
    ]);
  });

  it("forwards reasoning summary options", () => {
    const params = buildResponsesParams(testModel, makeContext(), {
      reasoningEffort: "medium",
      reasoningSummary: "auto",
    });

    expect(params.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("preserves null reasoning summary when reasoning effort is set", () => {
    const params = buildResponsesParams(testModel, makeContext(), {
      reasoningEffort: "medium",
      reasoningSummary: null,
    });

    expect(params.reasoning).toEqual({ effort: "medium", summary: null });
  });

  it("preserves URL image inputs and wraps bare base64 inputs", () => {
    const params = buildResponsesParams(
      testModel,
      makeContext({
        messages: [
          {
            role: "user",
            timestamp: 0,
            content: [
              { type: "text", text: "Compare these." },
              { type: "image", image: "https://example.com/image.png" },
              { type: "image", image: new URL("https://example.com/other.png") },
              { type: "image", image: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
          },
        ],
      }),
    );

    expect(params.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Compare these." },
          { type: "input_image", detail: "auto", image_url: "https://example.com/image.png" },
          { type: "input_image", detail: "auto", image_url: "https://example.com/other.png" },
          { type: "input_image", detail: "auto", image_url: "data:image/png;base64,iVBORw0KGgo=" },
        ],
      },
    ]);
  });

  it("uses azureDeploymentName when provided", () => {
    const params = buildResponsesParams(testModel, makeContext(), {
      azureDeploymentName: "deployment-name",
    });

    expect(params.model).toBe("deployment-name");
  });
});

describe("streamAzureOpenAIResponses", () => {
  it("treats response.incomplete as a length stop and preserves usage", async () => {
    azureOpenAIMock.events.push(
      {
        type: "response.output_item.added",
        sequence_number: 1,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      { type: "response.output_text.delta", sequence_number: 2, delta: "partial" },
      {
        type: "response.output_item.done",
        sequence_number: 3,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "incomplete",
          content: [{ type: "output_text", text: "partial" }],
        },
      },
      {
        type: "response.incomplete",
        sequence_number: 4,
        response: makeResponse({ status: "incomplete" }),
      },
    );

    const message = await streamAzureOpenAIResponses(testModel, makeContext(), {
      azureEndpoint: "https://example.openai.azure.com",
      apiKey: "key-1",
    }).result();

    expect(message.stopReason).toBe("length");
    expect(message.content).toEqual([{ type: "text", text: "partial" }]);
    expect(message.usage).toMatchObject({
      input: 8,
      output: 5,
      cacheRead: 2,
      reasoningTokens: 3,
      totalTokens: 15,
    });
  });

  it("uses per-call Azure credentials without env credentials and caches by apiKey", async () => {
    delete process.env["AZURE_OPENAI_ENDPOINT"];
    delete process.env["AZURE_OPENAI_API_KEY"];
    azureOpenAIMock.events.push(completedEvent());

    await streamAzureOpenAIResponses(testModel, makeContext(), {
      azureEndpoint: "https://example.openai.azure.com",
      apiKey: "key-1",
    }).result();
    await streamAzureOpenAIResponses(testModel, makeContext(), {
      azureEndpoint: "https://example.openai.azure.com",
      apiKey: "key-2",
    }).result();

    expect(azureOpenAIMock.AzureOpenAI).toHaveBeenCalledTimes(2);
    expect(azureOpenAIMock.configs).toEqual([
      {
        endpoint: "https://example.openai.azure.com",
        apiKey: "key-1",
        apiVersion: "2025-03-01-preview",
      },
      {
        endpoint: "https://example.openai.azure.com",
        apiKey: "key-2",
        apiVersion: "2025-03-01-preview",
      },
    ]);
  });
});
