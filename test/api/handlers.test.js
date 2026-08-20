const { test } = require('node:test');
const assert = require('node:assert');
const forecastHandler = require('../../api/forecast');
const metarHandler = require('../../api/metar');
const temperatureHandler = require('../../api/temperature');
const cityRankingHandler = require('../../api/city-ranking');
const botWeatherHandler = require('../../api/bot/weather');
const batchHandler = require('../../api/bot/weather/batch');
const { buildForecastPayload, metarPayload, dateKeyForTz } = require('../helpers/fixtures');
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

test('temperature handler requires API key', async (t) => {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = 'test-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = previous;
  });
  mockUpstream(t);

  const noKey = makePlainRes();
  await temperatureHandler(makePlainReq({ query: { city: 'London' } }), noKey);
  assert.strictEqual(noKey.statusCode, 401);

  const wrongKey = makePlainRes();
  await temperatureHandler(makePlainReq({ query: { city: 'London' }, headers: { 'x-api-key': 'nope' } }), wrongKey);
  assert.strictEqual(wrongKey.statusCode, 401);

  const ok = makePlainRes();
  await temperatureHandler(makePlainReq({ query: { city: 'London' }, headers: { 'x-api-key': 'test-secret' } }), ok);
  assert.strictEqual(ok.statusCode, 200);
  const body = parseBody(ok);
  assert.strictEqual(body.city.id, 'london');
  assert.ok(body.bestModel);
});

test('temperature handler supports Authorization Bearer', async (t) => {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = 'test-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = previous;
  });
  mockUpstream(t);

  const res = makePlainRes();
  await temperatureHandler(makePlainReq({ query: { city: 'London' }, headers: { authorization: 'Bearer test-secret' } }), res);
  assert.strictEqual(res.statusCode, 200);
});

test('temperature handler rejects missing city/station', async (t) => {
  const previous = process.env.API_SECRET;
  process.env.API_SECRET = 'test-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.API_SECRET;
    else process.env.API_SECRET = previous;
  });
  mockUpstream(t);

  const res = makePlainRes();
  await temperatureHandler(makePlainReq({ query: {}, headers: { 'x-api-key': 'test-secret' } }), res);
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

test('bot/weather returns v2.0 response', async (t) => {
  mockUpstream(t);
  const date = dateKeyForTz('Europe/London');
  const res = makePlainRes();
  await botWeatherHandler(makePlainReq({ query: { city: 'London', date } }), res);
  assert.strictEqual(res.statusCode, 200);
  const body = parseBody(res);
  assert.strictEqual(body.schema_version, '2.0');
  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(body.items[0].city.id, 'london');
  assert.strictEqual(body.items[0].category, 1);
});

test('bot/weather rejects missing date', async (t) => {
  mockUpstream(t);
  const res = makePlainRes();
  await botWeatherHandler(makePlainReq({ query: { city: 'London' } }), res);
  assert.strictEqual(res.statusCode, 400);
});

test('bot/weather rejects unknown city and station', async (t) => {
  mockUpstream(t);
  const res = makePlainRes();
  await botWeatherHandler(makePlainReq({ query: { date: '2026-08-20' } }), res);
  assert.strictEqual(res.statusCode, 400);
});

test('batch handler returns items and errors', async (t) => {
  mockUpstream(t);
  const date = dateKeyForTz('Europe/London');
  const req = makePlainReq({
    method: 'POST',
    body: { date, cities: ['London', 'Atlantis'] },
  });
  const res = makePlainRes();
  await batchHandler(req, res);
  assert.strictEqual(res.statusCode, 200);
  const body = parseBody(res);
  assert.strictEqual(body.items.length, 1);
  assert.strictEqual(body.errors.length, 1);
  assert.strictEqual(body.items[0].city.id, 'london');
});

test('batch handler rejects requests without cities', async (t) => {
  mockUpstream(t);
  const res = makePlainRes();
  await batchHandler(makePlainReq({ method: 'POST', body: { date: '2026-08-20' } }), res);
  assert.strictEqual(res.statusCode, 400);
});