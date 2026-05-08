import type { AssistantMessageEventStream, StreamOptions } from "./types.js";

type StreamFn = (options: StreamOptions) => AssistantMessageEventStream;

const providers = new Map<string, StreamFn>();

export function registerProvider(name: string, streamFn: StreamFn): void {
  providers.set(name, streamFn);
}

export function getProviderStreamFn(name: string): StreamFn {
  const fn = providers.get(name);
  if (!fn) {
    const available = [...providers.keys()];
    throw new Error(
      `Unknown provider: "${name}". Available providers: ${available.length ? available.join(", ") : "none"}`,
    );
  }
  return fn;
}

export function listProviders(): string[] {
  return [...providers.keys()];
}
