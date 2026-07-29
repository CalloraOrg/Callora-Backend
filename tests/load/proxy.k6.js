import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const failureRate = new Rate('failure_rate');

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 50 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    failure_rate: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// Helper functions

function randomPathComponent() {
  const components = ['current', 'forecast', 'historical', 'alerts', 'status'];
  return components[Math.floor(Math.random() * components.length)];
}

function randomPayload() {
  const items = [
    { input: 'hello world', lang: 'en' },
    { query: 'test', page: 1 },
    { id: 'abc-123', action: 'process' },
    { latitude: 40.7128, longitude: -74.0060 },
    { text: 'translate this', source: 'en', target: 'fr' },
  ];
  return items[Math.floor(Math.random() * items.length)];
}

function getApiKey() {
  return __ENV.API_KEY || 'test-key-123';
}

export default function () {
  const apiKey = getApiKey();
  const path = randomPathComponent();
  const payload = randomPayload();

  const headers = {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json',
  };

  const getRes = http.get(`${BASE_URL}/api/weather/${path}`, { headers });
  check(getRes, {
    'GET status is 200 or 404': (r) => r.status === 200 || r.status === 404,
  });

  const postRes = http.post(`${BASE_URL}/api/weather/${path}`, JSON.stringify(payload), { headers });
  const postSuccess = check(postRes, {
    'POST status is 200 or 400': (r) => r.status === 200 || r.status === 400,
  });

  failureRate.add(!postSuccess);

  sleep(1);
}
