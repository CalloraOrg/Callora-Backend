import { injectLatency, withSorobanLatencyWrapper } from './sorobanLatency.js';

describe('Soroban Latency Chaos Harness', () => {
  beforeEach(() => {
    delete process.env.SOROBAN_CHAOS;
  });

  afterEach(() => {
    delete process.env.SOROBAN_CHAOS;
  });

  it('should not inject latency when SOROBAN_CHAOS is not set', async () => {
    const start = Date.now();
    await injectLatency();
    const end = Date.now();
    expect(end - start).toBeLessThan(10);
  });

  it('should inject latency when SOROBAN_CHAOS=1', async () => {
    process.env.SOROBAN_CHAOS = '1';
    const start = Date.now();
    await injectLatency();
    const end = Date.now();
    expect(end - start).toBeGreaterThanOrEqual(50);
    expect(end - start).toBeLessThanOrEqual(1000);
  });

  it('should wrap fetch and inject latency when enabled', async () => {
    process.env.SOROBAN_CHAOS = '1';
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ result: {} }) });
    const wrappedFetch = withSorobanLatencyWrapper(mockFetch);

    const start = Date.now();
    await wrappedFetch('http://example.com');
    const end = Date.now();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(end - start).toBeGreaterThanOrEqual(50);
  });

  it('should wrap fetch and not inject latency when disabled', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ result: {} }) });
    const wrappedFetch = withSorobanLatencyWrapper(mockFetch);

    const start = Date.now();
    await wrappedFetch('http://example.com');
    const end = Date.now();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(end - start).toBeLessThan(10);
  });
});
