// Builds a fresh `loom_test` database from the real migrations before the integration tests run.
// Never touches any other database: it only connects to the local Postgres from docker-compose-style
// dev setup (TEST_DB_ADMIN_URL, default localhost:5442).
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL ?? 'postgresql://postgres:loom_dev@localhost:5442/postgres';
const TEST_URL = ADMIN_URL.replace(/\/[^/]*$/, '/loom_test');

export default async function setup() {
  if (!/localhost|127\.0\.0\.1/.test(ADMIN_URL)) {
    throw new Error('Refusing to run integration tests against a non-local database.');
  }

  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS loom_test WITH (FORCE)');
  await admin.query('CREATE DATABASE loom_test');
  await admin.end();

  const db = new Client({ connectionString: TEST_URL });
  await db.connect();
  const dir = path.resolve(__dirname, '../migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  await db.end();
}
