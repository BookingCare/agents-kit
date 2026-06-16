import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadMcpConfig } from "../../src/mcp/config.js";

function createTempDir(name: string): string {
  const dir = resolve(tmpdir(), `agent-mcp-config-${name}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
describe("loadMcpConfig", () => {
  it("loads servers from .mcp.json", async () => {
    const dir = createTempDir("root");
    try {
      writeFileSync(
        resolve(dir, ".mcp.json"),
        JSON.stringify({
          servers: [
            { name: "alpha", transport: "sse", connection: { type: "sse", url: "http://alpha" } },
          ],
        }),
      );

      await expect(loadMcpConfig(dir)).resolves.toEqual({
        servers: [
          { name: "alpha", transport: "sse", connection: { type: "sse", url: "http://alpha" } },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads servers from an explicit config file path", async () => {
    const dir = createTempDir("file");
    try {
      const configPath = resolve(dir, "custom-mcp.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          servers: [
            { name: "gamma", transport: "stdio", connection: { type: "stdio", command: "node" } },
          ],
        }),
      );

      await expect(loadMcpConfig(configPath)).resolves.toEqual({
        servers: [
          { name: "gamma", transport: "stdio", connection: { type: "stdio", command: "node" } },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads servers from .mcp/config.json", async () => {
    const dir = createTempDir("nested");
    try {
      mkdirSync(resolve(dir, ".mcp"), { recursive: true });
      writeFileSync(
        resolve(dir, ".mcp/config.json"),
        JSON.stringify({
          servers: [
            { name: "beta", transport: "stdio", connection: { type: "stdio", command: "node" } },
          ],
        }),
      );

      await expect(loadMcpConfig(dir)).resolves.toEqual({
        servers: [
          { name: "beta", transport: "stdio", connection: { type: "stdio", command: "node" } },
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads object-style mcpServers configs", async () => {
    const dir = createTempDir("object-style");
    const previousToken = process.env.MCP_AUTH_TOKEN;
    process.env.MCP_AUTH_TOKEN = "secret-token";

    try {
      writeFileSync(
        resolve(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "dentaltrip-kb": {
              type: "http",
              url: "https://mcp.example.com/mcp",
              headers: {
                authorization: "Bearer ${MCP_AUTH_TOKEN}",
                "cf-access-client-id": "client-id",
              },
            },
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
            legacy: {
              type: "sse",
              url: "http://localhost:3000/sse",
            },
          },
        }),
      );

      await expect(loadMcpConfig(dir)).resolves.toEqual({
        servers: [
          {
            name: "dentaltrip-kb",
            transport: "http",
            connection: {
              type: "http",
              url: "https://mcp.example.com/mcp",
              headers: {
                authorization: "Bearer secret-token",
                "cf-access-client-id": "client-id",
              },
            },
          },
          {
            name: "local",
            transport: "stdio",
            connection: { type: "stdio", command: "node", args: ["server.js"] },
          },
          {
            name: "legacy",
            transport: "sse",
            connection: { type: "sse", url: "http://localhost:3000/sse" },
          },
        ],
      });
    } finally {
      if (previousToken === undefined) {
        delete process.env.MCP_AUTH_TOKEN;
      } else {
        process.env.MCP_AUTH_TOKEN = previousToken;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty config when no file exists", async () => {
    const dir = createTempDir("empty");
    try {
      await expect(loadMcpConfig(dir)).resolves.toEqual({ servers: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults missing servers to an empty array", async () => {
    const dir = createTempDir("missing-servers");
    try {
      writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({}));
      await expect(loadMcpConfig(dir)).resolves.toEqual({ servers: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on invalid JSON", async () => {
    const dir = createTempDir("invalid");
    try {
      writeFileSync(resolve(dir, ".mcp.json"), "not json");
      await expect(loadMcpConfig(dir)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when servers and mcpServers are both present", async () => {
    const dir = createTempDir("mixed");
    try {
      writeFileSync(resolve(dir, ".mcp.json"), JSON.stringify({ servers: [], mcpServers: {} }));
      await expect(loadMcpConfig(dir)).rejects.toThrow(
        "Invalid MCP config: use either servers or mcpServers, not both",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on invalid object-style mcpServers", async () => {
    const dir = createTempDir("invalid-object-style");
    try {
      writeFileSync(
        resolve(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            remote: { type: "http" },
          },
        }),
      );

      await expect(loadMcpConfig(dir)).rejects.toThrow(
        "Invalid MCP config: mcpServers.remote.url must be a non-empty string",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on transport and connection type mismatches", async () => {
    const dir = createTempDir("mismatch");
    try {
      writeFileSync(
        resolve(dir, ".mcp.json"),
        JSON.stringify({
          servers: [
            {
              name: "remote",
              transport: "http",
              connection: { type: "sse", url: "https://mcp.example.com/mcp" },
            },
          ],
        }),
      );

      await expect(loadMcpConfig(dir)).rejects.toThrow(
        'MCP transport/connection mismatch: transport "http" does not match connection.type "sse"',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when config headers reference missing environment variables", async () => {
    const dir = createTempDir("missing-env");
    const previousToken = process.env.MCP_AUTH_TOKEN;
    delete process.env.MCP_AUTH_TOKEN;

    try {
      writeFileSync(
        resolve(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            remote: {
              type: "http",
              url: "https://mcp.example.com/mcp",
              headers: { authorization: "Bearer ${MCP_AUTH_TOKEN}" },
            },
          },
        }),
      );

      await expect(loadMcpConfig(dir)).rejects.toThrow(
        "Invalid MCP config: mcpServers.remote.headers.authorization references missing environment variable MCP_AUTH_TOKEN",
      );
    } finally {
      if (previousToken !== undefined) {
        process.env.MCP_AUTH_TOKEN = previousToken;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
