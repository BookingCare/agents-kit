import type { Model, Api, ThinkingLevelMap } from "../src/types.js";
import { models as currentModels } from "../src/models.generated.js";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generate the models.generated.ts file.
 *
 * For Azure OpenAI, deployments are per-resource so there's no public catalog API.
 * The model list is maintained here manually based on Azure's published documentation.
 * For future providers (OpenAI, Anthropic), this script can fetch from their model APIs.
 */

// Update this list when Azure adds new models or changes specs.
// Only include models that support tool/function calling.
const azureOpenAIModels: Model<Api>[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    api: "azure-openai-completions",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 10.0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    api: "azure-openai-completions",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.15,
      output: 0.6,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    api: "azure-openai-completions",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 2.0,
      output: 8.0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1_047_576,
    maxTokens: 32_768,
  },
  {
    id: "gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    api: "azure-openai-completions",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.4,
      output: 1.6,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1_047_576,
    maxTokens: 32_768,
  },
  {
    id: "gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    api: "azure-openai-completions",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: false,
    input: ["text", "image"],
    cost: {
      input: 0.1,
      output: 0.4,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1_047_576,
    maxTokens: 32_768,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "azure-openai-responses",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: true,
    thinkingLevelMap: {
      none: null,
      short: 40000,
      medium: 80000,
      long: 100000,
    },
    input: ["text", "image"],
    cost: {
      input: 2.5,
      output: 15.0,
      cacheRead: 0.25,
      cacheWrite: 0,
    },
    contextWindow: 1_050_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    api: "azure-openai-responses",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: true,
    thinkingLevelMap: {
      none: null,
      short: 40000,
      medium: 80000,
      long: 100000,
    },
    input: ["text", "image"],
    cost: {
      input: 0.75,
      output: 4.5,
      cacheRead: 0.075,
      cacheWrite: 0,
    },
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    api: "azure-openai-responses",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: true,
    thinkingLevelMap: {
      none: null,
      short: 40000,
      medium: 80000,
      long: 100000,
    },
    input: ["text", "image"],
    cost: {
      input: 0.2,
      output: 1.25,
      cacheRead: 0.02,
      cacheWrite: 0,
    },
    contextWindow: 400_000,
    maxTokens: 128_000,
  },
  {
    id: "o1",
    name: "o1",
    api: "azure-openai-completions",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: true,
    thinkingLevelMap: {
      none: null,
      short: 40000,
      medium: 80000,
      long: 100000,
    },
    input: ["text", "image"],
    cost: {
      input: 15.0,
      output: 60.0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200_000,
    maxTokens: 100_000,
  },
  {
    id: "o1-mini",
    name: "o1-mini",
    api: "azure-openai-completions",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: true,
    thinkingLevelMap: {
      none: null,
      short: 30000,
      medium: 50000,
      long: 65536,
    },
    input: ["text"],
    cost: {
      input: 3.0,
      output: 12.0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens: 65_536,
  },
  {
    id: "o3-mini",
    name: "o3-mini",
    api: "azure-openai-completions",
    provider: "azure-openai",
    baseUrl: "",
    reasoning: true,
    thinkingLevelMap: {
      none: null,
      short: 40000,
      medium: 80000,
      long: 100000,
    },
    input: ["text", "image"],
    cost: {
      input: 1.1,
      output: 4.4,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200_000,
    maxTokens: 100_000,
  },
];

function formatModelInput(input: Model<Api>["input"]): string {
  return `[${input.map((item) => JSON.stringify(item)).join(", ")}]`;
}

const thinkingLevelKeys = ["none", "short", "medium", "long"] as const;

function formatThinkingLevelMap(map: ThinkingLevelMap): string {
  const entries = thinkingLevelKeys.flatMap((key) => {
    const value = map[key];
    if (value === undefined) return [];

    return [`${key}: ${value === null ? "null" : value}`];
  });

  return `{ ${entries.join(", ")} }`;
}

function generateFile(models: Model<Api>[]): string {
  const modelEntries = models
    .map((m) => {
      const hasThinkingLevelMap = m.thinkingLevelMap;
      const thinkingLevelMapStr = hasThinkingLevelMap
        ? `\n    thinkingLevelMap: ${formatThinkingLevelMap(m.thinkingLevelMap)},`
        : "";

      return `  {
    id: ${JSON.stringify(m.id)},
    name: ${JSON.stringify(m.name)},
    api: ${JSON.stringify(m.api)},
    provider: ${JSON.stringify(m.provider)},
    baseUrl: ${JSON.stringify(m.baseUrl)},
    reasoning: ${m.reasoning},${thinkingLevelMapStr}
    input: ${formatModelInput(m.input)},
    cost: {
      input: ${m.cost.input},
      output: ${m.cost.output},
      cacheRead: ${m.cost.cacheRead},
      cacheWrite: ${m.cost.cacheWrite},
    },
    contextWindow: ${m.contextWindow},
    maxTokens: ${m.maxTokens},
  }`;
    })
    .join(",\n");

  return `// AUTO-GENERATED by scripts/generate-models.ts — do not edit manually.
import type { Model, Api } from "./types.js";

export const models: Model<Api>[] = [
${modelEntries},
];

const modelMap = new Map(models.map((m) => [m.id, m]));

export function getModel(id: string): Model<Api> | undefined {
  return modelMap.get(id);
}

export function listModels(): Model<Api>[] {
  return models;
}

export function getModelsByProvider(provider: string): Model<Api>[] {
  return models.filter((m) => m.provider === provider);
}
`;
}

const allModels: Model<Api>[] = [...azureOpenAIModels];
const output = generateFile(allModels);
const outPath = join(__dirname, "..", "src", "models.generated.ts");
writeFileSync(outPath, output);
console.log(`Generated ${allModels.length} models -> ${outPath}`);
