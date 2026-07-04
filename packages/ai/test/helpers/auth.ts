import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const AUTH_PATH = resolve(import.meta.dirname, "../../../../.agents/auth.json");

export interface AuthConfig {
  AZURE_OPENAI_ENDPOINT: string;
  AZURE_OPENAI_API_KEY: string;
  AZURE_OPENAI_API_VERSION?: string;
  AZURE_OPENAI_DEPLOYMENT_NAME_MAP?: string;
}

function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!value) return map;

  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const [modelId, deploymentName] = trimmed.split("=", 2);
    if (!modelId || !deploymentName) continue;

    map.set(modelId.trim(), deploymentName.trim());
  }

  return map;
}

/**
 * Load credentials from `.agents/auth.json`.
 * Returns `undefined` if the file is missing or contains placeholder values.
 */
export function loadAuth(): AuthConfig | undefined {
  let raw: AuthConfig;
  try {
    raw = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as AuthConfig;
  } catch {
    return undefined;
  }

  if (!raw.AZURE_OPENAI_ENDPOINT || !raw.AZURE_OPENAI_API_KEY) return undefined;
  if (raw.AZURE_OPENAI_API_KEY.startsWith("<")) return undefined;
  return raw;
}

/**
 * Set process.env from auth config for provider auto-detection.
 * Call before any provider imports resolve (i.e. at module level in test files).
 */
export function applyAuth(): AuthConfig | undefined {
  const auth = loadAuth();
  if (!auth) return undefined;

  process.env.AZURE_OPENAI_ENDPOINT = auth.AZURE_OPENAI_ENDPOINT;
  process.env.AZURE_OPENAI_API_KEY = auth.AZURE_OPENAI_API_KEY;
  if (auth.AZURE_OPENAI_API_VERSION) {
    process.env.AZURE_OPENAI_API_VERSION = auth.AZURE_OPENAI_API_VERSION;
  }
  if (auth.AZURE_OPENAI_DEPLOYMENT_NAME_MAP) {
    process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = auth.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
  }

  return auth;
}

export function resolveAzureDeploymentName(modelId: string): string | undefined {
  return parseDeploymentNameMap(process.env["AZURE_OPENAI_DEPLOYMENT_NAME_MAP"]).get(modelId);
}
