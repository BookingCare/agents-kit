import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const closeMock = vi.fn();
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
const clientCtorMock = vi.fn();
const transportCtorMock = vi.fn();
const stdioTransportCtorMock = vi.fn();

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
      { name: "test-server", version: "0.4.1" },
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
      { name: "stdio-server", version: "0.4.1" },
      { capabilities: {} },
    );
  });

  it("throws on mismatched transports and connection types", () => {
    expect(() =>
      createMcpClient({
        ...config,
        transport: "sse",
        connection: { type: "stdio", command: "node" },
      } as McpServerConfig),
    ).toThrow(
      'MCP transport/connection mismatch: transport "sse" does not match connection.type "stdio"',
    );
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
