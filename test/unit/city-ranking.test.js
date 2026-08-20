const { test } = require('node:test');
const assert = require('node:assert');
const { computeCityCategories, computeCityCategory, parseHourlyRows } = require('../../lib/city-ranking');
const { timesForDates, hourlyWithModels } = require('../helpers/fixtures');

const DAY = '2026-08-20';

function rowsFor(rule) {
  const times = timesForDates([DAY]);
  const hourly = hourlyWithModels(times, ['auto'], rule);
  return parseHourlyRows(hourly, DAY);
}

test('computeCityCategory: green when clear with low cloud', () => {
  const rows = rowsFor({ cloud: 20, low: 10 });
  assert.strictEqual(computeCityCategory(rows), 1);
});

test('computeCityCategory: blue when high cloud cover but low cloud below 50', () => {
  const rows = rowsFor({ cloud: 80, low: 20 });
  assert.strictEqual(computeCityCategory(rows), 2);
});

test('computeCityCategory: yellow when low cloud cover above 50', () => {
  const rows = rowsFor({ cloud: 30, low: 70 });
  assert.strictEqual(computeCityCategory(rows), 3);
});

test('computeCityCategory: red when 3+ rainy hours', () => {
  const rows = rowsFor({ cloud: 20, low: 10, rainAt: [9, 10, 11] });
  assert.strictEqual(computeCityCategory(rows), 4);
});

test('computeCityCategory: red beats cloud thresholds', () => {
  const rows = rowsFor({ cloud: 90, low: 90, rainAt: [13, 14, 15] });
  assert.strictEqual(computeCityCategory(rows), 4);
});

test('computeCityCategory: empty rows fall back to green', () => {
  assert.strictEqual(computeCityCategory([]), 1);
});

test('parseHourlyRows only returns rows for the requested date', () => {
  const times = [...timesForDates(['2026-08-19']), ...timesForDates([DAY])];
  const hourly = hourlyWithModels(times, ['auto'], {});
  const rows = parseHourlyRows(hourly, DAY);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.time.startsWith(DAY)));
  assert.ok(rows.every((row) => Number.isFinite(row.temp)));
});

test('computeCityCategories maps cities to categories by latitude rule', async () => {
  const ruleForLat = (lat) => {
    if (lat > 40) return { cloud: 20, low: 10 };
    if (lat > 20) return { cloud: 80, low: 20 };
    if (lat > 0) return { cloud: 80, low: 70 };
    return { cloud: 20, low: 10, rainAt: [9, 10, 11, 12] };
  };

  const fetchJson = async (url) => {
    const params = new URLSearchParams(new URL(url).search);
    const lat = Number(params.get('latitude'));
    const date = params.get('start_date') || params.get('end_date');
    const times = timesForDates([date]);
    const hourly = hourlyWithModels(times, ['auto'], ruleForLat(lat));
    return { hourly };
  };

  const categories = await computeCityCategories(fetchJson);

  assert.strictEqual(categories.london.category, 1);
  assert.strictEqual(categories.hongkong.category, 2);
  assert.strictEqual(categories.singapore.category, 3);
  assert.strictEqual(categories.saopaulo.category, 4);

  const allCities = Object.keys(require('../../assets/js/dashboard/config').CITIES);
  for (const cityId of allCities) {
    assert.ok(categories[cityId], `missing category for ${cityId}`);
    assert.ok([1, 2, 3, 4].includes(categories[cityId].category));
  }
});