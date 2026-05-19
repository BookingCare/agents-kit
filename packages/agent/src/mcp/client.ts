export interface McpServerConfig {
  name: string;
  transport: "stdio" | "sse" | "websocket";
  connection: { type: "stdio" | "sse" | "websocket"; [key: string]: any };
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
  inputSchema: any;
}

export interface McpClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: JsonRpcError;
}

interface McpSseEvent {
  event?: string;
  data: string;
}

const JSON_RPC_VERSION = "2.0";

export function createMcpClient(config: McpServerConfig): McpClient {
  if (config.transport !== "sse" || config.connection.type !== "sse") {
    throw new Error(`Unsupported MCP transport: ${config.transport}`);
  }

  return new SseMcpClient(config);
}

class SseMcpClient implements McpClient {
  private readonly config: McpServerConfig;
  private readonly headers: Headers;
  private messageEndpoint?: string;
  private connected = false;
  private requestId = 0;

  constructor(config: McpServerConfig) {
    this.config = config;
    this.headers = new Headers({ Accept: "text/event-stream" });
    if (config.auth?.type === "bearer" && config.auth.token) {
      this.headers.set("Authorization", `Bearer ${config.auth.token}`);
    }
    if (
      config.auth?.type === "basic" &&
      config.auth.username !== undefined &&
      config.auth.password !== undefined
    ) {
      const encoded = Buffer.from(`${config.auth.username}:${config.auth.password}`).toString(
        "base64",
      );
      this.headers.set("Authorization", `Basic ${encoded}`);
    }
  }

  async connect(): Promise<void> {
    const url = this.getConnectionUrl();
    let response: Response;
    try {
      response = await fetch(url, { headers: this.headers });
    } catch (error) {
      throw new Error(`Failed to connect to MCP SSE server: ${this.describeError(error)}`);
    }

    if (!response.ok || !response.body) {
      throw new Error(`Failed to connect to MCP SSE server: HTTP ${response.status}`);
    }

    const stream = response.body.getReader();
    try {
      const endpoint = await this.readEndpointFromStream(stream);
      this.messageEndpoint = endpoint ?? this.deriveMessageEndpoint(url);
      this.connected = true;
    } finally {
      await stream.cancel().catch(() => undefined);
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.messageEndpoint = undefined;
  }

  async listTools(): Promise<McpTool[]> {
    const response = await this.request<{ tools?: McpTool[] }>("tools/list", {});
    return response.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const response = await this.request<{ content?: Array<{ type?: string; text?: string }> }>(
      "tools/call",
      {
        name,
        arguments: args,
      },
    );

    const textContent = response.content?.map((item) => item.text ?? "").join("");
    return textContent ?? "";
  }

  private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.connected || !this.messageEndpoint) {
      throw new Error("MCP client is not connected");
    }

    const request: JsonRpcRequest = {
      jsonrpc: JSON_RPC_VERSION,
      id: ++this.requestId,
      method,
      params,
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    this.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let response: Response;
    try {
      response = await fetch(this.messageEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
      });
    } catch (error) {
      throw new Error(`Failed to send MCP request: ${this.describeError(error)}`);
    }

    if (!response.ok) {
      throw new Error(`MCP request failed: HTTP ${response.status}`);
    }

    const payload = (await response.json()) as JsonRpcResponse<T>;
    if (payload.error) {
      throw new Error(`MCP error ${payload.error.code}: ${payload.error.message}`);
    }
    return payload.result ?? ({} as T);
  }

  private getConnectionUrl(): string {
    const url = this.config.connection.url;
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("MCP SSE connection requires a url");
    }
    return url;
  }

  private deriveMessageEndpoint(url: string): string {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/sse")) {
      parsed.pathname = `${parsed.pathname.slice(0, -4)}/messages`;
      return parsed.toString();
    }
    return new URL("messages", url).toString();
  }

  private async readEndpointFromStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<string | undefined> {
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return undefined;
      }
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\n\n/);
      buffer = events.pop() ?? "";
      for (const rawEvent of events) {
        const event = this.parseSseEvent(rawEvent);
        if (event.event === "endpoint") {
          return event.data.trim();
        }
      }
    }
  }

  private parseSseEvent(rawEvent: string): McpSseEvent {
    const lines = rawEvent.split(/\r?\n/);
    let event: string | undefined;
    const data: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":") || line.length === 0) continue;
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trim());
      }
    }
    return { event, data: data.join("\n") };
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
