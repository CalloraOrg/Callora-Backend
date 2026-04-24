# Database Migrations

SQL migrations for PostgreSQL database schema.

## Migrations

1. **001_create_usage_events.sql** - Immutable usage events table for billing and analytics
2. **002_create_settlements.sql** - Settlement tracking for developer payouts
3. **003_create_revenue_ledger.sql** - Optional per-API revenue accrual tracking

## Running Migrations

### Using psql

```bash
psql -U <username> -d <database> -f migrations/001_create_usage_events.sql
psql -U <username> -d <database> -f migrations/002_create_settlements.sql
psql -U <username> -d <database> -f migrations/003_create_revenue_ledger.sql
```

### Using node-pg-migrate (future)

```bash
npm install node-pg-migrate pg
npm run migrate up
```

## Schema Overview

### usage_events
- Immutable records of API usage
- Indexed by user_id, api_id, and request_id
- Tracks USDC amounts and Stellar transaction hashes

### settlements
- Batch payouts to developers
- Status: pending, completed, failed
- Indexed by developer_id and status

### revenue_ledger (optional)
- Links usage events to settlements
- Per-API revenue tracking
- Foreign keys to usage_events and settlements
