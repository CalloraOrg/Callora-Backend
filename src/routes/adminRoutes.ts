import type { Express } from "express";
import { pool } from "../db.js";
import adminRouter from "./admin.js";
import { createExplainRouter } from "./admin/explain.js";
import { createUsageAnomaliesRouter } from "./admin/usage/anomalies.js";
import { createAdminUsageByEndpointRouter } from "./admin/usage/by-endpoint.js";
import { createSpikeRouter } from "./admin/usage/spike.js";

export function registerAdminRoutes(app: Express): void {
  // Mounted before the generic admin router so the specific path is not
  // shadowed by adminRouter's `/usage/:developerId` route.
  app.use("/api/admin/usage/anomalies", createUsageAnomaliesRouter({ pool }));
  app.use(
    "/api/admin/usage/by-endpoint",
    createAdminUsageByEndpointRouter({ pool }),
  );
  app.use("/api/admin", adminRouter);
  app.use("/api/admin/db/explain", createExplainRouter({ pool }));
  app.use('/api/admin/usage/anomalies', createUsageAnomaliesRouter({ pool }));
  app.use('/api/admin/usage/by-endpoint', createAdminUsageByEndpointRouter({ pool }));
  app.use('/api/admin/usage/spike', createSpikeRouter({ pool }));
  app.use('/api/admin', adminRouter);
  app.use('/api/admin/db/explain', createExplainRouter({ pool }));

}
