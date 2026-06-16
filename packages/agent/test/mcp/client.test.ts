import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const closeMock = vi.fn();
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
const clientCtorMock = vi.fn();
const transportCtorMock = vi.fn();
const stdioTransportCtorMock = vi.fn();
const httpTransportCtorMock = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = connectMock;
    close = closeMock;
    listTools = listToolsMock;
    callTool = callToolMock;

    constructor(...args: unknown[]) {
      clientCtorMock(...args);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class {
    constructor(...args: unknown[]) {
      transportCtorMock(...args);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    constructor(...args: unknown[]) {
      stdioTransportCtorMock(...args);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor(...args: unknown[]) {
      httpTransportCtorMock(...args);
    }
  },
}));

import { createMcpClient, type McpServerConfig } from "../../src/mcp/client.js";

describe("createMcpClient", () => {
  const config: McpServerConfig = {
    name: "test-server",
    transport: "sse",
    connection: { type: "sse", url: "http://example.com/sse" },
  };

  beforeEach(() => {
    connectMock.mockReset();
    closeMock.mockReset();
    listToolsMock.mockReset();
    callToolMock.mockReset();
    clientCtorMock.mockReset();
    transportCtorMock.mockReset();
    stdioTransportCtorMock.mockReset();
    httpTransportCtorMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("connects, lists tools, and calls tools over the SDK transport", async () => {
    listToolsMock.mockResolvedValue({
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
    });
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });

    const client = createMcpClient(config);
    await client.connect();

    await expect(client.listTools()).resolves.toEqual([
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    ]);
    await expect(client.callTool("echo", { message: "hi" })).resolves.toBe("ok");

    expect(transportCtorMock).toHaveBeenCalledWith(new URL("http://example.com/sse"));
    expect(clientCtorMock).toHaveBeenCalledWith(
      { name: "test-server", version: "0.5.0" },
      { capabilities: {} },
    );
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty string for non-text tool content", async () => {
    callToolMock.mockResolvedValue({ content: [{ type: "resource", resource: { text: "x" } }] });

    const client = createMcpClient(config);
    await client.connect();

    await expect(client.callTool("echo", {})).resolves.toBe("");
  });

  it("throws on invalid connection urls", () => {
    expect(() =>
      createMcpClient({
        ...config,
        connection: { type: "sse", url: "" },
      }),
    ).toThrow("MCP SSE connection requires a url");
  });

  it("creates a stdio transport with the provided command and args", async () => {
    const stdioConfig: McpServerConfig = {
      name: "stdio-server",
      transport: "stdio",
      connection: { type: "stdio", command: "node", args: ["server.js"] },
    };

    const client = createMcpClient(stdioConfig);
    await client.connect();

    expect(stdioTransportCtorMock).toHaveBeenCalledWith({
      command: "node",
      args: ["server.js"],
    });
    expect(clientCtorMock).toHaveBeenCalledWith(
      { name: "stdio-server", version: "0.5.0" },
      { capabilities: {} },
    );
  });

  it("creates a Streamable HTTP transport with request headers", async () => {
    const httpConfig: McpServerConfig = {
      name: "http-server",
      transport: "http",
      connection: {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: {
          authorization: "Bearer token",
          "cf-access-client-id": "client-id",
        },
      },
    };

    listToolsMock.mockResolvedValue({
      tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
    });
    callToolMock.mockResolvedValue({
      content: [{ type: "text", text: "result" }],
    });

    const client = createMcpClient(httpConfig);
    await client.connect();

    await expect(client.listTools()).resolves.toEqual([
      { name: "lookup", description: "Lookup", inputSchema: { type: "object" } },
    ]);
    await expect(client.callTool("lookup", { query: "hello" })).resolves.toBe("result");

    expect(httpTransportCtorMock).toHaveBeenCalledWith(new URL("https://mcp.example.com/mcp"), {
      requestInit: {
        headers: {
          authorization: "Bearer token",
          "cf-access-client-id": "client-id",
        },
      },
    });
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces Streamable HTTP initialization failures", async () => {
    const httpConfig: McpServerConfig = {
      name: "http-server",
      transport: "http",
      connection: { type: "http", url: "https://mcp.example.com/mcp" },
    };
    const error = new Error("HTTP 500 during MCP initialization");
    connectMock.mockRejectedValue(error);

    const client = createMcpClient(httpConfig);
    await expect(client.connect()).rejects.toThrow("HTTP 500 during MCP initialization");
  });

  it("throws on mismatched transports and connection types", () => {
    expect(() =>
      createMcpClient({
        ...config,
        transport: "sse",
        connection: { type: "stdio", command: "node" },
      } as unknown as McpServerConfig),
    ).toThrow(
      'MCP transport/connection mismatch: transport "sse" does not match connection.type "stdio"',
    );
  });

  it("throws on invalid HTTP connection urls", () => {
    expect(() =>
      createMcpClient({
        name: "http-server",
        transport: "http",
        connection: { type: "http", url: "" },
      }),
    ).toThrow("MCP HTTP connection requires a url");
  });

  it("throws on invalid HTTP headers", () => {
    expect(() =>
      createMcpClient({
        name: "http-server",
        transport: "http",
        connection: {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { authorization: 123 },
        },
      } as unknown as McpServerConfig),
    ).toThrow('MCP HTTP connection header "authorization" must be a string');
  });

  it("throws on unsupported transports", () => {
    expect(() =>
      createMcpClient({
        ...config,
        transport: "websocket",
        connection: { type: "websocket" },
      } as unknown as McpServerConfig),
    ).toThrow("Unsupported MCP transport: websocket");
  });

  it("closes the sdk client on disconnect", async () => {
    const client = createMcpClient(config);
    await client.disconnect();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
