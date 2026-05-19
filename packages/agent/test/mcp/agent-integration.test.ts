import { Type } from "@bookingcare/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../../src/agent.js";
import type { McpServerConfig } from "../../src/mcp/client.js";

const addServerMock = vi.fn();
const getAllToolsMock = vi.fn();
const callToolMock = vi.fn();
const shutdownMock = vi.fn();

vi.mock("../../src/mcp/registry.js", () => ({
  McpRegistry: class {
    addServer = addServerMock;
    getAllTools = getAllToolsMock;
    callTool = callToolMock;
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
    getAllToolsMock.mockReset();
    callToolMock.mockReset();
    shutdownMock.mockReset();
    addServerMock.mockResolvedValue(undefined);
    getAllToolsMock.mockResolvedValue([
      { name: "alpha:lookup", description: "Lookup", parameters: Type.Object({}) },
      { name: "beta:lookup", description: "Lookup", parameters: Type.Object({}) },
    ]);
    callToolMock.mockResolvedValue("lookup-result");
    shutdownMock.mockResolvedValue(undefined);
  });

  it("connects MCP servers during initialization, exposes their tools, and shuts them down", async () => {
    const agent = new Agent({ mcpServers: [createServer("alpha"), createServer("beta")] });

    await agent.shutdown();

    expect(addServerMock).toHaveBeenCalledTimes(2);
    expect(addServerMock).toHaveBeenNthCalledWith(1, createServer("alpha"));
    expect(addServerMock).toHaveBeenNthCalledWith(2, createServer("beta"));
    expect(getAllToolsMock).toHaveBeenCalledTimes(1);
    expect(agent.state.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["alpha:lookup", "beta:lookup"]),
    );

    const lookupTool = agent.state.tools.find((tool) => tool.name === "alpha:lookup");
    expect(lookupTool).toBeDefined();
    await expect(lookupTool!.execute("call-1", {})).resolves.toEqual({
      content: "lookup-result",
    });
    expect(callToolMock).toHaveBeenCalledWith("alpha:lookup", {});
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces MCP initialization failures", async () => {
    addServerMock.mockRejectedValueOnce(new Error("connect failed"));

    const agent = new Agent({ mcpServers: [createServer("alpha")] });

    await expect(agent.shutdown()).rejects.toThrow("connect failed");
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });
});
