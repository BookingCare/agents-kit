import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServerConfig } from "./registry.js";

export interface McpConfig {
  servers: McpServerConfig[];
}

export async function loadMcpConfig(dir: string = process.cwd()): Promise<McpConfig> {
  const paths = [resolve(dir, ".mcp.json"), resolve(dir, ".mcp/config.json")];

  for (const path of paths) {
    try {
      const content = await readFile(path, "utf-8");
      return JSON.parse(content) as McpConfig;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }

  return { servers: [] };
}
