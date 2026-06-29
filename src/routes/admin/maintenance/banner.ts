/**
 * Admin API maintenance banner routes.
 * * Routes:
 * POST /api/admin/maintenance/banner — set or update the maintenance banner
 */

import { Router } from "express";
import { getClientIp } from "../../../lib/clientIp.js";
import {
  BadRequestError,
  AppError,
  InternalServerError,
} from "../../../errors/index.js";
import { logger } from "../../../logger.js";

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === "true";

export interface MaintenanceBannerRouterDeps {
  
}

/**
 * Factory that returns the admin maintenance banner sub-router.
 */
export function createMaintenanceBannerRouter(
  _deps: MaintenanceBannerRouterDeps = {},
): Router {
  const router = Router();

  // ── POST /api/admin/maintenance/banner ──────────────────────────────────
  /**
   * Set or update the system-wide maintenance banner.
   * * Returns 200 OK with the updated banner data.
   */
  router.post("/", async (req, res, next) => {
    const { message, isActive } = req.body;

    // 1. Input Validation at the boundary (Criterio de Aceptación)
    if (typeof message !== "string" || message.trim() === "") {
      next(new BadRequestError("message must be a non-empty string"));
      return;
    }

    if (typeof isActive !== "boolean") {
      next(new BadRequestError("isActive must be a boolean"));
      return;
    }

    try {
      const correlationId = req.headers["x-request-id"] ?? req.headers["x-correlation-id"];
      
      
      const bannerData = {
        message: message.trim(),
        isActive,
        updatedAt: new Date().toISOString()
      };

      // 2. Structured logging with correlation IDs (Guideline requerida)
      logger.audit("SET_MAINTENANCE_BANNER", res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get("User-Agent"),
        correlationId,
        diff: bannerData,
      });

      // 3. Standardized error envelope/response
      res.status(200).json({ data: bannerData });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error("Failed to set maintenance banner", { error });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createMaintenanceBannerRouter;