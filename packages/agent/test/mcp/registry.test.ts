import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpRegistry, type McpServerConfig } from "../../src/mcp/registry.js";

const { createMcpClientMock } = vi.hoisted(() => ({
  createMcpClientMock: vi.fn(),
}));

vi.mock("../../src/mcp/client.js", () => ({
  createMcpClient: createMcpClientMock,
}));

function createClient(
  options: {
    tools?: Array<{ name: string; description?: string; inputSchema: unknown }>;
    callTool?: (name: string, args: Record<string, unknown>) => Promise<string> | string;
  } = {},
) {
  const tools = options.tools ?? [];
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn(options.callTool ?? (async () => "ok")),
  };
}

describe("McpRegistry", () => {
  const serverA: McpServerConfig = {
    name: "alpha",
    transport: "sse",
    connection: { type: "sse", url: "http://alpha/sse" },
  };

  const serverB: McpServerConfig = {
    name: "beta",
    transport: "sse",
    connection: { type: "sse", url: "http://beta/sse" },
  };

  beforeEach(() => {
    createMcpClientMock.mockReset();
  });

  it("adds servers, aggregates tools, and prefixes tool names", async () => {
    const alphaClient = createClient({
      tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
    });
    const betaClient = createClient({
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
    });
    createMcpClientMock.mockReturnValueOnce(alphaClient).mockReturnValueOnce(betaClient);

    const registry = new McpRegistry();
    await registry.addServer(serverA);
    await registry.addServer(serverB);

    await expect(registry.getAllTools()).resolves.toEqual([
      expect.objectContaining({ name: "alpha:lookup", description: "Lookup" }),
      expect.objectContaining({ name: "beta:echo", description: "Echo" }),
    ]);

    expect(alphaClient.connect).toHaveBeenCalledTimes(1);
    expect(betaClient.connect).toHaveBeenCalledTimes(1);
  });

  it("delegates tool calls to the correct server", async () => {
    const alphaClient = createClient({
      tools: [{ name: "lookup", inputSchema: { type: "object" } }],
      callTool: async (name) => `alpha:${name}`,
    });
    createMcpClientMock.mockReturnValueOnce(alphaClient);

    const registry = new McpRegistry();
    await registry.addServer(serverA);

    await expect(registry.callTool("alpha:lookup", { q: "x" })).resolves.toBe("alpha:lookup");
    expect(alphaClient.callTool).toHaveBeenCalledWith("lookup", { q: "x" });
  });

  it("throws on unknown servers, tools, and invalid names", async () => {
    const registry = new McpRegistry();

    await expect(registry.callTool("missing:lookup", {})).rejects.toThrow(
      "Unknown MCP server: missing",
    );
    await expect(registry.callTool("missing", {})).rejects.toThrow(
      "Invalid MCP tool name: missing",
    );

    const client = createClient({ tools: [] });
    createMcpClientMock.mockReturnValueOnce(client);
    await registry.addServer(serverA);
    await expect(registry.callTool("alpha:lookup", {})).rejects.toThrow(
      "Unknown MCP tool: alpha:lookup",
    );
  });

  it("removes servers and shuts down all clients", async () => {
    const alphaClient = createClient();
    const betaClient = createClient();
    createMcpClientMock.mockReturnValueOnce(alphaClient).mockReturnValueOnce(betaClient);

    const registry = new McpRegistry();
    await registry.addServer(serverA);
    await registry.addServer(serverB);

    await registry.removeServer("alpha");
    expect(alphaClient.disconnect).toHaveBeenCalledTimes(1);

    await registry.shutdown();
    expect(betaClient.disconnect).toHaveBeenCalledTimes(1);
    await expect(registry.getAllTools()).resolves.toEqual([]);
  });
});
