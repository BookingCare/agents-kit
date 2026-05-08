export interface AzureOpenAIEnvConfig {
  endpoint: string;
  apiKey: string;
  apiVersion?: string;
}

export function detectAzureOpenAIConfig(): AzureOpenAIEnvConfig | undefined {
  const endpoint = process.env["AZURE_OPENAI_ENDPOINT"];
  const apiKey = process.env["AZURE_OPENAI_API_KEY"];
  if (!endpoint || !apiKey) return undefined;
  return {
    endpoint,
    apiKey,
    apiVersion: process.env["AZURE_OPENAI_API_VERSION"],
  };
}
