/**
 * Tests for soft-delete and restore of APIs.
 *
 * Covers:
 *   - DELETE /api/admin/apis/:id  (soft-delete)
 *   - POST   /api/admin/apis/:id/restore
 *   - InMemoryApiRepository.delete / .restore behaviour
 *   - listByDeveloper / listPublic exclusion of deleted rows
 *   - findById exclusion of deleted rows
 */

jest.mock("better-sqlite3", () => {
  return class MockDatabase {
    prepare() {
      return { get: () => null };
    }
    exec() {}
    close() {}
  };
});

import express from "express";
import request from "supertest";
import { errorHandler } from "../../middleware/errorHandler.js";
import {
  InMemoryApiRepository,
  type ApiRepository,
} from "../../repositories/apiRepository.js";
import { createAdminApisRouter } from "./apis.js";
import type { Api } from "../../db/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_KEY = "test-admin-key";

function buildApp(repo: ApiRepository) {
  const app = express();
  app.use(express.json());

  // Simulate the admin-auth middleware: set adminActor and skip real checks.
  app.use((req, res, next) => {
    if (req.headers["x-admin-api-key"] !== ADMIN_KEY) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.locals.adminActor = "admin-api-key";
    next();
  });

  app.use("/api/admin/apis", createAdminApisRouter({ apiRepository: repo }));
  app.use(errorHandler);
  return app;
}

function makeApi(overrides: Partial<Api> = {}): Api {
  const now = new Date();
  return {
    id: 1,
    developer_id: 10,
    name: "Test API",
    description: null,
    base_url: "https://api.test",
    logo_url: null,
    category: null,
    status: "active",
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// InMemoryApiRepository — soft-delete behaviour
// ---------------------------------------------------------------------------

describe("InMemoryApiRepository — soft-delete", () => {
  it("delete() returns true and sets deleted_at on a live record", async () => {
    const repo = new InMemoryApiRepository([makeApi({ id: 1 })]);
    const result = await repo.delete(1);
    expect(result).toBe(true);
    // Row is no longer returned by listByDeveloper
    const rows = await repo.listByDeveloper(10);
    expect(rows).toHaveLength(0);
  });

  it("delete() returns false for an already-deleted record (idempotent safety)", async () => {
    const api = makeApi({ id: 1, deleted_at: new Date() });
    const repo = new InMemoryApiRepository([api]);
    const result = await repo.delete(1);
    expect(result).toBe(false);
  });

  it("delete() returns false for a non-existent id", async () => {
    const repo = new InMemoryApiRepository([]);
    expect(await repo.delete(999)).toBe(false);
  });

  it("restore() returns the Api row and clears deleted_at", async () => {
    const api = makeApi({ id: 1, deleted_at: new Date() });
    const repo = new InMemoryApiRepository([api]);
    const restored = await repo.restore(1);
    expect(restored).not.toBeNull();
    expect(restored!.deleted_at).toBeNull();
    expect(restored!.id).toBe(1);
  });

  it("restore() returns null for a live (non-deleted) record", async () => {
    const repo = new InMemoryApiRepository([makeApi({ id: 1 })]);
    expect(await repo.restore(1)).toBeNull();
  });

  it("restore() returns null for a non-existent id", async () => {
    const repo = new InMemoryApiRepository([]);
    expect(await repo.restore(999)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// InMemoryApiRepository — query exclusion
// ---------------------------------------------------------------------------

describe("InMemoryApiRepository — query exclusion", () => {
  function makeRepo() {
    const live = makeApi({ id: 1, developer_id: 10, status: "active" });
    const deleted = makeApi({
      id: 2,
      developer_id: 10,
      status: "active",
      deleted_at: new Date(),
    });
    return new InMemoryApiRepository([live, deleted]);
  }

  it("listByDeveloper excludes soft-deleted rows", async () => {
    const repo = makeRepo();
    const rows = await repo.listByDeveloper(10);
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("listPublic excludes soft-deleted rows", async () => {
    const repo = makeRepo();
    const rows = await repo.listPublic();
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("findById returns null for a soft-deleted record", async () => {
    const repo = makeRepo();
    expect(await repo.findById(2)).toBeNull();
  });

  it("findById returns the record for a live record", async () => {
    const repo = makeRepo();
    const found = await repo.findById(1);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(1);
  });

  it("delete then restore makes the record visible again in listings", async () => {
    const repo = makeRepo();
    await repo.delete(1);
    expect(await repo.listByDeveloper(10)).toHaveLength(0);
    await repo.restore(1);
    expect(await repo.listByDeveloper(10)).toHaveLength(1);
  });

  it("update on a soft-deleted record returns null", async () => {
    const repo = makeRepo();
    const updated = await repo.update(2, { name: "new name" });
    expect(updated).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP: DELETE /api/admin/apis/:id
// ---------------------------------------------------------------------------

describe("DELETE /api/admin/apis/:id", () => {
  it("returns 204 and soft-deletes the API", async () => {
    const repo = new InMemoryApiRepository([makeApi({ id: 42 })]);
    const app = buildApp(repo);

    const res = await request(app)
      .delete("/api/admin/apis/42")
      .set("x-admin-api-key", ADMIN_KEY);

    expect(res.status).toBe(204);
    // Confirm the record is no longer accessible via normal listing
    const rows = await repo.listByDeveloper(10);
    expect(rows).toHaveLength(0);
  });

  it("returns 404 when the API does not exist", async () => {
    const repo = new InMemoryApiRepository([]);
    const app = buildApp(repo);

    const res = await request(app)
      .delete("/api/admin/apis/999")
      .set("x-admin-api-key", ADMIN_KEY);

    expect(res.status).toBe(404);
  });

  it("returns 404 when the API is already deleted", async () => {
    const repo = new InMemoryApiRepository([
      makeApi({ id: 5, deleted_at: new Date() }),
    ]);
    const app = buildApp(repo);

    const res = await request(app)
      .delete("/api/admin/apis/5")
      .set("x-admin-api-key", ADMIN_KEY);

    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-integer id", async () => {
    const repo = new InMemoryApiRepository([]);
    const app = buildApp(repo);

    const res = await request(app)
      .delete("/api/admin/apis/abc")
      .set("x-admin-api-key", ADMIN_KEY);

    expect(res.status).toBe(400);
  });

  it("returns 400 for id=0", async () => {
    const repo = new InMemoryApiRepository([]);
    const app = buildApp(repo);

    const res = await request(app)
      .delete("/api/admin/apis/0")
      .set("x-admin-api-key", ADMIN_KEY);

    expect(res.status).toBe(400);
  });

  it("returns 401 without admin key", async () => {
    const repo = new InMemoryApiRepository([makeApi({ id: 1 })]);
    const app = buildApp(repo);

    const res = await request(app).delete("/api/admin/apis/1");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// HTTP: POST /api/admin/apis/:id/restore
// ---------------------------------------------------------------------------

describe("POST /api/admin/apis/:id/restore", () => {
  it("returns 200 with the restored API when the record is deleted", async () => {
    const repo = new InMemoryApiRepository([
      makeApi({ id: 7, deleted_at: new Date() }),
    ]);
    const app = buildApp(repo);

    const res = await request(app)
      .post("/api/admin/apis/7/restore")
      .set("x-admin-api-key", ADMIN_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBe(7);
    expect(res.body.data.deleted_at).toBeNull();
  });

  it("returns 404 when the API is already live (not deleted)", async () => {
    const repo = new InMemoryApiRepository([makeApi({ id: 8 })]);
    const app = buildApp(repo);

    const res = await request(app)
      .post("/api/admin/apis/8/restore")
      .set("x-admin-api-key", ADMIN_KEY);

    expect(res.status).toBe(404);
  });

  it("returns 404 when the API does not exist", async () => {
    const repo = new InMemoryApiRepository([]);
    const app = buildApp(repo);

    const res = await request(app)
      .post("/api/admin/apis/999/restore")
      .set("x-admin-api-key", ADMIN_KEY);

    expect(res.status).toBe(404);
  });

  it("returns 400 for a non-integer id", async () => {
    const repo = new InMemoryApiRepository([]);
    const app = buildApp(repo);

    const res = await request(app)
      .post("/api/admin/apis/abc/restore")
      .set("x-admin-api-key", ADMIN_KEY);

    expect(res.status).toBe(400);
  });

  it("returns 401 without admin key", async () => {
    const repo = new InMemoryApiRepository([
      makeApi({ id: 7, deleted_at: new Date() }),
    ]);
    const app = buildApp(repo);

    const res = await request(app).post("/api/admin/apis/7/restore");
    expect(res.status).toBe(401);
  });

  it("restores the API and makes it reappear in developer listings", async () => {
    const repo = new InMemoryApiRepository([
      makeApi({ id: 10, deleted_at: new Date() }),
    ]);
    const app = buildApp(repo);

    await request(app)
      .post("/api/admin/apis/10/restore")
      .set("x-admin-api-key", ADMIN_KEY);

    const rows = await repo.listByDeveloper(10);
    expect(rows.map((r) => r.id)).toContain(10);
  });
});