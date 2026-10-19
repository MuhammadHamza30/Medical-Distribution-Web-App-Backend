import { loadConfig } from "./config.mjs";
import { makePool } from "./db.mjs";
import { migrate } from "./migrate.mjs";
import { seed } from "./seed.mjs";
const config = loadConfig(),
  pool = makePool(config);
try {
  await migrate(pool);
  await seed(pool, config);
} finally {
  await pool.end();
}
await import("./server.mjs");
