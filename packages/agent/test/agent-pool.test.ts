import { describe, expect, it, vi } from "vitest";
import { Agent, AgentPool, type AgentOptions } from "../src/index.js";
import { liveModel } from "./helpers/live-model.js";

function createOptions(): AgentOptions {
  return {
    initialState: {
      model: liveModel(),
      systemPrompt: "You are helpful.",
      thinkingLevel: "off",
      tools: [],
      messages: [],
    },
  };
}

describe("AgentPool", () => {
  it("creates, gets, lists, and deletes agents", () => {
    const pool = new AgentPool();
    const agent = pool.create("alpha", createOptions());

    expect(agent).toBeInstanceOf(Agent);
    expect(pool.get("alpha")).toBe(agent);
    expect(pool.list()).toEqual([agent]);
    expect(pool.delete("alpha")).toBe(true);
    expect(pool.get("alpha")).toBeUndefined();
    expect(pool.delete("missing")).toBe(false);
  });

  it("rejects duplicate ids", () => {
    const pool = new AgentPool();
    pool.create("alpha", createOptions());

    expect(() => pool.create("alpha", createOptions())).toThrow("Agent already exists: alpha");
  });

  it("enforces maxAgents", () => {
    const pool = new AgentPool({ maxAgents: 1 });
    pool.create("alpha", createOptions());

    expect(() => pool.create("beta", createOptions())).toThrow("Agent pool capacity reached: 1");
  });

  it("shuts down all agents even if one fails and clears the pool", async () => {
    const pool = new AgentPool();
    const first = pool.create("alpha", createOptions());
    const second = pool.create("beta", createOptions());
    const firstShutdown = vi.spyOn(first, "shutdown").mockRejectedValueOnce(new Error("boom"));
    const secondShutdown = vi.spyOn(second, "shutdown").mockResolvedValueOnce();

    await expect(pool.shutdown()).rejects.toThrow("boom");

    expect(firstShutdown).toHaveBeenCalledTimes(1);
    expect(secondShutdown).toHaveBeenCalledTimes(1);
    expect(pool.list()).toHaveLength(0);
  });
});
