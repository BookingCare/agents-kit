import type { Message, StreamResult } from "@bookingcare/ai";
import { complete } from "@bookingcare/ai";
import { createToolDispatch } from "./tools.js";
import type { AgentLoopOptions } from "./types.js";

export type { AgentLoopOptions } from "./types.js";

// --- Agent loop ---

export async function agentLoop(query: string, options: AgentLoopOptions) {
  const {
    model,
    system,
    workdir,
    skillsDir,
    maxTokens = 8000,
    maxIterations = 50,
    onStreamResult,
  } = options;

  // Use provided dispatch or create default from workdir
  const { tools, dispatch, skillLoader } = options.dispatch
    ? { tools: options.tools ?? [], dispatch: options.dispatch, skillLoader: undefined }
    : createToolDispatch(workdir, skillsDir);

  // Build system prompt with skill descriptions (Layer 1)
  let systemPrompt = system ?? "";
  if (skillLoader && skillLoader.listNames().length > 0) {
    const skillSection = `\nSkills available:\n${skillLoader.getDescriptions()}`;
    systemPrompt += skillSection;
  }

  const messages: Message[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  messages.push({ role: "user", content: query, timestamp: Date.now() });

  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    const result = await complete(model, { messages, tools }, { maxTokens });

    if (result.stopReason === "error") {
      throw new Error(
        `LLM request failed (iteration ${iterations}). ` +
          `Try a different model or check provider credentials. ` +
          `Usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out.`,
      );
    }

    // Append assistant message
    messages.push({
      role: "assistant",
      content: [
        ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
        ...result.toolCalls,
      ],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: result.usage,
      stopReason: result.stopReason,
      timestamp: Date.now(),
    });

    onStreamResult?.(result, iterations);

    // Exit if model didn't call a tool
    if (result.stopReason !== "tool_use" && result.stopReason !== "toolUse") {
      return { messages, iterations };
    }

    // Execute tool calls via dispatch map
    for (const toolCall of result.toolCalls) {
      const handler = dispatch![toolCall.name];
      let output: string;

      if (handler) {
        const args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
        output = handler(args);
      } else {
        output = `Unknown tool: ${toolCall.name}`;
      }

      messages.push({
        role: "toolResult",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: "text", text: output }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }

  return { messages, iterations };
}
