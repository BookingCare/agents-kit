import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, JSONStore, MySQLStore } from "../src/index.js";

describe("createStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a JSON store", async () => {
    const store = {} as JSONStore;
    const createSpy = vi.spyOn(JSONStore, "create").mockResolvedValue(store);

    await expect(createStore({ type: "json", baseDir: "./data" })).resolves.toBe(store);
    expect(createSpy).toHaveBeenCalledWith({ baseDir: "./data" });
  });

  it("creates a MySQL store", async () => {
    const store = {} as MySQLStore;
    const createSpy = vi.spyOn(MySQLStore, "create").mockResolvedValue(store);

    await expect(
      createStore({
        type: "mysql",
        options: {
          host: "127.0.0.1",
          user: "agents",
          database: "agents",
        },
      }),
    ).resolves.toBe(store);
    expect(createSpy).toHaveBeenCalledWith({
      host: "127.0.0.1",
      user: "agents",
      database: "agents",
    });
  });
});
