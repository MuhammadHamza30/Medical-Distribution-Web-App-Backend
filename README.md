# PharmaFlow backend

Node.js / Express REST API with PostgreSQL storage for the included React administrator workspace. This release implements the credit-sale workflows in the frontend: catalog, shops, stock receiving, orders, full delivery, invoices, payments, returns and statements.

## Requirements

- Node.js 20.19 or later and npm.
- Docker Desktop for the supplied local PostgreSQL/API setup, or an existing PostgreSQL server.
- The `frontend` folder supplied in the full-stack ZIP. Your earlier frontend ZIP remains a browser-local demo; use the updated frontend here to connect to this API.

## Local setup using Docker Desktop

Run these commands **inside the backend folder that contains package.json**:

```powershell
npm ci
npm run setup
docker compose up -d --build
```

`npm run setup` creates `.env` with random database, session and administrator credentials. Save the printed administrator email and password. You can also find them in the local `.env` file. Setup never overwrites an existing `.env`.

Docker Compose starts PostgreSQL and the API, creates the schema and seeds the demonstration records. The database uses a persistent Docker volume. Wait for startup, then check:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

Expected response: `status: ok`.

Start the updated frontend in another PowerShell window:

```powershell
cd ..\frontend
npm ci
Copy-Item .env.example .env
npm run dev
```

Open `http://localhost:5173` and sign in using the credentials printed by backend setup. Use the same hostname for frontend and API, normally `localhost`. Mixing `127.0.0.1` and `localhost` can interfere with cookies.

To stop the containers while keeping records:

```powershell
docker compose down
```

Do not use `docker compose down -v` unless you deliberately want to delete the local database volume. Changing `DB_PASSWORD` in `.env` does not automatically change the password inside an existing PostgreSQL volume; rotate it in PostgreSQL or use your original local credentials.

## Local setup with your own PostgreSQL

Inside `backend`, run `npm ci`, then `npm run setup`. Create a database and user in PostgreSQL and update `DATABASE_URL` in `.env` with those connection details. For an empty local database:

```powershell
npm run migrate
npm run seed
npm run dev
```

`SEED_DEMO=true` creates sample shops, products, opening stock, invoices and payments only when the catalog is empty. Set `SEED_DEMO=false` for a business database. The seed creates the configured administrator and company settings but does not reset existing passwords or overwrite business records.

## Authentication and permissions

Login creates an eight-hour signed session in an HttpOnly cookie and a revocable database session. Passwords use bcrypt with cost 12. Logout and password change revoke sessions. Tokens and passwords are never returned by bootstrap or user listing.

| Role      | API scope                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| admin     | Full administrator frontend, settings, users and all business actions                                                    |
| sales     | Read shops/products/orders/invoices; create, approve and cancel orders; catalog price with at most five percent discount |
| warehouse | Read catalog, stock, suppliers and orders; receive stock and confirm delivery                                            |
| accounts  | Read financial records; add shops, post verified payments and accept authorized returns                                  |

The full React interface is an **administrator workspace**. Other staff roles are enforced on the API but do not have role-specific frontend navigation in this release. There is no public registration or shopkeeper portal. Users can be created through `POST /api/users` by an administrator.

Cookie-authenticated write requests require an allowed `Origin`. Keep `CLIENT_ORIGIN` as a comma-separated list of exact frontend origins. CORS does not use `*`. CLI API clients using a login cookie must also send a matching Origin header for writes.

## Main API endpoints

All paths below are prefixed with `/api`.

| Method     | Endpoint                       | Purpose                                     |
| ---------- | ------------------------------ | ------------------------------------------- |
| GET        | `/health`                      | Database readiness                          |
| POST       | `/auth/login`                  | Email/password login                        |
| GET        | `/auth/me`                     | Current session                             |
| POST       | `/auth/logout`                 | Revoke current session                      |
| POST       | `/auth/password`               | Change password and revoke all sessions     |
| GET        | `/bootstrap`                   | Administrator frontend snapshot             |
| GET / POST | `/shops`                       | Shop listing / creation                     |
| POST       | `/shops/:id/toggle`            | Block or activate new supply                |
| GET / POST | `/products`                    | Product listing / creation                  |
| GET        | `/inventory`                   | Batches and physical stock                  |
| GET / POST | `/suppliers`                   | Supplier contact records                    |
| POST       | `/goods-receipts`              | Receive a batch and post its stock movement |
| GET / POST | `/orders`                      | Orders / draft creation                     |
| POST       | `/orders/:id/approve`          | Credit validation and FEFO reservation      |
| POST       | `/orders/:id/cancel`           | Release reservations and commitments        |
| POST       | `/orders/:id/deliver`          | Full delivery, stock deduction and invoice  |
| GET        | `/invoices` or `/invoices/:id` | Posted invoices and snapshots               |
| GET / POST | `/payments`                    | Cleared receipts and allocations            |
| GET / POST | `/returns`                     | Authorized returns and quarantined stock    |
| GET        | `/shops/:id/statement`         | Dated ledger entries                        |
| PATCH      | `/settings`                    | Company details and expiry warning          |
| GET / POST | `/users`                       | Administrator user management               |
| GET        | `/reports/receivables`         | Exact-decimal invoice balances              |
| GET        | `/reports/reconciliation`      | Stock and ledger consistency checks         |

Business mutations require a unique `Idempotency-Key` header of 8–100 characters. Reuse the same key when retrying the same request. Reusing a key with a different action or payload produces HTTP 409. The supplied frontend adapter creates keys and retries a network failure once using the original key.

Successful administrator mutations return `{result, state}`. Other roles receive `{result}` and must fetch their permitted list endpoints. Errors use `{error: {code, message, fields?, requestId?}}`. Validation errors return 422; business conflicts return 409; unauthorized sessions return 401; role restrictions return 403.

## Transaction behavior

- Shop rows serialize credit and financial changes; product rows and batch locks coordinate inventory operations in a consistent order.
- Approval uses current receivables plus approved, unbilled credit commitments, then reserves eligible batches by earliest expiry.
- Full delivery rechecks the shop and batches, deducts stock, posts immutable invoice line snapshots, creates the customer ledger debit and applies customer advances in one transaction.
- Duplicate deliveries are blocked by status and a unique invoice/order link. Idempotency keys protect retries of other postings.
- Receipts post customer ledger credits, allocate oldest due invoices and preserve excess as customer credit.
- Returns cannot exceed charged packs delivered. They create a credit note and a quarantined batch. Saleable stock is not automatically replenished.
- Existing payment allocations are rebuilt deterministically after returns or new deliveries, leaving excess as unapplied credit. The customer cash ledger remains unchanged by reallocation.
- Money uses PostgreSQL `numeric` and Decimal.js with two-decimal, half-up rounding. A document total is limited to PKR 9,999,999,999.99. Line totals split across batches preserve the posted order total. Frontend snapshot values are converted to numbers for display; server values are authoritative.
- Append-only application ledger, stock movement and audit entries retain actor and source references. The application exposes no delete or arbitrary update endpoints for posted invoices and receipts. Database owners still have direct administrative access; audit records are not cryptographically tamper-proof.

## Testing

```powershell
npm test
```

By default, tests use a temporary in-memory **PGlite PostgreSQL WASM engine**. They exercise real SQL schemas, constraints and transactions through HTTP API tests, without installing a database service. This is not a multiclient PostgreSQL concurrency test.

To also run the concurrent credit approval test against real PostgreSQL:

```powershell
$env:TEST_DATABASE_URL = "postgresql://TEST_USER:TEST_PASSWORD@localhost:5432/pharmaflow_test"
npm test
Remove-Item Env:TEST_DATABASE_URL
```

**Use a separate disposable test database.** Tests truncate its business tables before each case. Never set `TEST_DATABASE_URL` to your live or demo database. Credential generation was verified. Docker image startup and the real PostgreSQL concurrency test were unavailable in the generation environment; verify them in your local Docker setup. The application SQL tests run with PGlite, and browser UI tests run in jsdom.

## Storage and deployment

The schema is in `sql/001_initial.sql`. `npm run migrate` creates the initial schema under a migration advisory lock; future schema changes need new versioned migrations rather than editing live tables manually. Indexes support batch expiry and invoice aging. Query parameters are bound through the PostgreSQL driver.

For production: use HTTPS, `NODE_ENV=production`, secure cookies, private random secrets, an explicit frontend origin, a least-privilege PostgreSQL app account, managed backups and tested restores. Place frontend and API on the same site or reverse-proxy API requests through the frontend origin. Only set `TRUST_PROXY=1` behind a controlled single proxy. Database TLS can be configured through the PostgreSQL connection URL according to your hosting provider. Do not expose PostgreSQL publicly. Local Compose ports bind only to 127.0.0.1.

Login throttling uses an in-memory store; use a shared store when running multiple API instances. Bootstrap currently reads the full administrator dataset and the last 200 audit records; add server pagination and filtered queries before operating at large scale. Idempotency records need a retention policy that exceeds client retry windows.

## Scope still to implement

This is a working starter for the included credit-sale frontend. It does not implement consignment, partial deliveries, invoices at dispatch, supplier payables, alternate selling units, receipt reversals, customer refunds, tax calculations, expiry release/disposal approvals, multiwarehouse transfers, recall notifications, cold-chain sensors, file uploads, sales territory assignments or a shopkeeper login. Authentication includes password change, but self-service password recovery is not included. License verification and jurisdiction-specific invoice rules require separate business review.

Do not interpret the supplied architecture or tests as proof of pharmaceutical regulatory compliance.

## Primary technical references

- Express security guidance: https://expressjs.com/en/advanced/best-practice-security/
- PostgreSQL official Docker image and PostgreSQL 18 volume layout: https://hub.docker.com/_/postgres
#   M e d i c a l - D i s t r i b u t i o n - W e b - A p p - B a c k e n d  
 