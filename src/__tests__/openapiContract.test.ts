import { readFileSync } from 'fs';
import path from 'path';

jest.mock('../repositories/apiRepository.js', () => ({
  defaultApiRepository: {
    listPublic: jest.fn(),
    findById: jest.fn(),
    getEndpoints: jest.fn(),
    createWithEndpoints: jest.fn(),
  },
}));

jest.mock('../repositories/developerRepository.js', () => ({
  defaultDeveloperRepository: {
    findByUserId: jest.fn(),
    getOrCreateByUserId: jest.fn(),
    upsertProfile: jest.fn(),
  },
}));

import { createApiRouter } from '../routes/index.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
const API_PREFIX = '/api';

const REGISTERED_ROUTE_ALLOWLIST = new Set([
  'GET /api/health',
  'GET /api/openapi.json',
]);

const OPENAPI_ROUTE_ALLOWLIST = new Set([
  'GET /api/developers/revenue',
]);

type ExpressLayer = {
  handle?: ExpressRouter;
  name?: string;
  regexp?: RegExp & { fast_slash?: boolean };
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
};

type ExpressRouter = {
  stack?: ExpressLayer[];
};

function normalizePath(pathname: string): string {
  return pathname
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .replace(/:([A-Za-z0-9_]+)/g, '{$1}') || '/';
}

function getMountPath(layer: ExpressLayer): string {
  if (!layer.regexp || layer.regexp.fast_slash) {
    return '';
  }

  const source = layer.regexp.source;
  const match = source.match(/^\^\\\/(.+?)\\\/\?\(\?=\\\/\|\$\)/);

  if (!match) {
    return '';
  }

  return `/${match[1].replace(/\\\//g, '/').replace(/\\/g, '')}`;
}

function collectRegisteredRoutes(router: ExpressRouter, prefix = API_PREFIX): Set<string> {
  const routes = new Set<string>();

  for (const layer of router.stack ?? []) {
    if (layer.route) {
      const routePaths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];

      for (const routePath of routePaths) {
        for (const method of Object.keys(layer.route.methods)) {
          routes.add(`${method.toUpperCase()} ${normalizePath(`${prefix}${routePath}`)}`);
        }
      }
      continue;
    }

    if (layer.name === 'router' && layer.handle?.stack) {
      const nestedPrefix = normalizePath(`${prefix}${getMountPath(layer)}`);
      for (const route of collectRegisteredRoutes(layer.handle, nestedPrefix)) {
        routes.add(route);
      }
    }
  }

  return routes;
}

function collectOpenApiRoutes(): Set<string> {
  const openApiPath = path.join(process.cwd(), 'docs/openapi.json');
  const spec = JSON.parse(readFileSync(openApiPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const routes = new Set<string>();

  for (const [pathname, operations] of Object.entries(spec.paths)) {
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${normalizePath(pathname)}`);
      }
    }
  }

  return routes;
}

describe('OpenAPI route contract', () => {
  it('keeps src/routes/index.ts registered routes and docs/openapi.json in sync', () => {
    const registeredRoutes = collectRegisteredRoutes(
      createApiRouter({ usageEventsRepository: undefined as never }) as ExpressRouter,
    );
    const documentedRoutes = collectOpenApiRoutes();

    const undocumentedRoutes = [...registeredRoutes]
      .filter((route) => !REGISTERED_ROUTE_ALLOWLIST.has(route))
      .filter((route) => !documentedRoutes.has(route));

    const unknownDocumentedRoutes = [...documentedRoutes]
      .filter((route) => !OPENAPI_ROUTE_ALLOWLIST.has(route))
      .filter((route) => !registeredRoutes.has(route));

    expect(undocumentedRoutes).toEqual([]);
    expect(unknownDocumentedRoutes).toEqual([]);
  });
});
