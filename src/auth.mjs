import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { id, fail, audit } from "./db.mjs";
export const COOKIE_NAME = "pharmaflow_session";
export function cookieOptions(config) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/api",
    maxAge: 8 * 60 * 60 * 1000,
  };
}
export function cookieToken(req) {
  try {
    const token = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(COOKIE_NAME + "="))
      ?.slice(COOKIE_NAME.length + 1);
    return token ? decodeURIComponent(token) : null;
  } catch {
    return null;
  }
}
export function auth(pool, config) {
  return async (req, res, next) => {
    try {
      const token = cookieToken(req);
      if (!token) fail(401, "AUTH_REQUIRED", "Sign in to continue.");
      let claims;
      try {
        claims = jwt.verify(token, config.jwtSecret, {
          algorithms: ["HS256"],
          issuer: "pharmaflow",
          audience: "pharmaflow-api",
        });
      } catch {
        fail(
          401,
          "SESSION_EXPIRED",
          "Your session has expired. Sign in again.",
        );
      }
      const result = await pool.query(
        "SELECT u.id,u.name,u.email,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.id=$1 AND u.id=$2 AND s.expires_at>now() AND u.active=true",
        [claims.sid, claims.sub],
      );
      if (!result.rowCount)
        fail(401, "SESSION_EXPIRED", "Your session is no longer active.");
      req.user = result.rows[0];
      req.sessionId = claims.sid;
      next();
    } catch (e) {
      next(e);
    }
  };
}
export const allow =
  (...roles) =>
  (req, res, next) => {
    if (!roles.includes(req.user.role))
      return next(
        Object.assign(new Error("Your role cannot perform this action."), {
          status: 403,
          code: "FORBIDDEN",
        }),
      );
    next();
  };
export async function signIn(pool, config, v) {
  const result = await pool.query("SELECT * FROM users WHERE email=$1", [
    v.email,
  ]);
  const user = result.rows[0];
  const fallback =
    "$2b$12$CbpsWsSKJJ.cOHJa.u3PNeAfGEbGCXBcqGXMCBjKLdcAdTcMOjSLe";
  const valid = await bcrypt.compare(
    v.password,
    user?.password_hash || fallback,
  );
  if (!valid || !user?.active)
    fail(401, "INVALID_LOGIN", "Email or password is incorrect.");
  const sessionId = id("session");
  await pool.query(
    "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",
    [sessionId, user.id],
  );
  const token = jwt.sign({ sid: sessionId }, config.jwtSecret, {
    algorithm: "HS256",
    subject: user.id,
    issuer: "pharmaflow",
    audience: "pharmaflow-api",
    expiresIn: "8h",
  });
  await pool.query("DELETE FROM sessions WHERE expires_at<now()");
  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  };
}
export async function addUser(c, actor, v) {
  const userId = id("user"),
    hash = await bcrypt.hash(v.password, 12);
  await c.query(
    "INSERT INTO users(id,email,name,password_hash,role) VALUES($1,$2,$3,$4,$5)",
    [userId, v.email, v.name, hash, v.role],
  );
  await audit(c, actor, "User created", v.email);
  return { id: userId, email: v.email, name: v.name, role: v.role };
}
