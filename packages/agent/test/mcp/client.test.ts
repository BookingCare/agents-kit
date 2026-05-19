import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const closeMock = vi.fn();
const listToolsMock = vi.fn();
const callToolMock = vi.fn();
const clientCtorMock = vi.fn();
const transportCtorMock = vi.fn();

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

import { createMcpClient, type McpServerConfig } from "../../src/mcp/client.js";

describe("createMcpClient", () => {
  const config: McpServerConfig = {
    name: "test-server",
    transport: "sse",
    connection: { type: "sse", url: "http://example.com/sse" },
    auth: { type: "bearer", token: "secret-token" },
  };

  beforeEach(() => {
    connectMock.mockReset();
    closeMock.mockReset();
    listToolsMock.mockReset();
    callToolMock.mockReset();
    clientCtorMock.mockReset();
    transportCtorMock.mockReset();
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

  it("throws on unsupported transports", () => {
    expect(() =>
      createMcpClient({
        ...config,
        transport: "stdio",
        connection: { type: "stdio" },
      }),
    ).toThrow("Unsupported MCP transport: stdio");
  });

  it("closes the sdk client on disconnect", async () => {
    const client = createMcpClient(config);
    await client.disconnect();
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
