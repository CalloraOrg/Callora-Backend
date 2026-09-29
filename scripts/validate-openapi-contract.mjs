import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const specPath = resolve(process.cwd(), "docs/openapi.json");
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const failures = [];
const warnings = [];
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);
const isResponseKey = (key) =>
  key === "default" || /^\d{3}([Xx]{2})?$/.test(key);

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function resolveRef(ref, location) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    fail(`${location}: unsupported reference ${String(ref)}`);
    return undefined;
  }

  const value = ref
    .slice(2)
    .split("/")
    .reduce((current, segment) => current?.[segment], spec);
  if (value === undefined) fail(`${location}: unresolved reference ${ref}`);
  return value;
}

function inspectSchema(schema, location) {
  if (!schema || typeof schema !== "object") {
    fail(`${location}: schema must be an object`);
    return;
  }
  if (schema.$ref) {
    inspectSchema(resolveRef(schema.$ref, location), location);
    return;
  }
  if (Array.isArray(schema.enum) && schema.enum.length === 0) {
    fail(`${location}: enum cannot be empty`);
  }
  if (
    schema.required &&
    (!Array.isArray(schema.required) || schema.required.length === 0)
  ) {
    fail(`${location}: required must contain at least one field`);
  }
  if (schema.required && schema.properties) {
    for (const field of schema.required) {
      if (!(field in schema.properties))
        warn(`${location}: required field ${field} is undocumented`);
    }
  }
  if (schema.properties) {
    for (const [name, child] of Object.entries(schema.properties)) {
      inspectSchema(child, `${location}.properties.${name}`);
    }
  }
  if (schema.items) inspectSchema(schema.items, `${location}.items`);
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword].forEach((child, index) =>
        inspectSchema(child, `${location}.${keyword}[${index}]`),
      );
    }
  }
}

function inspectParameter(parameter, location) {
  if (parameter?.$ref) {
    inspectParameter(resolveRef(parameter.$ref, location), location);
    return;
  }
  if (!parameter || typeof parameter !== "object") {
    fail(`${location}: parameter must be an object`);
    return;
  }
  if (
    !parameter.name ||
    !["path", "query", "header", "cookie"].includes(parameter.in)
  ) {
    fail(`${location}: parameter needs a name and valid location`);
  }
  if (parameter.in === "path" && parameter.required !== true) {
    fail(`${location}: path parameters must be required`);
  }
  if (parameter.schema) inspectSchema(parameter.schema, `${location}.schema`);
}

function inspectResponse(response, location, status) {
  if (response?.$ref) {
    inspectResponse(resolveRef(response.$ref, location), location, status);
    return;
  }
  if (
    !response ||
    typeof response !== "object" ||
    typeof response.description !== "string"
  ) {
    fail(`${location}: response needs a description`);
    return;
  }
  if (status !== "204") {
    const content = response.content?.["application/json"];
    if (!content?.schema) warn(`${location}: JSON response has no JSON schema`);
    if (content?.schema)
      inspectSchema(
        content.schema,
        `${location}.content.application/json.schema`,
      );
  }
}

if (spec.openapi !== "3.1.0")
  fail(`document: expected OpenAPI 3.1.0, got ${String(spec.openapi)}`);
if (!spec.info?.title || !spec.info?.version)
  fail("document: info.title and info.version are required");
if (
  !spec.paths ||
  typeof spec.paths !== "object" ||
  Object.keys(spec.paths).length === 0
) {
  fail("document: paths must contain at least one path");
}

for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
  if (!path.startsWith("/")) fail(`paths.${path}: paths must start with /`);
  if (pathItem.parameters) {
    pathItem.parameters.forEach((parameter, index) =>
      inspectParameter(parameter, `paths.${path}.parameters[${index}]`),
    );
  }
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!methods.has(method)) continue;
    const location = `paths.${path}.${method}`;
    if (!operation.operationId)
      warn(`${location}: operationId is missing for generated clients`);
    if (!operation.responses || typeof operation.responses !== "object") {
      fail(`${location}: responses are required`);
      continue;
    }
    const responseKeys = Object.keys(operation.responses).filter(isResponseKey);
    if (responseKeys.length === 0)
      fail(`${location}: at least one HTTP response is required`);
    if (!responseKeys.some((key) => key.startsWith("2") || key === "default")) {
      fail(`${location}: success/default response is required`);
    }
    for (const [status, response] of Object.entries(operation.responses)) {
      if (isResponseKey(status))
        inspectResponse(response, `${location}.responses.${status}`, status);
    }
    if (["post", "put", "patch"].includes(method) && operation.requestBody) {
      const body = operation.requestBody.$ref
        ? resolveRef(operation.requestBody.$ref, `${location}.requestBody`)
        : operation.requestBody;
      if (!body?.content?.["application/json"]?.schema)
        warn(`${location}: JSON request body has no schema`);
      if (body?.content?.["application/json"]?.schema)
        inspectSchema(
          body.content["application/json"].schema,
          `${location}.requestBody.schema`,
        );
    }
    for (const [index, parameter] of (operation.parameters ?? []).entries()) {
      inspectParameter(parameter, `${location}.parameters[${index}]`);
    }
  }
}

for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
  inspectSchema(schema, `components.schemas.${name}`);
}

async function checkRuntimeMounts() {
  let createApp;
  try {
    const appModule = await import(
      pathToFileURL(resolve(process.cwd(), "src/app.ts")).href
    );
    createApp = appModule.createApp ?? appModule.default;
  } catch (error) {
    warn(
      `runtime: unable to load createApp from src/app.ts (${error?.message ?? error})`,
    );
    return;
  }
  if (typeof createApp !== "function") {
    warn("runtime: createApp is not exported from src/app.ts");
    return;
  }

  let app;
  try {
    app = createApp();
  } catch (error) {
    fail(`runtime: createApp() threw (${error?.message ?? error})`);
    return;
  }

  const documented = new Set();
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (!methods.has(method)) continue;
      documented.add(`${method.toUpperCase()} ${path}`);
      const requestPath = path.replace(/\{([^}]+)\}/g, "__contract__");
      let response;
      try {
        response = await app.request(requestPath, { method: method.toUpperCase() });
      } catch (error) {
        fail(
          `runtime: ${method.toUpperCase()} ${path} threw (${error?.message ?? error})`,
        );
        continue;
      }
      if (response.status === 404) {
        fail(
          `runtime: ${method.toUpperCase()} ${path} returned 404 from createApp (documented path is not mounted)`,
        );
      }
    }
  }

  const mounted = new Set();
  const router = app?.router ?? app?._router;
  const stack = router?.stack ?? [];
  for (const layer of stack) {
    const layerPath = layer?.route?.path ?? layer?.path;
    if (typeof layerPath !== "string") continue;
    const layerMethods = layer?.route?.methods
      ? Object.keys(layer.route.methods)
      : ["get"];
    for (const method of layerMethods) {
      mounted.add(`${method.toUpperCase()} ${layerPath}`);
    }
  }
  for (const entry of mounted) {
    if (!documented.has(entry)) {
      warn(`runtime: mounted but undocumented path ${entry}`);
    }
  }
}

await checkRuntimeMounts();

if (failures.length > 0) {
  console.error(
    `OpenAPI contract validation failed with ${failures.length} issue(s):`,
  );
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  const operationCount = Object.values(spec.paths).reduce(
    (count, pathItem) =>
      count +
      Object.keys(pathItem).filter((method) => methods.has(method)).length,
    0,
  );
  console.log(
    `OpenAPI contract valid: ${Object.keys(spec.paths).length} paths, ${operationCount} operations.`,
  );
  if (warnings.length > 0) {
    console.warn(`OpenAPI contract compatibility warnings: ${warnings.length}`);
    for (const warning of warnings) console.warn(`- ${warning}`);
  }
}
