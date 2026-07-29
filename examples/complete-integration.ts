/**
 * Complete Integration Example — Billing + Vault + Gateway
 *
 * A linear, copy-paste-friendly walkthrough that exercises every backend
 * subsystem supported today.  All services use in-memory stores, so you
 * don't need a database, Stellar node, or any other external dependency.
 *
 * Steps demonstrated:
 *   1. Health check
 *   2. Create a vault for a developer on testnet
 *   3. Fund the vault (simulates an on-chain deposit)
 *   4. Proxy a request through the API gateway
 *   5. Inspect the recorded usage events
 *   6. Run a revenue-settlement batch
 *   7. Review final balances
 *
 * Run:
 *   npx tsx examples/complete-integration.ts
 *
 * Soroban contracts docs: https://github.com/CalloraOrg/callora-contracts
 * Backend README:         https://github.com/CalloraOrg/Callora-Backend#readme
 */

import express from 'express';
import type { Server } from 'node:http';
import { InMemoryVaultRepository } from '../src/repositories/vaultRepository.js';
import { MockSorobanBilling } from '../src/services/billingService.js';
import { InMemoryRateLimiter } from '../src/services/rateLimiter.js';
import { InMemoryUsageStore } from '../src/services/usageStore.js';
import { createGatewayRouter } from '../src/routes/gatewayRoutes.js';
import { RevenueSettlementService } from '../src/services/revenueSettlementService.js';
import { InMemorySettlementStore } from '../src/services/settlementStore.js';
import { MockSorobanSettlementClient } from '../src/services/sorobanSettlement.js';
import type { ApiKey, ApiRegistryEntry, ApiRegistry } from '../src/types/gateway.js';

// ============================================================================
// CONSTANTS — tweak these to experiment
// ============================================================================

const PORT    = parseInt(process.env.PORT || '3000', 10);
const NETWORK = 'testnet';

const DEVELOPER_ID = 'dev_alice';
const CONSUMER_ID  = 'consumer_bob';
const API_KEY      = 'key_live_abc123';
const API_ID       = 'api_weather';

// Mock Soroban vault contract address.
// For real contract IDs see: https://github.com/CalloraOrg/callora-contracts
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMDR4';

// Consumer starts with 100 credits in the billing ledger
const INITIAL_CREDITS = 100;

// ============================================================================
// IN-MEMORY SERVICES
// ============================================================================

const vaultRepo        = new InMemoryVaultRepository();
const billing          = new MockSorobanBilling({ [CONSUMER_ID]: INITIAL_CREDITS });
const rateLimiter      = new InMemoryRateLimiter(60, 60_000);
const usageStore       = new InMemoryUsageStore();
const settlementStore  = new InMemorySettlementStore();
const settlementClient = new MockSorobanSettlementClient(/* failureRate */ 0);

/**
 * Lightweight registry that maps API IDs to their upstream URL and
 * developer ownership.  The settlement service uses this to route
 * accumulated usage fees back to the correct developer.
 */
class SimpleRegistry implements ApiRegistry {
  private entries = new Map<string, ApiRegistryEntry>();

  register(entry: ApiRegistryEntry): void {
    this.entries.set(entry.id, entry);
  }

  resolve(slugOrId: string): ApiRegistryEntry | undefined {
    return this.entries.get(slugOrId);
  }
}

const apiRegistry = new SimpleRegistry();

const apiKeys = new Map<string, ApiKey>([
  [API_KEY, { key: API_KEY, developerId: CONSUMER_ID, apiId: API_ID }],
]);

const settlementService = new RevenueSettlementService(
  usageStore,
  settlementStore,
  apiRegistry,
  settlementClient,
  { minPayoutUsdc: 1 }, // low threshold so the demo triggers a payout
);

// ============================================================================
// MOCK UPSTREAM — stands in for the real API the developer published
// ============================================================================

function createUpstreamApp(): express.Express {
  const upstream = express();

  upstream.get('/forecast', (_req, res) => {
    res.json({
      location: 'Lagos',
      temp_c: 31,
      condition: 'Partly cloudy',
      fetched_at: new Date().toISOString(),
    });
  });

  upstream.use((_req, res) => {
    res.json({ ok: true });
  });

  return upstream;
}

// ============================================================================
// MAIN APP — wires health, vault, gateway, usage, and settlement endpoints
// ============================================================================

function createMainApp(upstreamUrl: string): express.Express {
  // Register the weather API now that we know the upstream URL
  apiRegistry.register({
    id: API_ID,
    slug: 'weather',
    base_url: upstreamUrl,
    developerId: DEVELOPER_ID,
    endpoints: [{ endpointId: 'forecast', path: '/forecast', priceUsdc: 1 }],
  });

  const app = express();
  app.use(express.json());

  // -- Health ---------------------------------------------------------------

  /**
   * GET /api/health
   *
   * Minimal liveness probe.  The production app layers on database and
   * Soroban-RPC checks via the HealthCheckConfig — see src/config/health.ts.
   */
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'callora-backend',
      timestamp: new Date().toISOString(),
    });
  });

  // -- Vault: create --------------------------------------------------------

  /**
   * POST /api/vault
   * Body: { userId, contractId, network }
   *
   * Creates a vault (one per user per network).  In production this is
   * backed by a Soroban contract; here we use InMemoryVaultRepository.
   */
  app.post('/api/vault', async (req, res) => {
    const { userId, contractId, network } = req.body;

    if (!userId || !contractId || !network) {
      res.status(400).json({ error: 'userId, contractId, and network are required' });
      return;
    }

    try {
      const vault = await vaultRepo.create(userId, contractId, network);
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

  // -- Vault: query balance -------------------------------------------------

  /**
   * GET /api/vault/balance?userId=...&network=testnet
   *
   * Returns the cached on-chain balance for a user's vault.
   */
  app.get('/api/vault/balance', async (req, res) => {
    const userId  = req.query.userId as string;
    const network = (req.query.network as string) ?? NETWORK;

    if (!userId) {
      res.status(400).json({ error: 'userId query parameter is required' });
      return;
    }

    const vault = await vaultRepo.findByUserId(userId, network);
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

  // -- Vault: fund (simulate on-chain deposit) ------------------------------

  /**
   * POST /api/vault/fund
   * Body: { userId, network?, amountStroops }
   *
   * In production the balance is synced by a Horizon listener after a real
   * Soroban deposit.  Here we update the snapshot directly.
   * Soroban contract docs: https://github.com/CalloraOrg/callora-contracts
   */
  app.post('/api/vault/fund', async (req, res) => {
    const { userId, network, amountStroops } = req.body;

    if (!userId || amountStroops === undefined) {
      res.status(400).json({ error: 'userId and amountStroops are required' });
      return;
    }

    const vault = await vaultRepo.findByUserId(userId, network ?? NETWORK);
    if (!vault) {
      res.status(404).json({ error: 'Vault not found — create one first' });
      return;
    }

    const newBalance = vault.balanceSnapshot + BigInt(amountStroops);
    const updated = await vaultRepo.updateBalanceSnapshot(
      vault.id,
      newBalance,
      new Date(),
    );

    res.json({
      id: updated.id,
      balanceSnapshot: updated.balanceSnapshot.toString(),
      lastSyncedAt: updated.lastSyncedAt?.toISOString() ?? null,
    });
  });

  // -- Gateway: proxy requests to upstream ----------------------------------

  /**
   * ALL /api/gateway/:apiId
   *
   * Full proxy flow:
   *   1. Validate API key (x-api-key header)
   *   2. Rate-limit check
   *   3. Deduct billing credit via MockSorobanBilling
   *   4. Forward request to upstream
   *   5. Record usage event
   *   6. Return upstream response
   */
  const gatewayRouter = createGatewayRouter({
    billing,
    rateLimiter,
    usageStore,
    upstreamUrl,
    apiKeys,
  });
  app.use('/api/gateway', gatewayRouter);

  // -- Usage: list recorded events ------------------------------------------

  app.get('/api/usage/events', (_req, res) => {
    const events = usageStore.getEvents();
    res.json({ count: events.length, events });
  });

  // -- Settlement: trigger batch --------------------------------------------

  /**
   * POST /api/settlement/run
   *
   * Runs the revenue settlement batch.  Groups unsettled usage events by
   * developer and, when they cross the minimum payout threshold, calls
   * the Soroban settlement contract to distribute funds.
   */
  app.post('/api/settlement/run', async (_req, res) => {
    const result = await settlementService.runBatch();
    res.json(result);
  });

  // -- 404 fallback ---------------------------------------------------------

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

// ============================================================================
// DEMO WALKTHROUGH — exercises every step linearly
// ============================================================================

async function runDemo(baseUrl: string): Promise<void> {
  const divider = () => console.log('\n' + '='.repeat(64));

  // Step 1 — Health check
  divider();
  console.log('STEP 1 · Health check');
  const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
  console.log(health);

  // Step 2 — Create vault for developer
  divider();
  console.log('STEP 2 · Create vault for developer on testnet');
  const vault = await fetch(`${baseUrl}/api/vault`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: DEVELOPER_ID,
      contractId: CONTRACT_ID,
      network: NETWORK,
    }),
  }).then((r) => r.json());
  console.log(vault);

  // Step 3 — Fund vault (50 USDC = 500 000 000 stroops)
  divider();
  console.log('STEP 3 · Fund vault (simulate 50 USDC on-chain deposit)');
  const funded = await fetch(`${baseUrl}/api/vault/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId: DEVELOPER_ID,
      network: NETWORK,
      amountStroops: '500000000',
    }),
  }).then((r) => r.json());
  console.log(funded);

  // Step 4 — Proxy a consumer request through the gateway
  divider();
  console.log('STEP 4 · Proxy request through gateway (consumer calls weather API)');
  const proxyRes = await fetch(`${baseUrl}/api/gateway/${API_ID}`, {
    method: 'GET',
    headers: { 'x-api-key': API_KEY },
  });
  const proxyBody = await proxyRes.json();
  console.log(`  HTTP ${proxyRes.status}`);
  console.log(proxyBody);

  // Step 5 — Inspect usage events and send more calls
  divider();
  console.log('STEP 5 · Inspect usage events');
  let usage = await fetch(`${baseUrl}/api/usage/events`).then((r) => r.json());
  console.log(`  ${usage.count} event(s) recorded so far`);

  // Send four more calls so the settlement threshold (1 USDC) is easily met
  for (let i = 0; i < 4; i++) {
    await fetch(`${baseUrl}/api/gateway/${API_ID}`, {
      method: 'GET',
      headers: { 'x-api-key': API_KEY },
    });
  }
  usage = await fetch(`${baseUrl}/api/usage/events`).then((r) => r.json());
  console.log(`  ${usage.count} event(s) after 4 additional calls`);

  // Step 6 — Revenue settlement
  divider();
  console.log('STEP 6 · Revenue settlement (pay developer from usage fees)');
  const batch = await fetch(`${baseUrl}/api/settlement/run`, {
    method: 'POST',
  }).then((r) => r.json());
  console.log(batch);

  // Step 7 — Final balances
  divider();
  console.log('STEP 7 · Final balances');

  const devBalance = await fetch(
    `${baseUrl}/api/vault/balance?userId=${DEVELOPER_ID}&network=${NETWORK}`,
  ).then((r) => r.json());
  console.log(`  Developer vault : ${devBalance.balanceSnapshot} stroops`);

  const consumerCredits = await billing.checkBalance(CONSUMER_ID);
  console.log(`  Consumer credits: ${consumerCredits} (started with ${INITIAL_CREDITS})`);

  divider();
  console.log('All steps complete — every subsystem exercised.');
}

// ============================================================================
// ENTRY POINT
// ============================================================================

let upstreamServer: Server;
let mainServer: Server;

async function start(): Promise<void> {
  const upstreamApp = createUpstreamApp();
  upstreamServer = await new Promise<Server>((resolve) => {
    const srv = upstreamApp.listen(0, () => resolve(srv));
  });
  const addr = upstreamServer.address();
  const upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
  const upstreamUrl = `http://localhost:${upstreamPort}`;

  const mainApp = createMainApp(upstreamUrl);
  mainServer = await new Promise<Server>((resolve) => {
    const srv = mainApp.listen(PORT, () => resolve(srv));
  });

  console.log(`Mock upstream on ${upstreamUrl}`);
  console.log(`Callora gateway on http://localhost:${PORT}\n`);

  await runDemo(`http://localhost:${PORT}`);
  await shutdown();
}

async function shutdown(): Promise<void> {
  console.log('\nShutting down...');
  if (mainServer) {
    await new Promise<void>((resolve) => mainServer.close(() => resolve()));
  }
  if (upstreamServer) {
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
  console.log('Done.');
}

process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));
process.on('SIGINT', () => shutdown().then(() => process.exit(0)));

start().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

export { createMainApp, createUpstreamApp };
