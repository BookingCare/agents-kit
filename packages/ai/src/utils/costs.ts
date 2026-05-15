import type { Model, Usage, Api } from "../types.js";

export function calculateCost(usage: Usage, model: Model<Api>): Usage["cost"] {
  const input = (usage.input / 1_000_000) * model.cost.input;
  const output = (usage.output / 1_000_000) * model.cost.output;
  const cacheRead = (usage.cacheRead / 1_000_000) * model.cost.input; // cache uses input pricing
  const cacheWrite = (usage.cacheWrite / 1_000_000) * model.cost.input; // cache uses input pricing
  const total = input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}
