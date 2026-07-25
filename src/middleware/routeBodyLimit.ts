import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

export interface RouteBodyLimitRule {
  method: string;
  route: string;
  limit: string;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizeRoute(route: string): string {
  if (!route || route === '/') {
    return '/';
  }

  return route.startsWith('/') ? route : `/${route}`;
}

function isRouteMatch(pathname: string, pattern: string): boolean {
  const normalizedPath = normalizeRoute(pathname);
  const normalizedPattern = normalizeRoute(pattern);

  const pathSegments = normalizedPath.split('/').filter(Boolean);
  const patternSegments = normalizedPattern.split('/').filter(Boolean);

  if (patternSegments.length === 0) {
    return true;
  }

  if (pathSegments.length < patternSegments.length) {
    return false;
  }

  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    const pathSegment = pathSegments[index];

    if (patternSegment === '*') {
      return true;
    }

    if (patternSegment.startsWith(':')) {
      continue;
    }

    if (patternSegment !== pathSegment) {
      return false;
    }
  }

  return true;
}

function isMethodMatch(requestMethod: string, ruleMethod: string): boolean {
  if (ruleMethod === '*') {
    return true;
  }
  return requestMethod.toUpperCase() === ruleMethod.toUpperCase();
}

export function createRouteBodyLimitMiddleware(rules: RouteBodyLimitRule[] = []): RequestHandler {
  const normalizedRules = rules.map((rule) => ({
    method: rule.method.toUpperCase(),
    route: normalizeRoute(rule.route),
    limit: rule.limit,
  }));

  const parserCache = new Map<string, { json: express.RequestHandler; urlEncoded: express.RequestHandler }>();

  function getParserPair(limit: string) {
    let pair = parserCache.get(limit);
    if (!pair) {
      pair = {
        json: express.json({ limit }),
        urlEncoded: express.urlencoded({ extended: false, limit }),
      };
      parserCache.set(limit, pair);
    }
    return pair;
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (!BODY_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const matchingRule = normalizedRules.find((rule) =>
      isMethodMatch(req.method, rule.method) && isRouteMatch(req.path, rule.route),
    );

    if (!matchingRule) {
      next();
      return;
    }

    const { json, urlEncoded } = getParserPair(matchingRule.limit);

    json(req, res, (jsonError) => {
      if (jsonError) {
        next(jsonError);
        return;
      }

      urlEncoded(req, res, next);
    });
  };
}
