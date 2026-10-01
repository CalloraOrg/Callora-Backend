/**
 * Tests for the liveness probe router (src/routes/healthz.ts).
 *
 * Why this suite exists: `healthzRouter` had no test coverage. A liveness
 * probe must be cheap and dependency-free — an accidental database call
 * would trigger restart loops during database outages (precisely when the
 * probe is needed most), and a cacheable response would let stale liveness
 * state mask an instance's recovery.
 *
 * Acceptance criteria covered:
 *   1. GET on `healthzRouter` returns 200 with body `{ status: "ok" }`.
 *   2. The response carries `Cache-Control: no-store`.
 *   3. `pool.query` (src/db.ts) is never called — the entire database
 *      module is mocked below, so any future import of it on this code
 *      path is surfaced by this suite.
 *   4. The response is served in under 50 ms.
 *
 * Additional regression coverage: exact response shape, JSON content type,
 * maintenance-window 503 branch (with `no-store` still applied), and
 * recovery to 200 once the window clears.
 */

// Replace the whole database module for this test file. The liveness probe
// must be dependency-free: if any code path under test ever calls
// `pool.query`, the spy records it and the assertion below fails — and the
// rejecting implementation guarantees that even a swallowed rejection would
// keep the probe from depending on a live database. No real Pool is
// constructed, so this suite needs no DATABASE_URL or running Postgres.
jest.mock("../db.js", () => ({
  __esModule: true,
  pool: {
    query: jest.fn(() =>
      Promise.reject(new Error("healthz must not query the database")),
    ),
    end: jest.fn(() => Promise.resolve()),
  },
  query: jest.fn(),
  readQuery: jest.fn(),
  writeQuery: jest.fn(),
  checkDbHealth: jest.fn(),
  closePgPool: jest.fn(),
}));

import express from "express";
import request from "supertest";
import { performance } from "node:perf_hooks";
import { healthzRouter } from "./healthz.js";
import { activeMaintenanceWindow } from "./admin/maintenance.js";
import { pool } from "../db.js";

const poolQuerySpy = pool.query as jest.Mock;

/** Mount the router exactly as production does (bare mount, root scope). */
function buildApp() {
  const app = express();
  app.use(healthzRouter);
  return app;
}

describe("healthzRouter (GET /healthz liveness probe)", () => {
  const savedMaintenance = { ...activeMaintenanceWindow };

  beforeAll(async () => {
    // Warm up the Express/router stack once so the latency assertion below
    // measures steady-state handler cost, not one-off runtime initialisation.
    await request(buildApp()).get("/healthz");
  });

  afterEach(() => {
    poolQuerySpy.mockClear();
    Object.assign(activeMaintenanceWindow, {
      isEnabled: false,
      startTime: null,
      endTime: null,
      reason: "",
    });
  });

  afterAll(() => {
    Object.assign(activeMaintenanceWindow, savedMaintenance);
  });

  it("returns 200 with the exact liveness payload", async () => {
    const res = await request(buildApp()).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.type).toBe("application/json");
    // Exact shape — no extra fields may leak into the probe response.
    expect(res.body).toEqual({ status: "ok" });
  });

  it("sets Cache-Control: no-store so liveness is never served stale", async () => {
    const res = await request(buildApp()).get("/healthz");

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("never calls pool.query — the probe is database-free", async () => {
    const res = await request(buildApp()).get("/healthz");

    expect(res.status).toBe(200);
    expect(poolQuerySpy).not.toHaveBeenCalled();
  });

  it("responds in under 50 ms", async () => {
    const start = performance.now();
    const res = await request(buildApp()).get("/healthz");
    const durationMs = performance.now() - start;

    expect(res.status).toBe(200);
    expect(durationMs).toBeLessThan(50);
  });

  describe("maintenance window", () => {
    it("returns 503 with the MAINTENANCE payload and no-store while a window is active", async () => {
      Object.assign(activeMaintenanceWindow, {
        isEnabled: true,
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-12-31T23:59:59.000Z",
        reason: "schema migration",
      });

      const res = await request(buildApp()).get("/healthz");

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: "MAINTENANCE" });
      // A cached 503 would hide recovery — no-store applies on this path too.
      expect(res.headers["cache-control"]).toBe("no-store");
      // Even the failure branch must stay database-free.
      expect(poolQuerySpy).not.toHaveBeenCalled();
    });

    it("recovers to 200 once the maintenance window clears", async () => {
      Object.assign(activeMaintenanceWindow, { isEnabled: true });
      const during = await request(buildApp()).get("/healthz");

      Object.assign(activeMaintenanceWindow, { isEnabled: false });
      const after = await request(buildApp()).get("/healthz");

      expect(during.status).toBe(503);
      expect(after.status).toBe(200);
      expect(after.body).toEqual({ status: "ok" });
      expect(after.headers["cache-control"]).toBe("no-store");
    });
  });
});
