import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type McpServerConfig =
  | {
      name: string;
      transport: "stdio";
      connection: { type: "stdio"; command: string; args?: string[] };
    }
  | {
      name: string;
      transport: "sse";
      connection: { type: "sse"; url: string };
    }
  | {
      name: string;
      transport: "http";
      connection: { type: "http"; url: string; headers?: Record<string, string> };
    };

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

const packageVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
) as { version: string };

export function createMcpClient(config: McpServerConfig): McpClient {
  if (config.transport !== config.connection.type) {
    throw new Error(
      `MCP transport/connection mismatch: transport "${config.transport}" does not match connection.type "${config.connection.type}"`,
    );
  }

  return new SdkMcpClient(config);
}

class SdkMcpClient implements McpClient {
  private readonly client: Client;
  private readonly transport:
    | SSEClientTransport
    | StdioClientTransport
    | StreamableHTTPClientTransport;

  constructor(config: McpServerConfig) {
    switch (config.transport) {
      case "stdio": {
        const { command, args = [] } = config.connection;
        this.transport = new StdioClientTransport({ command, args });
        break;
      }
      case "sse":
        this.transport = new SSEClientTransport(createTransportUrl(config.connection.url, "SSE"));
        break;
      case "http": {
        const { headers, url } = config.connection;
        this.transport = new StreamableHTTPClientTransport(createTransportUrl(url, "HTTP"), {
          requestInit: headers ? { headers: validateHttpHeaders(headers) } : undefined,
        });
        break;
      }
      default: {
        const unsupportedConfig = config as { transport: string };
        throw new Error(`Unsupported MCP transport: ${unsupportedConfig.transport}`);
      }
    }

    this.client = new Client(
      {
        name: config.name,
        version: packageVersion.version,
      },
      {
        capabilities: {},
      },
    );
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({
      name,
      arguments: args,
    });

    return (result.content as Array<{ type: string; text?: string }>)
      .map((item) => (item.type === "text" ? (item.text ?? "") : ""))
      .join("");
  }
}

function createTransportUrl(url: string, label: "SSE" | "HTTP"): URL {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`MCP ${label} connection requires a url`);
  }

  try {
    return new URL(url);
  } catch (error) {
    throw new Error(`MCP ${label} connection requires a valid url`, { cause: error });
  }
}

function validateHttpHeaders(headers: unknown): Record<string, string> {
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("MCP HTTP connection headers must be an object");
  }

  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string") {
      throw new Error(`MCP HTTP connection header "${name}" must be a string`);
    }
  }

  return headers as Record<string, string>;
}
