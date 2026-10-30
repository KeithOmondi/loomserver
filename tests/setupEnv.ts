// Runs before every test file: point the app's own `pool` at the throwaway test database.
const admin = process.env.TEST_DB_ADMIN_URL ?? 'postgresql://postgres:loom_dev@localhost:5442/postgres';
process.env.DATABASE_URL = admin.replace(/\/[^/]*$/, '/loom_test');
process.env.NODE_ENV = 'test';
