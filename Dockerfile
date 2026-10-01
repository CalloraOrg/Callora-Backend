# syntax=docker/dockerfile:1

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Copy manifests first so the dependency layer is cached independently of the
# source tree.
COPY package.json package-lock.json ./

# `npm ci` installs exactly what the lockfile pins and fails if the two files
# disagree. The previous `npm install` could silently rewrite the resolved tree,
# which made images non-reproducible.
RUN npm ci

# Source, scripts, prisma/ and docs/ (docs/openapi.json is read at runtime).
COPY . .

# Prisma's client is generated code. Without this the runtime import of
# `@prisma/client` resolves to a stub that throws when the app instantiates it.
RUN npx prisma generate

# Compile TypeScript.
#
# `npm run build` is `tsc`, and the repository currently reports pre-existing
# type errors in test files and unrelated modules (upstream CI marks its
# `typecheck` and `build` steps `continue-on-error` for exactly this reason).
# `tsc` still emits JavaScript for every file, so the compile step is allowed to
# report those pre-existing errors and the next step fails the build unless the
# entrypoint was actually produced.
RUN npx tsc -p tsconfig.json || true

# Metadata guards (these run as `prebuild` when using `npm run build`).
RUN npm run error-codes:check
RUN npm run validate:openapi

# Fail loudly if the compiler never emitted the server entrypoint.
RUN test -f dist/src/index.js \
    || (echo 'ERROR: build did not produce dist/src/index.js' >&2 && exit 1)

# ── Stage 2: Production Dependencies ─────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Exclude devDependencies (like TypeScript) to keep the image lightweight.
RUN npm ci --omit=dev
# The Prisma client lives in node_modules and must be generated in this stage
# too, since node_modules is the only thing copied out of it.
COPY prisma ./prisma
RUN npx prisma generate

# ── Stage 3: Production Runtime ──────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Copy the lean node_modules, the compiled assets, and the package manifest.
# `package.json` must be present because the project is ESM ("type": "module"):
# without it Node treats dist/**/*.js as CommonJS and the server cannot start.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# `src/routes/index.ts` resolves the OpenAPI document with
# `path.join(process.cwd(), "docs/openapi.json")` at import time and hands it to
# express-openapi-validator. Previously the image contained only node_modules and
# dist, so boot failed with ENOENT before a single request was served.
COPY --from=builder /app/docs/openapi.json ./docs/openapi.json

# The SQLite migration runner and the production schema check both read
# `migrations/*.sql` relative to the working directory, so the SQL migration
# files have to ship in the image as well.
COPY --from=builder /app/migrations ./migrations

# The process drops to the unprivileged `node` user, but it creates its SQLite
# database in the working directory at boot, so /app must be writable.
RUN chown -R node:node /app

# Enforce security by running as a non-root user
USER node

EXPOSE 3000

# Orchestrators and `docker run` need a liveness signal. Node 20 ships a global
# `fetch`, so this needs no curl/wget in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Apply pending migrations before serving. `initializeDb()` validates (rather
# than applies) migrations when NODE_ENV=production and refuses to start with
# pending migrations, which is always the case for a freshly created SQLite
# database — so the run has to be done up front. `exec` keeps the server as
# PID 1 so SIGTERM reaches the graceful-shutdown handler.
CMD ["sh", "-c", "node dist/src/migrate.js && exec node dist/src/index.js"]
