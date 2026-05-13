import type { Message } from "@bookingcare/ai";
import type { TodoItem, TodoSnapshot, AgentInfo } from "../types.js";

/**
 * Local interface describing only the fields that serializeAgentState needs.
 *
 * We intentionally avoid importing `AgentState` from `@bookingcare/agent`
 * because `@bookingcare/db` is consumed by `@bookingcare/agent`. Importing
 * the real type would create a circular dependency between the two packages.
 */
interface AgentStateLike {
  messages: Message[];
  model: { id: string; provider: string | unknown };
  systemPrompt: string;
}

/**
 * Extract serializable fields from an agent state.
 *
 * Transient fields (streamingMessage, pendingToolCalls, isStreaming, errorMessage)
 * are intentionally excluded. Tools are runtime function references and cannot be
 * serialized — callers must re-register tools after resume.
 */
export function serializeAgentState(state: AgentStateLike): {
  messages: Message[];
  info: Pick<AgentInfo, "model" | "provider" | "systemPrompt">;
} {
  return {
    messages: state.messages,
    info: {
      model: state.model.id,
      provider: String(state.model.provider),
      systemPrompt: state.systemPrompt,
    },
  };
}

/** Build a todo snapshot from items and rendered text. */
export function createTodoSnapshot(items: readonly TodoItem[], rendered: string): TodoSnapshot {
  return { items: items.slice(), rendered };
}
