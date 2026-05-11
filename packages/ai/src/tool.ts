import type { TSchema } from "@sinclair/typebox";
import type { Tool } from "./types.js";

/**
 * Define a tool with a TypeBox JSON Schema for its parameters.
 *
 * Use `Static<typeof result.parameters>` to get the static TypeScript type
 * for the tool arguments.
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
}): Tool<TParams> {
  return {
    name: def.name,
    ...(def.description !== undefined && { description: def.description }),
    parameters: def.parameters,
  };
}
