describe("config validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules(); // important for re-import
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("should load config with defaults", async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";

    const { config } = await import("./index.js");

    expect(config.port).toBeDefined();
    expect(config.databaseUrl).toContain("postgresql://");
  });

  it("should fail with invalid DATABASE_URL", async () => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "";

    const exitMock = jest
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    await import("./index.js");

    expect(exitMock).toHaveBeenCalledWith(1);

    exitMock.mockRestore();
  });
});
