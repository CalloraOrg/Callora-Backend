import type { Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'node:events';
import {
  securityHeaders,
  AUDIT_CSP_POLICY,
  AUDIT_X_CONTENT_TYPE_OPTIONS,
  AUDIT_REFERRER_POLICY,
} from './securityHeaders.js';

describe('securityHeaders middleware', () => {
  test('sets Content-Security-Policy header', () => {
    const req = {} as Request;
    const res = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
    }) as unknown as Response & { setHeader: jest.Mock };
    const next: NextFunction = jest.fn();

    securityHeaders(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Security-Policy', AUDIT_CSP_POLICY);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('sets X-Content-Type-Options header', () => {
    const req = {} as Request;
    const res = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
    }) as unknown as Response & { setHeader: jest.Mock };
    const next: NextFunction = jest.fn();

    securityHeaders(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', AUDIT_X_CONTENT_TYPE_OPTIONS);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('sets Referrer-Policy header', () => {
    const req = {} as Request;
    const res = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
    }) as unknown as Response & { setHeader: jest.Mock };
    const next: NextFunction = jest.fn();

    securityHeaders(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', AUDIT_REFERRER_POLICY);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('sets all three security headers in a single invocation', () => {
    const req = {} as Request;
    const res = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
    }) as unknown as Response & { setHeader: jest.Mock };
    const next: NextFunction = jest.fn();

    securityHeaders(req, res, next);

    expect(res.setHeader).toHaveBeenCalledTimes(3);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Security-Policy', AUDIT_CSP_POLICY);
    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', AUDIT_X_CONTENT_TYPE_OPTIONS);
    expect(res.setHeader).toHaveBeenCalledWith('Referrer-Policy', AUDIT_REFERRER_POLICY);
  });

  test('calls next to pass control to subsequent middleware', () => {
    const req = {} as Request;
    const res = Object.assign(new EventEmitter(), {
      setHeader: jest.fn(),
    }) as unknown as Response & { setHeader: jest.Mock };
    const next: NextFunction = jest.fn();

    securityHeaders(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});
