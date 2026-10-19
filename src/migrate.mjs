import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { makePool, transaction } from "./db.mjs";
import { loadConfig } from "./config.mjs";
export async function migrate(pool) {
  const sql = await readFile(
    new URL("../sql/001_initial.sql", import.meta.url),
    "utf8",
  );
  await transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(8172401)");
    await c.query(sql);
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = makePool(loadConfig());
  try {
    await migrate(pool);
    console.log("Database schema ready.");
  } finally {
    await pool.end();
  }
}
