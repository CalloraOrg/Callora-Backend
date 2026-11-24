import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { HmacObjectStorageClient } from './scheduledExports.js';

// HmacObjectStorageClient is an in-memory fake. Endpoint validation lives in
// src/lib/storageEndpoint.ts (covered by storageEndpoint.test.ts) and real S3
// failure mapping is out of scope here.

const FROZEN_NOW = new Date('2026-06-01T00:00:00.000Z');
const FROZEN_EPOCH_SECONDS = Math.floor(FROZEN_NOW.getTime() / 1000);
const SECRET = 'test-secret-access-key';
const ENDPOINT = 'https://s3.example.com';
const BUCKET = 'exports';

function expectedSignature(bucket: string, key: string, expiresAt: number, secret = SECRET): string {
  return crypto.createHmac('sha256', secret).update(`${bucket}/${key}:${expiresAt}`).digest('hex');
}

function parseSignedUrl(url: string): URL {
  return new URL(url);
}

describe('HmacObjectStorageClient.createSignedDownloadUrl', () => {
  let client: HmacObjectStorageClient;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FROZEN_NOW);
    client = new HmacObjectStorageClient();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('signs the canonical bucket/key/expires payload with HMAC-SHA256', () => {
    const url = client.createSignedDownloadUrl({
      bucket: BUCKET,
      key: 'reports/daily.csv',
      expiresInSeconds: 300,
      secretAccessKey: SECRET,
      endpoint: ENDPOINT,
    });

    const expiresAt = FROZEN_EPOCH_SECONDS + 300;
    const expected = `${ENDPOINT}/${encodeURIComponent(BUCKET)}/${encodeURIComponent('reports/daily.csv')}?expires=${expiresAt}&signature=${expectedSignature(BUCKET, 'reports/daily.csv', expiresAt)}`;

    assert.equal(url, expected);
    assert.equal(parseSignedUrl(url).searchParams.get('expires'), String(expiresAt));
    assert.equal(parseSignedUrl(url).searchParams.get('signature'), expectedSignature(BUCKET, 'reports/daily.csv', expiresAt));
  });

  test('uses the current time for expires when expiresInSeconds is 0', () => {
    const url = client.createSignedDownloadUrl({
      bucket: BUCKET,
      key: 'report.json',
      expiresInSeconds: 0,
      secretAccessKey: SECRET,
      endpoint: ENDPOINT,
    });

    assert.equal(parseSignedUrl(url).searchParams.get('expires'), String(FROZEN_EPOCH_SECONDS));
    assert.equal(
      parseSignedUrl(url).searchParams.get('signature'),
      expectedSignature(BUCKET, 'report.json', FROZEN_EPOCH_SECONDS),
    );
  });

  test('changing bucket, key, expiry or secret changes the signature', () => {
    const base = { bucket: BUCKET, key: 'reports/daily.csv', expiresInSeconds: 300, secretAccessKey: SECRET, endpoint: ENDPOINT };
    const baseline = parseSignedUrl(client.createSignedDownloadUrl(base)).searchParams.get('signature');

    const variants = [
      { ...base, bucket: 'other-exports' },
      { ...base, key: 'reports/hourly.csv' },
      { ...base, expiresInSeconds: 301 },
      { ...base, secretAccessKey: 'other-secret' },
    ];

    for (const variant of variants) {
      const signature = parseSignedUrl(client.createSignedDownloadUrl(variant)).searchParams.get('signature');
      assert.notEqual(signature, baseline, `expected signature to change for ${JSON.stringify(variant)}`);
    }
  });

  test('a trailing slash on the endpoint does not change the path', () => {
    const withoutSlash = client.createSignedDownloadUrl({
      bucket: BUCKET,
      key: 'reports/daily.csv',
      expiresInSeconds: 60,
      secretAccessKey: SECRET,
      endpoint: ENDPOINT,
    });
    const withSlash = client.createSignedDownloadUrl({
      bucket: BUCKET,
      key: 'reports/daily.csv',
      expiresInSeconds: 60,
      secretAccessKey: SECRET,
      endpoint: `${ENDPOINT}/`,
    });

    assert.equal(withSlash, withoutSlash);
  });

  test('URL-encodes bucket and key but signs the raw key', () => {
    const key = 'reports/a b+c?d#e/café.csv';
    const bucket = 'my exports';
    const url = client.createSignedDownloadUrl({
      bucket,
      key,
      expiresInSeconds: 120,
      secretAccessKey: SECRET,
      endpoint: ENDPOINT,
    });

    const expiresAt = FROZEN_EPOCH_SECONDS + 120;
    const parsed = parseSignedUrl(url);
    assert.equal(parsed.pathname, `/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`);
    assert.equal(parsed.pathname, '/my%20exports/reports%2Fa%20b%2Bc%3Fd%23e%2Fcaf%C3%A9.csv');
    assert.equal(parsed.searchParams.get('signature'), expectedSignature(bucket, key, expiresAt));
  });

  test('signs an empty key over the bare bucket and expiry', () => {
    const url = client.createSignedDownloadUrl({
      bucket: BUCKET,
      key: '',
      expiresInSeconds: 10,
      secretAccessKey: SECRET,
      endpoint: ENDPOINT,
    });

    const expiresAt = FROZEN_EPOCH_SECONDS + 10;
    assert.equal(parseSignedUrl(url).pathname, `/${BUCKET}/`);
    assert.equal(parseSignedUrl(url).searchParams.get('signature'), expectedSignature(BUCKET, '', expiresAt));
  });
});

describe('HmacObjectStorageClient.uploadObject', () => {
  let client: HmacObjectStorageClient;

  beforeEach(() => {
    client = new HmacObjectStorageClient();
  });

  const baseInput = {
    bucket: BUCKET,
    key: 'reports/daily.csv',
    contentType: 'text/csv',
    accessKeyId: 'access-key-id',
    secretAccessKey: SECRET,
    region: 'us-east-1',
    endpoint: ENDPOINT,
  };

  test('records a string body with its content type', async () => {
    await client.uploadObject({ ...baseInput, body: 'id,amount\n1,15\n' });

    assert.deepEqual(client.uploads, [
      { bucket: BUCKET, key: 'reports/daily.csv', body: 'id,amount\n1,15\n', contentType: 'text/csv' },
    ]);
  });

  test('concatenates async iterable chunks, including large bodies', async () => {
    const chunks = ['first-', 'second-', 'x'.repeat(256 * 1024), '-last'];
    async function* body(): AsyncGenerator<string> {
      for (const chunk of chunks) yield chunk;
    }

    await client.uploadObject({ ...baseInput, key: 'reports/large.json', contentType: 'application/json', body: body() });

    assert.equal(client.uploads.length, 1);
    assert.equal(client.uploads[0].body, chunks.join(''));
    assert.equal(client.uploads[0].contentType, 'application/json');
  });

  test('rejects with the abort reason before recording when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('export cancelled');
    controller.abort(reason);

    await assert.rejects(
      client.uploadObject({ ...baseInput, body: 'id,amount\n1,15\n', signal: controller.signal }),
      (error) => error === reason,
    );
    assert.deepEqual(client.uploads, []);
  });
});
