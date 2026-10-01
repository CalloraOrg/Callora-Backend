# Graceful Shutdown

This document describes the graceful shutdown mechanism implemented in the Callora Backend service.

## Overview

The graceful shutdown handler ensures that the application terminates cleanly when receiving termination signals (SIGTERM/SIGINT), preventing data loss and ensuring all in-flight operations complete successfully before exit. On SIGTERM, the handler starts subsystem draining immediately while the HTTP server is also being closed, so the process can move toward a clean exit without waiting on the server close callback before the drain phase begins.

## Features

- **Signal Handling**: Responds to SIGTERM and SIGINT signals
- **Request Draining**: Waits up to 30 seconds for in-flight HTTP requests to complete
- **Subsystem Coordination**: Stops and drains the six subsystems registered in `shutdownSubsystems`, then cancels the remaining background jobs
- **Database Cleanup**: Closes all database connection pools gracefully
- **Structured Logging**: Logs each phase of the shutdown process with correlation IDs
- **Timeout Protection**: Forcefully closes lingering connections after the grace period
- **Idempotency**: Duplicate signals are ignored if shutdown is already in progress

## Architecture

### Components

#### 1. Graceful Shutdown Handler

The main orchestrator that coordinates the shutdown sequence.

**Location**: `src/lifecycle/shutdown.ts`

**Interface**:
```typescript
function createGracefulShutdownHandler(options: {
  server: Server;
  activeConnections: Set<Socket>;
  closeDatabase: () => Promise<void>;
  logger?: Logger;
  timeoutMs?: number;
  subsystems?: DrainableSubsystem[];
}): (signal: NodeJS.Signals) => Promise<number>;
```

#### 2. Drainable Subsystem

Interface for background subsystems that need to be gracefully stopped.

```typescript
interface DrainableSubsystem {
  name: string;
  beginShutdown: () => void | Promise<void>;
  awaitIdle: () => Promise<void>;
}
```

The subsystems handed to `createGracefulShutdownHandler` are the entries of the
`shutdownSubsystems` array in `src/index.ts`. That array — not this document and
not the individual worker modules — is the source of truth for what the handler
drains. The exact list and order is in
[Registered drain subsystems](#registered-drain-subsystems).

#### 3. In-Flight Drain Tracker

Middleware-based tracker for monitoring active HTTP requests.

```typescript
function createInFlightDrainTracker(name: string): {
  middleware: RequestHandler;
  subsystem: DrainableSubsystem;
  /** Returns true once beginShutdown() has been called. */
  isDraining: () => boolean;
};
```

The `isDraining()` flag can be passed to the proxy router factory via `ProxyDeps.drainState`
so that new requests arriving after shutdown begins are immediately rejected with
`503 Service Unavailable` (with `Connection: close` and `Retry-After: 0`), while
requests that were already in flight when the shutdown signal arrived are allowed
to complete normally.  See the **Proxy drain guard** section below for details.

A tracker is only drained by the shutdown handler if its `subsystem` object is a
member of `shutdownSubsystems`. Creating a tracker (or exporting one from a
route module) does **not** register it — see
[Trackers that exist but are not wired](#trackers-that-exist-but-are-not-wired).

## Registered drain subsystems

`src/index.ts` builds the `shutdownSubsystems: DrainableSubsystem[]` array that is
passed to `createGracefulShutdownHandler`. The array is populated in one place
and has no conditional (`push`) entries, so the registered set is identical in
every environment:

<!-- shutdown-subsystem-order:start -->
```text
1. gateway-proxy
2. refresh-token
3. revenue-ledger-indexer
4. idempotency-sweeper
5. webhook-dispatcher
6. settlement-reconciliation
```
<!-- shutdown-subsystem-order:end -->

The order above is the order in which `beginShutdown()` is called. This list is
asserted by `src/lifecycle/shutdown.docs.test.ts`, which parses the
`shutdownSubsystems` array out of `src/index.ts` and fails if the document and
the code disagree.

| # | Subsystem name | Source in `src/index.ts` | In-flight work awaited by `awaitIdle()` |
|---|---|---|---|
| 1 | `gateway-proxy` | `createInFlightDrainTracker("gateway-proxy")` → `proxyDrainTracker` | In-flight `/v1/call/...` proxy requests. `isDraining()` is also injected into the proxy router so requests arriving after `beginShutdown()` are rejected with `503`. |
| 2 | `refresh-token` | `createInFlightDrainTracker('refresh-token')` → `refreshTokenDrainTracker` | In-flight `POST /api/refresh-token` requests. |
| 3 | `revenue-ledger-indexer` | `revenueLedgerIndexerJob` | The revenue-ledger indexer tick that was already running when the signal arrived. |
| 4 | `idempotency-sweeper` | `idempotencySweeperJob` | The idempotency-record sweep that was already running when the signal arrived. |
| 5 | `webhook-dispatcher` | `stopWebhookDispatching` / `awaitWebhookDispatcherIdle` | Webhook deliveries still queued or in flight. |
| 6 | `settlement-reconciliation` | `settlementReconJob` | The settlement reconciliation run in progress (see [Settlement reconciliation worker](./settlement-reconciliation-worker.md)). |

### Jobs that are cancelled, not drained

`closeAllDataResources` — passed to the handler as the `closeDatabase` callback —
calls `stop()` on every background job it can reach. Five of those jobs are
**not** members of `shutdownSubsystems`, so their `stop()` runs in Phase 6, after
the drain window, and no `awaitIdle()` is ever performed for them:

| Job | Constructed when | Why it is not drained |
|---|---|---|
| `settlement-status-sync` | always | `stop()` clears the polling timer. The job type exposes only `stop()` — there is no `beginShutdown()` / `awaitIdle()` pair to register. |
| `anomaly-detector` | `config.usageAnomalyDetector.enabled` (`USAGE_ANOMALY_DETECTOR_ENABLED`) | Poller whose tick is bounded by DB query timeouts; the job is constructed but never added to `shutdownSubsystems`. |
| `monthly-invoice` | always | Scheduler driven by a day boundary; the job is constructed but never added to `shutdownSubsystems`. |
| `slo-alert` | `SLO_ALERT_WEBHOOK_URL` is set **and** at least one `SLO_ROUTE_CONFIGS` entry exists | Poller whose tick posts a single webhook; the job is constructed but never added to `shutdownSubsystems`. |
| `slow-query-alerter` | `SLOW_QUERY_ALERT_WEBHOOK_URL` is set | Poller whose tick posts a single webhook; the job is constructed but never added to `shutdownSubsystems`. |

`anomaly-detector`, `monthly-invoice`, `slo-alert` and `slow-query-alerter` do
expose `beginShutdown()` / `awaitIdle()` and could be appended to
`shutdownSubsystems` without changing the handler. That is a runtime behaviour
change with its own review, not a documentation fix, so this document records
the behaviour that is actually shipped today.

`revenue-ledger-indexer`, `idempotency-sweeper` and `settlement-reconciliation`
appear in both places: they are drained in Phase 4 and then `stop()`ped
idempotently in Phase 6.

### Trackers that exist but are not wired

Two `createInFlightDrainTracker` instances are created but never registered in
`shutdownSubsystems`, so `awaitIdle()` is not called for them:

- `api-keys` (`keysDrainTracker` in `src/index.ts`) — the tracker is created, but
  neither its middleware nor the router it belongs to is mounted, so no requests
  are counted through it.
- `quotas` (`quotasDrainTracker`, defined in `src/routes/quotas/counts.ts` and
  re-exported by `src/app.ts`) — its middleware **is** mounted on
  `/api/quotas/counts`, but the subsystem is never appended to
  `shutdownSubsystems`.

Consequently the handler does not wait for in-flight `/api/quotas/counts`
requests by name; they are covered only by the process-wide drain
(`server.close()` plus `activeConnections`) and the same 30 s timeout.

## Shutdown Sequence

The shutdown process follows these phases:

### Phase 1: Signal Received
- Log the received signal (SIGTERM or SIGINT)
- Start the grace period timer (default: 30 seconds)

> Phases 2–4 are **started concurrently and awaited together** by
> `createGracefulShutdownHandler` (`Promise.all` over `stopSubsystems()`,
> `closeServer()` and `drainSubsystems()`). Draining does not wait for the HTTP
> server's `close` callback, and the server close does not wait for draining.
> The numbered phases describe intent, not wall-clock ordering.

### Phase 2: Subsystems Stopping
- Call `beginShutdown()` on all registered subsystems, in array order
  (`gateway-proxy`, `refresh-token`, `revenue-ledger-indexer`,
  `idempotency-sweeper`, `webhook-dispatcher`, `settlement-reconciliation`)
- Subsystems stop accepting new work but continue processing in-flight operations
- Log each subsystem as it stops

### Phase 3: Server Closing
- Close the HTTP server to stop accepting new connections
- Existing connections remain open for in-flight requests

### Phase 4: Subsystems Draining
- Wait for the registered subsystems to complete in-flight work via `awaitIdle()`
- Race against the timeout period
- Log each subsystem as it becomes idle

### Phase 5: Timeout Protection
- If the grace period expires, forcefully destroy all remaining socket connections
- Log warning with connection count
- A subsystem drain that hits the same deadline also fails the shutdown

### Phase 6: Database Closing (with final job cancellation)
- Cancel every background job this process started, including the ones that are
  not registered drain subsystems — `settlement-status-sync`,
  `slow-query-alerter` (conditional), `anomaly-detector` (conditional),
  `monthly-invoice`, `slo-alert` (conditional) — plus a second, idempotent
  `stop()` for the jobs already drained in Phase 4
- Close all database connection pools:
  - Drizzle ORM connections
  - PostgreSQL connection pool
  - Prisma client
  - Health check pools
- Wait for all connections to drain

### Phase 7: Exit
- Exit with code 0 for clean shutdown
- Exit with code 1 if the server close failed, any registered subsystem failed to
  stop, the subsystem drain timed out or rejected, the database close failed, or
  an unexpected error escaped the orchestration

## Configuration

### Environment Variables

No specific environment variables are required. The shutdown handler is configured programmatically.

### Default Settings

```typescript
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
```

## Timeout and exit codes

`createGracefulShutdownHandler` takes a single `timeoutMs` option, default
`30_000`. `src/index.ts` passes `30_000` explicitly, so production uses the
default value:

| Item | Value | Location |
|---|---|---|
| `timeoutMs` default | `30_000` ms | `createGracefulShutdownHandler` in `src/lifecycle/shutdown.ts` |
| `timeoutMs` in the production wiring | `30_000` ms | `createGracefulShutdownHandler({ ..., timeoutMs: 30_000 })` in `src/index.ts` |
| Force-close timer | armed when the signal arrives, fires after `timeoutMs` | `forceCloseTimeout` in `createGracefulShutdownHandler` |
| Subsystem drain race | `Promise.race([all awaitIdle(), timeoutMs])` | `drainSubsystems()` in `createGracefulShutdownHandler` |

The same window is applied independently to two things:

1. **Connections** — `forceCloseTimeout` destroys every socket still in
   `activeConnections` after `timeoutMs`.
2. **Subsystem drain** — `drainSubsystems()` races the `awaitIdle()` promises of
   all registered subsystems against the same `timeoutMs`; on expiry it logs
   `[shutdown:timeout_reached] Subsystem drain timeout after 30000ms` and the
   shutdown is reported as failed.

The handler resolves with an exit code and `src/index.ts` forwards it to
`process.exit(exitCode)`:

| Exit code | Conditions |
|---|---|
| `0` | All registered subsystems stopped and drained within the window, the HTTP server closed without error, and `closeDatabase()` succeeded. |
| `1` | The HTTP server `close` callback reported an error, **or** a subsystem `beginShutdown()` threw, **or** the subsystem drain timed out / an `awaitIdle()` rejected, **or** `closeDatabase()` threw, **or** an unexpected error escaped the orchestration. |

`0` is a drain guarantee for the six registered subsystems only. The jobs
listed under
[Jobs that are cancelled, not drained](#jobs-that-are-cancelled-not-drained) are
cancelled in Phase 6, after the window, without waiting for their in-flight tick,
so a `0` exit does not mean those ticks ran to completion.

## Usage

### Basic Setup

```typescript
import { createGracefulShutdownHandler } from './lifecycle/shutdown.js';

const server = app.listen(PORT);
const activeConnections = new Set<Socket>();

server.on('connection', (socket) => {
  activeConnections.add(socket);
  socket.once('close', () => activeConnections.delete(socket));
});

const shutdown = createGracefulShutdownHandler({
  server,
  activeConnections,
  closeDatabase: async () => {
    await pool.end();
    await prisma.$disconnect();
  },
  timeoutMs: 30_000,
});

process.once('SIGTERM', () => shutdown('SIGTERM').then(process.exit));
process.once('SIGINT', () => shutdown('SIGINT').then(process.exit));
```

### Adding Custom Subsystems

To register a custom drainable subsystem:

```typescript
const mySubsystem: DrainableSubsystem = {
  name: 'my-background-job',
  
  beginShutdown() {
    // Stop accepting new work
    this.accepting = false;
  },
  
  async awaitIdle() {
    // Wait for in-flight work to complete
    while (this.activeJobs > 0) {
      await this.waitForJob();
    }
  },
};

const shutdown = createGracefulShutdownHandler({
  // ... other options
  subsystems: [mySubsystem],
});
```

### Request Tracking Middleware

To track in-flight HTTP requests:

```typescript
import { createInFlightDrainTracker } from './lifecycle/shutdown.js';

const tracker = createInFlightDrainTracker('api-routes');

// Apply middleware
app.use('/api', tracker.middleware);

// Register subsystem
const shutdown = createGracefulShutdownHandler({
  // ... other options
  subsystems: [tracker.subsystem],
});
```

### Proxy Drain Guard

The `/v1/call` proxy router supports an optional `drainState` dependency that
enables active request rejection during the shutdown drain window:

```typescript
import { createInFlightDrainTracker } from './lifecycle/shutdown.js';
import { createProxyRouter } from './routes/proxyRoutes.js';

// Create the tracker first so we can pass isDraining to the router
const proxyDrainTracker = createInFlightDrainTracker('gateway-proxy');

const proxyRouter = createProxyRouter({
  // ... other deps
  drainState: { isDraining: proxyDrainTracker.isDraining },
});

// Mount the drain tracker middleware BEFORE the proxy router
// so that each request entering /v1/call is counted by the tracker
app.use('/v1/call', proxyDrainTracker.middleware);
app.use('/v1/call', proxyRouter);
```

**Behaviour during drain:**

| Request timing | What happens |
|---|---|
| Arrived **before** `beginShutdown()` | Allowed to complete normally; counted by the tracker |
| Arrived **after** `beginShutdown()` | Immediately rejected with `503 Service Unavailable` |

The 503 response includes:

- `Connection: close` — instructs the load balancer not to reuse the socket.
- `Retry-After: 0` — advises the client to retry immediately on a healthy instance.
- JSON body: `{ "code": "SERVICE_UNAVAILABLE", "message": "..." }`

The `drainState` hook is optional; omitting it reverts to the original behaviour
(requests proceed even during shutdown).

### In-flight drain tracker — isDraining()

The `isDraining()` accessor is exposed on the return value of
`createInFlightDrainTracker` so it can be injected into any component that
needs to know whether shutdown is in progress:

```typescript
const tracker = createInFlightDrainTracker('my-subsystem');

tracker.isDraining(); // false — before beginShutdown()
tracker.subsystem.beginShutdown();
tracker.isDraining(); // true — from now on
```

## Monitoring

### Log Output

The shutdown handler emits structured log messages for each phase:

```
[shutdown:signal_received] Received SIGTERM, initiating graceful shutdown
[shutdown:subsystems_stopping] Stopping 6 subsystem(s): gateway-proxy, refresh-token, revenue-ledger-indexer, idempotency-sweeper, webhook-dispatcher, settlement-reconciliation
[shutdown:subsystems_stopping] Stopped subsystem: gateway-proxy
[shutdown:server_closing] Closing HTTP server
[shutdown:subsystems_draining] Draining 6 subsystem(s) (timeout: 30000ms)
[shutdown:subsystems_draining] Drained subsystem: gateway-proxy
[shutdown:database_closing] Closing database pools
[shutdown:database_closing] Database pools closed successfully
[shutdown:complete] Shutdown complete (exit_code: 0, duration: 1247ms)
```

### Error Scenarios

**Subsystem Stop Failure**:
```
[shutdown:error] Failed to stop subsystem webhook-dispatcher: Connection timeout
```

**Drain Timeout**:
```
[shutdown:timeout_reached] Subsystem drain timeout after 30000ms
[shutdown:timeout_reached] Graceful drain exceeded 30000ms, forcefully closing 2 connection(s)
```

**Database Close Error**:
```
[shutdown:error] Error closing database: Connection pool already closed
```

## Testing

### Unit Tests

Location: `src/lifecycle/shutdown.test.ts`

Run tests:
```bash
npx jest src/lifecycle/shutdown.test.ts
npx jest src/lifecycle/shutdown.docs.test.ts
```

### Test Coverage

The test suite covers:
- ✅ Clean shutdown with SIGTERM
- ✅ Clean shutdown with SIGINT
- ✅ Subsystem stopping and draining
- ✅ Timeout with forceful connection closure
- ✅ Server close errors
- ✅ Database close errors
- ✅ Duplicate signal handling
- ✅ Subsystem drain timeout
- ✅ Request tracking middleware
- ✅ Multiple concurrent requests
- ✅ Structured logging output
- ✅ `isDraining()` flag — false before shutdown, true after
- ✅ Proxy drain guard — 503 on new requests during shutdown
- ✅ Proxy drain guard — `Connection: close` + `Retry-After: 0` headers
- ✅ Proxy drain guard — upstream NOT called for rejected requests
- ✅ Proxy drain guard — usage NOT recorded for rejected requests
- ✅ Shutdown handler waits for in-flight proxy requests before closing DB

### Documentation consistency test

`src/lifecycle/shutdown.docs.test.ts` guards this page against drift. It parses
`src/index.ts` and fails the build when:

- the ordered list in [Registered drain subsystems](#registered-drain-subsystems)
  no longer matches `shutdownSubsystems`;
- the documented timeout no longer matches the handler default (`30_000`) or the
  `timeoutMs` passed from `src/index.ts`;
- the documented exit codes no longer match the handler's contract;
- a background job that `closeAllDataResources` stops is no longer explained in
  [Jobs that are cancelled, not drained](#jobs-that-are-cancelled-not-drained);
- the README's "Production Shutdown Expectations" section stops linking here.

### Integration Tests

To test in a running environment:

```bash
# Start the server
npm start

# In another terminal, send SIGTERM
kill -TERM <pid>

# Or use Ctrl+C to send SIGINT
```

Verify logs show:
1. Signal received
2. Subsystems stopping
3. Server closing
4. Database cleanup
5. Exit code 0

## Operational Considerations

### Kubernetes

For Kubernetes deployments, ensure:

1. **Termination Grace Period** is at least 35 seconds (5s buffer beyond the 30s drain timeout):
   ```yaml
   spec:
     terminationGracePeriodSeconds: 35
   ```

2. **Readiness Probe** fails quickly on shutdown to stop routing new traffic:
   ```yaml
   readinessProbe:
     httpGet:
       path: /api/health
       port: 3000
     periodSeconds: 5
   ```

### Docker

When running with Docker, ensure proper signal forwarding:

```dockerfile
# Use exec form to ensure signals reach the Node process
CMD ["node", "dist/index.js"]
```

### Health Checks

The `/api/health` endpoint continues responding during shutdown until the HTTP server closes. External health checkers should mark the pod as unhealthy once the endpoint becomes unreachable.

## Troubleshooting

### Shutdown Takes Full 30 Seconds

**Cause**: In-flight requests or subsystems are not completing.

**Solution**:
- Check logs for which subsystems are slow to drain
- Verify database query performance
- Ensure background jobs are properly cancellable

### Forceful Connection Closure

**Cause**: Requests exceeded the 30-second grace period.

**Solution**:
- Investigate slow endpoints or queries
- Consider increasing `timeoutMs` if legitimate long-running operations exist
- Add request timeouts at the application level

### Exit Code 1 (Unclean Shutdown)

**Cause**: Error occurred during shutdown phases.

**Solution**:
- Review error logs for specific failures
- Check database connection health
- Verify subsystem shutdown logic

### Database "Connection Pool Already Closed" Errors

**Cause**: Attempting to close database pools multiple times.

**Solution**:
- Ensure `closePgPool()` guards against duplicate calls
- Check for race conditions in shutdown logic

## Security Considerations

1. **Graceful Degradation**: The shutdown handler ensures no data is lost during termination
2. **Timeout Protection**: Prevents indefinite hangs from misbehaving subsystems
3. **Connection Closure**: Forces closure of lingering connections to prevent resource leaks
4. **Audit Logging**: All shutdown phases are logged for security auditing

## Future Enhancements

Potential improvements:
- [ ] Configurable per-subsystem timeouts
- [ ] Prometheus metrics for shutdown duration
- [ ] Webhooks to notify external systems on shutdown
- [ ] Support for custom exit codes per error type
- [ ] Graceful reload without full shutdown (SIGHUP)

## References

- [Node.js Process Signals](https://nodejs.org/api/process.html#signal-events)
- [Express Server Close](https://expressjs.com/en/api.html#app.listen)
- [Kubernetes Pod Lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
