import express from "express";
import request from "supertest";
import { jest } from "@jest/globals";
import { requestIdMiddleware } from "../middleware/requestId";
import { errorHandler } from "../middleware/errorHandler";
import { registerVaultRoutes } from "./vaultRoutes";
import { InMemoryVaultRepository } from "../repositories/vaultRepository";
import { signTestToken, signExpiredToken, TEST_JWT_SECRET } from "../../tests/helpers/jwt";

process.env.JWT_SECRET = TEST_JWT_SECRET;

const TEST_CONTRACT_ID = "CTESTVAULT000000000000000000000000000000000000000000000000";
const MAINNET_CONTRACT_ID = "CMAINVAULT0000000000000000000000000000000000000000000000000";
const USER_ID = "user-vault-1";

function buildApp(repository: InMemoryVaultRepository, reader: { readVault: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  registerVaultRoutes(app, repository, reader as any);
  app.use(errorHandler);
  return app;
}

function makeReader() {
  return { readVault: jest.fn() as jest.Mock };
}

function seedVault(
  repository: InMemoryVaultRepository,
  overrides: Record<string, unknown> = {},
  network: "testnet" | "mainnet" = "testnet",
) {
  const contractId = network === "mainnet" ? MAINNET_CONTRACT_ID : TEST_CONTRACT_ID;
  const vault: any = repository.create(USER_ID, contractId, network);
  Object.assign(vault, overrides);
  return vault;
}

const auth = () => `Bearer ${signTestToken({ sub: USER_ID })}`;

describe("vault routes authentication", () => {
  const reader = makeReader();
  const repository = new InMemoryVaultRepository();
  const app = buildApp(repository, reader);

  it.each([
    ["get", "/api/vault/balance"],
    ["get", "/api/vault/onchain"],
    ["post", "/api/vault/deposit/prepare"],
  ])("%s %s returns 401 without a token", async (method, path) => {
    const res = await (request(app) as any)[method](path);
    expect(res.status).toBe(401);
  });

  it.each([
    ["get", "/api/vault/balance"],
    ["get", "/api/vault/onchain"],
    ["post", "/api/vault/deposit/prepare"],
  ])("%s %s returns 401 with an expired token", async (method, path) => {
    const res = await (request(app) as any)
      [method](path)
      .set("Authorization", `Bearer ${signExpiredToken({ sub: USER_ID })}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/vault/balance", () => {
  it("returns 400 for an invalid network query", async () => {
    const reader = makeReader();
    const app = buildApp(new InMemoryVaultRepository(), reader);
    const res = await request(app)
      .get("/api/vault/balance?network=foo")
      .set("Authorization", auth());
    expect(res.status).toBe(400);
    expect(reader.readVault).not.toHaveBeenCalled();
  });

  it("returns 404 VAULT_NOT_FOUND when the user has no vault", async () => {
    const reader = makeReader();
    const app = buildApp(new InMemoryVaultRepository(), reader);
    const res = await request(app)
      .get("/api/vault/balance")
      .set("Authorization", auth());
    expect(res.status).toBe(404);
    expect(res.body.code ?? res.body.error?.code).toBe("VAULT_NOT_FOUND");
  });

  it("returns a fresh snapshot without calling the reader", async () => {
    const reader = makeReader();
    const repository = new InMemoryVaultRepository();
    seedVault(repository, {
      balance_usdc: "125.5",
      lastSyncedAt: new Date(),
    });
    const app = buildApp(repository, reader);
    const res = await request(app)
      .get("/api/vault/balance")
      .set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(res.body.balance_usdc).toBe("125.5");
    expect(res.body.stale).toBe(false);
    expect(reader.readVault).not.toHaveBeenCalled();
  });

  it("refreshes a stale snapshot from the reader", async () => {
    const reader = makeReader();
    reader.readVault.mockResolvedValue({ balance_usdc: "300.0" });
    const repository = new InMemoryVaultRepository();
    seedVault(repository, {
      balance_usdc: "1.0",
      lastSyncedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const app = buildApp(repository, reader);
    const res = await request(app)
      .get("/api/vault/balance")
      .set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(reader.readVault).toHaveBeenCalledWith(TEST_CONTRACT_ID, "testnet");
    expect(res.body.balance_usdc).toBe("300.0");
    expect(res.body.stale).toBe(false);
  });

  it("returns the old snapshot with stale: true when the reader fails", async () => {
    const reader = makeReader();
    reader.readVault.mockRejectedValue(new Error("rpc down"));
    const repository = new InMemoryVaultRepository();
    seedVault(repository, {
      balance_usdc: "42.0",
      lastSyncedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const app = buildApp(repository, reader);
    const res = await request(app)
      .get("/api/vault/balance")
      .set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(reader.readVault).toHaveBeenCalledTimes(1);
    expect(res.body.balance_usdc).toBe("42.0");
    expect(res.body.stale).toBe(true);
  });

  it("treats lastSyncedAt null as stale and refreshes", async () => {
    const reader = makeReader();
    reader.readVault.mockResolvedValue({ balance_usdc: "7.0" });
    const repository = new InMemoryVaultRepository();
    seedVault(repository, { balance_usdc: "0", lastSyncedAt: null });
    const app = buildApp(repository, reader);
    const res = await request(app)
      .get("/api/vault/balance")
      .set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(reader.readVault).toHaveBeenCalledTimes(1);
    expect(res.body.balance_usdc).toBe("7.0");
  });

  it("selects the mainnet vault when network=mainnet", async () => {
    const reader = makeReader();
    reader.readVault.mockResolvedValue({ balance_usdc: "9.0" });
    const repository = new InMemoryVaultRepository();
    seedVault(repository, { lastSyncedAt: new Date() }, "mainnet");
    const app = buildApp(repository, reader);
    const res = await request(app)
      .get("/api/vault/balance?network=mainnet")
      .set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(res.body.network).toBe("mainnet");
    expect(res.body.contractId).toBe(MAINNET_CONTRACT_ID);
  });

  it("defaults to testnet when network is omitted", async () => {
    const reader = makeReader();
    const repository = new InMemoryVaultRepository();
    seedVault(repository, { lastSyncedAt: new Date() }, "testnet");
    const app = buildApp(repository, reader);
    const res = await request(app)
      .get("/api/vault/balance")
      .set("Authorization", auth());
    expect(res.status).toBe(200);
    expect(res.body.network).toBe("testnet");
  });

  it("returns 400 for a non-string network value", async () => {
    const reader = makeReader();
    const app = buildApp(new InMemoryVaultRepository(), reader);
    const res = await request(app)
      .get("/api/vault/balance?network[]=testnet")
      .set("Authorization", auth());
    expect(res.status).toBe(400);
  });
});

describe("POST /api/vault/deposit/prepare", () => {
  it("returns 400 MISSING_AMOUNT when amount_usdc is absent", async () => {
    const reader = makeReader();
    const repository = new InMemoryVaultRepository();
    seedVault(repository);
    const app = buildApp(repository, reader);
    const res = await request(app)
      .post("/api/vault/deposit/prepare")
      .set("Authorization", auth())
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code ?? res.body.error?.code).toBe("MISSING_AMOUNT");
  });

  it("returns vault-not-found behaviour when the user has no vault", async () => {
    const reader = makeReader();
    const app = buildApp(new InMemoryVaultRepository(), reader);
    const res = await request(app)
      .post("/api/vault/deposit/prepare")
      .set("Authorization", auth())
      .send({ amount_usdc: "10" });
    expect(res.status).toBe(404);
    expect(res.body.code ?? res.body.error?.code).toBe("VAULT_NOT_FOUND");
  });
});
