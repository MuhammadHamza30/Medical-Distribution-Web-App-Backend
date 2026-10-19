import { randomBytes } from "node:crypto";
import { writeFile, access } from "node:fs/promises";
try {
  await access(".env");
  console.log(".env already exists. No credentials were changed.");
  process.exit(0);
} catch {}
const databasePassword = "PF_" + randomBytes(18).toString("hex"),
  adminPassword = "PF!" + randomBytes(12).toString("base64url");
const content = `NODE_ENV=development\nPORT=3000\nDATABASE_URL=postgresql://pharmaflow:${databasePassword}@localhost:5432/pharmaflow\nDB_PASSWORD=${databasePassword}\nJWT_SECRET=${randomBytes(48).toString("hex")}\nCLIENT_ORIGIN=http://localhost:5173,http://127.0.0.1:5173\nCOOKIE_SECURE=false\nBUSINESS_TIMEZONE=Asia/Karachi\nTRUST_PROXY=0\nSEED_DEMO=true\nSEED_ADMIN_EMAIL=admin@pharmaflow.local\nSEED_ADMIN_PASSWORD=${adminPassword}\n`;
await writeFile(".env", content, { mode: 0o600 });
console.log("Created .env with local development credentials.");
console.log("Administrator email: admin@pharmaflow.local");
console.log("Administrator password: " + adminPassword);
console.log("Keep these local credentials private. They are also in .env.");
