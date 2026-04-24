# Event Emitter Documentation

## Overview

The `event.emitter.ts` module provides a centralized event system for the Callora backend, handling webhook dispatches for billing and settlement events. This document outlines the threading model, async expectations, and memory safety considerations.

## Architecture

### Components

- **calloraEvents**: Global Node.js EventEmitter instance
- **handleEvent()**: Async event handler that processes webhook dispatches
- **WebhookStore**: In-memory store for webhook configurations
- **dispatchToAll()**: Concurrent webhook dispatcher with retry logic

### Event Types

1. `new_api_call`: Triggered when API calls are made
2. `settlement_completed`: Triggered when settlements are processed
3. `low_balance_alert`: Triggered when balance falls below threshold

## Threading and Async Behavior

### Node.js Event Loop Model

The event emitter operates on Node.js's single-threaded event loop with the following characteristics:

#### Event Emission (Synchronous)
```typescript
// Event emission is SYNCHRONOUS and NON-BLOCKING
calloraEvents.emit('new_api_call', developerId, data);
// Returns immediately, does not wait for processing
```

#### Event Processing (Asynchronous)
```typescript
// Event listeners are ASYNCHRONOUS
calloraEvents.on('new_api_call', async (developerId, data) => {
    await handleEvent('new_api_call', developerId, data);
    // Processing happens in the background
});
```

### Concurrency Model

1. **Event Emission**: Synchronous, O(1) operation
2. **Webhook Dispatch**: Asynchronous, concurrent using `Promise.allSettled()`
3. **Error Handling**: Non-blocking, errors don't affect other webhooks

### Event Loop Phases

```
┌───────────────────────────┐
└─> emit(event, data)       │  Synchronous
    ┌─────────────────────┐ │
    │ add to event queue  │ │
    └─────────────────────┘ │
┌───────────────────────────┐
│ Event Loop Processing     │
└─> handleEvent()           │  Asynchronous
    ┌─────────────────────┐ │
    │ WebhookStore lookup │ │  Synchronous
    └─────────────────────┘ │
    ┌─────────────────────┐ │
    │ dispatchToAll()     │ │  Asynchronous
    └─────────────────────┘ │
┌───────────────────────────┐
│ Webhook Delivery          │
└─> HTTP requests           │  Concurrent, with retries
```

## Memory Safety

### Potential Memory Leaks

1. **Event Listener Accumulation**
   - **Risk**: Low - listeners are added once at module load
   - **Mitigation**: Fixed number of listeners (3), no dynamic addition

2. **WebhookStore Growth**
   - **Risk**: Medium - Map grows with webhook registrations
   - **Mitigation**: Provide cleanup methods, monitor store size

3. **Pending Promise Accumulation**
   - **Risk**: Low - `Promise.allSettled()` prevents hanging promises
   - **Mitigation**: Timeout on webhook requests (10s per attempt)

### Memory Management Guidelines

#### WebhookStore Management
```typescript
// Register webhook
WebhookStore.register(config);

// Clean up when no longer needed
WebhookStore.delete(developerId);

// Monitor store size
const storeSize = WebhookStore.list().length;
if (storeSize > MAX_WEBHOOKS) {
    // Implement cleanup strategy
}
```

#### Event Listener Management
```typescript
// Listeners are static - no cleanup needed
// But you can check count if needed
const listenerCount = calloraEvents.listenerCount('new_api_call');
```

## Performance Characteristics

### Hot Path Behavior

1. **Event Emission**: ~0.1ms (synchronous)
2. **WebhookStore Lookup**: ~0.01ms per webhook config
3. **Webhook Dispatch**: 10s timeout per attempt, max 5 retries

### Throughput Estimates

- **Events/second**: 10,000+ (emission only)
- **Webhook deliveries**: Limited by network latency and timeouts
- **Memory overhead**: ~1KB per registered webhook

## Error Handling

### Async Error Propagation

```typescript
// Errors in handleEvent() are NOT propagated to emit()
calloraEvents.emit('new_api_call', developerId, data);
// Always succeeds, even if webhook processing fails

// Errors are logged but don't crash the process
logger.error('[webhook] Failed to deliver...', error);
```

### Error Recovery

1. **Webhook Failures**: Automatic retry with exponential backoff
2. **Network Timeouts**: 10s timeout per attempt
3. **Unhandled Rejections**: Caught by `Promise.allSettled()`

## Best Practices

### For Event Emitters

```typescript
// ✅ DO: Emit events synchronously
calloraEvents.emit('new_api_call', developerId, data);

// ❌ DON'T: Wait for event processing
await calloraEvents.emit('new_api_call', developerId, data); // Doesn't work
```

### For Webhook Consumers

```typescript
// ✅ DO: Handle webhooks idempotently
if (alreadyProcessed(eventId)) {
    return 200; // Acknowledge but don't reprocess
}

// ✅ DO: Respond quickly
return 200; // Acknowledge immediately, process asynchronously

// ❌ DON'T: Block webhook processing
await longRunningOperation(); // May cause timeouts
```

### For Memory Management

```typescript
// ✅ DO: Monitor webhook store size
setInterval(() => {
    const size = WebhookStore.list().length;
    if (size > THRESHOLD) {
        logger.warn(`WebhookStore size: ${size}`);
    }
}, 60000);

// ✅ DO: Clean up unused webhooks
WebhookStore.delete(developerId);
```

## Monitoring and Debugging

### Key Metrics

1. **Event Rate**: Events emitted per second
2. **Webhook Success Rate**: Percentage of successful deliveries
3. **WebhookStore Size**: Number of registered webhooks
4. **Memory Usage**: Heap size over time

### Debug Logging

```typescript
// Enable debug logging
DEBUG=webhook:* npm start

// Monitor event emissions
DEBUG=events:* npm start
```

## Security Considerations

### Event Data Validation

- Event emitter does not validate payload structure
- Webhook consumers should validate incoming data
- Use type guards and schema validation

### Rate Limiting

- No built-in rate limiting on event emission
- Implement application-level rate limiting if needed
- Monitor webhook delivery rates to prevent abuse

## Testing Considerations

### Unit Testing

- Mock `dispatchToAll()` to avoid HTTP calls
- Test async behavior with proper timing
- Verify memory usage under load

### Integration Testing

- Test full webhook delivery flow
- Verify error handling and retry logic
- Test concurrent event processing

## Future Improvements

### Potential Enhancements

1. **Event Batching**: Batch multiple events for better throughput
2. **Circuit Breaker**: Stop webhook delivery after repeated failures
3. **Metrics Collection**: Built-in performance metrics
4. **Event Replay**: Store events for replay capability
5. **Webhook Deduplication**: Prevent duplicate webhook deliveries

### Scalability Considerations

- Consider external message queue for high-volume scenarios
- Implement webhook delivery partitioning for better parallelism
- Add webhook delivery priority queues
