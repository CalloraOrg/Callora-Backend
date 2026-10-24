#!/usr/bin/env node
import http from "node:http";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

// Minimal environment configuration required to boot the app in demo mode
process.env.DEMO_MODE = "true";
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "smoke-test-jwt-secret-min-32-chars-long";
process.env.ADMIN_API_KEY = process.env.ADMIN_API_KEY || "smoke-test-admin-key";
process.env.METRICS_API_KEY = process.env.METRICS_API_KEY || "smoke-test-metrics-key";
process.env.SQLITE_PATH = ":memory:";
process.env.CORS_ALLOW_MISSING_ORIGIN = "true";

console.log("[smoke] Importing deploy/api/index.mjs...");
const bundle = await import("../deploy/api/index.mjs");
const handler = bundle.default;
assert.equal(typeof handler, "function", "Bundle must export a default handler function");

const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error("[smoke] Handler unhandled error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const baseUrl = `http://127.0.0.1:${port}`;
console.log(`[smoke] Ephemeral server running on ${baseUrl}`);

try {
  // 1. Health check (Scenario 7)
  console.log("[smoke] Testing GET /api/health...");
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200, `Expected 200 from /api/health, got ${healthRes.status}`);
  console.log("[smoke] ✅ GET /api/health returned 200");

  // 2. Apis catalog (Scenario 8)
  console.log("[smoke] Testing GET /api/apis...");
  const apisRes = await fetch(`${baseUrl}/api/apis`);
  assert.equal(apisRes.status, 200, `Expected 200 from /api/apis, got ${apisRes.status}`);
  const apisData = await apisRes.json();
  const apisList = apisData.data?.data ?? apisData.data ?? apisData;
  assert(Array.isArray(apisList), "Expected apis response to contain a list of APIs");
  assert.equal(apisList.length, 3, `Expected 3 seeded APIs, got ${apisList.length}`);
  console.log(
    `[smoke] ✅ GET /api/apis returned 3 seeded APIs: ${apisList.map((a) => a.name).join(", ")}`,
  );

  // 3. Prisma-backed route in bundle (Scenario 9)
  console.log("[smoke] Testing Prisma-backed route GET /api/invoices in demo mode...");
  const devToken = jwt.sign(
    { userId: "demo-dev", role: "developer" },
    process.env.JWT_SECRET,
  );
  const prismaRes = await fetch(`${baseUrl}/api/invoices`, {
    headers: { Authorization: `Bearer ${devToken}` },
  });
  assert.equal(
    prismaRes.status,
    503,
    `Expected 503 from /api/invoices in demo mode, got ${prismaRes.status}`,
  );
  const prismaJson = await prismaRes.json();
  assert.equal(
    prismaJson.success,
    false,
    "Expected failure envelope from Prisma route in demo mode",
  );
  assert.equal(
    prismaJson.error?.code,
    "DEMO_MODE_UNSUPPORTED",
    `Expected DEMO_MODE_UNSUPPORTED error code, got ${prismaJson.error?.code}`,
  );
  console.log("[smoke] ✅ GET /api/invoices returned demo 503 envelope (not module resolution crash)");

  console.log("[smoke] All Vercel bundle smoke checks passed!");
} finally {
  server.close();
}
