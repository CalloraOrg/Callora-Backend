import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const catalogPath = path.join(root, "src", "errors", "errorCatalog.ts");
const docsPath = path.join(root, "docs", "error-codes.md");
const openApiPath = path.join(root, "docs", "openapi.json");
const checkOnly = process.argv.includes("--check");

const startMarker = "<!-- BEGIN GENERATED ERROR CODES -->";
const endMarker = "<!-- END GENERATED ERROR CODES -->";

function readCatalog() {
  const source = fs.readFileSync(catalogPath, "utf8");
  const entries = [];
  let section = "General";

  for (const line of source.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\/\/\s+(.+)$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }

    const entryMatch = line.match(/^\s*([A-Z0-9_]+):\s*"([A-Z0-9_]+)",$/);
    if (!entryMatch) continue;

    const [, key, value] = entryMatch;
    if (key !== value) {
      throw new Error(`ErrorCode key/value mismatch: ${key} !== ${value}`);
    }
    entries.push({ code: value, section });
  }

  if (entries.length === 0) {
    throw new Error(`No error codes found in ${catalogPath}`);
  }

  const duplicates = entries
    .map((entry) => entry.code)
    .filter((code, index, codes) => codes.indexOf(code) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate error codes: ${[...new Set(duplicates)].join(", ")}`);
  }

  return entries;
}

function buildMarkdownBlock(entries) {
  const rows = entries
    .map(({ code, section }) => `| \`${code}\` | ${section} |`)
    .join("\n");

  return [
    startMarker,
    "## Canonical error code catalog",
    "",
    "This section is generated from `src/errors/errorCatalog.ts`. Run `npm run error-codes:generate` after changing the catalog.",
    "",
    "| Code | Catalog section |",
    "|---|---|",
    rows,
    endMarker,
  ].join("\n");
}

function updateGeneratedBlock(markdown, block) {
  const blockPattern = new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`);
  if (blockPattern.test(markdown)) {
    return markdown.replace(blockPattern, block);
  }

  const introPattern = /^(# .+\r?\n\r?\n(?:.+\r?\n)+?\r?\n)/;
  const match = markdown.match(introPattern);
  if (!match) {
    return `${block}\n\n${markdown}`;
  }

  return `${match[1]}${block}\n\n${markdown.slice(match[1].length)}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateOpenApi(openApi, entries) {
  const schemas = openApi.components?.schemas;
  if (!schemas) {
    throw new Error("OpenAPI document is missing components.schemas");
  }

  schemas.ErrorCode = {
    type: "string",
    enum: entries.map((entry) => entry.code),
    description: "Canonical Callora backend error code.",
  };

  const errorResponse = schemas.ErrorResponse;
  if (!errorResponse?.properties?.code) {
    throw new Error("OpenAPI document is missing components.schemas.ErrorResponse.properties.code");
  }

  errorResponse.properties.code = {
    $ref: "#/components/schemas/ErrorCode",
  };

  return `${JSON.stringify(openApi, null, 2)}\n`;
}

function writeOrCheck(filePath, current, next) {
  if (current === next) return false;

  if (checkOnly) {
    console.error(`${path.relative(root, filePath)} is not generated from the current error catalog.`);
    return true;
  }

  fs.writeFileSync(filePath, next);
  return true;
}

const entries = readCatalog();
const docsCurrent = fs.readFileSync(docsPath, "utf8");
const docsNext = updateGeneratedBlock(docsCurrent, buildMarkdownBlock(entries));
const openApiCurrent = fs.readFileSync(openApiPath, "utf8");
const openApiNext = updateOpenApi(JSON.parse(openApiCurrent), entries);

const docsChanged = writeOrCheck(docsPath, docsCurrent, docsNext);
const openApiChanged = writeOrCheck(openApiPath, openApiCurrent, openApiNext);

if (checkOnly && (docsChanged || openApiChanged)) {
  process.exit(1);
}

if (!checkOnly) {
  const action = docsChanged || openApiChanged ? "Updated" : "Already up to date";
  console.log(`${action}: docs/error-codes.md, docs/openapi.json`);
}
