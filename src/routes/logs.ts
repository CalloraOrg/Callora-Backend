import { Router, Request, Response, NextFunction } from 'express';
import { getDefaultBreakerRegistry } from '../lib/circuitBreaker.js';
import { ServiceUnavailableError, BadGatewayError } from '../errors/index.js';
import { config } from '../config/index.js';

const logsRouter = Router();

logsRouter.all('/:endpoint(*)?', async (req: Request, res: Response, next: NextFunction) => {
  const endpoint = req.params.endpoint || 'default';
  const breakerKey = `logs-${req.method.toLowerCase()}-${endpoint.replace(/\//g, '-')}`;
  
  const breaker = getDefaultBreakerRegistry().getOrCreate(breakerKey, {
    failureThreshold: 5,
    cooldownMs: 30000,
    successThreshold: 1,
    onOpenError: (msg) => new ServiceUnavailableError(`Downstream logs endpoint is currently unavailable: ${msg}`),
  });

  try {
    const result = await breaker.execute(breakerKey, async () => {
      const controller = new AbortController();
      const timeoutMs = config.proxy?.timeoutMs || 30000;
      const id = setTimeout(() => controller.abort(), timeoutMs);
      
      try {
        const upstreamUrl = config.proxy?.upstreamUrl || 'http://localhost:4000';
        const url = `${upstreamUrl}/logs${req.params.endpoint ? `/${req.params.endpoint}` : ''}`;
        
        const response = await fetch(url, {
          method: req.method,
          headers: {
            'Content-Type': req.headers['content-type'] || 'application/json',
            ...(req.headers['authorization'] ? { 'Authorization': req.headers['authorization'] as string } : {}),
          },
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
          signal: controller.signal,
        });
        
        if (!response.ok) {
          throw new Error(`Upstream returned ${response.status}`);
        }
        
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          return await response.json();
        } else {
          return await response.text();
        }
      } finally {
        clearTimeout(id);
      }
    });

    if (typeof result === 'string') {
      res.send(result);
    } else {
      res.json(result);
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 503) {
      next(error);
    } else {
      next(new BadGatewayError(error instanceof Error ? error.message : 'Unknown error'));
    }
  }
});

export default logsRouter;
