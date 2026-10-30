// src/config/migrate.ts
//
// Minimal forward-only SQL migration runner.
//   npm run migrate            apply every pending migrations/*.sql in filename order
//   npm run migrate -- --status  list applied / pending without changing anything
//
// Each file runs in its own transaction and is recorded in schema_migrations.
// 0001_baseline.sql is the schema as it existed before migrations were introduced: on a
// database that already has the `users` table it is recorded as applied WITHOUT running.
import fs from 'fs';
import path from 'path';
import { pool } from './db';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const BASELINE = '0001_baseline.sql';

const run = async (): Promise<void> => {
  const statusOnly = process.argv.includes('--status');
  const client = await pool.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const applied = new Set(
      (await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
    );

    if (!applied.has(BASELINE) && !statusOnly) {
      const existing = await client.query(`SELECT to_regclass('public.users') AS t`);
      if (existing.rows[0].t) {
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [BASELINE]);
        applied.add(BASELINE);
        console.log(`↪ ${BASELINE} recorded as applied (existing database)`);
      }
    }

    const pending = files.filter((f) => !applied.has(f));
    if (statusOnly) {
      files.forEach((f) => console.log(`${applied.has(f) ? '✔ applied ' : '… pending '} ${f}`));
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`→ applying ${file}`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`✖ ${file} failed and was rolled back:`, (err as Error).message);
        process.exitCode = 1;
        return;
      }
    }

    console.log(pending.length ? `✔ ${pending.length} migration(s) applied` : '✔ database is up to date');
  } finally {
    client.release();
    await pool.end();
  }
};

run().catch((err) => {
  console.error('Migration runner failed:', err);
  process.exit(1);
});
