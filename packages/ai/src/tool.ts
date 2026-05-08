import type { TSchema } from "@sinclair/typebox";

/**
 * A tool definition with typed parameters backed by a TypeBox JSON Schema.
 *
 * Use `Static<typeof definition.parameters>` to extract the TypeScript type
 * for the tool's arguments.
 */
export interface TypedToolDefinition<
  TParams extends TSchema = TSchema,
> {
  name: string;
  description?: string;
  parameters: TParams;
}

/**
 * Define a tool with a TypeBox JSON Schema for its parameters.
 *
 * The returned definition is compatible with `ToolDefinition` and can be
 * passed directly to `stream()`. Use `Static<typeof result.parameters>` to
 * get the static TypeScript type for the tool arguments.
 *
 * @example
 * ```ts
 * import { Type, Static, tool } from "@agents-kit/ai"
 *
 * const GetWeatherParams = Type.Object({
 *   city: Type.String(),
 *   unit: Type.Optional(Type.Union([
 *     Type.Literal("celsius"),
 *     Type.Literal("fahrenheit"),
 *   ])),
 * })
 *
 * const getWeather = tool({
 *   name: "get_weather",
 *   description: "Get weather for a city",
 *   parameters: GetWeatherParams,
 * })
 *
 * type WeatherArgs = Static<typeof getWeather.parameters>
 * // { city: string; unit?: "celsius" | "fahrenheit" }
 * ```
 */
export function tool<TParams extends TSchema>(def: {
  name: string;
  description?: string;
  parameters: TParams;
}): TypedToolDefinition<TParams> {
  return {
    name: def.name,
    ...(def.description !== undefined && { description: def.description }),
    parameters: def.parameters,
  };
}
