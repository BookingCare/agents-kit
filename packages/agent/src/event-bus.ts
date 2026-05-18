import type { AgentEvent, Channel, ChannelListener } from "./types.js";

function channelForEvent(event: AgentEvent): Channel {
  switch (event.type) {
    case "agent_end":
    case "context_trimmed":
      return "lifecycle";
    case "message_start":
    case "message_update":
    case "message_end":
      return "streaming";
    case "permission_needed":
    case "tool_execution_start":
    case "tool_execution_end":
    case "turn_end":
      return "tools";
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

export class EventBus {
  private readonly channels: Record<Channel, Set<ChannelListener>> = {
    lifecycle: new Set(),
    streaming: new Set(),
    tools: new Set(),
  };

  on(channel: Channel, listener: ChannelListener): () => void {
    this.channels[channel].add(listener);
    return () => {
      this.channels[channel].delete(listener);
    };
  }

  once(channel: Channel, listener: ChannelListener): () => void {
    const wrapped: ChannelListener = async (event, signal) => {
      try {
        await listener(event, signal);
      } finally {
        this.channels[channel].delete(wrapped);
      }
    };

    this.channels[channel].add(wrapped);
    return () => {
      this.channels[channel].delete(wrapped);
    };
  }

  async emit(event: AgentEvent, signal: AbortSignal): Promise<void> {
    const listeners = Array.from(this.channels[channelForEvent(event)]);

    for (const listener of listeners) {
      try {
        await listener(event, signal);
      } catch (error) {
        if (event.type === "agent_end") {
          console.warn(
            `[agent] listener error during agent_end: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        throw error;
      }
    }
  }
}
