# Admin response schema stability

`tests/schema/admin.test.ts` locks the JSON response shape for a focused
subset of `/api/admin` so accidental drift fails CI as a snapshot diff.

## Covered endpoints

| Method | Path | Snapshots |
| --- | --- | --- |
| `GET` | `/api/admin/users` | 200 success, 401 unauthenticated |
| `GET` | `/api/admin/usage/:developerId` | 200 success, 404 not found |
| `POST` | `/api/admin/usage/:developerId/reset` | 200 success |

Success responses also assert stable top-level / nested key sets so new fields
or renames fail even if someone updates a snapshot without noticing.

## Running

```bash
npx jest --runInBand --forceExit tests/schema/admin.test.ts
```

To intentionally accept a schema change:

```bash
npx jest --runInBand --updateSnapshot tests/schema/admin.test.ts
```

## Related

- Pattern siblings: `tests/schema/export.test.ts`, `tests/schema/credits.test.ts`, `tests/schema/usage.test.ts`
- Behavioral coverage: `tests/integration/admin.test.ts`, `tests/integration/adminUsage.test.ts`
