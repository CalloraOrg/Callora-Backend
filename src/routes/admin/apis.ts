/**
 * Admin API management routes — soft-delete and restore.
 *
 * All routes in this module sit behind the IP allowlist and admin-auth
 * middleware that are applied at the parent `/api/admin` router level.
 * No additional auth wiring is required here.
 *
 * Routes:
 *   DELETE /api/admin/apis/:id   — soft-delete a live API
 *   POST   /api/admin/apis/:id/restore — restore a soft-deleted API
 */

import { Router } from "express";
import { getClientIp } from "../../lib/clientIp.js";
import {
  BadRequestError,
  NotFoundError,
  AppError,
  InternalServerError,
} from "../../errors/index.js";
import { logger } from "../../logger.js";
import {
  defaultApiRepository,
  type ApiRepository,
} from "../../repositories/apiRepository.js";

const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === "true";

export interface AdminApisRouterDeps {
  /** Override in tests to inject an in-memory repository. */
  apiRepository?: ApiRepository;
}

/**
 * Factory that returns the admin APIs sub-router.
 * Mount it under the existing admin router, e.g.:
 *   adminRouter.use('/apis', createAdminApisRouter());
 */
export function createAdminApisRouter(
  deps: AdminApisRouterDeps = {},
): Router {
  const router = Router();
  const apiRepository = deps.apiRepository ?? defaultApiRepository;

  // ── DELETE /api/admin/apis/:id ──────────────────────────────────────────
  /**
   * Soft-delete an API.
   *
   * Sets `deleted_at` to the current timestamp; the row is retained for audit
   * purposes and can be restored via POST /api/admin/apis/:id/restore.
   *
   * Returns 204 No Content on success.
   * Returns 404 if the API does not exist or is already deleted.
   */
  router.delete("/:id", async (req, res, next) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      next(new BadRequestError("id must be a positive integer"));
      return;
    }

    try {
      const deleted = await apiRepository.delete(id);

      if (!deleted) {
        next(
          new NotFoundError(
            "API not found or already deleted",
            "NOT_FOUND",
          ),
        );
        return;
      }

      logger.audit("SOFT_DELETE_API", res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get("User-Agent"),
        correlationId: req.headers["x-request-id"] ?? req.headers["x-correlation-id"],
        apiId: id,
        diff: { deleted_at: new Date().toISOString() },
      });

      res.status(204).end();
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error("Failed to soft-delete API", { apiId: id, error });
      next(new InternalServerError());
    }
  });

  // ── POST /api/admin/apis/:id/restore ────────────────────────────────────
  /**
   * Restore a soft-deleted API.
   *
   * Clears `deleted_at`, making the API visible again in all listings.
   * The API's previous `status` is preserved — if it was `active` before
   * deletion it will reappear in the public catalog immediately.
   *
   * Returns 200 with the restored API row.
   * Returns 404 if the API does not exist or is not currently deleted.
   */
  router.post("/:id/restore", async (req, res, next) => {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      next(new BadRequestError("id must be a positive integer"));
      return;
    }

    try {
      const restored = await apiRepository.restore(id);

      if (!restored) {
        next(
          new NotFoundError(
            "API not found or not currently deleted",
            "NOT_FOUND",
          ),
        );
        return;
      }

      logger.audit("RESTORE_API", res.locals.adminActor, {
        clientIp: getClientIp(req, TRUST_PROXY),
        userAgent: req.get("User-Agent"),
        correlationId: req.headers["x-request-id"] ?? req.headers["x-correlation-id"],
        apiId: id,
        diff: { deleted_at: null },
      });

      res.json({ data: restored });
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      logger.error("Failed to restore API", { apiId: id, error });
      next(new InternalServerError());
    }
  });

  return router;
}

export default createAdminApisRouter;