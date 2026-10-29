// src/config/db.ts
import { Pool } from 'pg';
import { env } from './env';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.IS_PRODUCTION || env.DATABASE_URL.includes('neon.tech')
    ? { rejectUnauthorized: true }
    : false,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 30000,
  max: 10,
  // Sets the session timezone as part of the connection handshake itself —
  // no extra query needed, avoids any race with queries fired right after connect.
  options: '-c timezone=Africa/Nairobi',
});

// Without this, an error on an IDLE pooled client (e.g. the DB restarting,
// a network blip) throws an *unhandled* error event and crashes the whole
// Node process — including every in-flight login/refresh request. This
// makes DB flakiness a recoverable event instead of a full outage.
pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle PostgreSQL client:', err.message);
});

export const connectDB = async (): Promise<void> => {
  try {
    console.log('🐘 Attempting to connect to PostgreSQL...');
    const client = await pool.connect();

    const res = await client.query('SELECT NOW()');
    console.log(`✅ PostgreSQL connected! Server time: ${res.rows[0].now}`);

    client.release();
  } catch (error) {
    console.error('❌ PostgreSQL connection failed.');
    // Deliberately not logging the raw error object in production — pg
    // connection errors can echo back the connection string (including
    // the DB password) in the error message/stack.
    if (!env.IS_PRODUCTION) {
      console.error(error);
    }
    process.exit(1);
  }
};

// Closes the pool cleanly on shutdown so in-flight queries (e.g. a
// refresh-token rotation mid-transaction) aren't abruptly severed, and so
// container/process managers don't force-kill before Postgres acknowledges
// the disconnect.
export const closeDB = async (): Promise<void> => {
  await pool.end();
  console.log('🐘 PostgreSQL pool closed.');
};