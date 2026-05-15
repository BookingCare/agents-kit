import { Type } from "@bookingcare/ai";
import { describe, expect, it } from "vitest";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "../src/index.js";
import { auth, liveModel as getLiveModel, type LiveModel } from "./helpers/live-model.js";

const echoTool: AgentTool = {
  name: "echo",
  description: "Echoes the provided message",
  parameters: Type.Object({ message: Type.String() }),
  label: "Echo",
  execute: async (_toolCallId, params) => ({
    content: (params as { message: string }).message,
  }),
};

function getTextContent(message: AgentMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function basicPrompt(liveModel: LiveModel) {
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant. Keep your responses concise.",
      model: liveModel,
      thinkingLevel: "off",
      tools: [],
    },
  });

  await agent.prompt("What is 2+2? Answer with just the number.");

  expect(agent.state.isStreaming).toBe(false);
  expect(agent.state.messages.length).toBe(2);
  expect(agent.state.messages[0].role).toBe("user");
  expect(agent.state.messages[1].role).toBe("assistant");

  const assistantMessage = agent.state.messages[1];
  if (assistantMessage.role !== "assistant") throw new Error("Expected assistant message");
  expect(getTextContent(assistantMessage)).toContain("4");
}

async function toolExecution(liveModel: LiveModel) {
  const agent = new Agent({
    initialState: {
      systemPrompt:
        "You are a helpful assistant. Always use the echo tool when asked to repeat a word.",
      model: liveModel,
      thinkingLevel: "off",
      tools: [echoTool],
    },
  });

  const pendingToolCallsDuringEvents: Array<{ type: AgentEvent["type"]; ids: string[] }> = [];
  agent.subscribe((event) => {
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
      pendingToolCallsDuringEvents.push({
        type: event.type,
        ids: [...agent.state.pendingToolCalls],
      });
    }
  });

  await agent.prompt("Use the echo tool to repeat HELLO exactly.");

  expect(agent.state.isStreaming).toBe(false);
  expect(agent.state.pendingToolCalls.size).toBe(0);
  expect(pendingToolCallsDuringEvents.some((event) => event.type === "tool_execution_start")).toBe(
    true,
  );
  expect(pendingToolCallsDuringEvents.some((event) => event.type === "tool_execution_end")).toBe(
    true,
  );

  const toolResultMsg = agent.state.messages.find((message) => message.role === "toolResult");
  expect(toolResultMsg).toBeDefined();
  if (toolResultMsg?.role !== "toolResult") throw new Error("Expected tool result message");
  expect(getTextContent(toolResultMsg)).toContain("HELLO");

  const finalMessage = agent.state.messages[agent.state.messages.length - 1];
  if (finalMessage.role !== "assistant") throw new Error("Expected final assistant message");
  expect(getTextContent(finalMessage)).toContain("HELLO");
}

async function stateUpdates(liveModel: LiveModel) {
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant.",
      model: liveModel,
      thinkingLevel: "off",
      tools: [],
    },
  });

  const events: AgentEvent["type"][] = [];
  agent.subscribe((event) => {
    events.push(event.type);
  });

  await agent.prompt("Count from 1 to 5.");

  expect(events).toContain("message_start");
  expect(events).toContain("message_update");
  expect(events).toContain("message_end");
  expect(events).toContain("agent_end");
  expect(events.indexOf("message_start")).toBeLessThan(events.indexOf("message_update"));
  expect(events.indexOf("message_update")).toBeLessThan(events.indexOf("message_end"));
  expect(events.indexOf("message_end")).toBeLessThan(events.indexOf("agent_end"));

  expect(agent.state.isStreaming).toBe(false);
  expect(agent.state.messages.length).toBe(2);
}

async function multiTurnConversation(liveModel: LiveModel) {
  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a helpful assistant.",
      model: liveModel,
      thinkingLevel: "off",
      tools: [],
    },
  });

  await agent.prompt("My name is Alice.");
  expect(agent.state.messages.length).toBe(2);

  await agent.prompt("What is my name?");
  expect(agent.state.messages.length).toBe(4);

  const lastMessage = agent.state.messages[3];
  if (lastMessage.role !== "assistant") throw new Error("Expected assistant message");
  expect(getTextContent(lastMessage).toLowerCase()).toContain("alice");
}

describe.skipIf(!auth)("Agent e2e", () => {
  it("handles a basic text prompt", async () => {
    await basicPrompt(getLiveModel());
  });

  it("executes tools and tracks pending tool calls", async () => {
    await toolExecution(getLiveModel());
  });

  it("emits lifecycle updates while streaming", async () => {
    await stateUpdates(getLiveModel());
  });

  it("maintains context across multiple turns", async () => {
    await multiTurnConversation(getLiveModel());
  });
});
