# Tamper-evident privileged audit records

## Guarantees

Privileged state changes are represented by rows in `audit_logs`. Each row
contains the actor, tenant, target resource, outcome, correlation ID, redacted
before/after details, and a timestamp. A row also stores:

- `sequence_no`, assigned by the database;
- `previous_hash`, the integrity hash of the previous row; and
- `integrity_hash`, a SHA-256 digest of the canonical row payload and
  `previous_hash`.

The chain is global to the audit table. Tenant filtering is applied only when
reading records; it never changes the chain order or lets one tenant create a
second unverifiable history.

## Append path

`appendAuditRow` obtains a PostgreSQL transaction advisory lock, reads the
latest chain hash, and inserts the new row in the same SQL statement. The
database calculates the integrity hash with `pgcrypto`, so two concurrent
writers cannot both claim the same predecessor. A failed insert does not
advance the chain.

The application passes stable values for `event`, `actor`, `target`, `outcome`,
`correlationId`, and the redacted details. The `outcome` value is constrained to
`success` or `failure`; request and provider errors must not be serialized into
the details field because they may contain credentials or internal topology.

## Immutability boundary

Migration `0022_tamper_evident_audit.sql` installs a `BEFORE UPDATE OR DELETE`
trigger. API roles can insert and read rows but cannot rewrite an existing row.
The trigger is intentionally in the database rather than only in a repository,
because direct SQL, an old binary, or a compromised application instance must
not be able to silently edit history.

The rollback migration removes the trigger and chain columns. Treat rollback as
an incident-operation decision: removing the trigger weakens forensic
guarantees and must be followed by reapplying migration 0022 before accepting
privileged traffic.

## Verification

`verifyAuditChain` sorts records by `sequenceNo`, starts at `GENESIS`, and
reports every sequence gap, broken predecessor link, and digest mismatch. It
returns a structured result:

```json
{
  "valid": false,
  "checked": 2,
  "issues": [
    {
      "sequenceNo": 2,
      "id": "audit-2",
      "reason": "integrity_hash_mismatch",
      "expected": "…",
      "actual": "…"
    }
  ]
}
```

Operators should treat any issue as a failed verification, preserve the raw
rows for investigation, and compare the database audit role grants. A valid
chain proves that the supplied row fields were not changed after insertion; it
does not prove that the original actor was a human or that the application was
correct. Authentication, authorization, and deployment provenance remain
separate controls.

## Redaction and isolation

Redaction recursively replaces secret, token, password, private-key, and API
key fields with `[REDACTED]`. Arrays and nested objects are traversed, circular
references become `[Circular]`, and source objects are never mutated. Tenant
queries return only rows whose `tenant_id` matches the requested tenant.

The chain verifier and in-memory store tests cover successful chaining,
concurrent-boundary semantics, field tampering, predecessor replacement,
sequence gaps, duplicate IDs, defensive copies, recursive redaction, and
tenant isolation.
