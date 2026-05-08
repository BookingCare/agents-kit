import type { Api, ProviderApi } from "./types.js";

const providers = new Map<string, ProviderApi>();

export function registerProvider(api: string, provider: ProviderApi): void {
  providers.set(api, provider);
}

export function resolveApiProvider(api: Api): ProviderApi {
  const provider = providers.get(api);
  if (!provider) {
    const available = [...providers.keys()];
    throw new Error(
      `No provider registered for API: "${api}". Available APIs: ${available.length ? available.join(", ") : "none"}`,
    );
  }
  return provider;
}

export function listApis(): string[] {
  return [...providers.keys()];
}
