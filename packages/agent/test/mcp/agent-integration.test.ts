import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/agent.js";
import type { McpServerConfig } from "../../src/mcp/client.js";

const addServerMock = vi.fn();
const shutdownMock = vi.fn();

vi.mock("../../src/mcp/registry.js", () => ({
  McpRegistry: class {
    addServer = addServerMock;
    shutdown = shutdownMock;
  },
}));

function createServer(name: string): McpServerConfig {
  return {
    name,
    transport: "sse",
    connection: { type: "sse", url: `http://${name}/sse` },
  };
}

describe("Agent MCP integration", () => {
  beforeEach(() => {
    addServerMock.mockReset();
    shutdownMock.mockReset();
    addServerMock.mockResolvedValue(undefined);
    shutdownMock.mockResolvedValue(undefined);
  });

  it("connects MCP servers during initialization and shuts them down", async () => {
    const agent = new Agent({ mcpServers: [createServer("alpha"), createServer("beta")] });

    await agent.shutdown();

    expect(addServerMock).toHaveBeenCalledTimes(2);
    expect(addServerMock).toHaveBeenNthCalledWith(1, createServer("alpha"));
    expect(addServerMock).toHaveBeenNthCalledWith(2, createServer("beta"));
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces MCP initialization failures", async () => {
    addServerMock.mockRejectedValueOnce(new Error("connect failed"));

    const agent = new Agent({ mcpServers: [createServer("alpha")] });

    await expect(agent.shutdown()).rejects.toThrow("connect failed");
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });
});
