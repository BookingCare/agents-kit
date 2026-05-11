import { describe, it, expect, expectTypeOf } from "vitest";
import { Type, Static, tool } from "../src/index.js";
import type { Tool } from "../src/index.js";

describe("tool()", () => {
  it("creates a typed tool definition", () => {
    const GetWeatherParams = Type.Object({
      city: Type.String(),
      unit: Type.Optional(Type.Union([Type.Literal("celsius"), Type.Literal("fahrenheit")])),
    });

    const getWeather = tool({
      name: "get_weather",
      description: "Get weather for a city",
      parameters: GetWeatherParams,
    });

    // Runtime shape
    expect(getWeather.name).toBe("get_weather");
    expect(getWeather.description).toBe("Get weather for a city");
    const params = getWeather.parameters as Record<string, unknown>;
    expect(params).toMatchObject({
      type: "object",
      properties: {
        city: { type: "string" },
        unit: {
          anyOf: [{ const: "celsius" }, { const: "fahrenheit" }],
        },
      },
      required: ["city"],
    });
  });

  it("omits description when not provided", () => {
    const schema = Type.Object({ x: Type.Number() });
    const t = tool({ name: "test", parameters: schema });
    expect(t).not.toHaveProperty("description");
  });

  it("Static resolves the correct TypeScript type", () => {
    const Params = Type.Object({
      id: Type.Number(),
      name: Type.String(),
      active: Type.Boolean(),
    });

    const t = tool({ name: "test", parameters: Params });

    type Args = Static<typeof t.parameters>;

    // Verify the type resolves correctly
    const valid: Args = { id: 1, name: "test", active: true };
    expect(valid).toEqual({ id: 1, name: "test", active: true });

    // Type-level check: Args should have these exact properties
    expectTypeOf<Args>().toMatchTypeOf<{ id: number; name: string; active: boolean }>();
  });

  it("typed tools are assignable to Tool", () => {
    const schema = Type.Object({ query: Type.String() });
    const t = tool({ name: "search", parameters: schema });

    // This should type-check: Tool<TSchema> -> Tool (erased)
    const tools: Tool[] = [t];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("search");
  });

  it("preserves optional and union types", () => {
    const Params = Type.Object({
      required_field: Type.String(),
      optional_field: Type.Optional(Type.Number()),
      union_field: Type.Union([Type.Literal("a"), Type.Literal("b")]),
    });

    const t = tool({ name: "test", parameters: Params });
    type Args = Static<typeof t.parameters>;

    const withAll: Args = { required_field: "hello", optional_field: 42, union_field: "a" };
    const withRequired: Args = { required_field: "hello", union_field: "b" };

    expect(withAll.required_field).toBe("hello");
    expect(withRequired.union_field).toBe("b");
  });
});
