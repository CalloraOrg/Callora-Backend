import express from 'express';
import webhookRouter from './webhooks/webhook.routes.js';
import { calloraEvents } from './events/event.emitter.js';
import helmet from 'helmet';
import { db, initializeDb, schema } from './db/index.js';
import { eq, desc, and, type SQL } from 'drizzle-orm';
import { requireAuth, type AuthenticatedLocals } from './middleware/requireAuth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { BadRequestError, NotFoundError, UnauthorizedError, ForbiddenError } from './errors/index.js';
import * as developerRepository from './repositories/developerRepository.js';
import type { Response } from 'express';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';

const app = createApp();
const PORT = process.env.PORT ?? 3000;

export default app;

// @ts-ignore - ES module
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {

  const innerApp = express();

  function asyncHandler<T>(fn: (req: express.Request, res: Response<T, AuthenticatedLocals>, next: express.NextFunction) => Promise<void>) {
    return (req: express.Request, res: Response<T, AuthenticatedLocals>, next: express.NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  const isProduction = process.env.NODE_ENV === 'production';

  innerApp.use(express.json());

  innerApp.use(
    helmet({
      // Allow embedding in iframes (e.g. if the frontend wants to embed this API)
      frameguard: false,
      // Keep default X-Content-Type-Options: nosniff
      // HSTS: only enable when we know we're behind HTTPS and in production
      hsts: isProduction
        ? {
          maxAge: 15552000, // 180 days
          includeSubDomains: false,
          preload: false,
        }
        : false,
      // No CSP needed since this is a pure JSON API (no HTML responses)
      contentSecurityPolicy: false,
      // Keep other defaults (dnsPrefetchControl, hidePoweredBy, ieNoOpen, noSniff, xssFilter, etc.)
    }),
  );

  // Health check endpoint
  innerApp.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'callora-backend' });
  });

  // Get all APIs with optional filtering by status
  innerApp.get('/api/apis', async (req, res) => {
    try {
      const { status, developer_id } = req.query;

      let query = db.select()
        .from(schema.apis)
        .orderBy(desc(schema.apis.created_at));

      const filters: SQL[] = [];

      // Add filters if provided
      if (status) {
        type ApiStatus = 'draft' | 'active' | 'paused' | 'archived';
        filters.push(eq(schema.apis.status, status as ApiStatus));
      }
      if (developer_id) {
        filters.push(eq(schema.apis.developer_id, parseInt(developer_id as string)));
      }

      const apis = await (filters.length > 0 ? query.where(and(...filters)) : query);
      res.json({ apis });
    } catch (error) {
      console.error('Error fetching APIs:', error);
      res.status(500).json({ error: 'Failed to fetch APIs' });
    }
  });

  // Get specific API by ID with its endpoints
  innerApp.get('/api/apis/:id', async (req, res) => {
    try {
      const apiId = parseInt(req.params.id);

      const api = await db.select()
        .from(schema.apis)
        .where(eq(schema.apis.id, apiId))
        .limit(1);

      if (api.length === 0) {
        return res.status(404).json({ error: 'API not found' });
      }

      const endpoints = await db.select()
        .from(schema.apiEndpoints)
        .where(eq(schema.apiEndpoints.api_id, apiId))
        .orderBy(desc(schema.apiEndpoints.created_at));

      res.json({
        api: api[0],
        endpoints
      });
    } catch (error) {
      console.error('Error fetching API:', error);
      res.status(500).json({ error: 'Failed to fetch API' });
    }
  });

  // Create new API
  innerApp.post('/api/apis', async (req, res) => {
    try {
      const { developer_id, name, description, base_url, logo_url, category, status = 'draft' } = req.body;

      if (!developer_id || !name || !base_url) {
        return res.status(400).json({ error: 'developer_id, name, and base_url are required' });
      }

      const [newApi] = await db.insert(schema.apis)
        .values({
          developer_id,
          name,
          description,
          base_url,
          logo_url,
          category,
          status
        })
        .returning();

      res.status(201).json({ api: newApi });
    } catch (error) {
      console.error('Error creating API:', error);
      res.status(500).json({ error: 'Failed to create API' });
    }
  });

  // Get endpoints for a specific API
  innerApp.get('/api/apis/:id/endpoints', async (req, res) => {
    try {
      const apiId = parseInt(req.params.id);

      const endpoints = await db.select()
        .from(schema.apiEndpoints)
        .where(eq(schema.apiEndpoints.api_id, apiId))
        .orderBy(desc(schema.apiEndpoints.created_at));

      res.json({ endpoints });
    } catch (error) {
      console.error('Error fetching API endpoints:', error);
      res.status(500).json({ error: 'Failed to fetch API endpoints' });
    }
  });

  // Create new endpoint for an API
  innerApp.post('/api/apis/:id/endpoints', async (req, res) => {
    try {
      const apiId = parseInt(req.params.id);
      const { path, method = 'GET', price_per_call_usdc = '0.01', description } = req.body;

      if (!path) {
        return res.status(400).json({ error: 'path is required' });
      }

      // Verify API exists
      const api = await db.select()
        .from(schema.apis)
        .where(eq(schema.apis.id, apiId))
        .limit(1);

      if (api.length === 0) {
        return res.status(404).json({ error: 'API not found' });
      }

      const [newEndpoint] = await db.insert(schema.apiEndpoints)
        .values({
          api_id: apiId,
          path,
          method,
          price_per_call_usdc,
          description
        })
        .returning();

      res.status(201).json({ endpoint: newEndpoint });
    } catch (error) {
      console.error('Error creating API endpoint:', error);
      res.status(500).json({ error: 'Failed to create API endpoint' });
    }
  });

  // Usage statistics endpoint (placeholder for now)
  innerApp.get('/api/usage', (_req, res) => {
    res.json({ calls: 0, period: 'current' });
  });

  // Developer profile: get current user's profile
  innerApp.get('/api/developers/me', requireAuth, asyncHandler(async (req, res) => {
    const user = res.locals.authenticatedUser;
    if (!user) throw new UnauthorizedError();
    const developer = await developerRepository.findByUserId(user.id);
    if (!developer) throw new NotFoundError('Developer profile not found');
    res.json({ developer });
  }));

  // Developer profile: create or update (upsert)
  innerApp.post('/api/developers', requireAuth, asyncHandler(async (req, res) => {
    const user = res.locals.authenticatedUser;
    if (!user) throw new UnauthorizedError();
    const { name, website, description, category } = req.body ?? {};
    const developer = await developerRepository.upsert(user.id, {
      name: name ?? null,
      website: website ?? null,
      description: description ?? null,
      category: category ?? null,
    });
    res.status(201).json({ developer });
  }));

  // Update API owned by current developer (PATCH /api/developers/apis/:id)
  innerApp.patch('/api/developers/apis/:id', requireAuth, asyncHandler(async (req, res) => {
    const user = res.locals.authenticatedUser;
    if (!user) throw new UnauthorizedError();
    const developer = await developerRepository.findByUserId(user.id);
    if (!developer) throw new ForbiddenError('Developer profile required');
    const apiId = parseInt(req.params.id, 10);
    if (Number.isNaN(apiId)) throw new BadRequestError('Invalid API id');
    const [apiRow] = await db.select().from(schema.apis).where(eq(schema.apis.id, apiId)).limit(1);
    if (!apiRow) throw new NotFoundError('API not found');
    if (apiRow.developer_id !== developer.id) throw new ForbiddenError('API does not belong to your developer account');

    const { name, description, base_url, category, status, endpoints } = req.body ?? {};
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (base_url !== undefined) updates.base_url = base_url;
    if (category !== undefined) updates.category = category;
    if (status !== undefined) {
      if (!['draft', 'active', 'paused', 'archived'].includes(String(status))) throw new BadRequestError('Invalid status');
      updates.status = status;
    }

    const [updatedApi] = await db.update(schema.apis).set(updates as Record<string, unknown>).where(eq(schema.apis.id, apiId)).returning();
    if (!updatedApi) throw new Error('Update failed');

    if (Array.isArray(endpoints)) {
      await db.delete(schema.apiEndpoints).where(eq(schema.apiEndpoints.api_id, apiId));
      for (const ep of endpoints) {
        const path = ep?.path;
        if (path == null || typeof path !== 'string') continue;
        const method = (ep?.method ?? 'GET').toUpperCase();
        const price = ep?.price_per_call_usdc ?? '0.01';
        const descText = ep?.description ?? null;
        const methodVal = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'GET';
        await db.insert(schema.apiEndpoints).values({
          api_id: apiId,
          path,
          method: methodVal,
          price_per_call_usdc: String(price),
          description: descText,
        });
      }
    }

    const endpointsList = await db.select().from(schema.apiEndpoints).where(eq(schema.apiEndpoints.api_id, apiId)).orderBy(desc(schema.apiEndpoints.created_at));
    res.json({ api: updatedApi, endpoints: endpointsList });
  }));

  // Webhook registration and management routes
  innerApp.use('/api/webhooks', webhookRouter);

  if (process.env.NODE_ENV !== 'production') {
    innerApp.post('/api/test/trigger-event', (req, res) => {
      const { developerId, event, data } = req.body;

      if (!developerId || !event) {
        return res.status(400).json({ error: 'developerId and event are required.' });
      }

      calloraEvents.emit(event, developerId, data ?? {});
      return res.json({ triggered: event, developerId });
    });
  }

  // Global error handler (must be after all routes)
  innerApp.use(errorHandler);

  // Initialize database and start server
  async function startServer() {
    try {
      await initializeDb();
      innerApp.listen(PORT, () => {
        console.log(`Callora backend listening on http://localhost:${PORT}`);
      });
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }

  startServer();
}
