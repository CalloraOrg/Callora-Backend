import express from "express";
import request from "supertest";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { DEMO_UNSUPPORTED_ROUTES, demoGuard } from "./demoGuard.js";

describe("demo capability guard", () => {
  beforeEach(() => jest.replaceProperty(config, "demoMode", true));
  afterEach(() => jest.restoreAllMocks());

  function app() {
    const server = express();
    server.use(demoGuard);
    server.use((_req, res) => res.json({ passed: true }));
    return server;
  }

  test.each(DEMO_UNSUPPORTED_ROUTES)("guards $prefix with feature details", async ({ prefix, methods, feature }) => {
    const method = methods[0] === "*" ? "get" : methods[0].toLowerCase();
    const response = await request(app())[method as "get" | "post"](`${prefix}/`)
      .set("x-request-id", "guard-test");
    expect(response.status).toBe(503);
    expect(response.body.error).toEqual({
      code: "DEMO_MODE_UNSUPPORTED",
      message: "This feature is unavailable in demo mode.",
      details: { feature },
    });
    expect(response.body.requestId).toBe("guard-test");
    expect(response.headers["retry-after"]).toBeUndefined();
  });

  test.each(["post", "put", "patch", "delete"] as const)("blocks audit %s writes", async (method) => {
    expect((await request(app())[method]("/api/audit/123")).status).toBe(503);
  });

  test.each(["/api/health", "/api/apis", "/api/audit", "/api/billing-lookalike", "/api/usage-report"])("allows GET %s", async (path) => {
    expect((await request(app()).get(path)).body).toEqual({ passed: true });
  });

  test("matches Express case-insensitive paths and generated request IDs", async () => {
    const response = await request(app()).post("/API/BILLING/deduct");
    expect(response.status).toBe(503);
    expect(response.body.requestId).toEqual(expect.any(String));
    expect(response.body.timestamp).toEqual(expect.any(String));
  });

  test("passes every guarded prefix through in standard mode", async () => {
    jest.replaceProperty(config, "demoMode", false);
    for (const { prefix } of DEMO_UNSUPPORTED_ROUTES) {
      expect((await request(app()).post(prefix)).body).toEqual({ passed: true });
    }
  });

  test("every declared capability corresponds to a mounted handler", () => {
    interface Layer {
      regexp: RegExp;
      route?: { methods: Record<string, boolean> };
      handle: { stack?: Layer[] };
    }
    jest.replaceProperty(config, "exports", {
      ...config.exports,
      enabled: true,
      bucket: "test-exports",
      endpoint: "https://storage.example.com",
      region: "test-region",
      signingSecret: "dummy-export-signing-secret-for-tests",
    });
    const server = createApp() as ReturnType<typeof createApp> & { _router: { stack: Layer[] } };
    function mounted(stack: Layer[], path: string, method: string): boolean {
      return stack.some((layer) => {
        const match = layer.regexp.exec(path);
        if (!match) return false;
        if (layer.route) return !!layer.route.methods[method];
        return !!layer.handle.stack && mounted(layer.handle.stack, path.slice(match[0].length) || "/", method);
      });
    }
    const examples: Record<string, [string, string]> = {
      "/api/billing": ["/api/billing/deduct", "post"],
      "/api/invoices": ["/api/invoices", "get"],
      "/api/usage": ["/api/usage", "get"],
      "/api/exports": ["/api/exports", "get"],
      "/api/admin/usage": ["/api/admin/usage/anomalies", "get"],
      "/api/admin/db/explain": ["/api/admin/db/explain", "post"],
      "/api/vault/deposit/prepare": ["/api/vault/deposit/prepare", "post"],
      "/api/vault/onchain": ["/api/vault/onchain", "get"],
      "/api/vault/balance": ["/api/vault/balance", "get"],
      "/api/audit": ["/api/audit", "post"],
      "/api/credits": ["/api/credits", "get"],
      "/api/refunds": ["/api/refunds", "get"],
      "/api/health/health": ["/api/health/health", "get"],
      "/api/health/dependencies": ["/api/health/dependencies", "get"],
    };
    for (const { prefix } of DEMO_UNSUPPORTED_ROUTES) {
      const [path, method] = examples[prefix];
      expect({ prefix, mounted: mounted(server._router.stack, path, method) }).toEqual({ prefix, mounted: true });
    }
  });
});
