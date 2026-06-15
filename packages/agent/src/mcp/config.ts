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
  const parsed = JSON.parse(content) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid MCP config: expected an object");
  }

  const config = parsed as Record<string, unknown>;

  if (config.servers !== undefined && config.mcpServers !== undefined) {
    throw new Error("Invalid MCP config: use either servers or mcpServers, not both");
  }

  if (config.mcpServers !== undefined) {
    return { servers: parseMcpServers(config.mcpServers) };
  }

  if (config.servers === undefined) {
    return { servers: [] };
  }

  if (!Array.isArray(config.servers)) {
    throw new Error("Invalid MCP config: servers must be an array");
  }

  return {
    servers: config.servers.map((server, index) => parseServerConfig(server, `servers[${index}]`)),
  };
}

function parseMcpServers(value: unknown): McpServerConfig[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid MCP config: mcpServers must be an object");
  }

  return Object.entries(value).map(([name, server]) => parseObjectStyleServer(name, server));
}

function parseObjectStyleServer(name: string, value: unknown): McpServerConfig {
  const server = requireObject(value, `mcpServers.${name}`);
  const transport = parseTransport(server.type, `mcpServers.${name}.type`);

  if (transport === "stdio") {
    const command = requireString(server.command, `mcpServers.${name}.command`);
    const args = parseOptionalStringArray(server.args, `mcpServers.${name}.args`);

    return {
      name,
      transport,
      connection:
        args === undefined ? { type: transport, command } : { type: transport, command, args },
    };
  }

  if (transport === "sse") {
    return {
      name,
      transport,
      connection: {
        type: transport,
        url: requireString(server.url, `mcpServers.${name}.url`),
      },
    };
  }

  const headers = parseOptionalHeaders(server.headers, `mcpServers.${name}.headers`);

  return {
    name,
    transport,
    connection: {
      type: transport,
      url: requireString(server.url, `mcpServers.${name}.url`),
      ...(headers === undefined ? {} : { headers }),
    },
  };
}

function parseServerConfig(value: unknown, context: string): McpServerConfig {
  const server = requireObject(value, context);
  const name = requireString(server.name, `${context}.name`);
  const transport = parseTransport(server.transport, `${context}.transport`);
  const connection = requireObject(server.connection, `${context}.connection`);
  const connectionType = requireString(connection.type, `${context}.connection.type`);

  if (transport !== connectionType) {
    throw new Error(
      `MCP transport/connection mismatch: transport "${transport}" does not match connection.type "${connectionType}"`,
    );
  }

  if (transport === "stdio") {
    const command = requireString(connection.command, `${context}.connection.command`);
    const args = parseOptionalStringArray(connection.args, `${context}.connection.args`);

    return {
      name,
      transport,
      connection:
        args === undefined ? { type: transport, command } : { type: transport, command, args },
    };
  }

  if (transport === "sse") {
    return {
      name,
      transport,
      connection: {
        type: transport,
        url: requireString(connection.url, `${context}.connection.url`),
      },
    };
  }

  const headers = parseOptionalHeaders(connection.headers, `${context}.connection.headers`);

  return {
    name,
    transport,
    connection: {
      type: transport,
      url: requireString(connection.url, `${context}.connection.url`),
      ...(headers === undefined ? {} : { headers }),
    },
  };
}

function requireObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid MCP config: ${context} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid MCP config: ${context} must be a non-empty string`);
  }

  return value;
}

function parseTransport(value: unknown, context: string): "stdio" | "sse" | "http" {
  if (value !== "stdio" && value !== "sse" && value !== "http") {
    throw new Error(`Invalid MCP config: ${context} must be one of stdio, sse, http`);
  }

  return value;
}

function parseOptionalStringArray(value: unknown, context: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid MCP config: ${context} must be an array of strings`);
  }

  return value;
}

function parseOptionalHeaders(value: unknown, context: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const headers = requireObject(value, context);
  const result: Record<string, string> = {};

  for (const [name, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      throw new Error(`Invalid MCP config: ${context}.${name} must be a string`);
    }

    result[name] = interpolateEnv(headerValue, `${context}.${name}`);
  }

  return result;
}

function interpolateEnv(value: string, context: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const envValue = process.env[name];
    if (envValue === undefined) {
      throw new Error(
        `Invalid MCP config: ${context} references missing environment variable ${name}`,
      );
    }

    return envValue;
  });
}
