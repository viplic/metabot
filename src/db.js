import { promises as fs } from "node:fs";
import { neon } from "@neondatabase/serverless";

let sqlClient = null;
let schemaReady = false;

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL || process.env.NEON_DATABASE_URL);
}

export async function getSql() {
  if (!hasDatabase()) return null;
  if (!sqlClient) {
    sqlClient = neon(process.env.DATABASE_URL || process.env.NEON_DATABASE_URL);
  }
  if (!schemaReady) {
    await ensureSchema(sqlClient);
    schemaReady = true;
  }
  return sqlClient;
}

async function ensureSchema(sql) {
  const schema = await fs.readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
  for (const statement of schema.split(";").map((item) => item.trim()).filter(Boolean)) {
    await sql.query(`${statement};`);
  }

  const migrations = [
    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS color TEXT DEFAULT '#10b981'",
    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS niche TEXT DEFAULT ''",
    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS signup_note TEXT DEFAULT ''",
    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ",
    "ALTER TABLE tenants ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ",
    `CREATE TABLE IF NOT EXISTS processed_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    "CREATE INDEX IF NOT EXISTS idx_processed_events_tenant_time ON processed_events(tenant_id, processed_at DESC)",
    `CREATE TABLE IF NOT EXISTS raw_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      platform_user_id TEXT DEFAULT '',
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`
  ];
  for (const statement of migrations) {
    await sql.query(statement);
  }
}

export function json(value) {
  return JSON.stringify(value ?? null);
}
