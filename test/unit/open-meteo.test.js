const { test } = require('node:test');
const assert = require('node:assert');
const { buildOpenMeteoUrl, fetchForecast, cachedFetchForecast } = require('../../lib/open-meteo');
const { buildForecastPayload } = require('../helpers/fixtures');

test('buildOpenMeteoUrl defaults to auto model with 2 forecast days', () => {
  const url = buildOpenMeteoUrl('EGLC', 'auto', '');
  const params = new URLSearchParams(new URL(url).search);
  assert.strictEqual(params.get('latitude'), '51.5053');
  assert.strictEqual(params.get('longitude'), '0.0553');
  assert.strictEqual(params.get('hourly'), 'temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover,cloud_cover_low');
  assert.strictEqual(params.get('forecast_days'), '2');
  assert.strictEqual(params.get('models'), null);
  assert.strictEqual(params.get('timezone'), 'Europe/London');
});

test('buildOpenMeteoUrl pins date with start_date/end_date and sets models', () => {
  const url = buildOpenMeteoUrl('EGLC', 'gfs_seamless', '2026-08-20');
  const params = new URLSearchParams(new URL(url).search);
  assert.strictEqual(params.get('start_date'), '2026-08-20');
  assert.strictEqual(params.get('end_date'), '2026-08-20');
  assert.strictEqual(params.get('models'), 'gfs_seamless');
  assert.strictEqual(params.get('forecast_days'), null);
});

test('fetchForecast returns json when hourly present', async () => {
  const payload = buildForecastPayload({ timezone: 'Europe/London', models: 'auto' });
  const data = await fetchForecast(async () => payload, 'EGLC', 'auto', '');
  assert.ok(Array.isArray(data.hourly.time));
  assert.ok(data.hourly.time.length > 0);
});

test('fetchForecast throws when hourly data is missing', async () => {
  await assert.rejects(
    () => fetchForecast(async () => ({ hourly: { time: [] } }), 'EGLC', 'auto', ''),
    /Open-Meteo missing hourly data/
  );
  await assert.rejects(
    () => fetchForecast(async () => ({}), 'EGLC', 'auto', ''),
    /Open-Meteo missing hourly data/
  );
});

test('cachedFetchForecast caches by station|model|date and reuses in-flight requests', async () => {
  let calls = 0;
  const fetchJson = async () => {
    calls += 1;
    return buildForecastPayload({ timezone: 'Europe/London', models: 'auto' });
  };

  const first = await cachedFetchForecast(fetchJson, 'EGLC', 'auto', '2026-08-20');
  assert.strictEqual(calls, 1);
  const second = await cachedFetchForecast(fetchJson, 'EGLC', 'auto', '2026-08-20');
  assert.strictEqual(calls, 1);
  const other = await cachedFetchForecast(fetchJson, 'EGLC', 'gfs_seamless', '2026-08-20');
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(first, second);
  assert.notStrictEqual(other, first);
});