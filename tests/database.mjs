import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
pg.types.setTypeParser(1082, (v) => v);
export async function testPool() {
  if (process.env.TEST_DATABASE_URL)
    return new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 10,
    });
  const db = new PGlite();
  await db.waitReady;
  let tail = Promise.resolve();
  const connect = async () => {
    let release;
    const turn = new Promise((r) => (release = r)),
      prev = tail;
    tail = tail.then(() => turn);
    await prev;
    return {
      async query(sql, params = []) {
        if (sql.includes(";") && params.length === 0) {
          const results = await db.exec(sql);
          const last = results.at(-1) || {};
          return { rows: last.rows || [], rowCount: last.affectedRows || 0 };
        }
        const r = await db.query(sql, params);
        return { rows: r.rows, rowCount: r.affectedRows || r.rows.length };
      },
      release,
    };
  };
  return {
    connect,
    async query(...args) {
      const c = await connect();
      try {
        return await c.query(...args);
      } finally {
        c.release();
      }
    },
    async end() {
      await tail;
      await db.close();
    },
    isPGlite: true,
  };
}
