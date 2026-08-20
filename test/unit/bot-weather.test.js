const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildSingleWeatherResponse,
  buildBatchWeatherResponse,
  buildWeatherItem,
} = require('../../lib/bot-weather');
const { setTestModels } = require('../../data/test-models');
const { buildForecastPayload, dateKeyForTz } = require('../helpers/fixtures');

const WEATHER_MODELS = require('../../assets/js/dashboard/config').WEATHER_MODELS;

function fetchJsonMock(url) {
  const params = new URLSearchParams(new URL(url).search);
  const timezone = params.get('timezone') || 'Europe/London';
  return Promise.resolve(buildForecastPayload(params, { cloud: 20, low: 10 }));
}

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

test('buildSingleWeatherResponse returns v2.0 schema with model slots', async () => {
  setTestModels('london', { basic: 'ecmwf_ifs025', additional: 'icon_seamless', test: 'gem_seamless' });
  const date = dateKeyForTz('Europe/London');

  const response = await buildSingleWeatherResponse({ city: 'London', date }, fetchJsonMock);

  assert.strictEqual(response.schema_version, '2.0');
  assert.ok(Number.isFinite(Date.parse(response.generated_at)));
  assert.strictEqual(response.items.length, 1);
  assert.deepStrictEqual(response.errors, []);

  const item = response.items[0];
  assert.deepStrictEqual(item.city, { id: 'london', name: 'London', station: 'EGLC', timezone: 'Europe/London' });
  assert.strictEqual(item.date, date);
  assert.strictEqual(item.unit, 'C');
  assert.strictEqual(item.category, 1);
  assert.strictEqual(item.category_label, 'green');

  const { basic, additional, test } = item.models;
  assert.strictEqual(basic.id, 'ecmwf_ifs025');
  assert.strictEqual(basic.name, WEATHER_MODELS.ecmwf_ifs025);
  assert.strictEqual(additional.id, 'icon_seamless');
  assert.strictEqual(test.id, 'gem_seamless');

  assert.ok(Number.isFinite(basic.max_temp_today_c));
  assert.match(basic.max_temp_today_time, ISO_OFFSET);
  assert.ok(Number.isFinite(basic.max_temp_tomorrow_c));
  assert.match(basic.max_temp_tomorrow_time, ISO_OFFSET);

  assert.ok(basic.hourly.today.length >= 8);
  assert.ok(basic.hourly.tomorrow.length >= 8);
  for (const row of basic.hourly.today) {
    assert.ok(row.hour >= 8 && row.hour <= 22);
    assert.match(row.time, ISO_OFFSET);
    assert.ok(Number.isFinite(row.temperature_c));
    assert.ok(Number.isFinite(row.cloud_cover));
    assert.ok(Number.isFinite(row.cloud_cover_low));
    assert.ok(Number.isFinite(row.precipitation));
  }

  const todayMax = Math.max(...basic.hourly.today.map((r) => r.temperature_c));
  assert.strictEqual(basic.max_temp_today_c, todayMax);

  assert.deepStrictEqual(item.data_quality, { status: 'ok', warnings: [] });
});

test('unconfigured slots are null', async () => {
  setTestModels('london', { basic: '', additional: '', test: '' });
  const date = dateKeyForTz('Europe/London');

  const response = await buildSingleWeatherResponse({ city: 'london', date }, fetchJsonMock);
  const models = response.items[0].models;
  assert.strictEqual(models.basic, null);
  assert.strictEqual(models.additional, null);
  assert.strictEqual(models.test, null);
});

test('station-only requests resolve to a city fallback', async () => {
  const date = dateKeyForTz('Europe/London');
  const response = await buildSingleWeatherResponse({ station: 'EGLC', date }, fetchJsonMock);
  const item = response.items[0];
  assert.strictEqual(item.city.id, 'eglc');
  assert.strictEqual(item.city.station, 'EGLC');
});

test('missing date is rejected', async () => {
  await assert.rejects(
    () => buildSingleWeatherResponse({ city: 'London' }, fetchJsonMock),
    /Invalid or missing date/
  );
  await assert.rejects(
    () => buildSingleWeatherResponse({ city: 'London', date: 'not-a-date' }, fetchJsonMock),
    /Invalid or missing date/
  );
});

test('unknown city and station is rejected', async () => {
  const date = dateKeyForTz('Europe/London');
  await assert.rejects(
    () => buildSingleWeatherResponse({ city: 'atlantis', date }, fetchJsonMock),
    /Unknown city or station/
  );
  await assert.rejects(
    () => buildSingleWeatherResponse({ city: '', date }, fetchJsonMock),
    /Unknown city or station/
  );
  await assert.rejects(
    () => buildSingleWeatherResponse({ date }, fetchJsonMock),
    /Unknown city or station/
  );
});

test('batch response builds items per city and collects errors', async () => {
  setTestModels('london', { basic: 'ecmwf_ifs025', additional: '', test: '' });
  const date = dateKeyForTz('Europe/London');

  const response = await buildBatchWeatherResponse({ date, cities: ['London', 'Beijing'] }, fetchJsonMock);
  assert.strictEqual(response.items.length, 2);
  assert.deepStrictEqual(response.items.map((item) => item.city.id), ['london', 'beijing']);
  assert.deepStrictEqual(response.errors, []);

  const byIds = await buildBatchWeatherResponse({ date, city_ids: ['london', 'atlantis'] }, fetchJsonMock);
  assert.strictEqual(byIds.items.length, 1);
  assert.strictEqual(byIds.items[0].city.id, 'london');
  assert.strictEqual(byIds.errors.length, 1);
  assert.strictEqual(byIds.errors[0].index, 1);
  assert.match(byIds.errors[0].error, /Unknown city or station/);
});

test('batch response requires cities or city_ids', async () => {
  const date = dateKeyForTz('Europe/London');
  await assert.rejects(
    () => buildBatchWeatherResponse({ date }, fetchJsonMock),
    /requires cities or city_ids/
  );
  await assert.rejects(
    () => buildBatchWeatherResponse({}, fetchJsonMock),
    /requires cities or city_ids/
  );
});

test('buildWeatherItem surfaces date, category and unit', async () => {
  setTestModels('london', { basic: 'ukmo_seamless', additional: '', test: '' });
  const date = dateKeyForTz('Europe/London');
  const item = await buildWeatherItem({ city: 'London', date }, fetchJsonMock);
  assert.strictEqual(item.city.name, 'London');
  assert.strictEqual(item.date, date);
  assert.strictEqual(item.unit, 'C');
  assert.strictEqual(item.models.basic.id, 'ukmo_seamless');
});