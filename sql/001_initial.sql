CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
 password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','accounts','sales','warehouse')),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings (
 id integer PRIMARY KEY CHECK(id=1), name text NOT NULL, phone text NOT NULL DEFAULT '',
 address text NOT NULL DEFAULT '', currency text NOT NULL DEFAULT 'PKR' CHECK(currency='PKR'),
 expiry_warning integer NOT NULL DEFAULT 60 CHECK(expiry_warning BETWEEN 1 AND 365)
);
CREATE TABLE IF NOT EXISTS shops (
 id text PRIMARY KEY, name text NOT NULL, owner text NOT NULL, phone text NOT NULL, city text NOT NULL,
 address text NOT NULL DEFAULT '', credit_limit numeric(14,2) NOT NULL CHECK(credit_limit>=0),
 terms integer NOT NULL CHECK(terms BETWEEN 1 AND 365), status text NOT NULL DEFAULT 'Active' CHECK(status IN ('Active','Blocked')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS products (
 id text PRIMARY KEY, name text NOT NULL, strength text NOT NULL DEFAULT '', form text NOT NULL,
 manufacturer text NOT NULL, category text NOT NULL, price numeric(14,2) NOT NULL CHECK(price>0),
 reorder_point integer NOT NULL CHECK(reorder_point>=0), units_per_pack integer NOT NULL CHECK(units_per_pack>0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS suppliers (
 id text PRIMARY KEY, name text NOT NULL, contact text NOT NULL, city text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS batches (
 id text PRIMARY KEY, product_id text NOT NULL REFERENCES products(id), number text NOT NULL,
 expiry date NOT NULL, stock integer NOT NULL CHECK(stock>=0), cost numeric(14,2) NOT NULL CHECK(cost>0),
 status text NOT NULL CHECK(status IN ('Saleable','Quarantine','Expired','Recalled')),
 location text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batches_fefo ON batches(product_id,expiry,id);
CREATE TABLE IF NOT EXISTS goods_receipts (
 id text PRIMARY KEY, supplier_id text NOT NULL REFERENCES suppliers(id), batch_id text NOT NULL REFERENCES batches(id),
 quantity integer NOT NULL CHECK(quantity>0), cost numeric(14,2) NOT NULL CHECK(cost>0), business_date date NOT NULL,
 created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
 id text PRIMARY KEY, shop_id text NOT NULL REFERENCES shops(id), business_date date NOT NULL,
 status text NOT NULL CHECK(status IN ('Draft','Approved','Delivered','Cancelled')),
 total numeric(14,2) NOT NULL CHECK(total>=0), created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_shop_status ON orders(shop_id,status);
CREATE TABLE IF NOT EXISTS order_lines (
 id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), product_id text NOT NULL REFERENCES products(id),
 quantity integer NOT NULL CHECK(quantity>0), bonus integer NOT NULL CHECK(bonus>=0), rate numeric(14,2) NOT NULL CHECK(rate>0),
 discount numeric(5,2) NOT NULL CHECK(discount BETWEEN 0 AND 100), total numeric(14,2) NOT NULL CHECK(total>=0)
);
CREATE TABLE IF NOT EXISTS reservations (
 order_line_id text NOT NULL REFERENCES order_lines(id), batch_id text NOT NULL REFERENCES batches(id),
 quantity integer NOT NULL CHECK(quantity>0), PRIMARY KEY(order_line_id,batch_id)
);
CREATE TABLE IF NOT EXISTS document_sequences (kind text PRIMARY KEY, value bigint NOT NULL CHECK(value>=0));
CREATE TABLE IF NOT EXISTS invoices (
 id text PRIMARY KEY, order_id text UNIQUE REFERENCES orders(id), shop_id text NOT NULL REFERENCES shops(id),
 business_date date NOT NULL, due_date date NOT NULL, total numeric(14,2) NOT NULL CHECK(total>=0),
 created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_aging ON invoices(shop_id,due_date);
CREATE TABLE IF NOT EXISTS invoice_lines (
 id text PRIMARY KEY, invoice_id text NOT NULL REFERENCES invoices(id), product_id text NOT NULL REFERENCES products(id),
 batch_id text NOT NULL REFERENCES batches(id), quantity integer NOT NULL CHECK(quantity>=0), bonus integer NOT NULL CHECK(bonus>=0),
 rate numeric(14,2) NOT NULL CHECK(rate>0), discount numeric(5,2) NOT NULL CHECK(discount BETWEEN 0 AND 100),
 total numeric(14,2) NOT NULL CHECK(total>=0), product_name text NOT NULL, strength text NOT NULL, batch_number text NOT NULL,
 expiry date NOT NULL, unit_cost numeric(14,2) NOT NULL CHECK(unit_cost>0), CHECK(quantity+bonus>0)
);
CREATE TABLE IF NOT EXISTS payments (
 id text PRIMARY KEY, shop_id text NOT NULL REFERENCES shops(id), business_date date NOT NULL,
 amount numeric(14,2) NOT NULL CHECK(amount>0), method text NOT NULL CHECK(method IN ('Cash','Bank transfer','Digital wallet')),
 reference text NOT NULL DEFAULT '', created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_allocations (
 payment_id text NOT NULL REFERENCES payments(id), invoice_id text NOT NULL REFERENCES invoices(id),
 amount numeric(14,2) NOT NULL CHECK(amount>0), PRIMARY KEY(payment_id,invoice_id)
);
CREATE TABLE IF NOT EXISTS returns (
 id text PRIMARY KEY, invoice_id text NOT NULL REFERENCES invoices(id), line_id text NOT NULL REFERENCES invoice_lines(id),
 shop_id text NOT NULL REFERENCES shops(id), product_id text NOT NULL REFERENCES products(id), batch_id text NOT NULL REFERENCES batches(id),
 quarantine_batch_id text NOT NULL REFERENCES batches(id), quantity integer NOT NULL CHECK(quantity>0), total numeric(14,2) NOT NULL CHECK(total>=0),
 reason text NOT NULL, business_date date NOT NULL, created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_ledger (
 id text PRIMARY KEY, shop_id text NOT NULL REFERENCES shops(id), type text NOT NULL CHECK(type IN ('Invoice','Payment','Return')),
 source_id text UNIQUE NOT NULL, amount numeric(14,2) NOT NULL, business_date date NOT NULL,
 created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_shop_date ON customer_ledger(shop_id,business_date,created_at);
CREATE TABLE IF NOT EXISTS stock_movements (
 id text PRIMARY KEY, batch_id text NOT NULL REFERENCES batches(id), quantity integer NOT NULL CHECK(quantity<>0),
 type text NOT NULL CHECK(type IN ('Opening','Receiving','Delivery','Return')),
 source_id text NOT NULL, created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS movements_batch ON stock_movements(batch_id);
CREATE TABLE IF NOT EXISTS audit_logs (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), action text NOT NULL, reference text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
 user_id text NOT NULL REFERENCES users(id), key text NOT NULL, fingerprint text NOT NULL,
 response jsonb, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,key)
);
