import { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { config } from "../../src/config/index.js";
import { closeDb, initializeDb } from "../../src/db/index.js";
import { createSorobanRpcBillingClient } from "../../src/services/sorobanBilling.js";

jest.mock("../../src/services/sorobanBilling.js", () => ({
  createSorobanRpcBillingClient: jest.fn(),
}));
jest.mock("../../src/config/index.js", () => {
  const actual = jest.requireActual("../../src/config/index.js");
  return { ...actual, config: { ...actual.config, demoMode: true } };
});

describe("demo capability integration", () => {
  const previousCors = process.env.CORS_ALLOW_MISSING_ORIGIN;
  beforeAll(async () => {
    process.env.CORS_ALLOW_MISSING_ORIGIN = "true";
    jest.replaceProperty(config, "demoMode", true);
    await initializeDb();
  });
  afterAll(async () => {
    if (previousCors === undefined) delete process.env.CORS_ALLOW_MISSING_ORIGIN;
    else process.env.CORS_ALLOW_MISSING_ORIGIN = previousCors;
    jest.restoreAllMocks();
    await closeDb();
  });

  test("rejects billing before handlers, preserves requestId and omits retry headers", async () => {
    const connect = jest.spyOn(Pool.prototype, "connect");
    const query = jest.spyOn(Pool.prototype, "query");
    const app = createApp();
    const response = await request(app).post("/api/billing/deduct")
      .set("x-request-id", "demo-regression");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      success: false,
      requestId: "demo-regression",
      error: { code: "DEMO_MODE_UNSUPPORTED", details: { feature: "billing" } },
    });
    expect(response.headers["retry-after"]).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  test("blocks invoices while keeping the seeded SQLite catalog available", async () => {
    const app = createApp();
    expect((await request(app).get("/api/invoices")).status).toBe(503);
    const catalog = await request(app).get("/api/apis");
    expect(catalog.status).toBe(200);
    expect(JSON.stringify(catalog.body)).toContain("Geo Lookup");
  });

  test("reports demo mode and never constructs the billing RPC client", async () => {
    const createClient = jest.fn();
    const app = createApp({ createBillingSorobanClient: createClient });
    const response = await request(app).get("/api/health");
    expect(response.body.data).toEqual({
      status: "ok", service: "callora-backend", mode: "demo",
    });
    expect(createClient).not.toHaveBeenCalled();
    expect(createSorobanRpcBillingClient).not.toHaveBeenCalled();
    expect(app.locals.billingService).toBeUndefined();
  });

  test("blocks newer on-chain vault routes before the injected reader is called", async () => {
    const readVault = jest.fn();
    const app = createApp({ vaultReader: { readVault } });
    for (const path of ["/api/vault/onchain", "/api/vault/balance"]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("DEMO_MODE_UNSUPPORTED");
      expect(response.headers["retry-after"]).toBeUndefined();
      expect((await request(app).head(path)).status).toBe(503);
    }
    expect(readVault).not.toHaveBeenCalled();
  });

  test("standard mode keeps the existing handler response and health shape", async () => {
    jest.replaceProperty(config, "demoMode", false);
    try {
      const app = createApp();
      const billing = await request(app).post("/api/billing/deduct");
      expect(billing.status).toBe(401);
      const health = await request(app).get("/api/health");
      expect(health.body.data).toMatchInlineSnapshot(`
        {
          "mode": "standard",
          "service": "callora-backend",
          "status": "ok",
        }
      `);
    } finally {
      jest.replaceProperty(config, "demoMode", true);
    }
  });
});
