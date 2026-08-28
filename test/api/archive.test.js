const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { buildForecastPayload, metarPayload, dateKeyForTz } = require('../helpers/fixtures');
const { jsonResponse, mockHttpsGet } = require('../helpers/mocks');
const { cityTodayKey, buildSnapshotFromPayloads, cityModelIds } = require('../../lib/archive');
const CITIES = require('../../assets/js/dashboard/config').CITIES;

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-api-test-'));
process.env.ARCHIVE_DATA_DIR = testDir;

const app = require('../../server');

let server;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
});

after(() => {
  server.close();
});

function apiRequest(pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path: pathname, method },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function makeSnapshotPayload(city = CITIES.london, ms = Date.now()) {
  return buildSnapshotFromPayloads({
    city,
    dateKey: cityTodayKey(city.timezone),
    forecastDay: 'today',
    model: 'auto',
    metarPayload: metarPayload({ station: city.metar, timezone: city.timezone }),
    forecastPayload: buildForecastPayload(new URLSearchParams({ timezone: city.timezone, models: 'auto' }), {}),
    now: new Date(ms),
  });
}

test('GET /api/archive/settings returns object', async () => {
  const res = await apiRequest('/api/archive/settings');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(typeof JSON.parse(res.body), 'object');
});

test('POST /api/archive/settings validates time and persists', async () => {
  const ok = await apiRequest('/api/archive/settings', {
    method: 'POST',
    body: { cityId: 'london', enabled: true, time: '09:00' },
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(JSON.parse(ok.body).settings.enabled, true);

  const bad = await apiRequest('/api/archive/settings', {
    method: 'POST',
    body: { cityId: 'london', enabled: true, time: 'not-a-time' },
  });
  assert.strictEqual(bad.status, 400);

  const get = await apiRequest('/api/archive/settings');
  assert.strictEqual(JSON.parse(get.body).london.time, '09:00');
});

test('POST /api/archive/snapshots stores and GET returns it', async () => {
  const payload = makeSnapshotPayload();
  const post = await apiRequest('/api/archive/snapshots', { method: 'POST', body: payload });
  assert.strictEqual(post.status, 200);
  const { snapshot } = JSON.parse(post.body);
  assert.ok(snapshot.id);
  assert.strictEqual(snapshot.cityId, 'london');

  const list = await apiRequest('/api/archive/snapshots');
  const listBody = JSON.parse(list.body);
  assert.ok(listBody.snapshots.some((s) => s.id === snapshot.id));

  const byId = await apiRequest(`/api/archive/snapshots/${snapshot.id}`);
  assert.strictEqual(byId.status, 200);
  assert.strictEqual(JSON.parse(byId.body).snapshot.id, snapshot.id);
});

test('GET /api/archive/snapshots?city= filters by city', async () => {
  await apiRequest('/api/archive/snapshots', { method: 'POST', body: makeSnapshotPayload(CITIES.london, 100) });
  await apiRequest('/api/archive/snapshots', { method: 'POST', body: makeSnapshotPayload(CITIES.paris, 200) });

  const london = await apiRequest('/api/archive/snapshots?city=london');
  const londonBody = JSON.parse(london.body);
  assert.ok(londonBody.snapshots.length > 0);
  assert.ok(londonBody.snapshots.every((s) => s.cityId === 'london'));
});

test('DELETE /api/archive/snapshots/:id removes snapshot', async () => {
  const payload = makeSnapshotPayload(CITIES.london, 300);
  const post = await apiRequest('/api/archive/snapshots', { method: 'POST', body: payload });
  const { snapshot } = JSON.parse(post.body);

  const del = await apiRequest(`/api/archive/snapshots/${snapshot.id}`, { method: 'DELETE' });
  assert.strictEqual(del.status, 200);

  const byId = await apiRequest(`/api/archive/snapshots/${snapshot.id}`);
  assert.strictEqual(byId.status, 404);
});

test('PATCH /api/archive/snapshots/:id updates category and keepForever', async () => {
  const post = await apiRequest('/api/archive/snapshots', { method: 'POST', body: makeSnapshotPayload(CITIES.london, 400) });
  const { snapshot } = JSON.parse(post.body);

  const patch = await apiRequest(`/api/archive/snapshots/${snapshot.id}`, {
    method: 'PATCH',
    body: { snapshot: { category: 'green', keepForever: true } },
  });
  assert.strictEqual(patch.status, 200);
  const patched = JSON.parse(patch.body).snapshot;
  assert.strictEqual(patched.category, 'green');
  assert.strictEqual(patched.keepForever, true);

  const byId = await apiRequest(`/api/archive/snapshots/${snapshot.id}`);
  assert.strictEqual(JSON.parse(byId.body).snapshot.keepForever, true);

  const missing = await apiRequest('/api/archive/snapshots/does-not-exist', {
    method: 'PATCH',
    body: { snapshot: { keepForever: true } },
  });
  assert.strictEqual(missing.status, 404);
});

test('GET /api/archive/snapshots/:id returns 404 for unknown id', async () => {
  const res = await apiRequest('/api/archive/snapshots/does-not-exist');
  assert.strictEqual(res.status, 404);
});

test('POST /api/archive/snapshots expands snapshot with all city models', async (t) => {
  mockHttpsGet(t, {
    byUrl(url) {
      if (url.includes('aviationweather')) {
        return { body: metarPayload({ station: 'EGLC', timezone: 'Europe/London' }) };
      }
      if (url.includes('open-meteo')) {
        const params = new URLSearchParams(new URL(url).search);
        return { body: buildForecastPayload(params, {}) };
      }
      return { body: {} };
    },
  });

  const city = CITIES.london;
  const payload = buildSnapshotFromPayloads({
    city,
    dateKey: cityTodayKey(city.timezone),
    forecastDay: 'today',
    model: 'auto',
    metarPayload: metarPayload({ station: city.metar, timezone: city.timezone }),
    forecastPayload: buildForecastPayload(new URLSearchParams({ timezone: city.timezone, models: 'auto' }), {}),
    now: new Date(),
  });

  const post = await apiRequest('/api/archive/snapshots', { method: 'POST', body: payload });
  assert.strictEqual(post.status, 200);
  const { snapshot } = JSON.parse(post.body);

  const byId = await apiRequest('/api/archive/snapshots/' + snapshot.id);
  const got = JSON.parse(byId.body).snapshot;
  const expectedIds = [...cityModelIds(city), 'auto'];
  assert.ok(got.models);
  assert.strictEqual(Object.keys(got.models).length, expectedIds.length);
  for (const id of expectedIds) {
    assert.ok(Array.isArray(got.models[id]), 'missing model ' + id);
    assert.ok(got.models[id].length > 0, 'empty rows for ' + id);
  }
});
