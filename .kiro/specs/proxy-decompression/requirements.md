# Requirements Document

## Introduction

The proxy gateway currently streams upstream responses to clients without
inspecting or transforming the body. This prevents `recordableStatuses` and
analytic hooks from performing size accounting on compressed payloads, because
the byte count they see reflects compressed size rather than actual payload
size. This spec adds an opt-in, stream-based decompression layer with a
compression-bomb guard that fires mid-stream.

## Requirements

### Requirement 1: Opt-in flag

**User Story:** As a gateway operator, I want to enable decompression only on specific router instances so that routes that don't need it are completely unaffected.

#### Acceptance Criteria

1.1 `ProxyConfig` gains a `decompressResponse?: boolean` field that defaults to `false`.

1.2 When `decompressResponse` is `false` or absent, the proxy forwards the upstream response body byte-for-byte without any transformation, and no `Content-Encoding` stripping occurs.

1.3 When `decompressResponse` is `true`, the proxy applies the decompression pipeline defined in Requirement 2 before forwarding to the client.

1.4 The opt-in flag is set per `createProxyRouter` call — it is not a global process-level setting and not read from the environment directly.

### Requirement 2: Encoding negotiation and decompression

**User Story:** As a gateway operator, I want the proxy to correctly decompress gzip, deflate, and brotli upstream responses when opted in, so that downstream consumers receive plain text bodies.

#### Acceptance Criteria

2.1 The proxy inspects the `Content-Encoding` response header to determine the upstream encoding.

2.2 Supported encodings and their corresponding decompressors: `gzip` → `zlib.createGunzip()`, `deflate` → `zlib.createInflate()`, `br` → `zlib.createBrotliDecompress()`.

2.3 All decompression is stream-based and incremental. The full response body is never buffered in memory before decompression begins.

2.4 After successful decompression, the `Content-Encoding` header is stripped from the forwarded response so the client receives a body without a misleading encoding declaration.

2.5 No new runtime npm dependencies are introduced for decompression. Only Node.js built-ins from `node:zlib` and `node:stream` are used.

### Requirement 3: Unsupported encoding fall-through

**User Story:** As a gateway operator, I want the proxy to pass through unrecognised encodings unchanged so that future upstream encodings do not cause errors or payload corruption.

#### Acceptance Criteria

3.1 When `Content-Encoding` contains a value not in {gzip, deflate, br}, the proxy forwards the raw bytes to the client without modification.

3.2 `Content-Encoding` is preserved (not stripped) on fall-through.

3.3 A single debug-level log entry is emitted: `[proxy] Unsupported Content-Encoding "%s" — passing through unchanged`.

3.4 The proxy does not throw an error, does not return a non-2xx status code for the encoding issue, and does not destroy the stream.

3.5 No `Content-Encoding` is also treated as a pass-through (no decompression is attempted when the header is absent).

### Requirement 4: Compression-bomb guard

**User Story:** As a security-conscious operator, I want the proxy to abort and return 413 if a compressed upstream response would expand beyond a configurable byte limit, so that malicious payloads cannot exhaust server memory.

#### Acceptance Criteria

4.1 A hard cap `maxDecompressedBytes` is enforced on the total decompressed byte count. The default is `52_428_800` (50 MB).

4.2 The cap is configurable via the `MAX_DECOMPRESSED_BYTES` environment variable (integer, bytes).

4.3 The cap is also configurable per router instance via `ProxyConfig.maxDecompressedBytes`.

4.4 The byte count is incremented inside `_transform` for each chunk, so the check fires mid-stream without ever accumulating the full body.

4.5 When the running total exceeds the cap, the decompressor stream is immediately destroyed via `this.destroy(new DecompressionLimitExceededError(...))`.

4.6 When a `DecompressionLimitExceededError` is caught: if headers have not been sent, respond with HTTP 413 and a JSON body `{ error: 'DECOMPRESSION_LIMIT_EXCEEDED', message: '…', requestId }`; if headers have already been sent, call `res.destroy()`.

4.7 A structured error is logged at `error` level containing: `upstreamUrl`, `encoding`, `bytesAtAbort`, `limitBytes`, and `requestId`.

4.8 The bomb guard must operate on decompressed bytes (output side of the decompressor), not compressed bytes.

### Requirement 5: Analytic hooks and size accounting

**User Story:** As a platform engineer, I want analytic hooks to receive the decompressed byte count so that usage metrics reflect actual payload size rather than wire size.

#### Acceptance Criteria

5.1 `ProxyConfig` gains an optional `onResponseSize?: (info: ResponseSizeInfo) => void | Promise<void>` field.

5.2 `ResponseSizeInfo` contains: `upstreamUrl`, `statusCode`, `upstreamEncoding`, `decompressedBytes`, `wasDecompressed`, `requestId`.

5.3 The hook is called non-blockingly via `setImmediate` after the response stream completes successfully.

5.4 Errors thrown or rejected by the hook are caught and logged at `error` level. They do not affect the proxy response.

5.5 `decompressedBytes` equals the total bytes written by the decompressor (post-decompression). When `wasDecompressed` is `false` (fall-through), `decompressedBytes` equals the raw byte count from upstream.

5.6 The hook is only fired when `decompressResponse` is `true`.

### Requirement 6: Accept-Encoding negotiation

**User Story:** As a protocol-correct implementor, I want the proxy to advertise only the encodings it can decompress to upstream, so that upstream never sends an encoding the proxy cannot handle when decompression is opted in.

#### Acceptance Criteria

6.1 When `decompressResponse` is `true`, the proxy replaces the client's `Accept-Encoding` header with `gzip, deflate, br, identity` before forwarding the request upstream.

6.2 `identity` is always included as a fallback.

6.3 When `decompressResponse` is `false`, the client's original `Accept-Encoding` is forwarded unchanged (existing behaviour, no regression).

6.4 A new exported function `buildAcceptEncodingHeader()` in `src/lib/hopByHop.ts` returns the negotiation string, so it can be unit-tested independently.

### Requirement 7: hopByHop.ts documentation and exports

**User Story:** As a maintainer, I want `hopByHop.ts` to clearly document the decompression-related header handling so the hop-by-hop rules remain understandable as the codebase evolves.

#### Acceptance Criteria

7.1 `PROXY_ACCEPTS_ENCODINGS` (const tuple) and `buildAcceptEncodingHeader()` are exported from `hopByHop.ts`.

7.2 A comment in `hopByHop.ts` explains that `Content-Encoding` is NOT a hop-by-hop header and therefore is not in `STATIC_HOP_BY_HOP`, but is stripped explicitly in `proxyRoutes.ts` after successful decompression.

7.3 All existing exports of `hopByHop.ts` remain unchanged in signature and behaviour.

### Requirement 8: Zero regression for non-opted-in routes

**User Story:** As an operator of existing proxy routes, I want confidence that enabling decompression on one router instance cannot affect any other instance.

#### Acceptance Criteria

8.1 All existing proxy integration tests pass without modification.

8.2 A router created without `decompressResponse: true` receives the raw upstream body for any `Content-Encoding` value.

8.3 No global state (module-level variables, shared streams) is introduced that could bleed between router instances.

### Requirement 9: Test coverage

**User Story:** As a quality-conscious engineer, I want comprehensive test coverage of the decompression feature so that regressions are caught automatically.

#### Acceptance Criteria

9.1 A new test file `src/__tests__/proxyDecompression.integration.test.ts` covers all 10 scenarios: gzip, deflate, brotli, unsupported fall-through, no encoding, bomb cap hit, bomb just under cap, opt-in off, onResponseSize hook, Accept-Encoding negotiation.

9.2 The bomb-guard test verifies mid-stream abort: the 413 is returned before the upstream has finished sending all data.

9.3 `npm test -- proxy` passes with at least 90% branch coverage on `src/lib/decompressStream.ts` and the modified sections of `src/routes/proxyRoutes.ts`.

9.4 All pre-existing proxy and non-proxy tests continue to pass.

### Requirement 10: Documentation

**User Story:** As an operator onboarding to this feature, I want clear documentation so I can configure decompression correctly without reading source code.

#### Acceptance Criteria

10.1 `docs/proxy-decompression.md` is created covering: opt-in mechanism, env variable, default value rationale, supported encodings, fall-through behaviour, bomb guard design, `onResponseSize` hook usage, and `Accept-Encoding` negotiation.

10.2 `.env.example` is updated with `MAX_DECOMPRESSED_BYTES` and a comment explaining the default.

10.3 Inline comments are added in `proxyRoutes.ts` at: the opt-in flag check, the `Accept-Encoding` override, the encoding inspection point, the bomb guard increment, and the `Content-Encoding` stripping call.

10.4 Inline comments are added in `hopByHop.ts` explaining `PROXY_ACCEPTS_ENCODINGS`, `buildAcceptEncodingHeader`, and why `Content-Encoding` is absent from `STATIC_HOP_BY_HOP`.

## Glossary

- **Opt-in decompression**: decompression that is only active when `decompressResponse: true` is set explicitly in `ProxyConfig`.
- **Compression bomb**: a compressed payload that expands to a much larger size on decompression, used to exhaust memory.
- **Bomb guard**: the `BombGuardTransform` that tracks decompressed bytes and aborts the stream if the cap is exceeded.
- **Fall-through**: when an unsupported `Content-Encoding` is detected, the raw bytes are forwarded unchanged.
- **recordableStatuses**: a predicate in `ProxyConfig` that decides whether a response status code should trigger usage metering.
- **onResponseSize hook**: an optional callback in `ProxyConfig` called after each proxied response with decompressed size data.
- **effectiveEncoding**: the `Content-Encoding` value after decompression — empty string if decompressed, original value if falling through.
