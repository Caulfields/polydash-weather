const { test } = require('node:test');
const assert = require('node:assert');
const forecastHandler = require('../../api/forecast');
const metarHandler = require('../../api/metar');
const cityRankingHandler = require('../../api/city-ranking');
const { buildForecastPayload, metarPayload } = require('../helpers/fixtures');
const { jsonResponse, makePlainRes, makePlainReq } = require('../helpers/mocks');

function mockUpstream(t, { metar = true } = {}) {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.hostname.includes('aviationweather')) {
      if (!metar) return jsonResponse({ error: 'down' }, 500);
      return jsonResponse(metarPayload({ station: 'EGLC', timezone: 'Europe/London' }));
    }
    if (u.hostname.includes('open-meteo')) {
      return jsonResponse(buildForecastPayload(u.searchParams, {}));
    }
    throw new Error('unexpected upstream url: ' + url);
  });
}

function parseBody(res) {
  return JSON.parse(res.body);
}

test('forecast handler returns hourly forecast with MISS header', async (t) => {
  mockUpstream(t);
  const req = makePlainReq({ query: { station: 'EGLC', model: 'auto' } });
  const res = makePlainRes();

  await forecastHandler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['x-cache'], 'MISS');
  const body = parseBody(res);
  assert.ok(body.hourly);
  assert.ok(body.hourly.time.length > 0);
  assert.ok(Array.isArray(body.hourly.temperature_2m));
});

test('forecast handler serves cached response on second call', async (t) => {
  mockUpstream(t);
  const req = makePlainReq({ query: { station: 'EGLC', model: 'gfs_seamless', date: '2026-08-20' } });

  const first = makePlainRes();
  await forecastHandler(req, first);
  assert.strictEqual(first.headers['x-cache'], 'MISS');

  const second = makePlainRes();
  await forecastHandler(req, second);
  assert.strictEqual(second.headers['x-cache'], 'HIT');
  assert.deepStrictEqual(parseBody(second), parseBody(first));
});

test('forecast handler rejects invalid station', async (t) => {
  mockUpstream(t);
  const res = makePlainRes();
  await forecastHandler(makePlainReq({ query: { station: 'ZZZZ', model: 'auto' } }), res);
  assert.strictEqual(res.statusCode, 400);
});

test('forecast handler rejects missing station', async (t) => {
  mockUpstream(t);
  const res = makePlainRes();
  await forecastHandler(makePlainReq({ query: { model: 'auto' } }), res);
  assert.strictEqual(res.statusCode, 400);
});

test('forecast handler defaults missing model to auto', async (t) => {
  mockUpstream(t);
  const res = makePlainRes();
  await forecastHandler(makePlainReq({ query: { station: 'EGLC' } }), res);
  assert.strictEqual(res.statusCode, 200);
});

test('forecast handler rejects invalid model values', async (t) => {
  mockUpstream(t);
  for (const model of ['BAD MODEL!', 'UPPER', 'has-hyphen']) {
    const res = makePlainRes();
    await forecastHandler(makePlainReq({ query: { station: 'EGLC', model } }), res);
    assert.strictEqual(res.statusCode, 400, `model=${model}`);
  }
});

test('forecast handler rejects invalid date', async (t) => {
  mockUpstream(t);
  const res = makePlainRes();
  await forecastHandler(makePlainReq({ query: { station: 'EGLC', model: 'auto', date: 'tomorrow' } }), res);
  assert.strictEqual(res.statusCode, 400);
});

test('metar handler returns observations', async (t) => {
  mockUpstream(t);
  const req = makePlainReq({ query: { station: 'EGLC' } });
  const res = makePlainRes();

  await metarHandler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['x-cache'], 'MISS');
  const body = parseBody(res);
  assert.ok(Array.isArray(body));
  assert.ok(body.length > 0);
  assert.ok(body.every((row) => Number.isFinite(row.temp)));
});

test('metar handler falls back to Open-Meteo when METAR service fails', async (t) => {
  mockUpstream(t, { metar: false });
  const res = makePlainRes();

  await metarHandler(makePlainReq({ query: { station: 'EHAM' } }), res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['x-cache'], 'FALLBACK');
  const body = parseBody(res);
  assert.ok(Array.isArray(body));
  assert.ok(body.every((row) => 'obsTime' in row && 'temp' in row));
});

test('metar handler rejects invalid station', async (t) => {
  mockUpstream(t);
  const res = makePlainRes();
  await metarHandler(makePlainReq({ query: { station: 'ZZZZ' } }), res);
  assert.strictEqual(res.statusCode, 400);
  await metarHandler(makePlainReq({ query: {} }), res);
  assert.strictEqual(res.statusCode, 400);
});

test('city-ranking handler returns categories for every city', async (t) => {
  mockUpstream(t);
  const res = makePlainRes();
  await cityRankingHandler(makePlainReq({ method: 'GET' }), res);
  assert.strictEqual(res.statusCode, 200);
  const body = parseBody(res);
  const { CITIES } = require('../../assets/js/dashboard/config');
  for (const cityId of Object.keys(CITIES)) {
    assert.ok(body[cityId], `missing ${cityId}`);
    assert.ok([1, 2, 3, 4].includes(body[cityId].category));
  }
});
