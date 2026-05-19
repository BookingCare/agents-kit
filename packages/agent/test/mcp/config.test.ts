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
});
