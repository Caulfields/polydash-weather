const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const app = require('../../server');
const { buildForecastPayload, metarPayload, dateKeyForTz } = require('../helpers/fixtures');
const { jsonResponse, mockHttpsGet } = require('../helpers/mocks');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

function apiRequest(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path, method, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function json(res) {
  return JSON.parse(res.body);
}

function mockUpstream(t, { metarDown = false } = {}) {
  mockHttpsGet(t, {
    byUrl(url) {
      if (url.includes('aviationweather')) {
        return metarDown
          ? { body: { error: 'down' }, status: 500 }
          : { body: metarPayload({ station: 'EGLC', timezone: 'Europe/London' }) };
      }
      if (url.includes('open-meteo')) {
        return { body: buildForecastPayload(new URLSearchParams(new URL(url).search), {}) };
      }
      return { body: {} };
    },
  });

  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.hostname.includes('aviationweather')) {
      return jsonResponse(metarPayload({ station: 'EGLC', timezone: 'Europe/London' }));
    }
    if (u.hostname.includes('open-meteo')) {
      return jsonResponse(buildForecastPayload(u.searchParams, {}));
    }
    throw new Error('unexpected upstream url: ' + url);
  });
}

test('serves the dashboard HTML at /', async () => {
  const res = await apiRequest('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /Weather Dashboard/);
});

test('GET /api/forecast returns hourly data', async (t) => {
  mockUpstream(t);
  const res = await apiRequest('/api/forecast?station=EGLC&model=auto');
  assert.strictEqual(res.status, 200);
  const body = json(res);
  assert.ok(body.hourly);
  assert.ok(body.hourly.time.length > 0);
});

test('GET /api/forecast validates station and model', async (t) => {
  mockUpstream(t);
  assert.strictEqual((await apiRequest('/api/forecast?station=ZZZZ&model=auto')).status, 400);
  assert.strictEqual((await apiRequest('/api/forecast?model=auto')).status, 400);
  assert.strictEqual((await apiRequest('/api/forecast?station=EGLC&model=BAD%20MODEL')).status, 400);
  assert.strictEqual((await apiRequest('/api/forecast?station=EGLC&model=auto&date=bad')).status, 400);
});

test('GET /api/metar returns observations', async (t) => {
  mockUpstream(t);
  const first = await apiRequest('/api/metar?station=EGLC');
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.headers['x-cache'], 'MISS');
  const body = json(first);
  assert.ok(Array.isArray(body));
  assert.ok(body.length > 0);

  const second = await apiRequest('/api/metar?station=EGLC');
  assert.strictEqual(second.headers['x-cache'], 'HIT');
});

test('GET /api/metar falls back to Open-Meteo when METAR service is down', async (t) => {
  mockUpstream(t, { metarDown: true });
  const res = await apiRequest('/api/metar?station=EHAM');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['x-cache'], 'FALLBACK');
  const body = json(res);
  assert.ok(Array.isArray(body));
  assert.ok(body.every((row) => 'obsTime' in row && 'temp' in row));
});

test('GET /api/metar rejects invalid station', async (t) => {
  mockUpstream(t);
  assert.strictEqual((await apiRequest('/api/metar?station=ZZZZ')).status, 400);
  assert.strictEqual((await apiRequest('/api/metar')).status, 400);
});

test('GET /api/test-models returns config and POST updates it', async (t) => {
  const initial = await apiRequest('/api/test-models');
  assert.strictEqual(initial.status, 200);
  assert.strictEqual(typeof json(initial), 'object');

  const post = await apiRequest('/api/test-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { cityId: 'routesville', models: { basic: 'gfs_seamless', additional: 'icon_seamless', test: '' } },
  });
  assert.strictEqual(post.status, 200);
  assert.strictEqual(json(post).ok, true);
  assert.strictEqual(json(post).models.basic, 'gfs_seamless');

  const updated = await apiRequest('/api/test-models');
  assert.deepStrictEqual(json(updated).routesville, {
    basic: 'gfs_seamless',
    additional: 'icon_seamless',
    test: '',
  });
});

test('GET /api/bot/weather returns v2.0 response', async (t) => {
  mockUpstream(t);
  const date = dateKeyForTz('Europe/London');
  const res = await apiRequest(`/api/bot/weather?city=London&date=${date}`);
  assert.strictEqual(res.status, 200);
  const body = json(res);
  assert.strictEqual(body.schema_version, '2.0');
  assert.strictEqual(body.items[0].city.id, 'london');
  assert.strictEqual(body.items[0].category, 1);
});

test('GET /api/bot/weather validates date and city', async (t) => {
  mockUpstream(t);
  assert.strictEqual((await apiRequest('/api/bot/weather?city=London')).status, 400);
  assert.strictEqual((await apiRequest('/api/bot/weather?date=2026-08-20')).status, 400);
});

test('POST /api/bot/weather/batch builds items and errors', async (t) => {
  mockUpstream(t);
  const date = dateKeyForTz('Europe/London');
  const res = await apiRequest('/api/bot/weather/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { date, cities: ['London', 'Atlantis'] },
  });
  assert.strictEqual(res.status, 200);
  const body = json(res);
  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(body.errors.length, 1);
  assert.strictEqual(body.items[0].city.id, 'london');
});

test('GET /api/temperature requires API key and resolves city', async (t) => {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = 'route-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = previous;
  });
  mockUpstream(t);

  assert.strictEqual((await apiRequest('/api/temperature?city=London')).status, 401);
  assert.strictEqual(
    (await apiRequest('/api/temperature?city=London', { headers: { 'x-api-key': 'wrong' } })).status,
    401,
  );

  const ok = await apiRequest('/api/temperature?city=London&unit=C', { headers: { 'x-api-key': 'route-secret' } });
  assert.strictEqual(ok.status, 200);
  const body = json(ok);
  assert.strictEqual(body.city.id, 'london');
  assert.ok(body.bestModel);
  assert.strictEqual(body.unit, 'C');
});

test('GET /api/temperature rejects missing city', async (t) => {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = 'route-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = previous;
  });
  mockUpstream(t);

  const res = await apiRequest('/api/temperature', { headers: { 'x-api-key': 'route-secret' } });
  assert.strictEqual(res.status, 400);
});