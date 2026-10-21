#!/usr/bin/env node
/**
 * Builds a minimal, self-contained Vercel deployment folder in ./deploy.
 *
 *   npm run build:vercel
 *   cd deploy && vercel deploy --prod
 *
 * The Express app is bundled into a single serverless function (api/index.mjs);
 * runtime dependencies are installed by Vercel from the generated package.json.
 * Keeping the upload to a few dozen files avoids Vercel's per-day file-upload
 * quota on free accounts.
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const out = "deploy";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/api`, { recursive: true });

// Embed the OpenAPI contract and SQL migrations so the function is one file.
const migrations = {};
for (const f of readdirSync("migrations")) {
  if (f.endsWith(".sql") && !f.endsWith(".down.sql")) migrations[f] = readFileSync(`migrations/${f}`, "utf8");
}
const assets = { openapi: readFileSync("docs/openapi.json", "utf8"), migrations };

await build({
  entryPoints: ["scripts/vercel-entry.ts"],
  outfile: `${out}/api/index.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  sourcemap: false,
  logLevel: "warning",
  banner: {
    // CommonJS interop for any bundled code that relies on require/__dirname.
    js:
      "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);\n" +
      `globalThis.__CALLORA_ASSETS__ = ${JSON.stringify(assets)};`,
  },
});

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const { prisma: _cli, ...dependencies } = pkg.dependencies;
writeFileSync(
  `${out}/package.json`,
  JSON.stringify(
    {
      name: "callora-backend-demo",
      private: true,
      type: "module",
      engines: pkg.engines ?? { node: "20.x" },
      dependencies,
    },
    null,
    2,
  ),
);
writeFileSync(
  `${out}/vercel.json`,
  JSON.stringify(
    {
      $schema: "https://openapi.vercel.sh/vercel.json",
      rewrites: [{ source: "/(.*)", destination: "/api/index" }],
      functions: { "api/index.mjs": { maxDuration: 30 } },
    },
    null,
    2,
  ),
);
console.log("Vercel bundle written to ./deploy");
