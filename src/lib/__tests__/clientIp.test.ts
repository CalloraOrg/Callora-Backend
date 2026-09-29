import assert from 'node:assert/strict';
import type { Request } from 'express';
import { getClientIp, isValidIp, DEFAULT_PROXY_HEADERS, selectClientIpWithTrust } from '../clientIp.js';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    ip: undefined,
    socket: { remoteAddress: undefined },
    ...overrides,
  } as unknown as Request;
}

describe('isValidIp', () => {
  test('accepts valid IPv4', () => {
    assert.equal(isValidIp('192.168.1.1'), true);
    assert.equal(isValidIp('0.0.0.0'), true);
    assert.equal(isValidIp('255.255.255.255'), true);
  });

  test('accepts valid IPv6', () => {
    assert.equal(isValidIp('::1'), true);
    assert.equal(isValidIp('2001:db8::1'), true);
    assert.equal(isValidIp('fe80::1'), true);
  });

  test('rejects non-IP strings', () => {
    assert.equal(isValidIp('not-an-ip'), false);
    assert.equal(isValidIp(''), false);
    assert.equal(isValidIp('example.com'), false);
  });
});

describe('getClientIp', () => {
  test('returns socket address when trustProxy is false', () => {
    const req = makeReq({ socket: { remoteAddress: '1.2.3.4' } as never });
    assert.equal(getClientIp(req, false), '1.2.3.4');
  });

  test('ignores x-forwarded-for when trustProxy is false', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '9.9.9.9' },
      socket: { remoteAddress: '1.2.3.4' } as never,
    });
    assert.equal(getClientIp(req, false), '1.2.3.4');
  });

  test('uses the rightmost entry with one trusted hop', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' },
    });
    assert.equal(getClientIp(req, 1), '2.2.2.2');
  });

  test('selects the correct entry for multiple trusted hops', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '5.5.5.5, 10.0.0.1, 172.16.0.1' },
    });
    assert.equal(getClientIp(req, 2), '10.0.0.1');
    assert.equal(getClientIp(req, 3), '5.5.5.5');
  });

  test('selects the leftmost untrusted entry for trusted CIDR list', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '1.1.1.1, 10.0.0.1, 172.16.0.1' },
    });
    assert.equal(getClientIp(req, ['10.0.0.0/8', '172.16.0.0/12']), '1.1.1.1');
  });

  test('spoofed leftmost entry cannot override the trusted hop selection', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '9.9.9.9, 2.2.2.2' },
    });
    assert.equal(getClientIp(req, 1), '2.2.2.2');
  });

  test('falls back to socket when proxy header is invalid', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': 'not-an-ip' },
      socket: { remoteAddress: '1.2.3.4' } as never,
    });
    assert.equal(getClientIp(req, 1), '1.2.3.4');
  });

  test('falls back to socket when the chain is shorter than the trust count', () => {
    const req = makeReq({
      headers: { 'x-forwarded-for': '2.2.2.2' },
      socket: { remoteAddress: '1.2.3.4' } as never,
    });
    assert.equal(getClientIp(req, 2), '1.2.3.4');
  });

  test('falls back to req.ip when socket is absent', () => {
    const req = makeReq({ ip: '3.3.3.3', socket: undefined as never });
    assert.equal(getClientIp(req, false), '3.3.3.3');
  });

  test('returns empty string when no IP source is available', () => {
    const req = makeReq({ ip: undefined, socket: undefined as never });
    assert.equal(getClientIp(req, false), '');
  });

  test('checks proxy headers in DEFAULT_PROXY_HEADERS priority order', () => {
    // x-forwarded-for is first; x-real-ip is second
    const reqBoth = makeReq({
      headers: { 'x-forwarded-for': '5.5.5.5', 'x-real-ip': '6.6.6.6' },
    });
    assert.equal(getClientIp(reqBoth, 1), '5.5.5.5');

    // Only x-real-ip present
    const reqReal = makeReq({ headers: { 'x-real-ip': '6.6.6.6' } });
    assert.equal(getClientIp(reqReal, 1), '6.6.6.6');
  });

  test('accepts custom proxy header list', () => {
    const req = makeReq({ headers: { 'x-custom-ip': '7.7.7.7' } });
    assert.equal(getClientIp(req, 1, ['x-custom-ip']), '7.7.7.7');
  });

  test('DEFAULT_PROXY_HEADERS includes x-forwarded-for', () => {
    assert.equal(DEFAULT_PROXY_HEADERS.includes('x-forwarded-for'), true);
  });

  test('selectClientIpWithTrust handles empty chain', () => {
    assert.equal(selectClientIpWithTrust([], 1), undefined);
  });
});
