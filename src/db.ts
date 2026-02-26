import { Pool } from 'pg';

// Initialize the Postgres connection pool
export const pool = new Pool({
// Use the env var, or fallback to a default local test database URL
connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/callora_test',
});