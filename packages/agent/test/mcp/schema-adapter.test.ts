import { describe, expect, it } from "vitest";
import { Type } from "@bookingcare/ai";
import { convertJsonSchemaToTypeBox, convertMcpToolToTool } from "../../src/mcp/schema-adapter.js";

describe("convertJsonSchemaToTypeBox", () => {
  it("converts primitive types", () => {
    expect(convertJsonSchemaToTypeBox({ type: "string" })).toEqual(Type.String());
    expect(convertJsonSchemaToTypeBox({ type: "number" })).toEqual(Type.Number());
    expect(convertJsonSchemaToTypeBox({ type: "boolean" })).toEqual(Type.Boolean());
  });

  it("converts required and optional object fields", () => {
    const schema = convertJsonSchemaToTypeBox({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });

    expect(schema).toEqual(
      Type.Object({
        name: Type.String(),
        age: Type.Optional(Type.Number()),
      }),
    );
  });

  it("converts nested objects and arrays", () => {
    const schema = convertJsonSchemaToTypeBox({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        profile: {
          type: "object",
          properties: {
            active: { type: "boolean" },
          },
          required: ["active"],
        },
      },
      required: ["tags", "profile"],
    });

    expect(schema).toEqual(
      Type.Object({
        tags: Type.Array(Type.String()),
        profile: Type.Object({
          active: Type.Boolean(),
        }),
      }),
    );
  });

  it("throws on unsupported schema types", () => {
    expect(() => convertJsonSchemaToTypeBox({ type: "null" })).toThrow(
      "Unsupported JSON Schema type: null",
    );
  });
});

describe("convertMcpToolToTool", () => {
  it("prefixes the tool name with the server name", () => {
    const toolDef = convertMcpToolToTool(
      {
        name: "lookup",
        description: "Lookup values",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      },
      "server-a",
    );

    expect(toolDef.name).toBe("server-a:lookup");
    expect(toolDef.description).toBe("Lookup values");
    expect(toolDef.parameters).toEqual(
      Type.Object({
        q: Type.String(),
      }),
    );
  });
});
