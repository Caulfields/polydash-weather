const { test, expect } = require('@playwright/test');
const {
  timesForDates,
  hourlyWithModels,
  metarPayload,
  dateKeyForTz,
} = require('../helpers/fixtures');

const CITIES = require('../../assets/js/dashboard/config').CITIES;

const archiveState = {
  settings: {},
  snapshots: [],
};

function forecastPayloadFor(url) {
  const params = new URLSearchParams(new URL(url).search);
  const date = params.get('date') || params.get('start_date') || dateKeyForTz('UTC');
  const model = params.get('model') || 'auto';
  const models = model === 'auto' ? ['auto'] : [model];
  const times = timesForDates([date]);
  const hourly = hourlyWithModels(times, models, { rainAt: [13], cloud: 40, low: 20, windBase: 22 });
  return { hourly };
}

async function setupRoutes(page) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const urlObj = new URL(url);
    const p = urlObj.pathname;

    if (p === '/api/test-models') {
      if (method === 'POST') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }

    if (p === '/api/city-ranking') {
      const categories = {};
      for (const cityId of Object.keys(CITIES)) categories[cityId] = { category: 1 };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(categories) });
      return;
    }

    if (p === '/api/forecast') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(forecastPayloadFor(url)) });
      return;
    }

    if (p === '/api/metar') {
      const station = urlObj.searchParams.get('station') || 'ZBAA';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(metarPayload({ station })) });
      return;
    }

    if (p === '/api/archive/settings') {
      if (method === 'POST') {
        const body = route.request().postDataJSON() || {};
        archiveState.settings[body.cityId] = { enabled: !!body.enabled, time: body.time || '', lastSavedDate: '' };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(archiveState.settings[body.cityId]) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(archiveState.settings) });
      return;
    }

    if (p === '/api/archive/snapshots') {
      if (method === 'POST') {
        const body = route.request().postDataJSON() || {};
        const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const saved = { ...body, id };
        archiveState.snapshots.push(saved);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, snapshot: { ...saved } }) });
        return;
      }
      const summaries = archiveState.snapshots.map((s) => ({
        id: s.id,
        cityId: s.cityId,
        cityName: s.cityName,
        metar: s.metar,
        dateKey: s.dateKey,
        savedAtISO: s.savedAtISO,
        savedAtMs: s.savedAtMs,
        savedHourFrac: s.savedHourFrac,
        model: s.model,
        modelLabel: s.modelLabel,
        metarCount: (s.metarRows || []).length,
        forecastCount: (s.forecastRows || []).length,
        modelCount: s.models ? Object.keys(s.models).length : 0,
      }));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ snapshots: summaries }) });
      return;
    }

    const idMatch = p.match(/^\/api\/archive\/snapshots\/(.+)$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]);
      if (method === 'DELETE') {
        archiveState.snapshots = archiveState.snapshots.filter((s) => s.id !== id);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      const found = archiveState.snapshots.find((s) => s.id === id);
      if (found) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ snapshot: found }) });
      } else {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found' }) });
      }
      return;
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

test.beforeEach(async ({ page }) => {
  archiveState.settings = {};
  archiveState.snapshots = [];
  await setupRoutes(page);
  await page.goto('/');
  await page.waitForSelector('.city-card');
  await page.waitForFunction(() => {
    const loading = document.getElementById('omLoading');
    return loading && loading.style.display === 'none';
  });
});

test('manual save stores a snapshot and shows it in the archive panel', async ({ page }) => {
  await page.waitForFunction(() => document.getElementById('forecastMaxTemp').textContent !== '');

  await page.locator('#manualSaveBtn').click();
  await expect.poll(() => archiveState.snapshots.length).toBe(1);

  await page.locator('#archivePanelBtn').click();
  await expect(page.locator('#archivePanel')).toBeVisible();
  const rows = page.locator('.archive-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Beijing');
});

test('opening a snapshot enters archive view with banner', async ({ page }) => {
  await page.waitForFunction(() => document.getElementById('forecastMaxTemp').textContent !== '');
  await page.locator('#manualSaveBtn').click();
  await expect.poll(() => archiveState.snapshots.length).toBe(1);

  await page.locator('#archivePanelBtn').click();
  await page.locator('.archive-open').first().click();

  await expect(page.locator('#archiveBanner')).toBeVisible();
  await expect(page.locator('#archiveBannerLabel')).toContainText('Beijing');
  await expect(page.locator('#manualSaveBtn')).toBeDisabled();
  await expect(page.locator('#metarToggle')).toBeHidden();
  await expect(page.locator('#archiveStamp')).toBeVisible();
  await expect(page.locator('#archiveStamp')).not.toBeEmpty();
});

test('exiting archive view restores live buttons', async ({ page }) => {
  await page.waitForFunction(() => document.getElementById('forecastMaxTemp').textContent !== '');
  await page.locator('#manualSaveBtn').click();
  await expect.poll(() => archiveState.snapshots.length).toBe(1);

  await page.locator('#archivePanelBtn').click();
  await page.locator('.archive-open').first().click();
  await expect(page.locator('#archiveBanner')).toBeVisible();

  await page.locator('.archive-exit').click();
  await expect(page.locator('#archiveBanner')).toBeHidden();
  await expect(page.locator('#manualSaveBtn')).toBeEnabled();
  await expect(page.locator('#metarToggle')).toBeVisible();
  await expect(page.locator('#archiveStamp')).toBeHidden();
});

test('archive settings can be enabled and saved from the settings panel', async ({ page }) => {
  await page.locator('#modelSettingsBtn').click();
  await expect(page.locator('#cityModelSettingsPanel')).toBeVisible();

  await page.locator('#archiveEnabled').check();
  await page.locator('#archiveTime').fill('09:00');
  await page.locator('.city-model-settings-save').click();

  await expect.poll(() => archiveState.settings.beijing).toMatchObject({ enabled: true, time: '09:00' });
});

test('archive snapshot shows all saved models and switching works without network', async ({ page }) => {
  const times = timesForDates([dateKeyForTz('Asia/Shanghai')]);
  const rowFor = (code) => hourlyWithModels(times, ['auto'], { rainAt: [], cloud: 40, low: 20, windBase: 22, code }).time
    .map((t, i) => ({
      time: t,
      hour: parseInt(t.substring(11, 13), 10),
      minute: 0,
      hourFrac: parseInt(t.substring(11, 13), 10),
      label: t.substring(11, 16),
      temp: hourlyWithModels(times, ['auto'], { rainAt: [], cloud: 40, low: 20, windBase: 22, code }).temperature_2m[i],
      rain: 0,
      rainProb: 10,
      windSpeed: 20,
      windDir: 90,
      cloudCover: 40,
      cloudCoverLow: 20,
      weatherCode: code,
    }))
    .filter((r) => r.time.startsWith(dateKeyForTz('Asia/Shanghai')));

  const models = {
    gfs_seamless: rowFor(1),
    ecmwf_ifs: rowFor(2),
    auto: rowFor(0),
  };
  const snapshot = {
    version: 1,
    id: 's_seed_allmodels',
    cityId: 'beijing',
    cityName: 'Beijing',
    metar: 'ZBAA',
    timezone: 'Asia/Shanghai',
    savedAtISO: new Date().toISOString(),
    savedAtMs: Date.now(),
    dateKey: dateKeyForTz('Asia/Shanghai'),
    savedHourFrac: 12,
    forecastDay: 'today',
    model: 'gfs_seamless',
    modelLabel: 'GFS Seamless',
    sourceLabel: 'Open-Meteo Forecast',
    omBadge: 'CMA',
    metarObsTime: Date.now(),
    metarRows: [],
    forecastRows: models.gfs_seamless,
    models,
    temperatureHighlight: null,
    additionalMaxTempC: null,
    testMaxTempC: null,
  };
  archiveState.snapshots.push(snapshot);

  await page.locator('#archivePanelBtn').click();
  await page.locator('.archive-open').first().click();
  await expect(page.locator('#archiveBanner')).toBeVisible();

  const chips = page.locator('.model-chip');
  await expect(chips).toHaveCount(3);

  await page.locator('.model-button', { hasText: 'ECMWF IFS' }).click();
  await expect(page.locator('.model-button.active')).toContainText('ECMWF IFS');

  await page.locator('.model-button', { hasText: 'Best match' }).click();
  await expect(page.locator('.model-button.active')).toContainText('Best match');
});
