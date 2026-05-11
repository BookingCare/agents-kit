import type { Cost, Model, Usage, Api } from "../types.js";

export function calculateCost(usage: Usage, model: Model<Api>): Cost {
  const input = (usage.inputTokens / 1_000_000) * model.cost.input;
  const output = (usage.outputTokens / 1_000_000) * model.cost.output;
  return { input, output, total: input + output };
}
