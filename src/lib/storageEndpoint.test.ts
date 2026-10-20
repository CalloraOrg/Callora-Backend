import { validateStorageEndpoint } from './storageEndpoint.js';

describe('validateStorageEndpoint', () => {
  it.each([
    'http://169.254.169.254',
    'http://10.0.0.5:9000',
    'https://[::ffff:10.0.0.1]',
    'http://127.0.0.1:9000',
    'http://100.64.0.1',
    'http://[fd00::1]',
    'http://224.0.0.1',
    'http://[ff02::1]',
    'http://240.0.0.1',
    'http://multicast.example.com.local',
    'http://localhost',
  ])('rejects internal endpoint %s', (url) => {
    expect(() => validateStorageEndpoint(url)).toThrow();
  });

  it('requires HTTPS in production', () => {
    expect(() => validateStorageEndpoint('http://s3.example.com', { production: true })).toThrow(/HTTPS/);
    expect(validateStorageEndpoint('https://s3.example.com', { production: true })).toBe('https://s3.example.com');
  });

  it('accepts a public S3 endpoint', () => {
    expect(validateStorageEndpoint('https://s3.us-east-1.amazonaws.com')).toBe(
      'https://s3.us-east-1.amazonaws.com',
    );
  });

  it('enforces the optional hostname allowlist', () => {
    expect(() => validateStorageEndpoint('https://other.example.com', {
      allowedHosts: ['s3.example.com'],
    })).toThrow(/allowlist/);
    expect(validateStorageEndpoint('https://s3.example.com', {
      allowedHosts: ['s3.example.com'],
    })).toBe('https://s3.example.com');
    expect(validateStorageEndpoint('https://bucket.s3.example.com', {
      allowedHosts: ['*.s3.example.com'],
    })).toBe('https://bucket.s3.example.com');
  });

  it.each([
    'ftp://s3.example.com',
    'https://user:pass@s3.example.com',
    'https://s3.example.com?token=abc',
    'https://s3.example.com/#fragment',
    'not a URL',
  ])('rejects malformed or unsupported endpoint %s', (url) => {
    expect(() => validateStorageEndpoint(url)).toThrow();
  });
});