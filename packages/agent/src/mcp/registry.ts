import type { Tool } from "@bookingcare/ai";
import type { McpClient, McpServerConfig, McpTool } from "./client.js";
import { createMcpClient } from "./client.js";
import { convertMcpToolToTool } from "./schema-adapter.js";

export type { McpServerConfig } from "./client.js";

export class McpRegistry {
  private readonly clients = new Map<string, McpClient>();
  private readonly toolCache = new Map<string, McpTool[]>();

  async addServer(config: McpServerConfig): Promise<void> {
    if (config.name.includes(":")) {
      throw new Error(`Invalid MCP server name: ${config.name}. ":" is reserved for tool routing.`);
    }

    if (this.clients.has(config.name)) {
      throw new Error(`MCP server already exists: ${config.name}`);
    }

    const client = createMcpClient(config);
    await client.connect();

    try {
      const tools = await client.listTools();
      this.clients.set(config.name, client);
      this.toolCache.set(config.name, tools);
    } catch (error) {
      await client.disconnect();
      throw error;
    }
  }

  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`Unknown MCP server: ${name}`);
    }

    await client.disconnect();
    this.clients.delete(name);
    this.toolCache.delete(name);
  }

  async getAllTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const [serverName] of this.clients) {
      const mcpTools = this.toolCache.get(serverName);
      if (!mcpTools) {
        throw new Error(`Unknown MCP server: ${serverName}`);
      }

      for (const mcpTool of mcpTools) {
        tools.push(convertMcpToolToTool(mcpTool, serverName));
      }
    }
    return tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    const separatorIndex = toolName.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === toolName.length - 1) {
      throw new Error(`Invalid MCP tool name: ${toolName}`);
    }

    const serverName = toolName.slice(0, separatorIndex);
    const actualToolName = toolName.slice(separatorIndex + 1);
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    const tools = this.toolCache.get(serverName);
    if (!tools) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    const tool = tools.find((item) => item.name === actualToolName);
    if (!tool) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }

    return await client.callTool(actualToolName, args);
  }

  async shutdown(): Promise<void> {
    const errors: Error[] = [];

    for (const [serverName, client] of this.clients) {
      try {
        await client.disconnect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(new Error(`Failed to disconnect MCP server ${serverName}: ${message}`));
      }
    }

    this.clients.clear();
    this.toolCache.clear();

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Failed to disconnect one or more MCP servers during shutdown.",
      );
    }
  }
}
