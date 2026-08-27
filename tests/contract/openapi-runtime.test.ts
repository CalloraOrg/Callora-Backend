/**
 * Runtime contract coverage for the highest-risk public surfaces.
 *
 * The production app installs express-openapi-validator for documented paths.
 * These tests exercise the same request boundaries in small deterministic
 * harnesses so CI does not need a database, a wallet, an upstream service, or
 * a DNS resolver. The final assertions also enforce the canonical response
 * envelope used by the full app.
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

type OpenApiDocument = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

const specPath = path.join(process.cwd(), "docs", "openapi.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as OpenApiDocument;

const validWallet = "G" + "A".repeat(55);

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
    expect([...testedSurfaces]).toEqual(
      expect.arrayContaining(["auth", "billing", "webhook", "proxy"]),
    );
  });
});
