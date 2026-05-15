import { getModel } from "@bookingcare/ai";
import { applyAuth } from "./auth.js";

export const auth = applyAuth();
export type LiveModel = NonNullable<ReturnType<typeof getModel>>;

export function liveModel(modelId = "gpt-5.4-nano"): LiveModel {
  const model = getModel(modelId);
  if (!model) {
    throw new Error(`Model not found: ${modelId}`);
  }
  return model;
}
