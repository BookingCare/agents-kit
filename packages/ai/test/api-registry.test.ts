import { describe, it, expect, beforeEach } from "vitest";
import {
  registerApiProvider,
  getApiProvider,
  getApiProviders,
  unregisterApiProviders,
  clearApiProviders,
} from "../src/api-registry.js";
import type {
  Api,
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  StreamOptions,
} from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function makeModel(api: Api): Model<Api> {
  return {
    id: "test-model",
    name: "Test Model",
    api,
    provider: "test",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

function makeStreamFn(prefix = "from"): StreamFunction<"test-api"> {
  return (
    model: Model<"test-api">,
    _context: Context,
    _options?: StreamOptions,
  ): AssistantMessageEventStream => {
    const stream = new AssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${prefix}-${model.id}` }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    });
    return stream;
  };
}

const makeStreamSimpleFn = (): StreamFunction<"test-api", SimpleStreamOptions> =>
  makeStreamFn("simple") as StreamFunction<"test-api", SimpleStreamOptions>;

describe("API Registry", () => {
  beforeEach(() => {
    clearApiProviders();
  });

  it("registers and retrieves a provider", () => {
    registerApiProvider({
      api: "test-api",
      stream: makeStreamFn(),
      streamSimple: makeStreamSimpleFn(),
    });

    const provider = getApiProvider("test-api");
    expect(provider).toBeDefined();
    expect(provider!.api).toBe("test-api");
  });

  it("returns undefined for unregistered api", () => {
    expect(getApiProvider("nonexistent")).toBeUndefined();
  });

  it("lists all registered providers", () => {
    registerApiProvider({
      api: "test-api-1",
      stream: makeStreamFn() as StreamFunction<Api>,
      streamSimple: makeStreamSimpleFn() as StreamFunction<Api, SimpleStreamOptions>,
    });
    registerApiProvider({
      api: "test-api-2",
      stream: makeStreamFn() as StreamFunction<Api>,
      streamSimple: makeStreamSimpleFn() as StreamFunction<Api, SimpleStreamOptions>,
    });

    const providers = getApiProviders();
    expect(providers).toHaveLength(2);
    const apis = providers.map((p) => p.api).sort();
    expect(apis).toEqual(["test-api-1", "test-api-2"]);
  });

  it("unregisters providers by sourceId", () => {
    registerApiProvider(
      {
        api: "keep-api",
        stream: makeStreamFn() as StreamFunction<Api>,
        streamSimple: makeStreamSimpleFn() as StreamFunction<Api, SimpleStreamOptions>,
      },
      "source-a",
    );
    registerApiProvider(
      {
        api: "remove-api",
        stream: makeStreamFn() as StreamFunction<Api>,
        streamSimple: makeStreamSimpleFn() as StreamFunction<Api, SimpleStreamOptions>,
      },
      "source-b",
    );

    unregisterApiProviders("source-b");

    expect(getApiProvider("keep-api")).toBeDefined();
    expect(getApiProvider("remove-api")).toBeUndefined();
  });

  it("clears all providers", () => {
    registerApiProvider({
      api: "test-api",
      stream: makeStreamFn(),
      streamSimple: makeStreamSimpleFn(),
    });
    expect(getApiProviders()).toHaveLength(1);

    clearApiProviders();

    expect(getApiProviders()).toHaveLength(0);
    expect(getApiProvider("test-api")).toBeUndefined();
  });

  it("overwrites provider on re-registration for same api", () => {
    registerApiProvider({
      api: "test-api",
      stream: makeStreamFn(),
      streamSimple: makeStreamSimpleFn(),
    });
    registerApiProvider({
      api: "test-api",
      stream: makeStreamFn(),
      streamSimple: makeStreamSimpleFn(),
    });

    expect(getApiProviders()).toHaveLength(1);
  });

  describe("wrapStream mismatch guard", () => {
    it("throws when model.api does not match registered api", () => {
      registerApiProvider({
        api: "test-api",
        stream: makeStreamFn(),
        streamSimple: makeStreamSimpleFn(),
      });

      const provider = getApiProvider("test-api")!;
      const wrongModel = makeModel("wrong-api");

      expect(() => provider.stream(wrongModel, { messages: [] })).toThrow(
        "Mismatched api: wrong-api expected test-api",
      );
      expect(() => provider.streamSimple(wrongModel, { messages: [] })).toThrow(
        "Mismatched api: wrong-api expected test-api",
      );
    });

    it("passes through when model.api matches", async () => {
      registerApiProvider({
        api: "test-api",
        stream: makeStreamFn(),
        streamSimple: makeStreamSimpleFn(),
      });

      const provider = getApiProvider("test-api")!;
      const model = makeModel("test-api");

      const streamResult = provider.stream(model, { messages: [] });
      const msg = await streamResult.result();
      expect(msg.model).toBe("test-model");

      const simpleResult = provider.streamSimple(model, { messages: [] });
      const simpleMsg = await simpleResult.result();
      expect(simpleMsg.model).toBe("test-model");
    });
  });
});
