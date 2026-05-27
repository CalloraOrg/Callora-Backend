# Event Emitter Contracts

## Overview

`src/events/event.emitter.ts` exposes a typed domain-event emitter for billing and usage related webhook fan-out. The API is intentionally small:

- `calloraEvents.on(event, listener)` registers an event-specific listener and returns an unsubscribe function
- `calloraEvents.off(event, listener)` removes the exact listener reference
- `calloraEvents.emit(event, developerId, payload)` synchronously schedules listeners and returns whether any listeners were present
- `calloraEvents.listenerCount(event)` reports the number of listeners for one event

The emitter is strongly typed through a shared event-name to payload map, so unknown events and mismatched payloads fail at compile time.

## Event Map

### `new_api_call`

Used when API usage is recorded for a developer.

```ts
{
  apiId: string;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  creditsUsed: number;
}
```

### `settlement_completed`

Used when a developer settlement completes successfully.

```ts
{
  settlementId: string;
  amount: string;
  asset: string;
  txHash: string;
  settledAt: string;
}
```

### `low_balance_alert`

Used when a developer or consumer balance falls below the configured threshold.

```ts
{
  currentBalance: string;
  thresholdBalance: string;
  asset: string;
}
```

## Typing Guarantees

```ts
calloraEvents.emit('new_api_call', developerId, {
  apiId: 'api_123',
  endpoint: '/v1/messages',
  method: 'POST',
  statusCode: 200,
  latencyMs: 42,
  creditsUsed: 1,
});

// Type error: event name is unknown
calloraEvents.emit('unknown_event', developerId, payload);

// Type error: payload shape does not match new_api_call
calloraEvents.emit('new_api_call', developerId, {
  settlementId: 'settlement_123',
});
```

## Unsubscribe Safety

Listeners are removed by exact function identity. Both of the following are safe and idempotent:

```ts
const unsubscribe = calloraEvents.on('new_api_call', listener);

unsubscribe();
unsubscribe(); // safe no-op

calloraEvents.off('new_api_call', listener);
calloraEvents.off('new_api_call', listener); // safe no-op
```

Unsubscribing one listener does not affect any other listener registered for the same event.

## Async Behavior

- `emit(...)` is synchronous and does not await webhook delivery
- listeners may return promises
- async listener failures are caught and logged so one failing listener does not break the rest
- webhook dispatch remains filtered by event type and `developerId`

## Built-in Webhook Bridge

The module registers one built-in listener per documented event:

- `new_api_call`
- `settlement_completed`
- `low_balance_alert`

Each built-in listener resolves matching webhook subscriptions from `WebhookStore` and forwards the typed payload through `dispatchToAll(...)`.
