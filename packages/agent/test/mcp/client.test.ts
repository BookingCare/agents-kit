import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createMcpClient, type McpServerConfig } from "../../src/mcp/client.js";

function sseResponse(body: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });

  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createMcpClient", () => {
  const config: McpServerConfig = {
    name: "test-server",
    transport: "sse",
    connection: { type: "sse", url: "http://example.com/sse" },
    auth: { type: "bearer", token: "secret-token" },
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("connects, lists tools, and calls tools over SSE transport", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(sseResponse("event: endpoint\ndata: http://example.com/messages\n\n"))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: "ok" }] },
        }),
      );

    const client = createMcpClient(config);
    await client.connect();

    await expect(client.listTools()).resolves.toEqual([
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    ]);
    await expect(client.callTool("echo", { message: "hi" })).resolves.toBe("ok");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://example.com/sse", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://example.com/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret-token" }),
      }),
    );
  });

  it("falls back to a derived message endpoint when the SSE stream omits one", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(sseResponse(": keep-alive\n\n"))
      .mockResolvedValueOnce(jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));

    const client = createMcpClient(config);
    await client.connect();
    await client.listTools();

    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://example.com/messages", expect.any(Object));
  });

  it("throws on connection failures", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const client = createMcpClient(config);
    await expect(client.connect()).rejects.toThrow(
      "Failed to connect to MCP SSE server: network down",
    );
  });

  it("throws MCP errors returned from JSON-RPC", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(sseResponse("event: endpoint\ndata: http://example.com/messages\n\n"))
      .mockResolvedValueOnce(
        jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "Method not found" },
        }),
      );

    const client = createMcpClient(config);
    await client.connect();
    await expect(client.listTools()).rejects.toThrow("MCP error -32601: Method not found");
  });
});
