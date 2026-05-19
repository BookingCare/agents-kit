import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse" | "websocket";
  connection: { type: "stdio" | "sse" | "websocket"; [key: string]: unknown };
  auth?: {
    type: "bearer" | "basic" | "none";
    token?: string;
    username?: string;
    password?: string;
  };
}

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

export function createMcpClient(config: McpServerConfig): McpClient {
  if (config.transport !== "sse" || config.connection.type !== "sse") {
    throw new Error(`Unsupported MCP transport: ${config.transport}`);
  }

  return new SdkMcpClient(config);
}

class SdkMcpClient implements McpClient {
  private readonly client: Client;
  private readonly transport: SSEClientTransport;

  constructor(config: McpServerConfig) {
    const url = config.connection.url;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("MCP SSE connection requires a url");
    }

    this.transport = new SSEClientTransport(new URL(url));
    this.client = new Client(
      {
        name: config.name,
        version: "0.4.1",
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

    return result.content.map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("");
  }
}
