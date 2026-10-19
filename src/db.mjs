import pg from "pg";
pg.types.setTypeParser(1082, (v) => v);
import { randomUUID, createHash } from "node:crypto";
export const id = (prefix) => `${prefix}-${randomUUID()}`;
export const makePool = (config) =>
  new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function fail(status, code, message) {
  throw new AppError(status, code, message);
}
export async function transaction(pool, operation) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (["40001", "40P01"].includes(error.code) && attempt < 2) continue;
      throw error;
    } finally {
      client.release();
    }
  }
}
export async function audit(c, user, action, reference) {
  await c.query(
    "INSERT INTO audit_logs(id,user_id,action,reference) VALUES($1,$2,$3,$4)",
    [id("audit"), user.id, action, reference],
  );
}
export async function mutate(pool, user, key, action, body, operation) {
  if (!key || !/^[-a-zA-Z0-9_:.]{8,100}$/.test(key))
    fail(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Provide an Idempotency-Key header of 8 to 100 characters.",
    );
  const fingerprint = createHash("sha256")
    .update(action + "\n" + JSON.stringify(body))
    .digest("hex");
  return transaction(pool, async (c) => {
    const claim = await c.query(
      "INSERT INTO idempotency_keys(user_id,key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING key",
      [user.id, key, fingerprint],
    );
    if (!claim.rowCount) {
      const previous = (
        await c.query(
          "SELECT fingerprint,response FROM idempotency_keys WHERE user_id=$1 AND key=$2 FOR UPDATE",
          [user.id, key],
        )
      ).rows[0];
      if (previous.fingerprint !== fingerprint)
        fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "This request key was already used for a different operation.",
        );
      if (previous.response) return previous.response;
      fail(409, "REQUEST_PENDING", "Request is already processing.");
    }
    const response = await operation(c);
    await c.query(
      "UPDATE idempotency_keys SET response=$3 WHERE user_id=$1 AND key=$2",
      [user.id, key, response],
    );
    return response;
  });
}
