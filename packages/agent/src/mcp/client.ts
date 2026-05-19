import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse" | "websocket";
  connection:
    | { type: "stdio"; command: string; args?: string[] }
    | { type: "sse"; url: string }
    | { type: "websocket"; [key: string]: unknown };
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
  if (config.transport !== config.connection.type) {
    throw new Error(`Unsupported MCP transport: ${config.transport}`);
  }

  if (config.transport !== "stdio" && config.transport !== "sse") {
    throw new Error(`Unsupported MCP transport: ${config.transport}`);
  }

  return new SdkMcpClient(config);
}

class SdkMcpClient implements McpClient {
  private readonly client: Client;
  private readonly transport: SSEClientTransport | StdioClientTransport;

  constructor(config: McpServerConfig) {
    if (config.transport === "stdio") {
      const { command, args = [] } = config.connection as Extract<
        McpServerConfig["connection"],
        { type: "stdio" }
      >;
      this.transport = new StdioClientTransport({
        command,
        args,
      });
    } else if (config.transport === "sse") {
      const { url } = config.connection as Extract<McpServerConfig["connection"], { type: "sse" }>;
      if (typeof url !== "string" || url.length === 0) {
        throw new Error("MCP SSE connection requires a url");
      }

      this.transport = new SSEClientTransport(new URL(url));
    } else {
      throw new Error(`Unsupported MCP transport: ${config.transport}`);
    }

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

    return (result.content as Array<{ type: string; text?: string }>)
      .map((item) => (item.type === "text" ? (item.text ?? "") : ""))
      .join("");
  }
}
