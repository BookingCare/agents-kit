import { JSONStore } from "./providers/json-store.js";
import { MySQLStore } from "./providers/mysql-store.js";
import type { Store, StoreConfig } from "./types.js";

export async function createStore(config: StoreConfig): Promise<Store> {
  const { type } = config;

  switch (type) {
    case "json":
      return JSONStore.create({ baseDir: config.baseDir });

    case "mysql":
      return MySQLStore.create(config.options);

    default:
      throw new Error(`Unsupported store type: ${type}`);
  }
}
