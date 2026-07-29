/**
 * src/routes/marketplace/plugins.ts
 *
 * Plugin Marketplace API — community-developed billing rule plugins.
 *
 * Endpoints:
 *   GET    /api/marketplace/plugins          — list all plugins
 *   POST   /api/marketplace/plugins          — register a new plugin manifest (auth required)
 *   GET    /api/marketplace/plugins/:id      — get a single plugin
 *   POST   /api/marketplace/plugins/:id/install    — install a plugin (auth required)
 *   DELETE /api/marketplace/plugins/:id/install    — uninstall a plugin (auth required)
 *   DELETE /api/marketplace/plugins/:id            — remove plugin from registry (auth required)
 */

import { Router, type Response } from 'express';
import { requireAuth, type AuthenticatedLocals } from '../../middleware/requireAuth.js';
import { bodyValidator } from '../../middleware/validate.js';
import { logger } from '../../logger.js';
import { NotFoundError } from '../../errors/index.js';
import {
  pluginManifestSchema,
  defaultPluginRepository,
  executeHook,
  type PluginRepository,
  type HookEvent,
} from '../../services/pluginRegistry.js';

export interface PluginRouterDeps {
  pluginRepository?: PluginRepository;
}

export function createPluginsRouter(deps: PluginRouterDeps = {}): Router {
  const router = Router();
  const repo = deps.pluginRepository ?? defaultPluginRepository;

  // ── GET /  — list all plugins ────────────────────────────────────────────
  router.get('/', (_req, res, next) => {
    try {
      const plugins = repo.list();
      res.json({ plugins, total: plugins.length });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /  — register a new plugin ──────────────────────────────────────
  router.post(
    '/',
    requireAuth,
    bodyValidator(pluginManifestSchema),
    (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actor = res.locals.authenticatedUser!.id;
        const manifest = pluginManifestSchema.parse(req.body);
        const record = repo.register(manifest);

        logger.audit('PLUGIN_REGISTERED', actor, {
          pluginId: manifest.id,
          version: manifest.version,
        });

        res.status(201).json(record);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /:id  — single plugin ─────────────────────────────────────────────
  router.get('/:id', (req, res, next) => {
    try {
      const record = repo.findById(req.params.id);
      if (!record) {
        return next(new NotFoundError(`Plugin '${req.params.id}' not found`));
      }
      res.json(record);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /:id/install  — install a plugin ────────────────────────────────
  router.post(
    '/:id/install',
    requireAuth,
    (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actor = res.locals.authenticatedUser!.id;
        const record = repo.install(req.params.id, actor);

        // Fire the install hook (sandboxed stub) if the plugin declares before_charge
        const installHook: HookEvent = 'before_charge';
        const hookResult = record.manifest.hooks.includes(installHook)
          ? executeHook(record, installHook, { userId: actor })
          : null;

        logger.audit('PLUGIN_INSTALLED', actor, {
          pluginId: req.params.id,
          hookFired: hookResult?.ok ?? false,
          sandboxed: hookResult?.sandboxed ?? false,
        });

        res.status(200).json({ plugin: record, hook: hookResult });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /:id/install  — uninstall a plugin ────────────────────────────
  router.delete(
    '/:id/install',
    requireAuth,
    (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actor = res.locals.authenticatedUser!.id;
        const record = repo.uninstall(req.params.id, actor);

        logger.audit('PLUGIN_UNINSTALLED', actor, { pluginId: req.params.id });

        res.status(200).json(record);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /:id  — remove plugin from registry ───────────────────────────
  router.delete(
    '/:id',
    requireAuth,
    (req, res: Response<unknown, AuthenticatedLocals>, next) => {
      try {
        const actor = res.locals.authenticatedUser!.id;
        repo.delete(req.params.id);

        logger.audit('PLUGIN_DELETED', actor, { pluginId: req.params.id });

        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

export default createPluginsRouter();
