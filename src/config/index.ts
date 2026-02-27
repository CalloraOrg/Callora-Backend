export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  /**
   * Primary PostgreSQL connection string used by the shared pg.Pool.
   * Example (matches docker-compose): postgresql://postgres:postgres@postgres:5432/callora?schema=public
   */
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/callora?schema=public',
  /**
   * Connection pool tuning. These can be overridden via environment variables
   * but have sensible defaults for local development.
   */
  dbPool: {
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS ?? 2_000),
  },
};
