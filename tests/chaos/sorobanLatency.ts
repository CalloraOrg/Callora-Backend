/**
 * Test-only harness to inject latency into Soroban RPC calls when SOROBAN_CHAOS=1
 */

const MIN_LATENCY_MS = 50;
const MAX_LATENCY_MS = 500;

function randomLatency(minMs: number = MIN_LATENCY_MS, maxMs: number = MAX_LATENCY_MS): number {
  const min = Math.max(0, minMs);
  const max = Math.max(min, maxMs);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function injectLatency(): Promise<void> {
  const chaosEnabled = process.env.SOROBAN_CHAOS === '1';
  if (!chaosEnabled) {
    return;
  }
  const delay = randomLatency();
  await new Promise(resolve => setTimeout(resolve, delay));
}

export function withSorobanLatencyWrapper(
  fetchImpl: typeof fetch
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    await injectLatency();
    return fetchImpl(input, init);
  };
}
