# Design Document — Pluggable Opt-in Decompression for proxyRoutes

## Overview

Add an opt-in, stream-based decompression layer to the proxy pipeline so that
`recordableStatuses` and analytic hooks can read decompressed response bodies
for size accounting. The feature is gated behind an explicit flag — routes that
do not opt in receive the raw upstream body exactly as before, with zero
behavioural change. Decompression uses only `node:zlib` and `node:stream`
built-ins. A `BombGuardTransform` enforces a hard cap on decompressed bytes
incrementally mid-stream.

## Architecture

### Pipeline overview

```
Client Request
     │
     ▼
proxyRoutes.ts — handleProxy()
     │
     ├─ [decompressResponse: false] ─────────────────────────────────────────┐
     │   Web ReadableStream reader loop                                       │
     │   res.write(chunk)  →  res.end()                                       │
     │                                                                        │
     └─ [decompressResponse: true] ──────────────────────────────────────────┤
         Readable.fromWeb(upstreamRes.body)                                   │
              │                                                               │
              ▼                                                               │
         createDecompressStream(encoding, opts)                               │
              ├─ gzip   → Gunzip → BombGuardTransform                        │
              ├─ deflate → Inflate → BombGuardTransform                      │
              ├─ br     → BrotliDecompress → BombGuardTransform              │
              └─ other  → PassThrough (fall-through, supported=false)        │
              │                                                               │
              ▼                                                               │
         stream.pipeline(source, decompressTransform, res)                   │
              │                                                               │
              ├─ error: DecompressionLimitExceededError → 413                │
              └─ success → strip Content-Encoding (if supported)             │
                         → fire onResponseSize hook (setImmediate)           │
                                                                             │
Client Response ◄────────────────────────────────────────────────────────────┘
```

### Module boundaries

| Module | Responsibility |
|---|---|
| `src/lib/decompressStream.ts` | `DecompressionLimitExceededError`, `BombGuardTransform`, `createDecompressStream` — all zlib logic |
| `src/lib/hopByHop.ts` | `PROXY_ACCEPTS_ENCODINGS`, `buildAcceptEncodingHeader` — Accept-Encoding negotiation |
| `src/types/gateway.ts` | `ProxyConfig` extension, `ResponseSizeInfo` interface |
| `src/config/env.ts` | `MAX_DECOMPRESSED_BYTES` Zod field |
| `src/config/index.ts` | `config.proxy.maxDecompressedBytes` |
| `src/routes/proxyRoutes.ts` | Pipeline wiring, opt-in gating, 413 handling, hook dispatch |

## Components and Interfaces

### `DecompressionLimitExceededError`

```ts
export class DecompressionLimitExceededError extends Error {
  readonly code = 'DECOMPRESSION_LIMIT_EXCEEDED';
  constructor(
    readonly upstreamUrl: string,
    readonly encoding: string,
    readonly bytesAtAbort: number,
    readonly limitBytes: number,
  ) {
    super(`Decompressed response exceeded limit of ${limitBytes} bytes`);
    this.name = 'DecompressionLimitExceededError';
  }
}
```

### `BombGuardTransform`

A `Transform` subclass that wraps the output of a decompressor. Counts
decompressed bytes in `_transform`. Destroys the stream immediately when
`bytesWritten > limitBytes`.

```ts
class BombGuardTransform extends Transform {
  private bytesWritten = 0;

  constructor(
    private readonly limitBytes: number,
    private readonly upstreamUrl: string,
    private readonly encoding: string,
  ) { super(); }

  _transform(chunk: Buffer, _enc: string, cb: TransformCallback): void {
    this.bytesWritten += chunk.length;
    if (this.bytesWritten > this.limitBytes) {
      this.destroy(new DecompressionLimitExceededError(
        this.upstreamUrl, this.encoding, this.bytesWritten, this.limitBytes,
      ));
      return;
    }
    cb(null, chunk);
  }

  _flush(cb: TransformCallback): void { cb(); }

  /** Expose byte count for the analytic hook. */
  get totalBytesWritten(): number { return this.bytesWritten; }
}
```

### `createDecompressStream`

```ts
export interface DecompressOptions {
  limitBytes?: number;
  upstreamUrl: string;
}

export function createDecompressStream(
  encoding: string,
  opts: DecompressOptions,
): { stream: Transform; effectiveEncoding: string; supported: boolean; guard: BombGuardTransform | null }
```

Returns a pipeline that routes to the right zlib decompressor followed by the
guard. For unsupported encodings returns a `PassThrough` with `supported=false`
and `guard=null`.

### `buildAcceptEncodingHeader` (hopByHop.ts)

```ts
export const PROXY_ACCEPTS_ENCODINGS = ['gzip', 'deflate', 'br'] as const;

export function buildAcceptEncodingHeader(): string {
  return [...PROXY_ACCEPTS_ENCODINGS, 'identity'].join(', ');
  // → 'gzip, deflate, br, identity'
}
```

### `ProxyConfig` additions (gateway.ts)

```ts
decompressResponse?: boolean;           // default: false
maxDecompressedBytes?: number;          // default: MAX_DECOMPRESSED_BYTES env or 52_428_800
onResponseSize?: (info: ResponseSizeInfo) => void | Promise<void>;
```

### `ResponseSizeInfo` (gateway.ts)

```ts
export interface ResponseSizeInfo {
  upstreamUrl: string;
  statusCode: number;
  upstreamEncoding: string;
  decompressedBytes: number;
  wasDecompressed: boolean;
  requestId: string;
}
```

## Data Models

### Environment variable

| Variable | Type | Default | Notes |
|---|---|---|---|
| `MAX_DECOMPRESSED_BYTES` | integer (bytes) | `52_428_800` | Added to `envSchema` in `src/config/env.ts` |

Rationale for 50 MB default:
- Large enough to serve typical API payloads without false positives.
- At 100 concurrent proxy calls the worst-case decompressed-memory exposure
  is 5 GB — within range for a typical gateway node.
- Classic zip bombs can expand 1 KB → 1 GB; 50 MB cuts those off well below
  useful exploitation size.

### `config.proxy` shape after changes

```ts
proxy: {
  upstreamUrl: string;
  timeoutMs: number;
  allowedHosts: string[];
  maxDecompressedBytes: number;   // ← new
}
```

## Correctness Properties

### Property 1: Opt-in isolation

Enabling decompression on router A cannot affect router B. All state (the `BombGuardTransform` instance, byte counters, `config.decompressResponse`) is scoped to a single `handleProxy` invocation. No module-level mutable state is introduced.

**Validates: Requirements 1.4, 8.3**

### Property 2: Mid-stream abort

The bomb guard fires inside `_transform` — the stream is destroyed before the full payload is collected. The test for this property must confirm 413 is returned before the upstream server finishes writing all data.

**Validates: Requirements 4.4, 4.5, 9.2**

### Property 3: Incremental byte accounting

`bytesWritten` increases by `chunk.length` per `_transform` call, never by the total buffered size. There is no `Buffer.concat` or accumulation before the limit check.

**Validates: Requirements 4.4, 4.8, 5.5**

### Property 4: Fall-through fidelity

Raw bytes are forwarded without modification on unsupported encodings. `Content-Encoding` is preserved unchanged. No error is thrown or returned to the client solely due to the encoding being unrecognised.

**Validates: Requirements 3.1, 3.2, 3.4**

### Property 5: Accept-Encoding correctness

When opt-in is active, upstream never receives an `Accept-Encoding` advertising encodings the proxy cannot decode. The set is locked to `['gzip', 'deflate', 'br', 'identity']` via `PROXY_ACCEPTS_ENCODINGS`.

**Validates: Requirements 6.1, 6.2, 6.3**

### Property 6: Content-Encoding stripping idempotency

`res.removeHeader('content-encoding')` is only called when `supported=true` after successful decompression — never on fall-through and never on the non-decompressing path.

**Validates: Requirements 2.4, 1.2**

## Error Handling

| Error scenario | Source | Handling |
|---|---|---|
| `DecompressionLimitExceededError` | `BombGuardTransform._transform` | Caught in `pipeline` error handler; 413 if headers not sent; `res.destroy()` otherwise; structured `console.error` |
| Decompressor error (e.g. corrupt gzip data) | `zlib.Gunzip` `error` event | Propagated by `stream.pipeline`; caught in same error handler; treated as 502 via existing `next(error)` path |
| `onResponseSize` hook throws/rejects | Hook callback | Caught in `setImmediate` wrapper; `console.error` only; does not affect response |
| Unsupported encoding | `createDecompressStream` | `supported=false` returned; `PassThrough` used; debug log emitted; no error thrown |

## Testing Strategy

All tests follow the existing `setUpstreamHandler` integration pattern: a real
Express upstream + a real Express proxy on dynamic ports, with Jest.

**New test file**: `src/__tests__/proxyDecompression.integration.test.ts`

| # | Scenario | Verification method |
|---|---|---|
| 1 | Gzip decompressed | Client receives decompressed JSON; Content-Encoding absent in response; onResponseSize spy called with `decompressedBytes > 0` |
| 2 | Deflate decompressed | Same as above for deflate |
| 3 | Brotli decompressed | Same as above for br |
| 4 | Unsupported encoding (zstd) | Body bytes match raw; Content-Encoding preserved; `console.debug` spy called |
| 5 | No Content-Encoding | Body passes through; no Content-Encoding set; no decompression attempted |
| 6 | Bomb — cap hit | 413 returned; `console.error` spy called with correct metadata; response arrives before all upstream data written |
| 7 | Bomb — just under cap | 200 returned; all bytes present |
| 8 | Opt-in off | Raw gzip bytes forwarded; Content-Encoding preserved |
| 9 | onResponseSize accuracy | Spy's `decompressedBytes` matches `Buffer.byteLength(originalPayload)` |
| 10 | Accept-Encoding negotiation | Upstream handler asserts `req.headers['accept-encoding']` equals `gzip, deflate, br, identity` |

Coverage target: ≥90% branch on `decompressStream.ts` and modified `proxyRoutes.ts` sections.
