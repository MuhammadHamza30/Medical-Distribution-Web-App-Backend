import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { AppError, transaction, mutate, fail, audit } from "./db.mjs";
import { schemas, validate } from "./validation.mjs";
import {
  auth,
  allow,
  signIn,
  cookieOptions,
  COOKIE_NAME,
  cookieToken,
  addUser,
} from "./auth.mjs";
import * as S from "./service.mjs";
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
export function createApp(pool, config) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set("X-Request-Id", req.requestId);
    next();
  });
  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || config.origins.includes(origin))
          return callback(null, true);
        callback(
          new AppError(
            403,
            "ORIGIN_FORBIDDEN",
            "This frontend origin is not allowed.",
          ),
        );
      },
      credentials: true,
      allowedHeaders: ["Content-Type", "Idempotency-Key"],
      methods: ["GET", "POST", "PATCH", "OPTIONS"],
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 300,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: {
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Try again shortly.",
        },
      },
    }),
  );
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      cookieToken(req) &&
      (!req.headers.origin || !config.origins.includes(req.headers.origin))
    )
      return next(
        new AppError(
          403,
          "CSRF_REJECTED",
          "Cookie authenticated changes require an allowed Origin header.",
        ),
      );
    next();
  });
  app.get(
    "/api/health",
    asyncRoute(async (req, res) => {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    }),
  );
  const loginLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 15,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
      error: {
        code: "LOGIN_RATE_LIMITED",
        message: "Too many sign-in attempts. Try again in 15 minutes.",
      },
    },
  });
  app.post(
    "/api/auth/login",
    loginLimit,
    validate(schemas.login),
    asyncRoute(async (req, res) => {
      const { token, user } = await signIn(pool, config, req.input);
      res.cookie(COOKIE_NAME, token, cookieOptions(config));
      res.json({ user });
    }),
  );
  app.use("/api", auth(pool, config));
  app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));
  app.post(
    "/api/auth/logout",
    asyncRoute(async (req, res) => {
      await pool.query("DELETE FROM sessions WHERE id=$1", [req.sessionId]);
      res.clearCookie(COOKIE_NAME, {
        ...cookieOptions(config),
        maxAge: undefined,
      });
      res.json({ ok: true });
    }),
  );
  app.post(
    "/api/auth/password",
    validate(schemas.password),
    asyncRoute(async (req, res) => {
      await transaction(pool, async (c) => {
        const u = (
          await c.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [
            req.user.id,
          ])
        ).rows[0];
        if (!(await bcrypt.compare(req.input.currentPassword, u.password_hash)))
          fail(401, "INVALID_PASSWORD", "Current password is incorrect.");
        await c.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
          u.id,
          await bcrypt.hash(req.input.newPassword, 12),
        ]);
        await c.query("DELETE FROM sessions WHERE user_id=$1", [u.id]);
        await audit(c, req.user, "Password changed", u.email);
      });
      res.clearCookie(COOKIE_NAME, {
        ...cookieOptions(config),
        maxAge: undefined,
      });
      res.json({ ok: true, message: "Password updated. Sign in again." });
    }),
  );
  const readSnapshot = () =>
    transaction(pool, async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      return S.snapshot(c, S.businessDate(config));
    });
  app.get(
    "/api/bootstrap",
    allow("admin"),
    asyncRoute(async (req, res) =>
      res.json({ state: await readSnapshot(), user: req.user }),
    ),
  );
  for (const [path, key, roles] of [
    ["products", "products", ["admin", "sales", "warehouse", "accounts"]],
    ["inventory", "batches", ["admin", "warehouse", "accounts"]],
    ["shops", "shops", ["admin", "sales", "accounts"]],
    ["orders", "orders", ["admin", "sales", "warehouse", "accounts"]],
    ["invoices", "invoices", ["admin", "accounts", "sales"]],
    ["payments", "payments", ["admin", "accounts"]],
    ["returns", "returns", ["admin", "accounts", "warehouse"]],
    ["suppliers", "suppliers", ["admin", "warehouse", "accounts"]],
  ])
    app.get(
      "/api/" + path,
      allow(...roles),
      asyncRoute(async (req, res) =>
        res.json({ data: (await readSnapshot())[key] }),
      ),
    );
  app.get(
    "/api/shops/:id/statement",
    allow("admin", "accounts", "sales"),
    asyncRoute(async (req, res) => {
      const rows = (
        await pool.query(
          "SELECT type,source_id,amount,business_date,created_at FROM customer_ledger WHERE shop_id=$1 ORDER BY business_date,created_at,id",
          [req.params.id],
        )
      ).rows;
      res.json({ data: rows });
    }),
  );
  app.get(
    "/api/invoices/:id",
    allow("admin", "accounts", "sales"),
    asyncRoute(async (req, res) => {
      const i = (await readSnapshot()).invoices.find(
        (i) => i.id === req.params.id,
      );
      if (!i) fail(404, "NOT_FOUND", "Invoice not found.");
      res.json({ data: i });
    }),
  );
  const mutation = (
    path,
    roles,
    schema,
    fn,
    { withState = true, method = "post" } = {},
  ) =>
    app[method](
      path,
      allow(...roles),
      ...(schema ? [validate(schema)] : []),
      asyncRoute(async (req, res) => {
        const input = req.input || {};
        const result = await mutate(
          pool,
          req.user,
          req.get("Idempotency-Key"),
          req.method + " " + req.path,
          input,
          (c) => fn(c, req.user, input, req.params, S.businessDate(config)),
        );
        res.json({
          result,
          ...(withState && req.user.role === "admin"
            ? { state: await readSnapshot() }
            : {}),
        });
      }),
    );
  mutation("/api/shops", ["admin", "accounts"], schemas.shop, (c, u, v) =>
    S.addShop(c, u, v),
  );
  mutation("/api/shops/:id/toggle", ["admin"], null, (c, u, v, p) =>
    S.toggleShop(c, u, p.id),
  );
  mutation(
    "/api/products",
    ["admin", "warehouse"],
    schemas.product,
    (c, u, v) => S.addProduct(c, u, v),
  );
  mutation(
    "/api/suppliers",
    ["admin", "warehouse"],
    schemas.supplier,
    (c, u, v) => S.addSupplier(c, u, v),
  );
  mutation(
    "/api/goods-receipts",
    ["admin", "warehouse"],
    schemas.receiving,
    (c, u, v, p, d) => S.receive(c, u, v, d),
  );
  mutation("/api/orders", ["admin", "sales"], schemas.order, (c, u, v, p, d) =>
    S.createOrder(c, u, v, d),
  );
  mutation(
    "/api/orders/:id/approve",
    ["admin", "sales"],
    null,
    (c, u, v, p, d) => S.approve(c, u, p.id, d),
  );
  mutation("/api/orders/:id/cancel", ["admin", "sales"], null, (c, u, v, p) =>
    S.cancel(c, u, p.id),
  );
  mutation(
    "/api/orders/:id/deliver",
    ["admin", "warehouse"],
    null,
    (c, u, v, p, d) => S.deliver(c, u, p.id, d),
  );
  mutation(
    "/api/payments",
    ["admin", "accounts"],
    schemas.payment,
    (c, u, v, p, d) => S.payment(c, u, v, d),
  );
  mutation(
    "/api/returns",
    ["admin", "accounts"],
    schemas.returned,
    (c, u, v, p, d) => S.returned(c, u, v, d),
  );
  mutation(
    "/api/settings",
    ["admin"],
    schemas.settings,
    (c, u, v) => S.settings(c, u, v),
    { method: "patch" },
  );
  mutation(
    "/api/users",
    ["admin"],
    schemas.user,
    (c, u, v) => addUser(c, u, v),
    { withState: false },
  );
  app.get(
    "/api/users",
    allow("admin"),
    asyncRoute(async (req, res) =>
      res.json({
        data: (
          await pool.query(
            "SELECT id,name,email,role,active,created_at FROM users ORDER BY created_at",
          )
        ).rows,
      }),
    ),
  );
  app.get(
    "/api/reports/receivables",
    allow("admin", "accounts"),
    asyncRoute(async (req, res) =>
      res.json({ data: await S.receivableReport(pool) }),
    ),
  );
  app.get(
    "/api/reports/reconciliation",
    allow("admin", "accounts"),
    asyncRoute(async (req, res) =>
      res.json(
        await transaction(pool, async (c) => {
          await c.query(
            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
          );
          return S.reconciliation(c);
        }),
      ),
    ),
  );
  app.use((req, res) =>
    res
      .status(404)
      .json({ error: { code: "NOT_FOUND", message: "Endpoint not found." } }),
  );
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = error.status || 500,
      code = error.code || "INTERNAL_ERROR",
      message = error.message;
    if (error.code === "23505") {
      status = 409;
      code = "DUPLICATE_RECORD";
      message = "A record with these unique details already exists.";
    } else if (error.code === "23503") {
      status = 422;
      code = "INVALID_REFERENCE";
      message = "A referenced record does not exist.";
    } else if (error.code === "23514" || error.code === "22003") {
      status = 422;
      code = "INVALID_VALUE";
      message = "A submitted value exceeds the allowed range.";
    }
    if (status >= 500) {
      console.error(
        JSON.stringify({
          requestId: req.requestId,
          code: error.code || "INTERNAL_ERROR",
        }),
      );
      message = "The server could not complete the request.";
    }
    res
      .status(status)
      .json({ error: { code, message, requestId: req.requestId } });
  });
  return app;
}
