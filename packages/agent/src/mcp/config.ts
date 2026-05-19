import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServerConfig } from "./registry.js";

export interface McpConfig {
  servers: McpServerConfig[];
}

export async function loadMcpConfig(path: string = process.cwd()): Promise<McpConfig> {
  const directConfig = await readMcpConfigIfFile(path);
  if (directConfig) {
    return directConfig;
  }

  const paths = [resolve(path, ".mcp.json"), resolve(path, ".mcp/config.json")];

  for (const candidate of paths) {
    const config = await readMcpConfigIfFile(candidate);
    if (config) {
      return config;
    }
  }

  return { servers: [] };
}

async function readMcpConfigIfFile(path: string): Promise<McpConfig | undefined> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return undefined;
    }

    const content = await readFile(path, "utf-8");
    return parseMcpConfig(content);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }

    throw error;
  }
}

function parseMcpConfig(content: string): McpConfig {
  const parsed = JSON.parse(content) as { servers?: unknown };
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid MCP config: expected an object");
  }

  if (parsed.servers === undefined) {
    return { servers: [] };
  }

  if (!Array.isArray(parsed.servers)) {
    throw new Error("Invalid MCP config: servers must be an array");
  }

  return { servers: parsed.servers as McpServerConfig[] };
}
