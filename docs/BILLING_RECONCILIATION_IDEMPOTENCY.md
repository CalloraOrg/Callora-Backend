# Billing reconciliation idempotency

Provider webhooks are at-least-once. The immutable key is the tuple
`tenant_id + provider_event_id`; it must be unique in the reconciliation table
and never be replaced when an invoice is edited. The canonical fingerprint
binds that tuple to invoice, developer, amount, currency, timestamp, and the
sorted payload. A repeated tuple with the same fingerprint is a replay and
returns the original ledger entry. A different fingerprint is a conflict.

`admitBillingEvent` executes lookup, ledger mutation, and reconciliation
insert inside one transaction supplied by the store. The ledger mutation is
not committed if the reconciliation row cannot be inserted. Database-backed
stores should enforce a unique `(tenant_id, provider_event_id)` constraint and
translate a unique-key race into a lookup/replay after the winning transaction
commits.

Conflicts write only non-sensitive fingerprints and identity metadata to the
audit stream. Raw provider payloads and secrets are not copied into audit
records. A conflict must be visible to operations and must never be treated as
a successful replay.

The in-memory store is a deterministic test adapter, not a production
replacement. Production deployments must use a database transaction with row
locking or an atomic insert-on-conflict operation, and must retain reconciliation
records long enough to cover provider retry windows and chargeback review.

Operational checks:

- alert on conflict volume and unexpected tenant mismatches;
- expose applied, replay, and conflict counters separately;
- retain the original ledger entry id in provider-response metadata;
- never retry a conflict without human or provider-side correction;
- verify authorization before accepting a tenant-scoped provider key.

Deployment note: apply the unique-key migration before enabling the consumer,
then run a shadow pass that compares provider event counts with reconciliation
records. During rollback keep the records and unique constraint in place; an
older consumer may safely return a replay, but deleting the key would reopen
the double-charge window. Operators should retain conflict fingerprints for
forensic correlation without retaining payment secrets or complete payloads.

### Acceptance mapping

- Replay leaves the balance unchanged: admission regression tests.
- Conflicts are rejected and audited: the conflict parameter matrix.
- Ledger and record are one transaction: rollback tests in both suites.
- Concurrent submissions are serialized: the 25-request race test.
- Authorization remains tenant-scoped: tenant isolation cases.

The adapter deliberately does not infer tenant identity from invoice or
developer identifiers. The authenticated provider connection supplies the
tenant, and the provider event id is accepted only in that namespace. This
prevents an event copied between tenants from being interpreted as a replay.

For a database implementation, use a parameterized insert and a unique index;
never build SQL from the provider id. Store monetary values in the smallest
integer unit and do not use floating point arithmetic. Compare currency after
normalization but preserve the canonical uppercase code in the audit context.

The operation is intentionally monotonic: `applied` is written once, replay
does not rewrite its timestamp, and conflict never changes the ledger. This
makes provider retries safe to observe and safe to reconcile after a restart.
If a database transaction is lost after the provider call, the next delivery
uses the same immutable event key and resolves to the existing record rather
than issuing another ledger mutation.

### Incident response

When conflicts rise, first identify the provider and tenant from the audit
entry, then compare the two fingerprints in the provider console. Do not
delete the original record to force a retry. Correct the provider payload or
invoice mapping, record the decision, and submit a new provider event with a
new immutable id. For suspected duplicate charges, freeze automated retries,
reconcile ledger entry ids against settlement records, and preserve the
original audit trail for review.

Metrics should include the tenant-independent outcome labels `applied`,
`replay`, and `conflict`; tenant ids belong in logs with access controls, not
metric labels. This avoids high-cardinality billing identifiers leaking into
shared monitoring systems.

Reviewers should retain this evidence with the release record and verify that
the production adapter implements the same transaction contract.

The contract is part of the billing correctness boundary.
