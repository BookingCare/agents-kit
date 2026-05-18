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

type AnyChannelListener = ChannelListener<Channel>;

export class EventBus {
  private readonly channels: Record<Channel, Set<AnyChannelListener>> = {
    lifecycle: new Set(),
    streaming: new Set(),
    tools: new Set(),
  };

  on<C extends Channel>(channel: C, listener: ChannelListener<C>): () => void {
    const channelListeners = this.channels[channel];
    channelListeners.add(listener as AnyChannelListener);
    return () => {
      channelListeners.delete(listener as AnyChannelListener);
    };
  }

  once<C extends Channel>(channel: C, listener: ChannelListener<C>): () => void {
    const channelListeners = this.channels[channel];
    const wrapped: ChannelListener<C> = async (event, signal) => {
      try {
        await listener(event, signal);
      } finally {
        channelListeners.delete(wrapped as AnyChannelListener);
      }
    };

    channelListeners.add(wrapped as AnyChannelListener);
    return () => {
      channelListeners.delete(wrapped as AnyChannelListener);
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
