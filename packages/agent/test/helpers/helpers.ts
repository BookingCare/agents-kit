import { createAssistantMessageEventStream, type AssistantMessage } from "@bookingcare/ai";
import { vi } from "vitest";
import type { StreamFn } from "../../src/types.js";

type MockResponse = {
  text?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  stopReason?: "stop" | "length" | "toolUse";
};

function buildAssistantMessage(response: MockResponse): AssistantMessage {
  const content: AssistantMessage["content"] = [];

  if (response.text) {
    content.push({ type: "text", text: response.text });
  }

  if (response.toolCalls) {
    for (const toolCall of response.toolCalls) {
      content.push({
        type: "toolCall",
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
      });
    }
  }

  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: response.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

export function createMockStream(responses: MockResponse[]): StreamFn {
  const remaining = [...responses];

  return vi.fn((_model, _context, _options) => {
    const stream = createAssistantMessageEventStream();
    const response = remaining.shift();
    if (!response) {
      throw new Error("No more mock responses");
    }

    setTimeout(() => {
      const assistant = buildAssistantMessage(response);

      stream.push({ type: "start", partial: assistant });
      if (response.text) {
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: response.text,
          partial: assistant,
        });
      }

      const contentIndexOffset = response.text ? 1 : 0;
      response.toolCalls?.forEach((toolCall, index) => {
        const contentIndex = contentIndexOffset + index;
        stream.push({ type: "toolcall_start", contentIndex, partial: assistant });
        stream.push({
          type: "toolcall_end",
          contentIndex,
          toolCall: {
            type: "toolCall",
            id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          },
          partial: assistant,
        });
      });

      stream.push({
        type: "done",
        reason: response.stopReason ?? "stop",
        message: assistant,
      });
    }, 0);

    return stream;
  });
}
