import "dotenv/config";
export function loadConfig(env = process.env) {
  if (!env.DATABASE_URL)
    throw Error(
      "DATABASE_URL is missing. Run npm run setup and configure .env.",
    );
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32)
    throw Error(
      "JWT_SECRET must contain at least 32 characters. Run npm run setup.",
    );
  const origins = (
    env.CLIENT_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173"
  )
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (
    origins.some((x) => {
      try {
        return (
          !["http:", "https:"].includes(new URL(x).protocol) || x.includes("*")
        );
      } catch {
        return true;
      }
    })
  )
    throw Error(
      "CLIENT_ORIGIN must list exact HTTP origins separated by commas.",
    );
  const production = env.NODE_ENV === "production";
  if (production && env.COOKIE_SECURE === "false")
    throw Error(
      "Production requires secure cookies. Serve frontend and API through HTTPS.",
    );
  return {
    databaseUrl: env.DATABASE_URL,
    jwtSecret: env.JWT_SECRET,
    port: Number(env.PORT || 3000),
    origins,
    production,
    cookieSecure: production || env.COOKIE_SECURE === "true",
    timezone: env.BUSINESS_TIMEZONE || "Asia/Karachi",
    trustProxy: env.TRUST_PROXY === "1",
    seedDemo: env.SEED_DEMO === "true",
    adminEmail: (env.SEED_ADMIN_EMAIL || "admin@pharmaflow.local")
      .trim()
      .toLowerCase(),
    adminPassword: env.SEED_ADMIN_PASSWORD,
  };
}
