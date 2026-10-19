import pg from "pg";
import { loadConfig } from "./config.mjs";
import { makePool } from "./db.mjs";
import { createApp } from "./app.mjs";
pg.types.setTypeParser(1082, (v) => v);
const config = loadConfig(),
  pool = makePool(config);
await pool.query("SELECT 1");
const server = createApp(pool, config).listen(config.port, () =>
  console.log(`PharmaFlow API listening on http://localhost:${config.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  });
