import type { IncomingMessage, ServerResponse } from "http";

const mockInitializeDb = jest.fn();
jest.mock("../src/db/index.js", () => ({
  initializeDb: (...args: unknown[]) => mockInitializeDb(...args),
}));

const mockApp = jest.fn();
jest.mock("../src/index.js", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockApp(...args),
}));

import handler, {
  ensureReady,
  isDbReady,
  resetReadinessState,
} from "./vercel-entry.js";

function createMockReq(headers: Record<string, string> = {}): IncomingMessage {
  return {
    headers,
    method: "GET",
    url: "/api/health",
  } as unknown as IncomingMessage;
}

function createMockRes() {
  const res: {
    statusCode: number;
    headers: Record<string, string>;
    headersSent: boolean;
    body: string;
    setHeader: jest.Mock;
    end: jest.Mock;
  } = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: "",
    setHeader: jest.fn((k: string, v: string) => {
      res.headers[k.toLowerCase()] = v;
    }),
    end: jest.fn((data?: string) => {
      res.body = data ?? "";
      res.headersSent = true;
    }),
  };
  return res as unknown as ServerResponse & typeof res;
}

describe("scripts/vercel-entry.ts", () => {
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    resetReadinessState();
    errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("Scenario 1: First initializeDb rejects, second resolves", async () => {
    mockInitializeDb
      .mockRejectedValueOnce(new Error("disk I/O error"))
      .mockResolvedValueOnce(undefined);

    mockApp.mockImplementation((_req, res: ServerResponse) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ status: "ok" }));
    });

    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(10000);

    // 1. First request fails with 503 SERVICE_INITIALIZING
    const req1 = createMockReq({ "x-request-id": "req-1" });
    const res1 = createMockRes();

    await handler(req1, res1);

    expect(res1.statusCode).toBe(503);
    const body1 = JSON.parse(res1.body);
    expect(body1.success).toBe(false);
    expect(body1.error.code).toBe("SERVICE_INITIALIZING");
    expect(body1.requestId).toBe("req-1");
    expect(res1.headers["retry-after"]).toBe("5");
    expect(mockApp).not.toHaveBeenCalled();
    expect(isDbReady()).toBe(false);

    // 2. Request within backoff window (2 seconds later) returns 503 without retrying
    nowSpy.mockReturnValue(12000);
    const req2 = createMockReq({ "x-request-id": "req-2" });
    const res2 = createMockRes();

    await handler(req2, res2);

    expect(res2.statusCode).toBe(503);
    expect(mockInitializeDb).toHaveBeenCalledTimes(1);

    // 3. Request after backoff window (6 seconds later) retries and succeeds
    nowSpy.mockReturnValue(16001);
    const req3 = createMockReq({ "x-request-id": "req-3" });
    const res3 = createMockRes();

    await handler(req3, res3);

    expect(mockInitializeDb).toHaveBeenCalledTimes(2);
    expect(res3.statusCode).toBe(200);
    expect(mockApp).toHaveBeenCalledWith(req3, res3);
    expect(isDbReady()).toBe(true);

    nowSpy.mockRestore();
  });

  it("Scenario 2: initializeDb keeps failing with back-off and no unhandled rejection", async () => {
    mockInitializeDb.mockRejectedValue(new Error("persistent failure"));

    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(1000);

    // First attempt fails
    const req1 = createMockReq();
    const res1 = createMockRes();
    await handler(req1, res1);
    expect(res1.statusCode).toBe(503);

    // Rapid successive requests within backoff are rejected immediately
    for (let i = 0; i < 5; i++) {
      nowSpy.mockReturnValue(1000 + i * 100);
      const req = createMockReq();
      const res = createMockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error.code).toBe("SERVICE_INITIALIZING");
    }

    // Only 1 attempt was made to initializeDb during backoff
    expect(mockInitializeDb).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });

  it("Scenario 3: app throws synchronously -> 500 envelope, not a crashed function", async () => {
    mockInitializeDb.mockResolvedValue(undefined);
    mockApp.mockImplementation(() => {
      throw new Error("synchronous router failure");
    });

    const req = createMockReq({ "x-request-id": "req-sync-fail" });
    const res = createMockRes();

    await expect(handler(req, res)).resolves.not.toThrow();

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(body.requestId).toBe("req-sync-fail");
  });

  it("ensureReady fast-paths when already ready", async () => {
    mockInitializeDb.mockResolvedValue(undefined);

    const first = await ensureReady();
    expect(first).toBe(true);
    expect(mockInitializeDb).toHaveBeenCalledTimes(1);

    const second = await ensureReady();
    expect(second).toBe(true);
    expect(mockInitializeDb).toHaveBeenCalledTimes(1);
  });
});
