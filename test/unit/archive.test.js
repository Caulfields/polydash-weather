const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cityTodayKey,
  parseUsMetarTenths,
  parseMetarWeather,
  parseMetarRowsFromPayload,
  parseForecastRows,
  buildSnapshotFromPayloads,
  shouldRunScheduledSave,
  sanitizeSnapshot,
  createArchiveStore,
  cityModelIds,
  MAX_ARCHIVES_PER_CITY,
} = require('../../lib/archive');
const { buildForecastPayload, metarPayload, timesForDates, hourlyWithModels } = require('../helpers/fixtures');
const CITIES = require('../../assets/js/dashboard/config').CITIES;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
}

function londonMetarPayload() {
  return metarPayload({ station: 'EGLC', timezone: 'Europe/London' });
}

function londonForecastPayload() {
  return buildForecastPayload(new URLSearchParams({ timezone: 'Europe/London', models: 'auto' }), {});
}

test('cityTodayKey returns city-local date', () => {
  const date = new Date('2026-08-20T12:00:00Z');
  assert.strictEqual(cityTodayKey('Europe/London', date), '2026-08-20');
});

test('parseUsMetarTenths parses signed tenths', () => {
  assert.deepStrictEqual(parseUsMetarTenths('T01031012'), { tempC: 10.3, dewpC: -1.2 });
  assert.strictEqual(parseUsMetarTenths('no group'), null);
});

test('parseMetarWeather decodes weather and sky tokens', () => {
  assert.strictEqual(parseMetarWeather('EGLC 22008KT RA'), 'rain');
  assert.strictEqual(parseMetarWeather('EGLC BKN020'), 'cloudy');
  assert.strictEqual(parseMetarWeather('EGLC CAVOK'), 'clear');
});

test('parseMetarRowsFromPayload builds rows with timeMs and weather', () => {
  const city = CITIES.london;
  const rows = parseMetarRowsFromPayload(londonMetarPayload(), city);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => Number.isFinite(r.timeMs) && Number.isFinite(r.temp)));
  assert.ok(rows.every((r) => typeof r.weather === 'string'));
  const sorted = rows.every((r, i) => i === 0 || rows[i - 1].timeMs <= r.timeMs);
  assert.ok(sorted);
});

test('parseForecastRows filters to date and includes fields', () => {
  const payload = londonForecastPayload();
  const date = cityTodayKey('Europe/London');
  const rows = parseForecastRows(payload.hourly, date, 'auto');
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.time.startsWith(date)));
  assert.ok(rows.every((r) => Number.isFinite(r.temp)));
  assert.ok('windSpeed' in rows[0]);
  assert.ok('cloudCover' in rows[0]);
  assert.ok('weatherCode' in rows[0]);
});

test('buildSnapshotFromPayloads produces serializable snapshot', () => {
  const city = CITIES.london;
  const date = cityTodayKey(city.timezone);
  const now = new Date('2026-08-20T10:00:00Z');
  const snapshot = buildSnapshotFromPayloads({
    city,
    dateKey: date,
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    additionalPayload: null,
    testPayload: null,
    now,
  });
  assert.strictEqual(snapshot.cityId, 'london');
  assert.strictEqual(snapshot.dateKey, date);
  assert.strictEqual(snapshot.forecastDay, 'today');
  assert.strictEqual(snapshot.model, 'auto');
  assert.strictEqual(snapshot.savedAtISO, now.toISOString());
  assert.ok(Array.isArray(snapshot.metarRows));
  assert.ok(Array.isArray(snapshot.forecastRows));
  assert.ok(snapshot.forecastRows.length > 0);
  assert.strictEqual(snapshot.metarObsTime, snapshot.metarRows[snapshot.metarRows.length - 1].timeMs);
  assert.ok(snapshot.savedHourFrac >= 0 && snapshot.savedHourFrac < 24);
  assert.ok(JSON.stringify(snapshot).length > 0);
});

test('buildSnapshotFromPayloads computes additional/test max temps', () => {
  const city = CITIES.london;
  const date = cityTodayKey(city.timezone);
  const snapshot = buildSnapshotFromPayloads({
    city,
    dateKey: date,
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    additionalPayload: londonForecastPayload(),
    testPayload: londonForecastPayload(),
    now: new Date(),
  });
  assert.ok(snapshot.additionalMaxTempC != null);
  assert.ok(snapshot.testMaxTempC != null);
});

test('shouldRunScheduledSave respects enabled, time and once-per-day', () => {
  const settings = { enabled: true, time: '09:00', lastSavedDate: '' };
  const tz = 'Europe/London';

  // London in August is UTC+1, so 09:00 local = 08:00 UTC.
  const before = new Date('2026-08-20T07:30:00Z');
  assert.strictEqual(shouldRunScheduledSave(settings, tz, before), false);

  const at = new Date('2026-08-20T09:30:00Z');
  assert.strictEqual(shouldRunScheduledSave(settings, tz, at), true);

  const afterSave = { ...settings, lastSavedDate: '2026-08-20' };
  assert.strictEqual(shouldRunScheduledSave(afterSave, tz, at), false);
});

test('shouldRunScheduledSave requires enabled and valid time', () => {
  const tz = 'Europe/London';
  const now = new Date('2026-08-20T12:00:00Z');
  assert.strictEqual(shouldRunScheduledSave({ enabled: false, time: '09:00' }, tz, now), false);
  assert.strictEqual(shouldRunScheduledSave({ enabled: true, time: 'bad' }, tz, now), false);
  assert.strictEqual(shouldRunScheduledSave(null, tz, now), false);
});

test('archive store persists settings and snapshots across instances', async () => {
  const dir = tempDir();
  const store1 = createArchiveStore(dir);
  const settings = await store1.setSettings('london', { enabled: true, time: '09:00' });
  assert.strictEqual(settings.enabled, true);
  assert.strictEqual(settings.time, '09:00');

  const city = CITIES.london;
  const snapshot = buildSnapshotFromPayloads({
    city,
    dateKey: cityTodayKey(city.timezone),
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    now: new Date('2026-08-20T10:00:00Z'),
  });
  const added = await store1.addSnapshot(snapshot);
  assert.ok(added.id);

  const store2 = createArchiveStore(dir);
  const got = await store2.getSnapshot(added.id);
  assert.ok(got);
  assert.strictEqual(got.cityId, 'london');
  assert.deepStrictEqual(got.metarRows, snapshot.metarRows);

  const list = await store2.listSnapshots();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, added.id);
  assert.strictEqual(list[0].cityName, 'London');
});

test('archive store listSnapshots filters by city and sorts newest first', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  const city = CITIES.london;
  const mk = (ms) => buildSnapshotFromPayloads({
    city,
    dateKey: '2026-08-20',
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    now: new Date(ms),
  });
  await store.addSnapshot(mk(1000));
  await store.addSnapshot(mk(3000));
  await store.addSnapshot(mk(2000));

  const all = await store.listSnapshots();
  assert.strictEqual(all.length, 3);
  assert.strictEqual(all[0].savedAtMs, 3000);
  assert.strictEqual(all[1].savedAtMs, 2000);
  assert.strictEqual(all[2].savedAtMs, 1000);

  const filtered = await store.listSnapshots('london');
  assert.strictEqual(filtered.length, 3);
  assert.strictEqual((await store.listSnapshots('paris')).length, 0);
});

test('archive store prunes snapshots beyond the per-city cap', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  const city = CITIES.london;
  for (let i = 0; i < MAX_ARCHIVES_PER_CITY + 5; i += 1) {
    await store.addSnapshot(buildSnapshotFromPayloads({
      city,
      dateKey: '2026-08-20',
      forecastDay: 'today',
      model: 'auto',
      metarPayload: londonMetarPayload(),
      forecastPayload: londonForecastPayload(),
      now: new Date(i),
    }));
  }
  const list = await store.listSnapshots('london');
  assert.strictEqual(list.length, MAX_ARCHIVES_PER_CITY);
});

test('archive store deleteSnapshot removes it', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  const city = CITIES.london;
  const added = await store.addSnapshot(buildSnapshotFromPayloads({
    city,
    dateKey: '2026-08-20',
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    now: new Date(),
  }));
  await store.deleteSnapshot(added.id);
  assert.strictEqual(await store.getSnapshot(added.id), null);
});

test('sanitizeSnapshot rejects malformed input', () => {
  assert.strictEqual(sanitizeSnapshot(null), null);
  assert.strictEqual(sanitizeSnapshot([]), null);
  assert.strictEqual(sanitizeSnapshot({}), null);
});

test('auto-save updates lastSavedDate when the city has settings', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  await store.setSettings('london', { enabled: true, time: '09:00' });
  const city = CITIES.london;
  const date = cityTodayKey(city.timezone);
  await store.addSnapshot(buildSnapshotFromPayloads({
    city,
    dateKey: date,
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    now: new Date(),
  }));
  const settings = await store.getSettings();
  assert.strictEqual(settings.london.lastSavedDate, date);
});

test('cityModelIds returns city model options without auto', () => {
  const ids = cityModelIds(CITIES.london);
  assert.ok(Array.isArray(ids));
  assert.ok(ids.length > 0);
  assert.ok(!ids.includes('auto'));
  assert.ok(ids.every((id) => CITIES.london.modelOptions.includes(id)));
});

test('buildSnapshotFromPayloads stores all models from modelsPayloads', () => {
  const city = CITIES.london;
  const date = cityTodayKey(city.timezone);
  const modelIds = cityModelIds(city);
  const modelsPayloads = {};
  for (const id of modelIds) {
    modelsPayloads[id] = buildForecastPayload(
      new URLSearchParams({ timezone: city.timezone, models: id }),
      {}
    );
  }
  const snapshot = buildSnapshotFromPayloads({
    city,
    dateKey: date,
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    modelsPayloads,
    now: new Date(),
  });
  assert.ok(snapshot.models);
  for (const id of modelIds) {
    assert.ok(Array.isArray(snapshot.models[id]), 'missing model ' + id);
    assert.ok(snapshot.models[id].length > 0, 'empty rows for ' + id);
    assert.ok(snapshot.models[id].every((r) => Number.isFinite(r.temp)));
  }
  assert.strictEqual(Object.keys(snapshot.models).length, modelIds.length);
});

test('buildSnapshotFromPayloads ignores empty model payloads', () => {
  const city = CITIES.london;
  const date = cityTodayKey(city.timezone);
  const snapshot = buildSnapshotFromPayloads({
    city,
    dateKey: date,
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    modelsPayloads: { ecmwf_ifs: { hourly: { time: [], temperature_2m: [] } } },
    now: new Date(),
  });
  assert.deepStrictEqual(snapshot.models, {});
});

test('archive store summary includes modelCount', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  const city = CITIES.london;
  const date = cityTodayKey(city.timezone);
  const modelsPayloads = {};
  for (const id of cityModelIds(city)) {
    modelsPayloads[id] = buildForecastPayload(
      new URLSearchParams({ timezone: city.timezone, models: id }),
      {}
    );
  }
  const snapshot = buildSnapshotFromPayloads({
    city,
    dateKey: date,
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    modelsPayloads,
    now: new Date(),
  });
  const added = await store.addSnapshot(snapshot);
  const summary = store.summary(added);
  assert.strictEqual(summary.modelCount, cityModelIds(city).length);
});

test('buildSnapshotFromPayloads stores auto (best match) rows in models', () => {
  const city = CITIES.london;
  const date = cityTodayKey(city.timezone);
  const modelsPayloads = {
    auto: buildForecastPayload(new URLSearchParams({ timezone: city.timezone, models: 'auto' }), {}),
  };
  const snapshot = buildSnapshotFromPayloads({
    city,
    dateKey: date,
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    modelsPayloads,
    now: new Date(),
  });
  assert.ok(Array.isArray(snapshot.models.auto));
  assert.ok(snapshot.models.auto.length > 0);
});

test('settings persist category and keepForever, defaulting to none', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  const s1 = await store.setSettings('london', { enabled: true, time: '09:00' });
  assert.strictEqual(s1.category, '');
  assert.strictEqual(s1.keepForever, false);

  const s2 = await store.setSettings('london', { enabled: true, time: '09:00', category: 'green', keepForever: true });
  assert.strictEqual(s2.category, 'green');
  assert.strictEqual(s2.keepForever, true);

  const bad = await store.setSettings('paris', { enabled: true, time: '09:00', category: 'purple' });
  assert.strictEqual(bad.category, '');

  const get = await store.getSettings();
  assert.strictEqual(get.london.category, 'green');
  assert.strictEqual(get.london.keepForever, true);
});

test('snapshot stores category and keepForever, and inherits them from settings', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  await store.setSettings('london', { enabled: true, time: '09:00', category: 'red', keepForever: true });

  const added = await store.addSnapshot(buildSnapshotFromPayloads({
    city: CITIES.london,
    dateKey: cityTodayKey(CITIES.london.timezone),
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    now: new Date(),
  }));
  assert.strictEqual(added.category, 'red');
  assert.strictEqual(added.keepForever, true);

  const summary = store.summary(added);
  assert.strictEqual(summary.category, 'red');
  assert.strictEqual(summary.keepForever, true);
});

test('updateSnapshot updates category and keepForever', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  const added = await store.addSnapshot(buildSnapshotFromPayloads({
    city: CITIES.london,
    dateKey: cityTodayKey(CITIES.london.timezone),
    forecastDay: 'today',
    model: 'auto',
    metarPayload: londonMetarPayload(),
    forecastPayload: londonForecastPayload(),
    now: new Date(),
  }));
  assert.strictEqual(added.category, '');
  assert.strictEqual(added.keepForever, false);

  await store.updateSnapshot(added.id, { category: 'green', keepForever: true });
  const got = await store.getSnapshot(added.id);
  assert.strictEqual(got.category, 'green');
  assert.strictEqual(got.keepForever, true);

  assert.strictEqual(await store.updateSnapshot('missing-id', { keepForever: true }), null);
});

test('prune keeps kept-forever snapshots beyond the per-city cap', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  const city = CITIES.london;

  // Oldest snapshot marked keepForever.
  await store.addSnapshot({
    ...buildSnapshotFromPayloads({
      city,
      dateKey: '2026-08-20',
      forecastDay: 'today',
      model: 'auto',
      metarPayload: londonMetarPayload(),
      forecastPayload: londonForecastPayload(),
      now: new Date(0),
    }),
    keepForever: true,
  });

  for (let i = 0; i < MAX_ARCHIVES_PER_CITY + 5; i += 1) {
    await store.addSnapshot(buildSnapshotFromPayloads({
      city,
      dateKey: '2026-08-20',
      forecastDay: 'today',
      model: 'auto',
      metarPayload: londonMetarPayload(),
      forecastPayload: londonForecastPayload(),
      now: new Date(i + 1),
    }));
  }

  const list = await store.listSnapshots('london');
  assert.strictEqual(list.length, MAX_ARCHIVES_PER_CITY + 1);
  assert.ok(list.some((s) => s.savedAtMs === 0 && s.keepForever), 'kept-forever snapshot survived cap prune');
});

test('prune skips kept-forever snapshots older than retentionDays', async () => {
  const dir = tempDir();
  const store = createArchiveStore(dir);
  await store.setSettings('london', { enabled: true, time: '09:00', retentionDays: 1 });
  const city = CITIES.london;
  const mk = (ms, extra) => ({
    ...buildSnapshotFromPayloads({
      city,
      dateKey: '2026-07-01',
      forecastDay: 'today',
      model: 'auto',
      metarPayload: londonMetarPayload(),
      forecastPayload: londonForecastPayload(),
      now: new Date(ms),
    }),
    ...extra,
  });

  await store.addSnapshot(mk(Date.now() - 30 * 86400000, { keepForever: true }));
  await store.addSnapshot(mk(Date.now() - 31 * 86400000));

  const list = await store.listSnapshots('london');
  const kept = list.find((s) => s.keepForever);
  assert.ok(kept, 'kept-forever snapshot survives retention prune');
  assert.strictEqual(list.filter((s) => !s.keepForever).length, 0, 'non-kept old snapshot was pruned');
});
