import type { Tool } from "@bookingcare/ai";
import type { McpClient, McpServerConfig } from "./client.js";
import { createMcpClient } from "./client.js";
import { convertMcpToolToTool } from "./schema-adapter.js";

export type { McpServerConfig } from "./client.js";

export class McpRegistry {
  private readonly clients = new Map<string, McpClient>();

  async addServer(config: McpServerConfig): Promise<void> {
    if (this.clients.has(config.name)) {
      throw new Error(`MCP server already exists: ${config.name}`);
    }

    const client = createMcpClient(config);
    await client.connect();
    this.clients.set(config.name, client);
  }

  async removeServer(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (!client) {
      throw new Error(`Unknown MCP server: ${name}`);
    }

    await client.disconnect();
    this.clients.delete(name);
  }

  async getAllTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    for (const [serverName, client] of this.clients) {
      const mcpTools = await client.listTools();
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

    const tools = await client.listTools();
    const tool = tools.find((item) => item.name === actualToolName);
    if (!tool) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }

    return await client.callTool(actualToolName, args);
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.disconnect();
    }
    this.clients.clear();
  }
}
