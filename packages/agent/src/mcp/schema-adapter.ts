import { Type, tool } from "@bookingcare/ai";
import type { TSchema } from "@sinclair/typebox";
import type { McpTool } from "./client.js";

type JsonSchema = Record<string, unknown>;

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

  return convertSchema(jsonSchema, jsonSchema, new Set());
}

function convertSchema(schema: JsonSchema, root: JsonSchema, refStack: Set<string>): TSchema {
  if (typeof schema.$ref === "string") {
    return convertReference(schema.$ref, root, refStack);
  }

  if (schema.const !== undefined) {
    return Type.Const(schema.const);
  }

  if (Array.isArray(schema.enum)) {
    return convertEnum(schema.enum);
  }

  if (Array.isArray(schema.oneOf)) {
    return convertUnionLike(schema.oneOf, root, refStack, "oneOf");
  }

  if (Array.isArray(schema.anyOf)) {
    return convertUnionLike(schema.anyOf, root, refStack, "anyOf");
  }

  if (Array.isArray(schema.allOf)) {
    return convertIntersect(schema.allOf, root, refStack);
  }

  if (Array.isArray(schema.type)) {
    if (schema.type.length === 0) {
      throw new Error("Unsupported JSON Schema type: empty type array");
    }

    const branches = schema.type.map((typeValue) => {
      if (typeof typeValue !== "string") {
        throw new Error("Unsupported JSON Schema type: type array must contain strings");
      }
      return convertSchema({ ...schema, type: typeValue }, root, refStack);
    });

    return combineUnion(branches);
  }

  if (schema.type === "null") {
    return Type.Null();
  }

  if (schema.type === "string") {
    return Type.String();
  }

  if (schema.type === "number" || schema.type === "integer") {
    return Type.Number();
  }

  if (schema.type === "boolean") {
    return Type.Boolean();
  }

  if (schema.type === "array" || schema.items !== undefined || schema.prefixItems !== undefined) {
    return convertArraySchema(schema, root, refStack);
  }

  if (
    schema.type === "object" ||
    schema.properties !== undefined ||
    schema.additionalProperties !== undefined
  ) {
    return convertObjectSchema(schema, root, refStack);
  }

  throw new Error(`Unsupported JSON Schema type: ${String(schema.type)}`);
}

function convertReference(ref: string, root: JsonSchema, refStack: Set<string>): TSchema {
  if (!ref.startsWith("#")) {
    throw new Error(`Unsupported JSON Schema $ref: ${ref}`);
  }

  if (refStack.has(ref)) {
    throw new Error(`Cyclic JSON Schema $ref detected: ${ref}`);
  }

  const target = resolveJsonPointer(root, ref);
  if (!isRecord(target)) {
    throw new Error(`Unsupported JSON Schema $ref: ${ref}`);
  }

  refStack.add(ref);
  try {
    return convertSchema(target, root, refStack);
  } finally {
    refStack.delete(ref);
  }
}

function resolveJsonPointer(root: JsonSchema, ref: string): unknown {
  if (ref === "#") {
    return root;
  }

  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported JSON Schema $ref: ${ref}`);
  }

  const tokens = ref.slice(2).split("/").map(decodeJsonPointerToken);

  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Unresolvable JSON Schema $ref: ${ref}`);
      }
      current = current[index];
      continue;
    }

    if (!isRecord(current) || !(token in current)) {
      throw new Error(`Unresolvable JSON Schema $ref: ${ref}`);
    }

    current = current[token];
  }

  return current;
}

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function convertEnum(values: unknown[]): TSchema {
  if (values.length === 0) {
    return Type.Never();
  }

  if (values.length === 1) {
    return Type.Const(values[0]);
  }

  return combineUnion(values.map((value) => Type.Const(value)));
}

function convertUnionLike(
  schemas: unknown[],
  root: JsonSchema,
  refStack: Set<string>,
  keyword: "oneOf" | "anyOf",
): TSchema {
  if (schemas.length === 0) {
    throw new Error(`Unsupported JSON Schema ${keyword}: empty schema array`);
  }

  const branches = schemas.map((schema) => {
    if (!isRecord(schema)) {
      throw new Error(`Unsupported JSON Schema ${keyword}: entries must be objects`);
    }
    return convertSchema(schema, root, refStack);
  });

  return combineUnion(branches);
}

function convertIntersect(schemas: unknown[], root: JsonSchema, refStack: Set<string>): TSchema {
  if (schemas.length === 0) {
    return Type.Any();
  }

  if (schemas.length === 1) {
    const only = schemas[0];
    if (!isRecord(only)) {
      throw new Error("Unsupported JSON Schema allOf: entries must be objects");
    }
    return convertSchema(only, root, refStack);
  }

  const branches = schemas.map((schema) => {
    if (!isRecord(schema)) {
      throw new Error("Unsupported JSON Schema allOf: entries must be objects");
    }
    return convertSchema(schema, root, refStack);
  });

  return Type.Intersect(branches as [TSchema, TSchema, ...TSchema[]]);
}

function convertArraySchema(schema: JsonSchema, root: JsonSchema, refStack: Set<string>): TSchema {
  if (Array.isArray(schema.prefixItems)) {
    if (schema.prefixItems.length === 0) {
      return Type.Tuple([]);
    }

    const items = schema.prefixItems.map((item) => {
      if (!isRecord(item)) {
        throw new Error("Unsupported JSON Schema prefixItems: entries must be objects");
      }
      return convertSchema(item, root, refStack);
    });

    return Type.Tuple(items as [TSchema, TSchema, ...TSchema[]]);
  }

  if (Array.isArray(schema.items)) {
    if (schema.items.length === 0) {
      return Type.Tuple([]);
    }

    const items = schema.items.map((item) => {
      if (!isRecord(item)) {
        throw new Error("Unsupported JSON Schema items: entries must be objects");
      }
      return convertSchema(item, root, refStack);
    });

    return Type.Tuple(items as [TSchema, TSchema, ...TSchema[]]);
  }

  if (schema.items !== undefined) {
    if (!isRecord(schema.items)) {
      throw new Error("Unsupported JSON Schema array: items must be an object or array");
    }

    return Type.Array(convertSchema(schema.items, root, refStack));
  }

  return Type.Array(Type.Unknown());
}

function convertObjectSchema(schema: JsonSchema, root: JsonSchema, refStack: Set<string>): TSchema {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set<string>(readStringArray(schema.required, "required"));
  const converted: Record<string, TSchema> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (!isRecord(value)) {
      throw new Error(`Unsupported JSON Schema property: ${key}`);
    }

    const convertedValue = convertSchema(value, root, refStack);
    converted[key] = required.has(key) ? convertedValue : Type.Optional(convertedValue);
  }

  if (schema.additionalProperties === false) {
    return Type.Object(converted, { additionalProperties: false });
  }

  if (isRecord(schema.additionalProperties)) {
    return Type.Object(converted, {
      additionalProperties: convertSchema(schema.additionalProperties, root, refStack),
    });
  }

  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean"
  ) {
    throw new Error("Unsupported JSON Schema additionalProperties value");
  }

  return Type.Object(converted);
}

function combineUnion(schemas: TSchema[]): TSchema {
  if (schemas.length === 0) {
    throw new Error("Unsupported JSON Schema union: empty schema array");
  }

  if (schemas.length === 1) {
    return schemas[0];
  }

  return Type.Union(schemas as [TSchema, TSchema, ...TSchema[]]);
}

function readStringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Unsupported JSON Schema ${label} list`);
  }

  return value;
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
