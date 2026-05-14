import { vi } from "vitest";
import type {
  AssistantMessage,
  Model,
  SimpleStreamOptions,
  StopReason,
  ToolCall,
} from "@bookingcare/ai";
import { createAssistantMessageEventStream } from "@bookingcare/ai";

export interface MockResponse {
  text?: string;
  toolCalls?: ToolCall[];
  stopReason?: StopReason;
}

/**
 * Build an AssistantMessage from a MockResponse.
 */
export function buildAssistantMessage(response: MockResponse): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (response.text) {
    content.push({ type: "text", text: response.text });
  }
  if (response.toolCalls) {
    for (const tc of response.toolCalls) {
      content.push({ type: "toolCall", id: tc.id, name: tc.name, arguments: tc.arguments });
    }
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 10,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 30,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: response.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

/**
 * Create a mock streamFn that emits a text response, optionally followed by
 * tool calls. Returns the event stream — the caller's loop collects it.
 */
export function createMockStream(responses: MockResponse[]) {
  const remaining = [...responses];
  return vi.fn((_model: Model<any>, _ctx: any, _opts?: SimpleStreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const response = remaining.shift();
    if (!response) throw new Error("No more mock responses");

    setTimeout(() => {
      const assistant = buildAssistantMessage(response);

      stream.push({ type: "start", partial: assistant });

      if (response.text) {
        stream.push({ type: "text_start", contentIndex: 0, partial: assistant });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: response.text,
          partial: assistant,
        });
        stream.push({
          type: "text_end",
          contentIndex: 0,
          content: response.text,
          partial: assistant,
        });
      }

      for (let i = 0; i < (response.toolCalls?.length ?? 0); i++) {
        const tc = response.toolCalls![i];
        stream.push({ type: "toolcall_start", contentIndex: i, partial: assistant });
        stream.push({
          type: "toolcall_delta",
          contentIndex: i,
          delta: "",
          partial: assistant,
        });
        stream.push({ type: "toolcall_end", contentIndex: i, toolCall: tc, partial: assistant });
      }

      stream.push({
        type: "done",
        reason: (response.stopReason ?? "stop") as "stop" | "length" | "toolUse",
        message: assistant,
      });
    }, 0);

    return stream;
  });
}
