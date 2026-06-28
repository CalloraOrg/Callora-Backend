# Graceful Shutdown

This document describes the graceful shutdown mechanism implemented in the Callora Backend service.

## Overview

The graceful shutdown handler ensures that the application terminates cleanly when receiving termination signals (SIGTERM/SIGINT), preventing data loss and ensuring all in-flight operations complete successfully before exit.

## Features

- **Signal Handling**: Responds to SIGTERM and SIGINT signals
- **Request Draining**: Waits up to 30 seconds for in-flight HTTP requests to complete
- **Subsystem Coordination**: Stops and drains background jobs, webhook dispatchers, and other subsystems
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

**Built-in Subsystems**:
- `gateway-proxy`: Tracks in-flight HTTP requests through the API gateway
- `revenue-ledger-indexer`: Background job for indexing revenue events
- `idempotency-sweeper`: Background job for cleaning up expired idempotency records
- `webhook-dispatcher`: Asynchronous webhook delivery system

#### 3. In-Flight Drain Tracker

Middleware-based tracker for monitoring active HTTP requests.

```typescript
function createInFlightDrainTracker(name: string): {
  middleware: RequestHandler;
  subsystem: DrainableSubsystem;
};
```

## Shutdown Sequence

The shutdown process follows these phases:

### Phase 1: Signal Received
- Log the received signal (SIGTERM or SIGINT)
- Start the grace period timer (default: 30 seconds)

### Phase 2: Subsystems Stopping
- Call `beginShutdown()` on all registered subsystems
- Subsystems stop accepting new work but continue processing in-flight operations
- Log each subsystem as it stops

### Phase 3: Server Closing
- Close the HTTP server to stop accepting new connections
- Existing connections remain open for in-flight requests

### Phase 4: Subsystems Draining
- Wait for all subsystems to complete in-flight work via `awaitIdle()`
- Race against the timeout period
- Log each subsystem as it becomes idle

### Phase 5: Timeout Protection
- If the grace period expires, forcefully destroy all remaining socket connections
- Log warning with connection count

### Phase 6: Database Closing
- Close all database connection pools:
  - Drizzle ORM connections
  - PostgreSQL connection pool
  - Prisma client
  - Health check pools
- Wait for all connections to drain

### Phase 7: Exit
- Exit with code 0 for clean shutdown
- Exit with code 1 if any errors occurred

## Configuration

### Environment Variables

No specific environment variables are required. The shutdown handler is configured programmatically.

### Default Settings

```typescript
const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds
```

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

## Monitoring

### Log Output

The shutdown handler emits structured log messages for each phase:

```
[shutdown:signal_received] Received SIGTERM, initiating graceful shutdown
[shutdown:subsystems_stopping] Stopping 4 subsystem(s): gateway-proxy, revenue-ledger-indexer, idempotency-sweeper, webhook-dispatcher
[shutdown:subsystems_stopping] Stopped subsystem: gateway-proxy
[shutdown:server_closing] Closing HTTP server
[shutdown:subsystems_draining] Draining 4 subsystem(s) (timeout: 30000ms)
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
npm test -- shutdown.test.ts
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
