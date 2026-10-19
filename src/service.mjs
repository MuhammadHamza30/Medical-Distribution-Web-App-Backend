import Decimal from "decimal.js";
import { id, fail, audit } from "./db.mjs";
export const decimal = (v) => new Decimal(v || 0);
const calendarDate = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const cents = (v) =>
  decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const sum = (values) => values.reduce((s, v) => s.plus(v), decimal(0));
export function businessDate(config) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
export function addDays(value, days) {
  const d = new Date(value + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
async function one(c, sql, args = [], message = "Record not found.") {
  const r = await c.query(sql, args);
  if (!r.rows[0]) fail(404, "NOT_FOUND", message);
  return r.rows[0];
}
async function lockShop(c, id) {
  return one(
    c,
    "SELECT * FROM shops WHERE id=$1 FOR UPDATE",
    [id],
    "Shop not found.",
  );
}
async function lockProducts(c, ids) {
  return (
    await c.query(
      "SELECT * FROM products WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE",
      [[...new Set(ids)]],
    )
  ).rows;
}
async function balance(c, shopId) {
  return (
    await c.query(
      "SELECT COALESCE(SUM(amount),0) value FROM customer_ledger WHERE shop_id=$1",
      [shopId],
    )
  ).rows[0].value;
}
async function committed(c, shopId, exclude = "") {
  return (
    await c.query(
      "SELECT COALESCE(SUM(total),0) value FROM orders WHERE shop_id=$1 AND status='Approved' AND id<>$2",
      [shopId, exclude],
    )
  ).rows[0].value;
}
async function ledger(c, user, shopId, type, source, amount, date) {
  await c.query(
    "INSERT INTO customer_ledger(id,shop_id,type,source_id,amount,business_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [id("ledger"), shopId, type, source, cents(amount), date, user.id],
  );
}
async function stockMovement(c, user, batchId, quantity, type, source) {
  await c.query(
    "INSERT INTO stock_movements(id,batch_id,quantity,type,source_id,created_by) VALUES($1,$2,$3,$4,$5,$6)",
    [id("movement"), batchId, quantity, type, source, user.id],
  );
}
async function nextDocument(c, kind, date) {
  const { rows } = await c.query(
    "INSERT INTO document_sequences(kind,value) VALUES($1,1) ON CONFLICT(kind) DO UPDATE SET value=document_sequences.value+1 RETURNING value",
    [kind],
  );
  return `${kind}-${date.slice(0, 4)}-${String(rows[0].value).padStart(6, "0")}`;
}
function limitMoney(value) {
  if (decimal(value).gt("9999999999.99"))
    fail(
      422,
      "AMOUNT_TOO_LARGE",
      "Document amount exceeds the allowed maximum.",
    );
}
async function invoiceFinancial(c, shopId) {
  return (
    await c.query(
      `SELECT i.*,COALESCE((SELECT SUM(total) FROM returns r WHERE r.invoice_id=i.id),0) credits,COALESCE((SELECT SUM(amount) FROM payment_allocations a WHERE a.invoice_id=i.id),0) paid FROM invoices i WHERE shop_id=$1 ORDER BY due_date,business_date,created_at,id`,
      [shopId],
    )
  ).rows;
}
// Shop lock serializes financial operations. Rebuild allocations deterministically after a new credit or delivery.
async function allocateCredits(c, shopId) {
  const invoices = await invoiceFinancial(c, shopId),
    payments = (
      await c.query(
        "SELECT * FROM payments WHERE shop_id=$1 ORDER BY business_date,created_at,id",
        [shopId],
      )
    ).rows;
  const capacity = new Map(
    invoices.map((i) => [
      i.id,
      Decimal.max(0, decimal(i.total).minus(i.credits)),
    ]),
  );
  await c.query(
    "DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM payments WHERE shop_id=$1)",
    [shopId],
  );
  for (const payment of payments) {
    let available = decimal(payment.amount);
    for (const invoice of invoices) {
      const take = Decimal.min(available, capacity.get(invoice.id));
      if (take.gt(0)) {
        await c.query(
          "INSERT INTO payment_allocations(payment_id,invoice_id,amount) VALUES($1,$2,$3)",
          [payment.id, invoice.id, cents(take)],
        );
        capacity.set(invoice.id, capacity.get(invoice.id).minus(take));
        available = available.minus(take);
      }
      if (available.lte(0)) break;
    }
  }
}
export async function addShop(c, user, v) {
  const shopId = id("shop");
  await c.query(
    "INSERT INTO shops(id,name,owner,phone,city,address,credit_limit,terms) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      shopId,
      v.name,
      v.owner,
      v.phone,
      v.city,
      v.address,
      cents(v.limit),
      v.terms,
    ],
  );
  await audit(c, user, "Shop added", v.name);
  return { id: shopId };
}
export async function toggleShop(c, user, shopId) {
  const shop = await lockShop(c, shopId);
  const status = shop.status === "Active" ? "Blocked" : "Active";
  await c.query("UPDATE shops SET status=$2 WHERE id=$1", [shopId, status]);
  await audit(c, user, `Shop ${status.toLowerCase()}`, shop.name);
  return { id: shopId, status };
}
export async function addProduct(c, user, v) {
  const productId = id("product");
  await c.query(
    "INSERT INTO products(id,name,strength,form,manufacturer,category,price,reorder_point,units_per_pack) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      productId,
      v.name,
      v.strength,
      v.form,
      v.manufacturer,
      v.category,
      cents(v.price),
      v.reorder,
      v.pack,
    ],
  );
  await audit(c, user, "Product added", v.name);
  return { id: productId };
}
export async function addSupplier(c, user, v) {
  const supplierId = id("supplier");
  await c.query(
    "INSERT INTO suppliers(id,name,contact,city) VALUES($1,$2,$3,$4)",
    [supplierId, v.name, v.contact, v.city],
  );
  await audit(c, user, "Supplier added", v.name);
  return { id: supplierId };
}
export async function receive(c, user, v, date) {
  if (v.expiry <= date)
    fail(422, "BATCH_EXPIRED", "Expiry must be after the business date.");
  await one(
    c,
    "SELECT id FROM suppliers WHERE id=$1",
    [v.supplierId],
    "Supplier not found.",
  );
  if (!(await lockProducts(c, [v.productId])).length)
    fail(404, "NOT_FOUND", "Product not found.");
  const batchId = id("batch"),
    receiptId = await nextDocument(c, "GRN", date);
  await c.query(
    "INSERT INTO batches(id,product_id,number,expiry,stock,cost,status,location) VALUES($1,$2,$3,$4,$5,$6,'Saleable','Main warehouse')",
    [batchId, v.productId, v.number, v.expiry, v.qty, cents(v.cost)],
  );
  await c.query(
    "INSERT INTO goods_receipts(id,supplier_id,batch_id,quantity,cost,business_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [receiptId, v.supplierId, batchId, v.qty, cents(v.cost), date, user.id],
  );
  await stockMovement(c, user, batchId, v.qty, "Receiving", receiptId);
  await audit(c, user, "Stock received", receiptId);
  return { id: receiptId, batchId };
}
export async function createOrder(c, user, v, date) {
  const shop = await lockShop(c, v.shopId);
  if (shop.status !== "Active")
    fail(409, "SHOP_BLOCKED", "This shop is blocked for new supply.");
  const products = await lockProducts(
      c,
      v.lines.map((l) => l.productId),
    ),
    map = new Map(products.map((p) => [p.id, p]));
  const lines = v.lines.map((l) => {
    const product = map.get(l.productId);
    if (!product) fail(404, "NOT_FOUND", "Product not found.");
    if (
      user.role !== "admin" &&
      (!decimal(l.rate).eq(product.price) || l.discount > 5)
    )
      fail(
        403,
        "PRICE_PERMISSION",
        "Only an administrator can change catalog prices or apply discounts above five percent.",
      );
    return {
      ...l,
      id: id("line"),
      total: cents(
        decimal(l.rate)
          .mul(l.qty)
          .mul(decimal(1).minus(decimal(l.discount).div(100))),
      ),
    };
  });
  const total = cents(sum(lines.map((l) => l.total)));
  limitMoney(total);
  const orderId = await nextDocument(c, "ORD", date);
  await c.query(
    "INSERT INTO orders(id,shop_id,business_date,status,total,created_by) VALUES($1,$2,$3,'Draft',$4,$5)",
    [orderId, v.shopId, date, total, user.id],
  );
  for (const l of lines)
    await c.query(
      "INSERT INTO order_lines(id,order_id,product_id,quantity,bonus,rate,discount,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        l.id,
        orderId,
        l.productId,
        l.qty,
        l.bonus,
        cents(l.rate),
        cents(l.discount),
        l.total,
      ],
    );
  await audit(c, user, "Order created", orderId);
  return { id: orderId };
}
async function lockedOrder(c, orderId) {
  const info = await one(
    c,
    "SELECT shop_id FROM orders WHERE id=$1",
    [orderId],
    "Order not found.",
  );
  const shop = await lockShop(c, info.shop_id),
    order = await one(c, "SELECT * FROM orders WHERE id=$1 FOR UPDATE", [
      orderId,
    ]);
  const lines = (
    await c.query("SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id", [
      orderId,
    ])
  ).rows;
  return { shop, order, lines };
}
async function checkCredit(c, shop, order) {
  if (shop.status !== "Active")
    fail(409, "SHOP_BLOCKED", "This shop is blocked for new supply.");
  const used = decimal(await balance(c, shop.id))
    .plus(await committed(c, shop.id, order.id))
    .plus(order.total);
  if (used.gt(shop.credit_limit))
    fail(
      409,
      "CREDIT_LIMIT_EXCEEDED",
      "This order exceeds the shop credit limit. Collect payment or revise the draft.",
    );
}
export async function approve(c, user, orderId, date) {
  const { shop, order, lines } = await lockedOrder(c, orderId);
  if (order.status !== "Draft")
    fail(409, "INVALID_STATUS", "Only draft orders can be approved.");
  await checkCredit(c, shop, order);
  await lockProducts(
    c,
    lines.map((l) => l.product_id),
  );
  for (const line of lines) {
    let remaining = line.quantity + line.bonus;
    const batches = (
      await c.query(
        "SELECT * FROM batches WHERE product_id=$1 AND status='Saleable' AND expiry>$2 ORDER BY expiry,id FOR UPDATE",
        [line.product_id, date],
      )
    ).rows;
    for (const batch of batches) {
      const reserved = Number(
        (
          await c.query(
            "SELECT COALESCE(SUM(r.quantity),0) value FROM reservations r JOIN order_lines l ON l.id=r.order_line_id JOIN orders o ON o.id=l.order_id WHERE r.batch_id=$1 AND (o.status='Approved' OR o.id=$2)",
            [batch.id, orderId],
          )
        ).rows[0].value,
      );
      const take = Math.min(remaining, Math.max(0, batch.stock - reserved));
      if (take > 0) {
        await c.query(
          "INSERT INTO reservations(order_line_id,batch_id,quantity) VALUES($1,$2,$3)",
          [line.id, batch.id, take],
        );
        remaining -= take;
      }
      if (!remaining) break;
    }
    if (remaining)
      fail(
        409,
        "STOCK_UNAVAILABLE",
        "Not enough eligible stock to approve every ordered pack.",
      );
  }
  await c.query("UPDATE orders SET status='Approved' WHERE id=$1", [orderId]);
  await audit(c, user, "Order approved", orderId);
  return { id: orderId, status: "Approved" };
}
export async function cancel(c, user, orderId) {
  const { order } = await lockedOrder(c, orderId);
  if (!["Draft", "Approved"].includes(order.status))
    fail(409, "INVALID_STATUS", "This order cannot be cancelled.");
  await c.query(
    "DELETE FROM reservations WHERE order_line_id IN (SELECT id FROM order_lines WHERE order_id=$1)",
    [orderId],
  );
  await c.query("UPDATE orders SET status='Cancelled' WHERE id=$1", [orderId]);
  await audit(c, user, "Order cancelled", orderId);
  return { id: orderId, status: "Cancelled" };
}
export async function deliver(c, user, orderId, date) {
  const { shop, order, lines } = await lockedOrder(c, orderId);
  if (order.status !== "Approved")
    fail(
      409,
      "INVALID_STATUS",
      "Approve the order before confirming delivery.",
    );
  await checkCredit(c, shop, order);
  const products = await lockProducts(
      c,
      lines.map((l) => l.product_id),
    ),
    map = new Map(products.map((p) => [p.id, p]));
  const allocations = (
    await c.query(
      "SELECT r.*,b.* FROM reservations r JOIN batches b ON b.id=r.batch_id WHERE r.order_line_id=ANY($1::text[]) ORDER BY b.expiry,b.id FOR UPDATE OF b",
      [lines.map((l) => l.id)],
    )
  ).rows;
  const invoiceId = await nextDocument(c, "INV", date);
  await c.query(
    "INSERT INTO invoices(id,order_id,shop_id,business_date,due_date,total,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      invoiceId,
      orderId,
      shop.id,
      date,
      addDays(date, shop.terms),
      order.total,
      user.id,
    ],
  );
  for (const line of lines) {
    let paidLeft = line.quantity;
    const pieces = allocations.filter((a) => a.order_line_id === line.id);
    if (
      pieces.reduce((s, a) => s + a.quantity, 0) !==
      line.quantity + line.bonus
    )
      fail(409, "RESERVATION_INVALID", "Stock reservation is incomplete.");
    let assignedTotal = decimal(0),
      paidAssigned = 0;
    for (let index = 0; index < pieces.length; index++) {
      const a = pieces[index];
      if (a.status !== "Saleable" || calendarDate(a.expiry) <= date)
        fail(
          409,
          "BATCH_INELIGIBLE",
          "A reserved batch is expired, quarantined or recalled. Cancel and recreate this order.",
        );
      const paid = Math.min(paidLeft, a.quantity);
      paidLeft -= paid;
      paidAssigned += paid;
      let part = cents(
        decimal(line.total)
          .mul(paidAssigned)
          .div(line.quantity)
          .minus(assignedTotal),
      );
      if (index === pieces.length - 1)
        part = cents(decimal(line.total).minus(assignedTotal));
      assignedTotal = assignedTotal.plus(part);
      const updated = await c.query(
        "UPDATE batches SET stock=stock-$2 WHERE id=$1 AND stock>=$2 RETURNING id",
        [a.batch_id, a.quantity],
      );
      if (!updated.rowCount)
        fail(409, "STOCK_UNAVAILABLE", "Reserved stock is unavailable.");
      const product = map.get(line.product_id);
      await c.query(
        "INSERT INTO invoice_lines(id,invoice_id,product_id,batch_id,quantity,bonus,rate,discount,total,product_name,strength,batch_number,expiry,unit_cost) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
        [
          id("il"),
          invoiceId,
          line.product_id,
          a.batch_id,
          paid,
          a.quantity - paid,
          line.rate,
          line.discount,
          part,
          product.name,
          product.strength,
          a.number,
          a.expiry,
          a.cost,
        ],
      );
      await stockMovement(
        c,
        user,
        a.batch_id,
        -a.quantity,
        "Delivery",
        invoiceId,
      );
    }
  }
  await c.query("UPDATE orders SET status='Delivered' WHERE id=$1", [orderId]);
  await ledger(c, user, shop.id, "Invoice", invoiceId, order.total, date);
  await allocateCredits(c, shop.id);
  await audit(c, user, "Delivery confirmed and invoice posted", invoiceId);
  return { id: orderId, invoiceId, status: "Delivered" };
}
export async function payment(c, user, v, date) {
  if (v.date > date)
    fail(422, "FUTURE_RECEIPT", "Receipt date cannot be in the future.");
  await lockShop(c, v.shopId);
  const receiptId = await nextDocument(c, "RCPT", date);
  await c.query(
    "INSERT INTO payments(id,shop_id,business_date,amount,method,reference,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      receiptId,
      v.shopId,
      v.date,
      cents(v.amount),
      v.method,
      v.reference,
      user.id,
    ],
  );
  await ledger(
    c,
    user,
    v.shopId,
    "Payment",
    receiptId,
    decimal(v.amount).negated(),
    v.date,
  );
  const invoices = (await invoiceFinancial(c, v.shopId)).filter(
    (i) => calendarDate(i.business_date) <= v.date,
  );
  let available = decimal(v.amount);
  for (const invoice of invoices) {
    const due = Decimal.max(
        0,
        decimal(invoice.total).minus(invoice.credits).minus(invoice.paid),
      ),
      take = Decimal.min(available, due);
    if (take.gt(0)) {
      await c.query(
        "INSERT INTO payment_allocations(payment_id,invoice_id,amount) VALUES($1,$2,$3)",
        [receiptId, invoice.id, cents(take)],
      );
      available = available.minus(take);
    }
    if (available.lte(0)) break;
  }
  await audit(c, user, "Payment recorded", receiptId);
  return { id: receiptId, unallocated: cents(available) };
}
export async function returned(c, user, v, date) {
  const invoice = await one(
    c,
    "SELECT * FROM invoices WHERE id=$1",
    [v.invoiceId],
    "Invoice not found.",
  );
  await lockShop(c, invoice.shop_id);
  const line = await one(
    c,
    "SELECT * FROM invoice_lines WHERE id=$1 AND invoice_id=$2",
    [v.lineId, v.invoiceId],
    "Invoice line not found.",
  );
  await lockProducts(c, [line.product_id]);
  const previous = (
    await c.query(
      "SELECT COALESCE(SUM(quantity),0) qty,COALESCE(SUM(total),0) total FROM returns WHERE line_id=$1",
      [line.id],
    )
  ).rows[0];
  if (v.qty + Number(previous.qty) > line.quantity)
    fail(
      409,
      "RETURN_QUANTITY_EXCEEDED",
      "Cumulative return quantity exceeds charged packs delivered.",
    );
  let credit = cents(
    decimal(line.rate)
      .mul(v.qty)
      .mul(decimal(1).minus(decimal(line.discount).div(100))),
  );
  if (v.qty + Number(previous.qty) === line.quantity)
    credit = cents(decimal(line.total).minus(previous.total));
  credit = cents(
    Decimal.min(decimal(credit), decimal(line.total).minus(previous.total)),
  );
  const original = await one(
      c,
      "SELECT * FROM batches WHERE id=$1 FOR UPDATE",
      [line.batch_id],
    ),
    batchId = id("quarantine"),
    creditId = await nextDocument(c, "CN", date);
  await c.query(
    "INSERT INTO batches(id,product_id,number,expiry,stock,cost,status,location) VALUES($1,$2,$3,$4,$5,$6,'Quarantine','Returns quarantine')",
    [
      batchId,
      line.product_id,
      line.batch_number,
      line.expiry,
      v.qty,
      line.unit_cost,
    ],
  );
  await c.query(
    "INSERT INTO returns(id,invoice_id,line_id,shop_id,product_id,batch_id,quarantine_batch_id,quantity,total,reason,business_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      creditId,
      invoice.id,
      line.id,
      invoice.shop_id,
      line.product_id,
      original.id,
      batchId,
      v.qty,
      credit,
      v.reason,
      date,
      user.id,
    ],
  );
  await stockMovement(c, user, batchId, v.qty, "Return", creditId);
  await ledger(
    c,
    user,
    invoice.shop_id,
    "Return",
    creditId,
    decimal(credit).negated(),
    date,
  );
  await allocateCredits(c, invoice.shop_id);
  await audit(c, user, "Return accepted and credit posted", creditId);
  return { id: creditId, credit, quarantineBatchId: batchId };
}
export async function settings(c, user, v) {
  await c.query(
    "UPDATE settings SET name=$1,phone=$2,address=$3,expiry_warning=$4 WHERE id=1",
    [v.name, v.phone, v.address, v.expiryWarning],
  );
  await audit(c, user, "Settings updated", v.name);
  return { id: 1 };
}
export async function snapshot(c, date) {
  const products = (
    await c.query("SELECT * FROM products ORDER BY created_at,id")
  ).rows.map((p) => ({
    id: p.id,
    name: p.name,
    strength: p.strength,
    form: p.form,
    manufacturer: p.manufacturer,
    category: p.category,
    price: Number(p.price),
    reorder: p.reorder_point,
    pack: p.units_per_pack,
    unit: "pack",
  }));
  const shops = (
    await c.query("SELECT * FROM shops ORDER BY created_at,id")
  ).rows.map((s) => ({
    id: s.id,
    name: s.name,
    owner: s.owner,
    phone: s.phone,
    city: s.city,
    address: s.address,
    limit: Number(s.credit_limit),
    terms: s.terms,
    status: s.status,
    initials: s.name
      .split(" ")
      .slice(0, 2)
      .map((x) => x[0])
      .join("")
      .toUpperCase(),
  }));
  const batches = (
    await c.query("SELECT * FROM batches ORDER BY created_at,id")
  ).rows.map((b) => ({
    id: b.id,
    productId: b.product_id,
    number: b.number,
    expiry: calendarDate(b.expiry),
    stock: b.stock,
    cost: Number(b.cost),
    status: b.status,
    location: b.location,
  }));
  const orderLines = (await c.query("SELECT * FROM order_lines ORDER BY id"))
      .rows,
    allocations = (await c.query("SELECT * FROM reservations")).rows,
    invLines = (await c.query("SELECT * FROM invoice_lines ORDER BY id")).rows,
    paid = (await c.query("SELECT * FROM payment_allocations")).rows;
  const mapLine = (l) => ({
    id: l.id,
    productId: l.product_id,
    batchId: l.batch_id,
    qty: l.quantity,
    bonus: l.bonus,
    rate: Number(l.rate),
    discount: Number(l.discount),
    total: Number(l.total),
    productName: l.product_name,
    strength: l.strength,
    batchNumber: l.batch_number,
    expiry: l.expiry ? calendarDate(l.expiry) : undefined,
  });
  const invoices = (
    await c.query("SELECT * FROM invoices ORDER BY created_at DESC,id")
  ).rows.map((i) => ({
    id: i.id,
    orderId: i.order_id,
    shopId: i.shop_id,
    date: calendarDate(i.business_date),
    due: calendarDate(i.due_date),
    total: Number(i.total),
    lines: invLines.filter((l) => l.invoice_id === i.id).map(mapLine),
  }));
  const orders = (
    await c.query("SELECT * FROM orders ORDER BY created_at DESC,id")
  ).rows.map((o) => ({
    id: o.id,
    shopId: o.shop_id,
    date: calendarDate(o.business_date),
    status: o.status,
    total: Number(o.total),
    invoiceId: invoices.find((i) => i.orderId === o.id)?.id,
    lines: orderLines.filter((l) => l.order_id === o.id).map(mapLine),
    allocations: allocations
      .filter((a) =>
        orderLines.some((l) => l.id === a.order_line_id && l.order_id === o.id),
      )
      .map((a) => ({
        lineId: a.order_line_id,
        batchId: a.batch_id,
        qty: a.quantity,
      })),
  }));
  const payments = (
    await c.query("SELECT * FROM payments ORDER BY created_at DESC,id")
  ).rows.map((p) => ({
    id: p.id,
    shopId: p.shop_id,
    date: calendarDate(p.business_date),
    amount: Number(p.amount),
    method: p.method,
    reference: p.reference,
    allocations: paid
      .filter((a) => a.payment_id === p.id)
      .map((a) => ({ invoiceId: a.invoice_id, amount: Number(a.amount) })),
  }));
  const returns = (
    await c.query("SELECT * FROM returns ORDER BY created_at DESC,id")
  ).rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoice_id,
    lineId: r.line_id,
    shopId: r.shop_id,
    productId: r.product_id,
    batchId: r.batch_id,
    date: calendarDate(r.business_date),
    qty: r.quantity,
    total: Number(r.total),
    reason: r.reason,
    disposition: "Quarantine",
  }));
  const suppliers = (
    await c.query("SELECT * FROM suppliers ORDER BY created_at,id")
  ).rows;
  const receivings = (
    await c.query(
      "SELECT r.*,b.product_id,b.number,b.expiry FROM goods_receipts r JOIN batches b ON b.id=r.batch_id ORDER BY r.created_at DESC",
    )
  ).rows.map((r) => ({
    id: r.id,
    supplierId: r.supplier_id,
    batchId: r.batch_id,
    productId: r.product_id,
    date: calendarDate(r.business_date),
    number: r.number,
    expiry: calendarDate(r.expiry),
    qty: r.quantity,
    cost: Number(r.cost),
  }));
  const audit = (
    await c.query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200")
  ).rows.map((a) => ({
    id: a.id,
    date: new Date(a.created_at).toISOString(),
    action: a.action,
    ref: a.reference,
  }));
  const s = await one(c, "SELECT * FROM settings WHERE id=1");
  return {
    version: 1,
    today: date,
    products,
    shops,
    batches,
    invoices,
    orders,
    payments,
    returns,
    suppliers,
    receivings,
    audit,
    settings: {
      name: s.name,
      phone: s.phone,
      address: s.address,
      currency: s.currency,
      expiryWarning: s.expiry_warning,
    },
  };
}
export async function receivableReport(c) {
  return (
    await c.query(
      `SELECT i.id,i.shop_id,s.name shop,i.business_date,i.due_date,i.total,COALESCE(r.credits,0) credited,COALESCE(a.paid,0) paid,GREATEST(0,i.total-COALESCE(r.credits,0)-COALESCE(a.paid,0)) outstanding FROM invoices i JOIN shops s ON s.id=i.shop_id LEFT JOIN (SELECT invoice_id,SUM(total) credits FROM returns GROUP BY invoice_id) r ON r.invoice_id=i.id LEFT JOIN (SELECT invoice_id,SUM(amount) paid FROM payment_allocations GROUP BY invoice_id) a ON a.invoice_id=i.id ORDER BY i.due_date`,
    )
  ).rows;
}
export async function reconciliation(c) {
  const stock = (
    await c.query(
      "SELECT b.id,b.stock,COALESCE(SUM(m.quantity),0) movement_quantity FROM batches b LEFT JOIN stock_movements m ON m.batch_id=b.id GROUP BY b.id HAVING b.stock<>COALESCE(SUM(m.quantity),0)",
    )
  ).rows;
  const ledgerDifferences = (
    await c.query(
      `SELECT s.id,COALESCE((SELECT SUM(amount) FROM customer_ledger l WHERE l.shop_id=s.id),0) ledger,COALESCE((SELECT SUM(total) FROM invoices i WHERE i.shop_id=s.id),0)-COALESCE((SELECT SUM(amount) FROM payments p WHERE p.shop_id=s.id),0)-COALESCE((SELECT SUM(total) FROM returns r WHERE r.shop_id=s.id),0) documents FROM shops s`,
    )
  ).rows.filter((x) => !decimal(x.ledger).eq(x.documents));
  return {
    stockDifferences: stock,
    ledgerDifferences,
    ok: stock.length === 0 && ledgerDifferences.length === 0,
  };
}
