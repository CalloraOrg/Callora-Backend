# PR: Property-based tests for amountValidator (Stellar/USDC precision)

## Summary

Adds 11 fast-check property-based tests to `src/validators/amountValidator.test.ts`, expanding coverage beyond the existing unit tests to fuzz fractional precision, leading zeros, negative sentinels, and denormalized number strings so silent regressions are caught automatically.

## Changes

### Modified files
- `src/validators/amountValidator.test.ts` — added 11 `fc.property` tests (PBT-1 through PBT-11), all with pinned seeds for determinism

## Properties covered

| # | Property | Requirement |
|---|----------|-------------|
| PBT-1 | All valid canonical amounts accepted | Baseline validity |
| PBT-2 | `normalizedAmount` equals input for valid amounts | Round-trip identity |
| PBT-3 | `toSmallestUnit` stroop → string → stroop round-trip | Bigint correctness |
| PBT-4 | Integer-equivalent amounts (`N.0000000`) round-trip | Issue requirement |
| PBT-5 | >7 fractional digits always rejected | Issue requirement |
| PBT-6 | Negative sentinel strings always rejected | Issue requirement |
| PBT-7 | Leading zeros in fractional part handled correctly | Precision boundary |
| PBT-8 | Scientific notation strings always rejected | Stellar/USDC format |
| PBT-9 | Whitespace-padded strings always rejected | Format strictness |
| PBT-10 | NaN/Infinity string variants always rejected | Denormalized inputs |
| PBT-11 | `toSmallestUnit` always returns positive bigint | Stroop correctness |

## Design notes

- All `fc.assert` calls use `{ seed: 1234567 }` for reproducibility — no flaky seeds
- `validAmountArb` generates amounts from stroop integers via `stroopsToCanonical`, guaranteeing exact IEEE 754 representation with no precision loss
- `numRuns` kept to 200–500 per property; total runtime well under 5 s
- `fast-check` is already a devDependency — no new dependencies added

## Validation

```bash
npm test -- --testPathPattern=amountValidator
```

closes #420
