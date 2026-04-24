describe('config validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should load config with defaults when required vars are set', async () => {
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'test-secret';
    process.env.ADMIN_API_KEY = 'test-admin-key';
    process.env.METRICS_API_KEY = 'test-metrics-key';

    let cfg: { config: { port: unknown; databaseUrl: string } } | undefined;
    await jest.isolateModulesAsync(async () => {
      cfg = await import('./index.js');
    });

    expect(cfg!.config.port).toBeDefined();
    expect(cfg!.config.databaseUrl).toContain('postgresql://');
  });

  it('should call process.exit(1) when required env vars are missing', async () => {
    // Remove fields that have no defaults — env.ts will fail to parse and call process.exit(1)
    delete process.env.JWT_SECRET;
    delete process.env.ADMIN_API_KEY;
    delete process.env.METRICS_API_KEY;

    const exitMock = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);

    await jest.isolateModulesAsync(async () => {
      await import('./env.js');
    });

    expect(exitMock).toHaveBeenCalledWith(1);
    exitMock.mockRestore();
  });
});
