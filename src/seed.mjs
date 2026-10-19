import bcrypt from "bcryptjs";
import { fileURLToPath } from "node:url";
import { makePool, transaction, id } from "./db.mjs";
import { loadConfig } from "./config.mjs";
import { createSeed } from "./sample-data.mjs";
export async function seed(pool, config) {
  return transaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(8172402)");
    const existing = (
      await c.query("SELECT id FROM users WHERE email=$1", [config.adminEmail])
    ).rows[0];
    let adminId = existing?.id;
    if (!adminId) {
      if (!config.adminPassword || config.adminPassword.length < 12)
        throw Error("SEED_ADMIN_PASSWORD must contain at least 12 characters.");
      adminId = id("admin");
      await c.query(
        "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,'Hamza',$3,'admin')",
        [
          adminId,
          config.adminEmail,
          await bcrypt.hash(config.adminPassword, 12),
        ],
      );
    }
    await c.query(
      "INSERT INTO settings(id,name,phone,address,currency,expiry_warning) VALUES(1,'PharmaFlow Distribution','0922 510 240','Main Bazaar, Kohat, Pakistan','PKR',60) ON CONFLICT DO NOTHING",
    );
    if (
      !config.seedDemo ||
      Number(
        (await c.query("SELECT COUNT(*) count FROM products")).rows[0].count,
      ) !== 0
    )
      return { adminCreated: !existing, demoSeeded: false };
    // Seed is intended only for a fresh demonstration database and never overwrites live records.
    if (
      Number(
        (await c.query("SELECT COUNT(*) count FROM shops")).rows[0].count,
      ) !== 0
    )
      throw Error(
        "Demo seed requires an empty catalog and shop directory. Set SEED_DEMO=false for an existing business.",
      );
    const db = createSeed();
    for (const s of db.shops)
      await c.query(
        "INSERT INTO shops(id,name,owner,phone,city,address,credit_limit,terms,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          s.id,
          s.name,
          s.owner,
          s.phone,
          s.city,
          s.address,
          s.limit,
          s.terms,
          s.status,
        ],
      );
    for (const p of db.products)
      await c.query(
        "INSERT INTO products(id,name,strength,form,manufacturer,category,price,reorder_point,units_per_pack) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          p.id,
          p.name,
          p.strength,
          p.form,
          p.manufacturer,
          p.category,
          p.price,
          p.reorder,
          p.pack,
        ],
      );
    for (const s of db.suppliers)
      await c.query(
        "INSERT INTO suppliers(id,name,contact,city) VALUES($1,$2,$3,$4)",
        [s.id, s.name, s.contact, s.city],
      );
    for (const b of db.batches) {
      await c.query(
        "INSERT INTO batches(id,product_id,number,expiry,stock,cost,status,location) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          b.id,
          b.productId,
          b.number,
          b.expiry,
          b.stock,
          b.cost,
          b.status,
          b.location,
        ],
      );
      await c.query(
        "INSERT INTO stock_movements(id,batch_id,quantity,type,source_id,created_by) VALUES($1,$2,$3,'Opening',$4,$5)",
        [id("opening"), b.id, b.stock, "SEED-OPENING", adminId],
      );
    }
    for (const i of db.invoices) {
      await c.query(
        "INSERT INTO invoices(id,shop_id,business_date,due_date,total,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [i.id, i.shopId, i.date, i.due, i.total, adminId],
      );
      for (const l of i.lines) {
        const p = db.products.find((p) => p.id === l.productId),
          b = db.batches.find((b) => b.id === l.batchId);
        await c.query(
          "INSERT INTO invoice_lines(id,invoice_id,product_id,batch_id,quantity,bonus,rate,discount,total,product_name,strength,batch_number,expiry,unit_cost) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            l.id,
            i.id,
            l.productId,
            l.batchId,
            l.qty,
            l.bonus,
            l.rate,
            l.discount,
            l.qty * l.rate,
            p.name,
            p.strength,
            b.number,
            b.expiry,
            b.cost,
          ],
        );
      }
      await c.query(
        "INSERT INTO customer_ledger(id,shop_id,type,source_id,amount,business_date,created_by) VALUES($1,$2,'Invoice',$3,$4,$5,$6)",
        [id("ledger"), i.shopId, i.id, i.total, i.date, adminId],
      );
    }
    for (const p of db.payments) {
      await c.query(
        "INSERT INTO payments(id,shop_id,business_date,amount,method,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [p.id, p.shopId, p.date, p.amount, p.method, p.reference, adminId],
      );
      for (const a of p.allocations)
        await c.query(
          "INSERT INTO payment_allocations(payment_id,invoice_id,amount) VALUES($1,$2,$3)",
          [p.id, a.invoiceId, a.amount],
        );
      await c.query(
        "INSERT INTO customer_ledger(id,shop_id,type,source_id,amount,business_date,created_by) VALUES($1,$2,'Payment',$3,$4,$5,$6)",
        [id("ledger"), p.shopId, p.id, -p.amount, p.date, adminId],
      );
    }
    for (const o of db.orders) {
      await c.query(
        "INSERT INTO orders(id,shop_id,business_date,status,total,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [o.id, o.shopId, o.date, o.status, o.total, adminId],
      );
      for (const l of o.lines)
        await c.query(
          "INSERT INTO order_lines(id,order_id,product_id,quantity,bonus,rate,discount,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            l.id,
            o.id,
            l.productId,
            l.qty,
            l.bonus,
            l.rate,
            l.discount,
            l.qty * l.rate,
          ],
        );
    }
    for (const [kind, value] of [
      ["INV", 5],
      ["ORD", 2],
      ["RCPT", 3],
      ["CN", 0],
      ["GRN", 0],
    ])
      await c.query(
        "INSERT INTO document_sequences(kind,value) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [kind, value],
      );
    return { adminCreated: !existing, demoSeeded: true };
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = makePool(loadConfig());
  try {
    const result = await seed(pool, loadConfig());
    console.log(JSON.stringify(result));
  } finally {
    await pool.end();
  }
}
