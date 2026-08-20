const { test } = require('node:test');
const assert = require('node:assert');
const { STATIONS, normalizeStation } = require('../../data/weather-stations');

test('normalizeStation uppercases and strips non-alphanumerics', () => {
  assert.strictEqual(normalizeStation('eglc'), 'EGLC');
  assert.strictEqual(normalizeStation('  zbaa '), 'ZBAA');
  assert.strictEqual(normalizeStation('k-dal'), 'KDAL');
  assert.strictEqual(normalizeStation('EGLC extra'), 'EGLC');
});

test('normalizeStation truncates to 4 chars', () => {
  assert.strictEqual(normalizeStation('ABCDEF'), 'ABCD');
});

test('normalizeStation empty input resolves to empty string', () => {
  assert.strictEqual(normalizeStation(''), '');
  assert.strictEqual(normalizeStation(undefined), '');
  assert.strictEqual(normalizeStation(null), '');
  assert.strictEqual(normalizeStation('   '), '');
});

test('STATIONS contains expected airports with valid coords and timezone', () => {
  for (const key of ['EGLC', 'ZBAA', 'KDAL', 'KLGA', 'RJTT']) {
    const station = STATIONS[key];
    assert.ok(station, `missing station ${key}`);
    assert.ok(Number.isFinite(station.lat) && station.lat >= -90 && station.lat <= 90, `${key} lat`);
    assert.ok(Number.isFinite(station.lon) && station.lon >= -180 && station.lon <= 180, `${key} lon`);
    assert.ok(station.timezone && station.timezone.includes('/'), `${key} timezone`);
  }
});

test('STATIONS keys are valid 4-letter ICAO codes', () => {
  for (const key of Object.keys(STATIONS)) {
    assert.match(key, /^[A-Z0-9]{4}$/, `bad key ${key}`);
  }
});

test('every configured city METAR exists in STATIONS', () => {
  const { CITIES } = require('../../assets/js/dashboard/config');
  for (const city of Object.values(CITIES)) {
    assert.ok(STATIONS[city.metar], `city ${city.id} references unknown station ${city.metar}`);
  }
});