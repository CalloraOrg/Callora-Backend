-- Create invoices table

CREATE TABLE IF NOT EXISTS invoices (
    id BIGSERIAL PRIMARY KEY,
    developer_id VARCHAR(255) NOT NULL,
    period_id VARCHAR(20) NOT NULL UNIQUE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    total_amount DECIMAL(20,7) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_line_items (
    id BIGSERIAL PRIMARY KEY,
    invoice_id BIGINT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    api_id VARCHAR(255) NOT NULL,
    usage_count INTEGER NOT NULL,
    amount_usdc DECIMAL(20,7) NOT NULL
);

CREATE INDEX idx_invoice_period
ON invoices(period_id);

CREATE INDEX idx_invoice_developer
ON invoices(developer_id);