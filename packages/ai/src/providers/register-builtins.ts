import { registerProvider } from "../provider-registry.js";
import { streamAzureOpenAI } from "./azure-openai.js";

let registered = false;

export function registerBuiltinProviders(): void {
  if (registered) return;
  registered = true;

  registerProvider("azure-openai", streamAzureOpenAI);
}
