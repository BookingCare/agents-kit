import { Type, tool } from "@bookingcare/ai";
import type { TSchema } from "@sinclair/typebox";
import type { McpTool } from "./client.js";

export function convertMcpToolToTool(mcpTool: McpTool, serverName: string) {
  const parameters = convertJsonSchemaToTypeBox(mcpTool.inputSchema);
  return tool({
    name: `${serverName}:${mcpTool.name}`,
    description: mcpTool.description,
    parameters,
  });
}

export function convertJsonSchemaToTypeBox(jsonSchema: unknown): TSchema {
  if (!isRecord(jsonSchema)) {
    throw new Error("Unsupported JSON Schema: expected an object schema");
  }

  if (jsonSchema.type === "string") {
    return Type.String();
  }

  if (jsonSchema.type === "number" || jsonSchema.type === "integer") {
    return Type.Number();
  }

  if (jsonSchema.type === "boolean") {
    return Type.Boolean();
  }

  if (jsonSchema.type === "array") {
    if (!isRecord(jsonSchema.items)) {
      throw new Error("Unsupported JSON Schema array: missing items schema");
    }
    return Type.Array(convertJsonSchemaToTypeBox(jsonSchema.items));
  }

  if (jsonSchema.type === "object" || jsonSchema.properties !== undefined) {
    const properties = isRecord(jsonSchema.properties) ? jsonSchema.properties : {};
    const required = new Set<string>(Array.isArray(jsonSchema.required) ? jsonSchema.required : []);

    const converted: Record<string, TSchema> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (!isRecord(value)) {
        throw new Error(`Unsupported JSON Schema property: ${key}`);
      }
      const schema = convertJsonSchemaToTypeBox(value);
      converted[key] = required.has(key) ? schema : Type.Optional(schema);
    }

    return Type.Object(converted);
  }

  throw new Error(`Unsupported JSON Schema type: ${String(jsonSchema.type)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
