import express from "express";
import supertest from "supertest";
import { createMaintenanceBannerRouter } from "./banner.js";

describe("Admin Maintenance Banner Endpoint", () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    
    // Mock administrative auth middleware to inject required res.locals context
    app.use((req, res, next) => {
      res.locals.adminActor = { id: "admin_test_user", role: "superadmin" };
      next();
    });

    // Mount the sub-router under the exact target path for isolated integration testing
    app.use("/api/admin/maintenance/banner", createMaintenanceBannerRouter());
  });

  // ── SUCCESSFUL CASE ──────────────────────────────────────────────────────────
  it("should successfully set the maintenance banner and return 200", async () => {
    const response = await supertest(app)
      .post("/api/admin/maintenance/banner")
      .send({
        message: "System upgrade in progress",
        isActive: true,
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("data");
    expect(response.body.data.message).toBe("System upgrade in progress");
    expect(response.body.data.isActive).toBe(true);
    expect(response.body.data).toHaveProperty("updatedAt");
  });

  // ──  (INPUT VALIDATION EDGE CASES) ──────────────────────────────────────
  it("should return 400 BadRequest if message is missing or empty", async () => {
    const response = await supertest(app)
      .post("/api/admin/maintenance/banner")
      .send({
        message: "   ",
        isActive: true,
      });

    expect(response.status).toBe(400);
  });

  it("should return 400 BadRequest if isActive is not a boolean", async () => {
    const response = await supertest(app)
      .post("/api/admin/maintenance/banner")
      .send({
        message: "Valid message",
        isActive: "true", 
      });

    expect(response.status).toBe(400);
  });
});