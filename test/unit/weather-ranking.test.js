const { test } = require('node:test');
const assert = require('node:assert');
const { resolveCity, rankTemperature } = require('../../lib/weather-ranking');
const { buildForecastPayload, metarPayload } = require('../helpers/fixtures');
const { jsonResponse } = require('../helpers/mocks');

function mockUpstreamFetch(t, { metarOptions = {}, forecastRule = {} } = {}) {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.hostname.includes('aviationweather')) {
      return jsonResponse(metarPayload(metarOptions));
    }
    if (u.hostname.includes('open-meteo')) {
      return jsonResponse(buildForecastPayload(u.searchParams, forecastRule));
    }
    throw new Error('unexpected upstream url: ' + url);
  });
}

test('resolveCity resolves names, ids and METAR codes', () => {
  assert.strictEqual(resolveCity('London').id, 'london');
  assert.strictEqual(resolveCity('london').id, 'london');
  assert.strictEqual(resolveCity('EGLC').id, 'london');
  assert.strictEqual(resolveCity('New York').id, 'nyc');
  assert.strictEqual(resolveCity('KLGA').id, 'nyc');
  assert.strictEqual(resolveCity('Beijing').id, 'beijing');
});

test('resolveCity returns null for empty or unknown input', () => {
  assert.strictEqual(resolveCity(''), null);
  assert.strictEqual(resolveCity(undefined), null);
  assert.strictEqual(resolveCity(null), null);
  assert.strictEqual(resolveCity('Atlantis'), null);
});

test('rankTemperature returns ranked best model for London (C)', async (t) => {
  mockUpstreamFetch(t, { metarOptions: { station: 'EGLC', timezone: 'Europe/London', tempBase: 16 } });

  const city = resolveCity('London');
  const data = await rankTemperature(city, { unit: 'C' });

  assert.strictEqual(data.city.id, 'london');
  assert.strictEqual(data.city.name, 'London');
  assert.strictEqual(data.city.station, 'EGLC');
  assert.strictEqual(data.unit, 'C');
  assert.match(data.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isFinite(Date.parse(data.generatedAt)));
  assert.ok(data.observations.count >= 3);
  assert.ok(data.observations.latestTime);

  assert.ok(data.bestModel);
  assert.ok(data.bestModel.id);
  assert.ok(data.bestModel.modelIds.length >= 1);
  assert.ok(Number.isFinite(data.bestModel.maxTemperature.celsius));
  assert.strictEqual(data.bestModel.maxTemperature.unit, 'C');
  assert.strictEqual(data.bestModel.maxTemperature.value, Number(data.bestModel.maxTemperature.celsius.toFixed(1)));
  assert.ok(data.bestModel.accuracy.matches >= 3);
  assert.ok(Number.isFinite(data.bestModel.accuracy.maeC));
  assert.ok(Number.isFinite(data.bestModel.accuracy.score));

  assert.strictEqual(typeof data.averageImprovesBestModel, 'boolean');
  if (data.bestAverageModel) {
    assert.ok(Array.isArray(data.bestAverageModel.modelIds));
  }
});

test('rankTemperature converts temperatures to Fahrenheit for US cities', async (t) => {
  mockUpstreamFetch(t, { metarOptions: { station: 'KDAL', timezone: 'America/Chicago', tempBase: 20 } });

  const city = resolveCity('KDAL');
  const data = await rankTemperature(city, { unit: 'F' });

  assert.strictEqual(data.city.id, 'dallas');
  assert.strictEqual(data.unit, 'F');
  assert.ok(data.bestModel.maxTemperature.value > data.bestModel.maxTemperature.celsius);
  const expected = Number((data.bestModel.maxTemperature.celsius * 9 / 5 + 32).toFixed(1));
  assert.strictEqual(data.bestModel.maxTemperature.value, expected);
  assert.strictEqual(data.bestModel.maxTemperature.unit, 'F');
});

test('rankTemperature throws when observations are insufficient', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(url);
    if (u.hostname.includes('aviationweather')) return jsonResponse([]);
    if (u.hostname.includes('open-meteo')) return jsonResponse(buildForecastPayload(u.searchParams, {}));
    throw new Error('unexpected upstream url: ' + url);
  });

  const city = resolveCity('Warsaw');
  await assert.rejects(
    () => rankTemperature(city),
    /Need at least 3 same-day METAR observations/
  );
});