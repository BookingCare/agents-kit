# Plan Update: Use Official @modelcontextprotocol/sdk

## Change Summary

Instead of implementing MCP client from scratch, we'll use the official `@modelcontextprotocol/sdk@1.29.0` package.

## Why Use the Official SDK?

1. **Official maintenance** - Maintained by Anthropic/MCP team
2. **Protocol compliance** - Handles JSON-RPC, transport variations, auth properly
3. **Robust error handling** - Handles retries, timeouts, connection failures
4. **Less maintenance burden** - No need to track protocol changes
5. **Proven in production** - Used by real MCP servers

## Revised Implementation

### Phase 1: Install SDK and Create Client Wrapper

**Dependency**: `@modelcontextprotocol/sdk@1.29.0`

**File**: `packages/agent/src/mcp/client.ts`

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerConfig } from "./registry.js";

export interface McpClientWrapper {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema: any }>>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export async function createMcpClient(config: McpServerConfig): Promise<McpClientWrapper> {
  // Use SDK's Client + SSEClientTransport
  // Wrapper adapts SDK to our interface
}
```

**Key changes**:

- Use SDK's `Client` class for JSON-RPC handling
- Use SDK's `SSEClientTransport` for SSE connections
- Create wrapper class that adapts SDK to our interface
- No need to implement JSON-RPC, auth, or connection management

### Phase 2: Schema Adapter (unchanged)

Still needed because:

- SDK uses JSON Schema for tool definitions
- Our agent system uses TypeBox
- Need conversion layer

### Phase 3: Registry (unchanged)

Same implementation, just uses the SDK-based client wrapper

### Phase 4-5: Integration (unchanged)

No changes to integration layers

## Revised Todos

| Original                               | Status                              | Notes                            |
| -------------------------------------- | ----------------------------------- | -------------------------------- |
| TODO-65e4f634: MCP Client from scratch | ✅ Completed but should be replaced | Implementing SDK wrapper instead |
| TODO-6394d407: Schema Adapter          | ✅ Completed                        | Unchanged - still needed         |
| TODO-8d437eb4: Registry                | 🔄 In progress                      | Uses SDK-based client            |
| TODO-125f9c41: Tool Dispatch           | ⏳ Pending                          | Unchanged                        |
| TODO-99479a48: Agent Integration       | ⏳ Pending                          | Unchanged                        |

## New Todo

- Replace scratch MCP client implementation with SDK wrapper
- Update tests to use SDK mocks
- Keep existing schema adapter

## Dependencies

```bash
pnpm add @modelcontextprotocol/sdk
```

## Benefits

1. **Less code** - No need to implement JSON-RPC, auth, transport
2. **More robust** - SDK handles edge cases, retries, proper error handling
3. **Future-proof** - SDK tracks protocol changes
4. **Proven** - Used in production by real MCP servers

## Migration Path

1. Install SDK dependency
2. Create wrapper class using SDK's Client + SSEClientTransport
3. Update registry to use SDK-based client
4. Remove scratch implementation (or keep as reference)
5. Update tests to mock SDK instead of fetch
