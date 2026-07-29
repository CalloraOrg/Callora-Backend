# Implementation Plan: Pluggable Opt-in Decompression for proxyRoutes

## Overview

Seven tasks implement the full feature bottom-up: env config first, then types,
then the hopByHop negotiation utilities, then the core decompressor module,
then proxy wiring, then integration tests, then documentation. Each task is
independently completable once its dependencies are done.

## Tasks

- [ ] 1. Add `MAX_DECOMPRESSED_BYTES` to env schema and config
  - Add `MAX_DECOMPRESSED_BYTES: z.coerce.number().int().positive().default(52_428_800)` to `envSchema` in `src/config/env.ts`
  - Expose `config.proxy.maxDecompressedBytes` in `src/config/index.ts`
  - Add `MAX_DECOMPRESSED_BYTES=52428800` with explanatory comment to `.env.example`
  - _Requirements: 4.2, 10.2_

- [ ] 2. Extend `ProxyConfig` and add `ResponseSizeInfo` in `src/types/gateway.ts`
  - Add `decompressResponse?: boolean` to `ProxyConfig` with JSDoc
  - Add `maxDecompressedBytes?: number` to `ProxyConfig` with JSDoc
  - Add `onResponseSize?: (info: ResponseSizeInfo) => void | Promise<void>` to `ProxyConfig`
  - Add `ResponseSizeInfo` interface: `upstreamUrl`, `statusCode`, `upstreamEncoding`, `decompressedBytes`, `wasDecompressed`, `requestId`
  - _Requirements: 1.1, 4.3, 5.1, 5.2_

- [ ] 3. Add Accept-Encoding negotiation exports to `src/lib/hopByHop.ts`
  - Add `PROXY_ACCEPTS_ENCODINGS` const tuple `['gzip', 'deflate', 'br'] as const` with JSDoc
  - Add `ProxyAcceptEncoding` type alias
  - Add `buildAcceptEncodingHeader()` returning `'gzip, deflate, br, identity'`
  - Add comment explaining `content-encoding` is NOT in `STATIC_HOP_BY_HOP` and is stripped explicitly in `proxyRoutes.ts` post-decompression
  - _Requirements: 6.4, 7.1, 7.2, 7.3_

- [ ] 4. Create `src/lib/decompressStream.ts`
  - Implement `DecompressionLimitExceededError` with fields: `code`, `upstreamUrl`, `encoding`, `bytesAtAbort`, `limitBytes`
  - Implement `BombGuardTransform` (Transform subclass): counts decompressed bytes in `_transform` per-chunk before passing downstream; calls `this.destroy(new DecompressionLimitExceededError(...))` when total exceeds limit; exposes `totalBytesWritten` getter
  - Implement `createDecompressStream(encoding, opts)` returning `{ stream, effectiveEncoding, supported, guard }`: `gzip` → `pipeline(createGunzip(), new BombGuardTransform(...))`, `deflate` → `pipeline(createInflate(), new BombGuardTransform(...))`, `br` → `pipeline(createBrotliDecompress(), new BombGuardTransform(...))`, unknown → `PassThrough`, `supported=false`, emit debug log
  - Export `DecompressOptions` interface
  - Add inline comments at: supported encoding dispatch, bomb-guard `_transform` increment, fall-through path, `effectiveEncoding` logic
  - _Requirements: 2.2, 2.3, 2.5, 3.1–3.4, 4.4, 4.5, 4.8_
  - _Depends on: 1, 2_

- [ ] 5. Wire decompression into `src/routes/proxyRoutes.ts`
  - Import `createDecompressStream`, `DecompressionLimitExceededError` from `../lib/decompressStream.js` and `buildAcceptEncodingHeader` from `../lib/hopByHop.js`
  - Update `resolveConfig`: default `decompressResponse: false`, `maxDecompressedBytes` from `process.env.MAX_DECOMPRESSED_BYTES` or `52_428_800`, `onResponseSize: undefined`
  - In `forwardHeaders` build: when `config.decompressResponse` is true, set `forwardHeaders['accept-encoding'] = buildAcceptEncodingHeader()` with inline comment
  - After upstream response: extract `encoding = upstreamRes.headers.get('content-encoding') ?? ''`
  - Split streaming: Path A (`decompressResponse: false`) keeps existing reader loop unchanged; Path B (`decompressResponse: true`) adapts with `Readable.fromWeb`, calls `createDecompressStream`, uses `stream.pipeline` from `node:stream/promises`, catches `DecompressionLimitExceededError` for 413, strips `content-encoding` if `supported`, fires `onResponseSize` hook via `setImmediate`
  - Add inline comments at: opt-in check, Accept-Encoding override, encoding extraction, bomb error catch block, Content-Encoding strip, onResponseSize dispatch
  - _Requirements: 1.2–1.4, 2.1–2.4, 4.6, 4.7, 5.3–5.6, 6.1–6.3, 8.3_
  - _Depends on: 2, 3, 4_

- [ ] 6. Write `src/__tests__/proxyDecompression.integration.test.ts`
  - Test 1: Gzip — upstream sends gzip body; client gets decompressed JSON; Content-Encoding absent; onResponseSize spy called with correct `decompressedBytes`
  - Test 2: Deflate — same for deflate encoding
  - Test 3: Brotli — same for br encoding
  - Test 4: Unsupported encoding (`zstd`) — body bytes match raw; Content-Encoding preserved; `console.debug` spy called with expected message
  - Test 5: No Content-Encoding — body passes through unchanged; no Content-Encoding set
  - Test 6: Bomb cap hit — 413 returned; `console.error` spy called with `upstreamUrl`, `encoding`, `bytesAtAbort`; response arrives mid-stream (before upstream finishes writing)
  - Test 7: Bomb just under cap — 200 returned; all payload bytes received
  - Test 8: Opt-in off — upstream sends gzip; raw gzip bytes forwarded; Content-Encoding preserved
  - Test 9: onResponseSize accuracy — `decompressedBytes` in hook equals `Buffer.byteLength(originalPayload)`; `wasDecompressed: true`
  - Test 10: Accept-Encoding negotiation — upstream receives `gzip, deflate, br, identity` when opt-in is true; receives original (or none) when opt-in is false
  - _Requirements: 9.1–9.4_
  - _Depends on: 5_

- [ ] 7. Documentation
  - Create `docs/proxy-decompression.md` covering: opt-in code example, `MAX_DECOMPRESSED_BYTES` env var and sizing rationale, supported encodings table, fall-through behaviour, bomb guard design (incremental check, 413 shape), `onResponseSize` hook interface and usage example, Accept-Encoding negotiation, security notes (4 points)
  - Verify `.env.example` includes `MAX_DECOMPRESSED_BYTES` with comment (added in Task 1)
  - _Requirements: 10.1, 10.3, 10.4_
  - _Depends on: 5_

## Notes

- All zlib imports use the `node:zlib` protocol to match the project's existing built-in import style.
- `stream.pipeline` from `node:stream/promises` is preferred over `.pipe()` because it automatically cleans up streams on error.
- `Readable.fromWeb()` requires Node.js ≥18 — this project already targets Node 18+ (confirmed by `fetch` usage in proxyRoutes.ts).
- TypeScript strict mode: `BombGuardTransform._transform` callback type must be `TransformCallback` from `node:stream`.
- The `guard` field returned from `createDecompressStream` lets `proxyRoutes.ts` read `guard.totalBytesWritten` for the `onResponseSize` hook even after the pipeline finishes.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["1", "2", "3"],
      "description": "Foundation — env config, types, hopByHop utilities. All independent."
    },
    {
      "wave": 2,
      "tasks": ["4"],
      "description": "Core decompressor module. Depends on tasks 1 and 2."
    },
    {
      "wave": 3,
      "tasks": ["5"],
      "description": "Proxy wiring. Depends on tasks 2, 3, and 4."
    },
    {
      "wave": 4,
      "tasks": ["6", "7"],
      "description": "Tests and documentation. Both depend on task 5 and can run in parallel."
    }
  ]
}
```
