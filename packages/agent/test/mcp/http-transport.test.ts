import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpClient } from "../../src/mcp/client.js";

interface TestServer {
  url: string;
  seenAuthorizationHeaders: Array<string | undefined>;
  close(): Promise<void>;
}

function createSdkServer(): McpServer {
  const server = new McpServer({ name: "test-mcp-server", version: "1.0.0" });

  server.registerTool("lookup", { description: "Lookup a value" }, async () => ({
    content: [{ type: "text", text: "lookup-result" }],
  }));

  return server;
}

async function startStreamableHttpServer(options: {
  expectedAuthorization?: string;
  failRequests?: boolean;
}): Promise<TestServer> {
  const seenAuthorizationHeaders: Array<string | undefined> = [];

  const server = createServer(async (req, res) => {
    try {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }

      seenAuthorizationHeaders.push(req.headers.authorization);

      if (options.failRequests) {
        res.writeHead(500).end("initialization failed");
        return;
      }

      if (
        options.expectedAuthorization !== undefined &&
        req.headers.authorization !== options.expectedAuthorization
      ) {
        res.writeHead(401).end("unauthorized");
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }

      const sdkServer = createSdkServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const body = await readJsonBody(req);

      await sdkServer.connect(transport);
      await transport.handleRequest(req, res, body);

      res.on("close", () => {
        void transport.close();
        void sdkServer.close();
      });
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500).end(error instanceof Error ? error.message : String(error));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    seenAuthorizationHeaders,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf-8");
  if (body.length === 0) {
    return undefined;
  }

  return JSON.parse(body) as unknown;
}

describe("Streamable HTTP MCP transport", () => {
  const servers: TestServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("connects, lists tools, calls tools, and propagates auth headers", async () => {
    const server = await startStreamableHttpServer({ expectedAuthorization: "Bearer token" });
    servers.push(server);

    const client = createMcpClient({
      name: "remote",
      transport: "http",
      connection: {
        type: "http",
        url: server.url,
        headers: { authorization: "Bearer token" },
      },
    });

    await client.connect();

    try {
      await expect(client.listTools()).resolves.toEqual([
        expect.objectContaining({ name: "lookup", description: "Lookup a value" }),
      ]);
      await expect(client.callTool("lookup", {})).resolves.toBe("lookup-result");

      expect(server.seenAuthorizationHeaders).toContain("Bearer token");
    } finally {
      await client.disconnect();
    }
  });

  it("surfaces non-2xx initialization failures", async () => {
    const server = await startStreamableHttpServer({ failRequests: true });
    servers.push(server);

    const client = createMcpClient({
      name: "remote",
      transport: "http",
      connection: { type: "http", url: server.url },
    });

    await expect(client.connect()).rejects.toThrow();
  });
});
