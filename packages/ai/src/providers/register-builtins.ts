import { registerApiProvider } from "../api-registry.js";
import { azureOpenAIProvider, type AzureOpenAICompletionsOptions } from "./azure-openai.js";
import {
  azureOpenAIResponsesProvider,
  type AzureOpenAIResponsesOptions,
} from "./azure-openai-responses.js";

let registered = false;

export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;

  registerApiProvider<"azure-openai-completions", AzureOpenAICompletionsOptions>({
    api: "azure-openai-completions",
    stream: azureOpenAIProvider.stream,
    streamSimple: azureOpenAIProvider.streamSimple,
  });

  registerApiProvider<"azure-openai-responses", AzureOpenAIResponsesOptions>({
    api: "azure-openai-responses",
    stream: azureOpenAIResponsesProvider.stream,
    streamSimple: azureOpenAIResponsesProvider.streamSimple,
  });
}
