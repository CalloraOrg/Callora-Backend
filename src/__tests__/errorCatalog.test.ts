import fs from "node:fs";
import path from "node:path";

import { ErrorCode, isErrorCode } from "../errors/errorCatalog.js";

const root = process.cwd();
const sourceRoot = path.join(root, "src");
const generatedStart = "<!-- BEGIN GENERATED ERROR CODES -->";
const generatedEnd = "<!-- END GENERATED ERROR CODES -->";
const errorClasses = [
  "AppError",
  "BadRequestError",
  "UnauthorizedError",
  "ForbiddenError",
  "NotFoundError",
  "PaymentRequiredError",
  "TooManyRequestsError",
  "ConflictError",
  "InternalServerError",
  "BadGatewayError",
  "ServiceUnavailableError",
  "GatewayTimeoutError",
].join("|");

function walkTypeScriptFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") return [];
      return walkTypeScriptFiles(fullPath);
    }

    if (
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".spec.ts") ||
      entry.name.endsWith(".d.ts")
    ) {
      return [];
    }

    return [fullPath];
  });
}

function relative(filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function collectEmittedCodes(): Map<string, Set<string>> {
  const codesByFile = new Map<string, Set<string>>();
  const codePropertyPattern = /\bcode:\s*["']([A-Z][A-Z0-9_]+)["']/g;
  const errorConstructorPattern = new RegExp(
    `new\\s+(?:${errorClasses})\\s*\\([\\s\\S]*?\\)`,
    "g",
  );
  const stringLiteralPattern = /["']([A-Z][A-Z0-9_]+)["']/g;

  for (const filePath of walkTypeScriptFiles(sourceRoot)) {
    const source = fs.readFileSync(filePath, "utf8");
    const found = new Set<string>();

    for (const match of source.matchAll(codePropertyPattern)) {
      found.add(match[1]);
    }

    for (const constructorMatch of source.matchAll(errorConstructorPattern)) {
      for (const stringMatch of constructorMatch[0].matchAll(stringLiteralPattern)) {
        found.add(stringMatch[1]);
      }
    }

    if (found.size > 0) {
      codesByFile.set(relative(filePath), found);
    }
  }

  return codesByFile;
}

describe("error code catalog", () => {
  const catalogCodes = Object.values(ErrorCode);

  it("has unique string values and a working type guard", () => {
    expect(new Set(catalogCodes).size).toBe(catalogCodes.length);

    for (const code of catalogCodes) {
      expect(isErrorCode(code)).toBe(true);
    }

    expect(isErrorCode("NOT_IN_THE_CATALOG")).toBe(false);
    expect(isErrorCode(null)).toBe(false);
  });

  it("keeps generated docs and OpenAPI schema aligned with the catalog", () => {
    const docs = fs.readFileSync(path.join(root, "docs", "error-codes.md"), "utf8");
    const generatedBlock = docs.match(
      new RegExp(`${generatedStart}[\\s\\S]*?${generatedEnd}`),
    )?.[0];
    expect(generatedBlock).toBeDefined();

    for (const code of catalogCodes) {
      expect(generatedBlock).toContain(`\`${code}\``);
    }

    const openApi = JSON.parse(fs.readFileSync(path.join(root, "docs", "openapi.json"), "utf8"));
    expect(openApi.components.schemas.ErrorCode.enum).toEqual(catalogCodes);
    expect(openApi.components.schemas.ErrorResponse.properties.code).toEqual({
      $ref: "#/components/schemas/ErrorCode",
    });
  });

  it("does not emit uncataloged error codes from source files", () => {
    const unknown: string[] = [];

    for (const [filePath, codes] of collectEmittedCodes()) {
      for (const code of codes) {
        if (!isErrorCode(code)) {
          unknown.push(`${filePath}: ${code}`);
        }
      }
    }

    expect(unknown).toEqual([]);
  });
});
