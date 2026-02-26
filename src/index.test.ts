import request from "supertest";
import app from "./index.js";

import assert from 'node:assert/strict';
import test from 'node:test';

describe("Health API", () => {
  it("should return ok status", async () => {
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });


test('Health API returns ok status', async () => {
  const response = await request(app).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
});
