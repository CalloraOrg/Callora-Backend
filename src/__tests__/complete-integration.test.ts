import express from 'express';
import type { Server } from 'node:http';
import { InMemoryVaultRepository } from '../repositories/vaultRepository.js';
import { MockSorobanBilling } from '../services/billingService.js';
import { InMemoryRateLimiter } from '../services/rateLimiter.js';
import { InMemoryUsageStore } from '../services/usageStore.js';
import { createGatewayRouter } from '../routes/gatewayRoutes.js';
import { RevenueSettlementService } from '../services/revenueSettlementService.js';
import { InMemorySettlementStore } from '../services/settlementStore.js';
import { MockSorobanSettlementClient } from '../services/sorobanSettlement.js';
import type { ApiKey, ApiRegistryEntry, ApiRegistry } from '../types/gateway.js';

// ── Helpers ────────────────────────────────────────────────────────────────

class SimpleRegistry implements ApiRegistry {
  private entries = new Map<string, ApiRegistryEntry>();

  register(entry: ApiRegistryEntry): void {
    this.entries.set(entry.id, entry);
  }

  resolve(slugOrId: string): ApiRegistryEntry | undefined {
    return this.entries.get(slugOrId);
  }
}

function buildStack(overrides?: { initialCredits?: number; minPayoutUsdc?: number }) {
  const credits = overrides?.initialCredits ?? 100;
  const minPayout = overrides?.minPayoutUsdc ?? 1;

  const vaultRepo = new InMemoryVaultRepository();
  const billing = new MockSorobanBilling({ consumer_bob: credits });
  const rateLimiter = new InMemoryRateLimiter(60, 60_000);
  const usageStore = new InMemoryUsageStore();
  const settlementStore = new InMemorySettlementStore();
  const settlementClient = new MockSorobanSettlementClient(0);
  const apiRegistry = new SimpleRegistry();

  const apiKeys = new Map<string, ApiKey>([
    ['key_test', { key: 'key_test', developerId: 'consumer_bob', apiId: 'api_weather' }],
  ]);

  const settlement = new RevenueSettlementService(
    usageStore,
    settlementStore,
    apiRegistry,
    settlementClient,
    { minPayoutUsdc: minPayout },
  );

  return {
    vaultRepo,
    billing,
    rateLimiter,
    usageStore,
    settlementStore,
    settlementClient,
    apiRegistry,
    apiKeys,
    settlement,
  };
}

// ── Test fixtures ──────────────────────────────────────────────────────────

const DEVELOPER_ID = 'dev_alice';
const CONSUMER_ID = 'consumer_bob';
const API_ID = 'api_weather';
const API_KEY = 'key_test';
const NETWORK = 'testnet';
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4';

let upstreamServer: Server;
let upstreamUrl: string;
let gatewayServer: Server;
let gatewayUrl: string;

let stack: ReturnType<typeof buildStack>;

beforeAll(async () => {
  // Start mock upstream
  const upstream = express();
  upstream.get('/forecast', (_req, res) => {
    res.json({ location: 'Lagos', temp_c: 31 });
  });
  upstream.use((_req, res) => {
    res.json({ ok: true });
  });

  upstreamServer = await new Promise<Server>((resolve) => {
    const srv = upstream.listen(0, () => resolve(srv));
  });
  const addr = upstreamServer.address();
  upstreamUrl = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  if (gatewayServer) await new Promise<void>((r) => gatewayServer.close(() => r()));
  if (upstreamServer) await new Promise<void>((r) => upstreamServer.close(() => r()));
});

beforeEach(async () => {
  // Close previous gateway if running
  if (gatewayServer) {
    await new Promise<void>((r) => gatewayServer.close(() => r()));
  }

  stack = buildStack();

  stack.apiRegistry.register({
    id: API_ID,
    slug: 'weather',
    base_url: upstreamUrl,
    developerId: DEVELOPER_ID,
    endpoints: [{ endpointId: 'forecast', path: '/forecast', priceUsdc: 1 }],
  });

  const app = express();
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'callora-backend' });
  });

  app.post('/api/vault', async (req, res) => {
    const { userId, contractId, network } = req.body;
    if (!userId || !contractId || !network) {
      res.status(400).json({ error: 'userId, contractId, and network are required' });
      return;
    }
    try {
      const vault = await stack.vaultRepo.create(userId, contractId, network);
      res.status(201).json({
        id: vault.id,
        userId: vault.userId,
        contractId: vault.contractId,
        network: vault.network,
        balanceSnapshot: vault.balanceSnapshot.toString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(409).json({ error: message });
    }
  });

  app.get('/api/vault/balance', async (req, res) => {
    const userId = req.query.userId as string;
    const network = (req.query.network as string) ?? 'testnet';
    if (!userId) {
      res.status(400).json({ error: 'userId query parameter is required' });
      return;
    }
    const vault = await stack.vaultRepo.findByUserId(userId, network);
    if (!vault) {
      res.status(404).json({ error: `No vault for user "${userId}" on ${network}` });
      return;
    }
    res.json({
      id: vault.id,
      balanceSnapshot: vault.balanceSnapshot.toString(),
      network: vault.network,
      lastSyncedAt: vault.lastSyncedAt?.toISOString() ?? null,
    });
  });

  app.post('/api/vault/fund', async (req, res) => {
    const { userId, network, amountStroops } = req.body;
    if (!userId || amountStroops === undefined) {
      res.status(400).json({ error: 'userId and amountStroops are required' });
      return;
    }
    const vault = await stack.vaultRepo.findByUserId(userId, network ?? 'testnet');
    if (!vault) {
      res.status(404).json({ error: 'Vault not found' });
      return;
    }
    const newBalance = vault.balanceSnapshot + BigInt(amountStroops);
    const updated = await stack.vaultRepo.updateBalanceSnapshot(vault.id, newBalance, new Date());
    res.json({
      id: updated.id,
      balanceSnapshot: updated.balanceSnapshot.toString(),
      lastSyncedAt: updated.lastSyncedAt?.toISOString() ?? null,
    });
  });

  const gatewayRouter = createGatewayRouter({
    billing: stack.billing,
    rateLimiter: stack.rateLimiter,
    usageStore: stack.usageStore,
    upstreamUrl,
    apiKeys: stack.apiKeys,
  });
  app.use('/api/gateway', gatewayRouter);

  app.get('/api/usage/events', (_req, res) => {
    res.json({ count: stack.usageStore.getEvents().length, events: stack.usageStore.getEvents() });
  });

  app.post('/api/settlement/run', async (_req, res) => {
    const result = await stack.settlement.runBatch();
    res.json(result);
  });

  gatewayServer = await new Promise<Server>((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
  const gAddr = gatewayServer.address();
  gatewayUrl = `http://localhost:${typeof gAddr === 'object' && gAddr ? gAddr.port : 0}`;
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Complete Integration — Vault + Billing + Gateway + Settlement', () => {

  it('health check returns ok', async () => {
    const res = await fetch(`${gatewayUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('creates a vault, funds it, and queries the balance', async () => {
    // Create
    const createRes = await fetch(`${gatewayUrl}/api/vault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: DEVELOPER_ID, contractId: CONTRACT_ID, network: NETWORK }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.userId).toBe(DEVELOPER_ID);
    expect(created.balanceSnapshot).toBe('0');

    // Fund (50 USDC = 500_000_000 stroops)
    const fundRes = await fetch(`${gatewayUrl}/api/vault/fund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: DEVELOPER_ID, network: NETWORK, amountStroops: '500000000' }),
    });
    expect(fundRes.status).toBe(200);
    const funded = await fundRes.json();
    expect(funded.balanceSnapshot).toBe('500000000');

    // Query balance
    const balRes = await fetch(`${gatewayUrl}/api/vault/balance?userId=${DEVELOPER_ID}&network=${NETWORK}`);
    expect(balRes.status).toBe(200);
    const balance = await balRes.json();
    expect(balance.balanceSnapshot).toBe('500000000');
    expect(balance.lastSyncedAt).toBeTruthy();
  });

  it('rejects duplicate vault creation for same user and network', async () => {
    await fetch(`${gatewayUrl}/api/vault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: DEVELOPER_ID, contractId: CONTRACT_ID, network: NETWORK }),
    });

    const dupRes = await fetch(`${gatewayUrl}/api/vault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: DEVELOPER_ID, contractId: 'other-contract', network: NETWORK }),
    });
    expect(dupRes.status).toBe(409);
  });

  it('returns 404 for vault balance when vault does not exist', async () => {
    const res = await fetch(`${gatewayUrl}/api/vault/balance?userId=nonexistent&network=${NETWORK}`);
    expect(res.status).toBe(404);
  });

  it('proxies a request through the gateway, deducts credit, and records usage', async () => {
    const res = await fetch(`${gatewayUrl}/api/gateway/${API_ID}`, {
      method: 'GET',
      headers: { 'x-api-key': API_KEY },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Billing deducted (100 - 1 = 99)
    const balance = await stack.billing.checkBalance(CONSUMER_ID);
    expect(balance).toBe(99);

    // Usage event recorded
    const events = stack.usageStore.getEvents(API_KEY);
    expect(events.length).toBe(1);
    expect(events[0].apiId).toBe(API_ID);
    expect(events[0].statusCode).toBe(200);
  });

  it('returns 401 when API key is missing', async () => {
    const res = await fetch(`${gatewayUrl}/api/gateway/${API_ID}`, {
      method: 'GET',
    });
    expect(res.status).toBe(401);
    expect(stack.usageStore.getEvents().length).toBe(0);
  });

  it('returns 402 when consumer has insufficient balance', async () => {
    stack.billing.setBalance(CONSUMER_ID, 0);

    const res = await fetch(`${gatewayUrl}/api/gateway/${API_ID}`, {
      method: 'GET',
      headers: { 'x-api-key': API_KEY },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toMatch(/insufficient balance/i);
  });

  it('returns 429 when rate limited', async () => {
    stack.rateLimiter.exhaust(API_KEY);

    const res = await fetch(`${gatewayUrl}/api/gateway/${API_ID}`, {
      method: 'GET',
      headers: { 'x-api-key': API_KEY },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('settles revenue after enough usage accumulates', async () => {
    // Generate 5 usage events (5 credits total, above 1 USDC threshold)
    for (let i = 0; i < 5; i++) {
      await fetch(`${gatewayUrl}/api/gateway/${API_ID}`, {
        method: 'GET',
        headers: { 'x-api-key': API_KEY },
      });
    }

    expect(stack.usageStore.getEvents().length).toBe(5);

    // Run settlement
    const res = await fetch(`${gatewayUrl}/api/settlement/run`, { method: 'POST' });
    expect(res.status).toBe(200);

    const batch = await res.json();
    expect(batch.processed).toBe(5);
    expect(batch.settledAmount).toBe(5);
    expect(batch.errors).toBe(0);

    // All events should now be settled
    expect(stack.usageStore.getUnsettledEvents().length).toBe(0);
  });

  it('settlement skips when below minimum payout threshold', async () => {
    // Only 1 event (1 credit), but threshold is 1 — meets threshold
    // Use a higher threshold to test skipping
    stack = buildStack({ minPayoutUsdc: 100 });
    stack.apiRegistry.register({
      id: API_ID,
      slug: 'weather',
      base_url: upstreamUrl,
      developerId: DEVELOPER_ID,
      endpoints: [{ endpointId: 'forecast', path: '/forecast', priceUsdc: 1 }],
    });

    // Record one usage event directly
    stack.usageStore.record({
      id: 'evt_1',
      requestId: 'req_1',
      apiKey: API_KEY,
      apiKeyId: API_KEY,
      apiId: API_ID,
      endpointId: 'forecast',
      userId: CONSUMER_ID,
      amountUsdc: 1,
      statusCode: 200,
      timestamp: new Date().toISOString(),
    });

    const result = await stack.settlement.runBatch();
    expect(result.processed).toBe(0);
    expect(result.settledAmount).toBe(0);

    // Event remains unsettled
    expect(stack.usageStore.getUnsettledEvents().length).toBe(1);
  });

  it('end-to-end: vault → gateway → settlement lifecycle', async () => {
    // 1. Create and fund developer vault
    await fetch(`${gatewayUrl}/api/vault`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: DEVELOPER_ID, contractId: CONTRACT_ID, network: NETWORK }),
    });
    await fetch(`${gatewayUrl}/api/vault/fund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: DEVELOPER_ID, network: NETWORK, amountStroops: '500000000' }),
    });

    // 2. Consumer proxies 3 requests through gateway
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${gatewayUrl}/api/gateway/${API_ID}`, {
        method: 'GET',
        headers: { 'x-api-key': API_KEY },
      });
      expect(res.status).toBe(200);
    }

    // 3. Verify usage recorded
    const usageRes = await fetch(`${gatewayUrl}/api/usage/events`);
    const usage = await usageRes.json();
    expect(usage.count).toBe(3);

    // 4. Verify consumer was charged
    const consumerBalance = await stack.billing.checkBalance(CONSUMER_ID);
    expect(consumerBalance).toBe(97); // 100 - 3

    // 5. Settle revenue
    const settlementRes = await fetch(`${gatewayUrl}/api/settlement/run`, { method: 'POST' });
    const batch = await settlementRes.json();
    expect(batch.processed).toBe(3);
    expect(batch.errors).toBe(0);

    // 6. Developer vault balance unchanged (in-memory vault is independent of billing)
    const balRes = await fetch(`${gatewayUrl}/api/vault/balance?userId=${DEVELOPER_ID}&network=${NETWORK}`);
    const bal = await balRes.json();
    expect(bal.balanceSnapshot).toBe('500000000');
  });
});
