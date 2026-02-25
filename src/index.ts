import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';

const app = createApp();
const PORT = process.env.PORT ?? 3000;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
import express from 'express';
import helmet from 'helmet';
import { db, initializeDb, schema } from './db/index.js';
import { eq, desc } from 'drizzle-orm';

const app = express();
const PORT = process.env.PORT ?? 3000;

const isProduction = process.env.NODE_ENV === 'production';

app.use(express.json());

app.use(
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
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'callora-backend' });
});

// Get all APIs with optional filtering by status
app.get('/api/apis', async (req, res) => {
  try {
    const { status, developer_id } = req.query;
    
    let query = db.select()
      .from(schema.apis)
      .orderBy(desc(schema.apis.created_at));

    // Add filters if provided
    if (status) {
      query = query.where(eq(schema.apis.status, status as string));
    }
    if (developer_id) {
      query = query.where(eq(schema.apis.developer_id, parseInt(developer_id as string)));
    }

    const apis = await query;
    res.json({ apis });
  } catch (error) {
    console.error('Error fetching APIs:', error);
    res.status(500).json({ error: 'Failed to fetch APIs' });
  }
});

// Get specific API by ID with its endpoints
app.get('/api/apis/:id', async (req, res) => {
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
app.post('/api/apis', async (req, res) => {
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
app.get('/api/apis/:id/endpoints', async (req, res) => {
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
app.post('/api/apis/:id/endpoints', async (req, res) => {
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
app.get('/api/usage', (_req, res) => {
  res.json({ calls: 0, period: 'current' });
});

// Initialize database and start server
async function startServer() {
  try {
    await initializeDb();
    app.listen(PORT, () => {
      console.log(`Callora backend listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Callora backend listening on http://localhost:${PORT}`);
  });
}

export default app;
