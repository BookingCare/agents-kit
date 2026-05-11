import { registerProvider } from "../provider-registry.js";
import { azureOpenAIProvider } from "./azure-openai.js";

let registered = false;

export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;

  registerProvider("azure-openai-completions", azureOpenAIProvider);
}
