import { createAssistantMessageEventStream } from "@bookingcare/ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/mcp/config.js", () => ({
  loadMcpConfig: vi.fn(async () => ({ servers: [] })),
}));

vi.mock("../src/mcp/registry.js", () => ({
  McpRegistry: class {
    async addServer() {}
    async getAllTools() {
      return [];
    }
    async callTool() {
      return "";
    }
    async shutdown() {}
  },
}));

import { Agent } from "../src/agent.js";
import type { StreamFn } from "../src/types.js";
import { liveModel } from "./helpers/live-model.js";

const errorMessage =
  "Azure OpenAI requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY environment variables.";

function createErrorStreamFn(): StreamFn {
  return (model) => {
    const stream = createAssistantMessageEventStream();
    const assistant = {
      role: "assistant" as const,
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error" as const,
      errorMessage,
      timestamp: Date.now(),
    };

    stream.push({ type: "start", partial: assistant });
    stream.push({ type: "error", reason: "error", error: assistant });
    return stream;
  };
}

describe("Agent error state", () => {
  it("copies stream error messages into state.errorMessage", async () => {
    const agent = new Agent({
      initialState: {
        model: liveModel(),
        systemPrompt: "You are helpful.",
        thinkingLevel: "off",
        tools: [],
        messages: [],
      },
      streamFn: createErrorStreamFn(),
    });

    await agent.prompt("say hello briefly");

    expect(agent.state.errorMessage).toBe(errorMessage);
    expect(agent.state.messages.at(-1)).toMatchObject({ errorMessage });
    expect(agent.state.messages.at(-1)?.role).toBe("assistant");
    expect(agent.state.isStreaming).toBe(false);
  });
});
