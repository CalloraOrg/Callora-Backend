import { injectLatency, withSorobanLatencyWrapper } from './sorobanLatencyChaos.js';

describe('Soroban Latency Chaos Helper', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    delete process.env.SOROBAN_CHAOS;
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    delete process.env.SOROBAN_CHAOS;
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('should not inject latency when SOROBAN_CHAOS is not set', async () => {
    const start = Date.now();
    await injectLatency();
    const end = Date.now();
    expect(end - start).toBeLessThan(10);
  });

  it('should not inject latency when SOROBAN_CHAOS=0', async () => {
    process.env.SOROBAN_CHAOS = '0';
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

  it('should ignore SOROBAN_CHAOS=1 when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SOROBAN_CHAOS = '1';
    const start = Date.now();
    await injectLatency();
    const end = Date.now();
    expect(end - start).toBeLessThan(10);
  });

  it('should wrap fetch and inject latency when enabled', async () => {
    process.env.SOROBAN_CHAOS = '1';
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ result: {} }) });
    const wrappedFetch = withSorobanLatencyWrapper(mockFetch);

    const init: RequestInit = { method: 'POST', body: '{}' };
    const start = Date.now();
    await wrappedFetch('http://example.com', init);
    const end = Date.now();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('http://example.com', init);
    expect(end - start).toBeGreaterThanOrEqual(50);
  });

  it('should wrap fetch and not inject latency when disabled', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ result: {} }) });
    const wrappedFetch = withSorobanLatencyWrapper(mockFetch);

    const init: RequestInit = { method: 'GET' };
    const start = Date.now();
    await wrappedFetch('http://example.com', init);
    const end = Date.now();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('http://example.com', init);
    expect(end - start).toBeLessThan(10);
  });
});
