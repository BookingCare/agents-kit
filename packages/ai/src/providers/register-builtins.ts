import { registerApiProvider } from "../api-registry.js";
import { azureOpenAIProvider, type AzureOpenAICompletionsOptions } from "./azure-openai.js";

let registered = false;

export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;

  registerApiProvider<"azure-openai-completions", AzureOpenAICompletionsOptions>({
    api: "azure-openai-completions",
    stream: azureOpenAIProvider.stream,
    streamSimple: azureOpenAIProvider.streamSimple,
  });
}
