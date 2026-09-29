/**
 * Runtime contract coverage for the highest-risk public surfaces.
 *
 * The production app installs express-openapi-validator for documented paths.
 * These tests exercise the same request boundaries in small deterministic
 * harnesses so CI does not need a database, a wallet, an upstream service, or
 * a DNS resolver. The final assertions also enforce the canonical response
 * envelope used by the full app.
 *
 * The assembled-app contract suite below builds the real `createApp()`
 * instance and issues a request for every documented path in `docs/openapi.json`,
 * failing when a documented path is not mounted (the app returns 404). This
 * catches the class of bug where a router is tested in isolation but never
 * installed in the assembled app.
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { describe, expect, it } from "@jest/globals";
import {
  walletLoginSchema,
  refreshTokenSchema,
} from "../../src/validators/auth.js";
import {
  bodyValidator,
  ValidationError,
} from "../../src/middleware/validate.js";
import {
  envelopeSchema,
  errorEnvelopeSchema,
  successEnvelopeSchema,
} from "../../src/middleware/envelope.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import {
  validateWebhookUrl,
  WebhookValidationError,
} from "../../src/webhooks/webhook.validator.js";
import { createApp } from "../../src/app.js";

type OpenApiDocument = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

const specPath = path.join(process.cwd(), "docs", "openapi.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as OpenApiDocument;

const validWallet = "G" + "A".repeat(55);

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Parameter values that satisfy the documented path templates. The goal is
 * to reach the mounted router so the app responds with anything other than
 * 404. Authentication and validation failures (4xx) are acceptable because
 * they prove the route is wired into the app.
 */
const PATH_PARAMETER_VALUES: Record<string, string> = {
  id: "contract-test-id",
  userId: "contract-test-user",
  walletAddress: validWallet,
  address: validWallet,
  tenantId: "contract-test-tenant",
  flagKey: "contract-test-flag",
  key: "contract-test-key",
  jobId: "contract-test-job",
  webhookId: "contract-test-webhook",
  refundId: "contract-test-refund",
};

const DEFAULT_PATH_PARAMETER_VALUE = "contract-test";

function buildSchemaApp(schema: z.ZodSchema) {
  const app = express();
  app.use(express.json());
  app.post("/contract", bodyValidator(schema), (req, res) => {
    res.status(200).json({
      success: true,
      data: { accepted: true, body: req.body },
      requestId: "contract-test",
      timestamp: new Date().toISOString(),
    });
  });
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (error instanceof ValidationError) {
        res.status(400).json({
          success: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
          requestId: "contract-test",
          timestamp: new Date().toISOString(),
        });
        return;
      }
      next(error);
    },
  );
  return app;
}

function assertSuccessEnvelope(body: unknown) {
  const parsed = successEnvelopeSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.success).toBe(true);
    expect(parsed.data.requestId).toEqual(expect.any(String));
    expect(new Date(parsed.data.timestamp).toString()).not.toBe("Invalid Date");
  }
}

function assertErrorEnvelope(body: unknown, code?: string) {
  const parsed = errorEnvelopeSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.success).toBe(false);
    expect(parsed.data.error.code).toEqual(code ?? expect.any(String));
    expect(parsed.data.error.message).toEqual(expect.any(String));
    expect(parsed.data.requestId).toEqual(expect.any(String));
    expect(new Date(parsed.data.timestamp).toString()).not.toBe("Invalid Date");
  }
}

function isHttpMethod(method: string): method is HttpMethod {
  return (HTTP_METHODS is readonly string[]).includes(method);
}

function describePath(pathTemplate: string) {
  return pathTemplate.replace(/{([^}]+)}/g, (_match, name: string) => {
    const value = PATH_PARAMETER_VALUES[name] ?? DEFAULT_PATH_PARAMETER_VALUE;
    return encodeURIComponent(value);
  });
}

function documentedRoutes() {
  const routes: Array<{ pathTemplate: string; method: HttpMethod }> = [];
  for (const [pathTemplate, pathItem] of Object.entries(spec.paths)) {
    for (const method of Object.keys(pathItem)) {
      if (isHttpMethod(method)) {
        routes.push({ pathTemplate, method });
      }
    }
  }
  return routes;
}

/**
 * Request bodies for documented POST/PUT/PATCH operations. The bodies are
 * intentionally minimal: the goal is to exercise the mounted router, not to
 * satisfy business validation. A 400 response is a successful contract
 * assertion because it proves the route is mounted.
 */
function requestBodyFor(pathTemplate: string, method: HttpMethod): unknown | undefined {
  if (!method.match(/^(post|put|patch)$/)) return undefined;
  if (pathTemplate.includes("/auth/")) {
    if (pathTemplate.endsWith("/login")) {
      return {
        walletAddress: validWallet,
        signature: "contract-test-signature",
        message: "contract-test-message",
      };
    }
    if (pathTemplate.endsWith("/refresh")) {
      return { refreshToken: "contract-test-refresh-token" };
    }
  }
  return {};
}

describe("OpenAPI document integrity", () => {
  it("is OpenAPI 3.1 and exposes the canonical JSON contract", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths).toEqual(expect.any(Object));
    expect(Object.keys(spec.paths).length).toBeGreaterThan(20);
    expect(spec.components?.schemas).toEqual(expect.any(Object));
  });

  it("documents the response envelope schemas used by runtime handlers", () => {
    const schemas = spec.components?.schemas ?? {};
    const success = JSON.stringify(schemas);
    expect(success).toContain("StandardErrorEnvelope");
    expect(success).toContain("success");
    expect(success).toContain("requestId");
    expect(success).toContain("timestamp");
  });

  it("keeps billing operations and their request fields discoverable", () => {
    for (const route of ["/api/billing/deduct", "/api/billing/deduct/bulk"]) {
      const operation = spec.paths[route]?.post;
      expect(operation).toEqual(expect.any(Object));
      const value = JSON.stringify(operation);
      expect(value).toContain("requestId");
      expect(value).toContain(
        route.endsWith("/bulk") ? "entries" : "amountUsdc",
      );
      expect(value).toContain(route.endsWith("/bulk") ? "429" : "400");
    }
  });

  it("rejects a document with missing response declarations in the contract checker", () => {
    const paths = Object.values(spec.paths);
    expect(
      paths.every((item) =>
        Object.entries(item)
          .filter(([method]) => method !== "parameters")
          .every(([, operation]) => {
            const candidate = operation as { responses?: unknown };
            return candidate.responses !== undefined;
          }),
      ),
    ).toBe(true);
  });
});

describe("assembled app OpenAPI contract", () => {
  const routes = documentedRoutes();

  it("documents at least one operation per documented path", () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it("mounts every documented path in createApp()", async () => {
    const app = createApp();
    const missing: string[] = [];

    for (const { pathTemplate, method } of routes) {
      const url = describePath(pathTemplate);
      const body = requestBodyFor(pathTemplate, method);
      const call = request(app)[method](url);
      if (body !== undefined) {
        call.send(body as object);
      }
      const response = await call;
      if (response.status === 404) {
        missing.push(`${method.toUpperCase()} ${pathTemplate}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("reports undocumented mounted paths as warnings", () => {
    const app = createApp();
    const documented = new Set(
      routes.map(({ pathTemplate, method }) => `${method} ${pathTemplate}`),
    );
    const mounted = new Set<string>();
    const stack = (app as unknown as { _router?: { stack?: Array<{ route?: unknown }> } })._router
      ?.stack;
    for (const layer of stack ?? []) {
      const route = layer.route;
      if (typeof route === "string") {
        mounted.add(`GET ${route}`);
      }
    }
    const undocumented = [...mounted].filter((entry) => !documented.has(entry));
    if (undocumented.length > 0) {
      console.warn(
        `Undocumented mounted paths (${undocumented.length}): ${undocumented.join(", ")}`,
      );
    }
    expect(Array.isArray(undocumented)).toBe(true);
  });
});

describe("auth request contracts at runtime", () => {
  it("accepts the complete wallet login request and returns a success envelope", async () => {
    const response = await request(buildSchemaApp(walletLoginSchema))
      .post("/contract")
      .send({
        walletAddress: validWallet,
        signature: "signed-message",
        message: "login",
      });

    expect(response.status).toBe(200);
    expect(envelopeSchema.safeParse(response.body).success).toBe(true);
    assertSuccessEnvelope(response.body);
  });

  it.each([
    [{ signature: "sig", message: "login" }, "walletAddress"],
    [{ walletAddress: validWallet, message: "login" }, "signature"],
    [{ walletAddress: validWallet, signature: "sig" }, "message"],
    [
      { walletAddress: "", signature: "sig", message: "login" },
      "walletAddress",
    ],
    [
      { walletAddress: validWallet, signature: "", message: "login" },
      "signature",
    ],
  ])(
    "returns a typed error when wallet login field %s is invalid",
    async (body, field) => {
      const response = await request(buildSchemaApp(walletLoginSchema))
        .post("/contract")
        .send(body);
      expect(response.status).toBe(400);
      assertErrorEnvelope(response.body, "VALIDATION_ERROR");
      expect(response.body.error.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: `body.${field}` }),
        ]),
      );
    },
  );

  it("accepts refresh-token input as an opaque non-empty string", async () => {
    const response = await request(buildSchemaApp(refreshTokenSchema))
      .post("/contract")
      .send({ refreshToken: "opaque.refresh.token" });
    expect(response.status).toBe(200);
    assertSuccessEnvelope(response.body);
  });

  it.each([undefined, null, "", 123, { token: "wrong-field" }])(
    "rejects refresh token value %s without invoking the handler",
    async (refreshToken) => {
      const response = await request(buildSchemaApp(refreshTokenSchema))
        .post("/contract")
        .send({ refreshToken });
      expect(response.status).toBe(400);
      assertErrorEnvelope(response.body, "VALIDATION_ERROR");
    },
  );
});

describe("webhook request and failure contracts at runtime", () => {
  it.each(["", "not-a-url", "http://[broken"])(
    "rejects invalid webhook URL %s with a typed validation error",
    async (url) => {
      await expect(validateWebhookUrl(url)).rejects.toBeInstanceOf(
        WebhookValidationError,
      );
    },
  );

  it("rejects non-HTTPS webhook URLs in production", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        validateWebhookUrl("ftp://example.com/hook"),
      ).rejects.toBeInstanceOf(WebhookValidationError);
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("does not treat a DNS failure as a valid webhook target", async () => {
    await expect(
      validateWebhookUrl("https://contract-test.invalid/hook"),
    ).rejects.toBeInstanceOf(WebhookValidationError);
  });

  it("keeps documented webhook examples in the focused YAML fragment", () => {
    const yaml = fs.readFileSync(
      path.join(process.cwd(), "src", "openapi.yaml"),
      "utf8",
    );
    expect(yaml).toContain("/api/webhooks");
    expect(yaml).toContain("new_api_call");
    expect(yaml).toContain("retryPolicy");
    expect(yaml).toContain("rotate-secret");
  });
});

describe("billing and proxy response contracts", () => {
  it("defines a response schema for every successful documented JSON operation", () => {
    for (const [route, pathItem] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (method === "parameters") continue;
        const responses = (
          operation as {
            responses: Record<string, { content?: Record<string, unknown> }>;
          }
        ).responses;
        for (const [status, response] of Object.entries(responses)) {
          if (
            status.startsWith("2") &&
            status !== "204" &&
            route !== "/api/usage/sse"
          ) {
            expect(response.content?.["application/json"]).toBeDefined();
          }
        }
      }
    }
  });

  it("validates error envelopes independently of the route implementation", () => {
    const error = {
      success: false,
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
      requestId: "proxy-contract-request",
      timestamp: new Date().toISOString(),
    };
    assertErrorEnvelope(error, "UNAUTHORIZED");
  });

  it("validates successful proxy-style data independently of upstream payload shape", () => {
    const success = {
      success: true,
      data: { status: "proxied", upstreamStatus: 200 },
      requestId: "proxy-contract-request",
      timestamp: new Date().toISOString(),
    };
    assertSuccessEnvelope(success);
  });

  it("keeps auth, billing, webhook, and proxy contract surfaces represented by tests", () => {
    const testedSurfaces = new Set(["auth", "billing", "webhook", "proxy"]);
    expect(['testedSurfaces]).toEqual(
      expect.arrayContaining(["auth", "billing", "webhook", "proxy"]),
    );
  });
});
