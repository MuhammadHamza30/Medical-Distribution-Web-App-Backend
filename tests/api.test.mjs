import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { testPool } from "./database.mjs";
import { migrate } from "../src/migrate.mjs";
import { seed } from "../src/seed.mjs";
import { createApp } from "../src/app.mjs";
import { businessDate, addDays } from "../src/service.mjs";
import { loadConfig } from "../src/config.mjs";
let pool, app, agent;
const origin = "http://localhost:5173",
  password = "TestOnlyPassword#2026!";
const config = {
  databaseUrl: "test",
  jwtSecret: "test-only-secret-".repeat(4),
  origins: [origin],
  production: false,
  cookieSecure: false,
  timezone: "Asia/Karachi",
  trustProxy: false,
  seedDemo: true,
  adminEmail: "admin@pharmaflow.local",
  adminPassword: password,
};
const today = businessDate(config);
async function post(path, body = {}, key = randomUUID(), actor = agent) {
  return actor
    .post("/api" + path)
    .set("Origin", origin)
    .set("Idempotency-Key", key)
    .send(body);
}
async function makeOrder(
  shopId = "s4",
  qty = 10,
  productId = "p1",
  rate = 180,
) {
  const res = await post("/orders", {
    shopId,
    lines: [{ productId, qty, bonus: 0, rate, discount: 0 }],
  });
  assert.equal(res.status, 200, res.text);
  return res.body.result.id;
}
async function state() {
  const r = await agent.get("/api/bootstrap");
  assert.equal(r.status, 200, r.text);
  return r.body.state;
}
test.before(async () => {
  pool = await testPool();
  await migrate(pool);
  await seed(pool, config);
  app = createApp(pool, config);
});
test.beforeEach(async () => {
  await pool.query(
    "TRUNCATE idempotency_keys,audit_logs,customer_ledger,stock_movements,returns,payment_allocations,payments,invoice_lines,invoices,reservations,order_lines,orders,goods_receipts,batches,products,shops,suppliers,document_sequences,sessions,users,settings CASCADE",
  );
  await seed(pool, config);
  agent = request.agent(app);
  const r = await agent
    .post("/api/auth/login")
    .set("Origin", origin)
    .send({ email: config.adminEmail, password });
  assert.equal(r.status, 200, r.text);
});
test.after(async () => await pool.end());
test("authentication rejects anonymous, invalid login, bad origin and missing request keys", async () => {
  assert.equal((await request(app).get("/api/bootstrap")).status, 401);
  assert.equal(
    (
      await request(app)
        .post("/api/auth/login")
        .send({ email: config.adminEmail, password: "wrong" })
    ).status,
    401,
  );
  assert.equal(
    (
      await agent
        .post("/api/orders")
        .set("Origin", "http://evil.example")
        .send({})
    ).status,
    403,
  );
  assert.equal(
    (
      await agent
        .post("/api/orders/ORD-001/approve")
        .set("Origin", origin)
        .send({})
    ).status,
    400,
  );
  assert.equal((await agent.post("/api/auth/logout").send({})).status, 403);
});
test("credit order through payment and return preserves stock and customer ledger", async () => {
  const id = await makeOrder();
  let r = await post(`/orders/${id}/approve`);
  assert.equal(r.status, 200, r.text);
  let s = r.body.state;
  assert.equal(s.orders.find((o) => o.id === id).allocations[0].batchId, "b9");
  r = await post(`/orders/${id}/deliver`);
  assert.equal(r.status, 200, r.text);
  const invoiceId = r.body.result.invoiceId,
    invoice = r.body.state.invoices.find((i) => i.id === invoiceId);
  assert.equal(invoice.total, 1800);
  assert.equal(r.body.state.batches.find((b) => b.id === "b9").stock, 170);
  r = await post("/payments", {
    shopId: "s4",
    date: today,
    amount: 1000,
    method: "Cash",
    reference: "",
  });
  assert.equal(r.status, 200, r.text);
  r = await post("/returns", {
    invoiceId,
    lineId: invoice.lines[0].id,
    qty: 2,
    reason: "Damaged packaging",
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.result.credit, "360.00");
  assert.equal(r.body.state.batches.at(-1).status, "Quarantine");
  const rec = await agent.get("/api/reports/reconciliation");
  assert.equal(rec.status, 200, rec.text);
  assert.equal(rec.body.ok, true);
  const ledger = (
    await pool.query(
      "SELECT SUM(amount) value FROM customer_ledger WHERE shop_id='s4'",
    )
  ).rows[0].value;
  assert.equal(Number(ledger), 440);
});
test("same delivery idempotency key posts once and conflicting use is rejected", async () => {
  const id = await makeOrder();
  await post(`/orders/${id}/approve`);
  const key = randomUUID();
  const first = await post(`/orders/${id}/deliver`, {}, key),
    again = await post(`/orders/${id}/deliver`, {}, key);
  assert.equal(first.status, 200, first.text);
  assert.equal(again.status, 200, again.text);
  assert.equal(first.body.result.invoiceId, again.body.result.invoiceId);
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*) value FROM invoices WHERE order_id=$1",
        [id],
      )
    ).rows[0].value.toString(),
    "1",
  );
  assert.equal((await post(`/orders/${id}/cancel`, {}, key)).status, 409);
});
test("failed approval rolls back partial reservations and keeps draft unchanged", async () => {
  const id = await makeOrder("s4", 2000);
  await pool.query("UPDATE shops SET credit_limit=999999 WHERE id='s4'");
  const r = await post(`/orders/${id}/approve`);
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.error.code, "STOCK_UNAVAILABLE");
  assert.equal(
    (
      await pool.query(
        "SELECT COUNT(*) n FROM reservations WHERE order_line_id IN(SELECT id FROM order_lines WHERE order_id=$1)",
        [id],
      )
    ).rows[0].n.toString(),
    "0",
  );
  assert.equal(
    (await pool.query("SELECT status FROM orders WHERE id=$1", [id])).rows[0]
      .status,
    "Draft",
  );
});
test("expired stock cannot fulfill an approved order and delivery is atomic", async () => {
  const id = await makeOrder();
  await post(`/orders/${id}/approve`);
  await pool.query("UPDATE batches SET expiry=$1 WHERE id='b9'", [
    addDays(today, -1),
  ]);
  const r = await post(`/orders/${id}/deliver`);
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.error.code, "BATCH_INELIGIBLE");
  assert.equal(
    (
      await pool.query("SELECT COUNT(*) n FROM invoices WHERE order_id=$1", [
        id,
      ])
    ).rows[0].n.toString(),
    "0",
  );
  assert.equal(
    (await pool.query("SELECT stock FROM batches WHERE id='b9'")).rows[0].stock,
    180,
  );
});
test("combined approved credit exposure is enforced and cancellation releases credit", async () => {
  await pool.query("UPDATE shops SET credit_limit=3000 WHERE id='s4'");
  const a = await makeOrder(),
    b = await makeOrder();
  assert.equal((await post(`/orders/${a}/approve`)).status, 200);
  const blocked = await post(`/orders/${b}/approve`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, "CREDIT_LIMIT_EXCEEDED");
  assert.equal((await post(`/orders/${a}/cancel`)).status, 200);
  assert.equal((await post(`/orders/${b}/approve`)).status, 200);
});
test("customer advances are automatically allocated on delivery", async () => {
  assert.equal(
    (
      await post("/payments", {
        shopId: "s4",
        date: today,
        amount: 2500,
        method: "Cash",
        reference: "",
      })
    ).status,
    200,
  );
  const id = await makeOrder();
  await post(`/orders/${id}/approve`);
  const r = await post(`/orders/${id}/deliver`);
  assert.equal(r.status, 200, r.text);
  const allocations = (
    await pool.query(
      "SELECT SUM(amount) n FROM payment_allocations WHERE invoice_id=$1",
      [r.body.result.invoiceId],
    )
  ).rows[0].n;
  assert.equal(allocations, "1800.00");
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT SUM(amount) n FROM customer_ledger WHERE shop_id='s4'",
        )
      ).rows[0].n,
    ),
    -700,
  );
});
test("return caps are enforced and paid invoice return becomes unapplied credit", async () => {
  let r = await post("/returns", {
    invoiceId: "INV-2026-003",
    lineId: "il5",
    qty: 2,
    reason: "Damaged",
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.result.credit, "1560.00");
  const paid = (
    await pool.query(
      "SELECT SUM(amount) n FROM payment_allocations WHERE invoice_id='INV-2026-003'",
    )
  ).rows[0].n;
  assert.equal(paid, "54840.00");
  r = await post("/returns", {
    invoiceId: "INV-2026-003",
    lineId: "il5",
    qty: 59,
    reason: "Damaged",
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "RETURN_QUANTITY_EXCEEDED");
});
test("decimal prices and split batch allocations preserve invoice totals", async () => {
  const order = await post("/orders", {
    shopId: "s4",
    lines: [
      { productId: "p1", qty: 185, bonus: 2, rate: 0.03, discount: 33.33 },
    ],
  });
  assert.equal(order.status, 200, order.text);
  const id = order.body.result.id;
  assert.equal((await post(`/orders/${id}/approve`)).status, 200);
  const r = await post(`/orders/${id}/deliver`);
  assert.equal(r.status, 200, r.text);
  const invoice = r.body.state.invoices.find(
    (i) => i.id === r.body.result.invoiceId,
  );
  assert.equal(invoice.lines.length, 2);
  assert.equal(invoice.total, 3.7);
  const total = (
    await pool.query(
      "SELECT SUM(total) n FROM invoice_lines WHERE invoice_id=$1",
      [invoice.id],
    )
  ).rows[0].n;
  assert.equal(total, "3.70");
});
test("server validates unknown fields and calendar dates", async () => {
  const r = await post("/payments", {
    shopId: "s4",
    date: today,
    amount: -1,
    method: "Cash",
    reference: "",
    status: "Settled",
  });
  assert.equal(r.status, 422);
  const q = await post("/goods-receipts", {
    supplierId: "sup1",
    productId: "p1",
    number: "A",
    expiry: "2028-02-31",
    qty: 1,
    cost: 125,
  });
  assert.equal(q.status, 422);
});
test("role restriction prevents warehouse collections and full workspace access", async () => {
  let r = await post("/users", {
    email: "warehouse@demo.local",
    name: "Warehouse Staff",
    password: "WarehouseTest#2026",
    role: "warehouse",
  });
  assert.equal(r.status, 200, r.text);
  const worker = request.agent(app);
  r = await worker
    .post("/api/auth/login")
    .set("Origin", origin)
    .send({ email: "warehouse@demo.local", password: "WarehouseTest#2026" });
  assert.equal(r.status, 200, r.text);
  assert.equal((await worker.get("/api/bootstrap")).status, 403);
  assert.equal((await worker.get("/api/inventory")).status, 200);
  assert.equal(
    (
      await post(
        "/payments",
        {
          shopId: "s4",
          date: today,
          amount: 100,
          method: "Cash",
          reference: "",
        },
        randomUUID(),
        worker,
      )
    ).status,
    403,
  );
});
test("logout revokes a session and settings do not reset business data", async () => {
  let r = await agent
    .patch("/api/settings")
    .set("Origin", origin)
    .set("Idempotency-Key", randomUUID())
    .send({
      name: "Hamza Distribution",
      phone: "0922510240",
      address: "Kohat",
      currency: "PKR",
      expiryWarning: 45,
    });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.state.settings.name, "Hamza Distribution");
  assert.equal(r.body.state.invoices.length, 5);
  assert.equal(
    (await agent.post("/api/auth/logout").set("Origin", origin).send({}))
      .status,
    200,
  );
  assert.equal((await agent.get("/api/bootstrap")).status, 401);
});
test(
  "concurrent approvals cannot jointly exceed credit on a real PostgreSQL server",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    await pool.query("UPDATE shops SET credit_limit=3000 WHERE id='s4'");
    const a = await makeOrder(),
      b = await makeOrder();
    const results = await Promise.all([
      post(`/orders/${a}/approve`),
      post(`/orders/${b}/approve`),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  },
);
test("production configuration rejects insecure cookies", () => {
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgresql://example",
        JWT_SECRET: "x".repeat(40),
        NODE_ENV: "production",
        COOKIE_SECURE: "false",
      }),
    /secure cookies/,
  );
});
