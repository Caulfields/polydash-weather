const { test, expect } = require('@playwright/test');
const {
  timesForDates,
  hourlyWithModels,
  metarPayload,
  dateKeyForTz,
  tomorrowKey,
} = require('../helpers/fixtures');

const CITIES = require('../../assets/js/dashboard/config').CITIES;
const WEATHER_MODELS = require('../../assets/js/dashboard/config').WEATHER_MODELS;

const FORECAST_RULE = { rainAt: [13, 14, 15], cloud: 40, low: 20, windBase: 22 };

const state = {
  testModelsPost: null,
  forecastDates: [],
};

function forecastPayloadFor(url) {
  const params = new URLSearchParams(new URL(url).search);
  const date = params.get('date') || params.get('start_date') || dateKeyForTz('UTC');
  const model = params.get('model') || 'auto';
  const models = model === 'auto' ? ['auto'] : [model];
  const times = timesForDates([date]);
  const hourly = hourlyWithModels(times, models, FORECAST_RULE);
  return { hourly };
}

async function setupRoutes(page) {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const urlObj = new URL(url);

    if (urlObj.pathname === '/api/test-models') {
      if (method === 'POST') {
        state.testModelsPost = route.request().postDataJSON() || {};
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, models: state.testModelsPost.models || {} }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }

    if (urlObj.pathname === '/api/city-ranking') {
      const categories = {};
      for (const cityId of Object.keys(CITIES)) categories[cityId] = { category: 1 };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(categories) });
      return;
    }

    if (urlObj.pathname === '/api/forecast') {
      state.forecastDates.push(urlObj.searchParams.get('date'));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(forecastPayloadFor(url)) });
      return;
    }

    if (urlObj.pathname === '/api/metar') {
      const station = urlObj.searchParams.get('station') || 'ZBAA';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(metarPayload({ station })) });
      return;
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

test.beforeEach(async ({ page }) => {
  state.testModelsPost = null;
  state.forecastDates = [];
  await setupRoutes(page);
  await page.context().addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: (text) => {
          window.__copiedText = text;
          return Promise.resolve();
        },
      },
      configurable: true,
    });
  });
  await page.goto('/');
  await page.waitForSelector('.city-card');
  await page.waitForFunction(() => {
    const loading = document.getElementById('omLoading');
    return loading && loading.style.display === 'none';
  });
});

test('renders the full city list with Beijing active by default', async ({ page }) => {
  const cards = page.locator('.city-card');
  await expect(cards).toHaveCount(Object.keys(CITIES).length);
  const active = page.locator('.city-card.active');
  await expect(active).toHaveCount(1);
  await expect(active).toContainText('Beijing');
  await expect(active).toContainText('ZBAA');
  await expect(page.locator('#chartTitle')).toHaveText('ZBAA');
});

test('loads METAR observation and forecast for the default city', async ({ page }) => {
  await expect(page.locator('#tempNow')).not.toHaveText('--');
  await expect(page.locator('#tempNow')).toContainText('°C');
  await expect(page.locator('#metarRaw')).not.toHaveText('loading...');
  await expect(page.locator('#metarRaw')).not.toBeEmpty();
  await expect(page.locator('#forecastMaxTemp')).not.toBeEmpty();
  await expect(page.locator('#forecastMaxTemp')).toContainText('°C');
  await expect(page.locator('#cfMin')).not.toHaveText('--');
  await expect(page.locator('#cfMax')).not.toHaveText('--');
  await expect(page.locator('#cfWeather')).not.toHaveText('--');
});

test('draws the temperature chart', async ({ page }) => {
  await page.waitForFunction(() => {
    const canvas = document.getElementById('tempChart');
    if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true;
    }
    return false;
  });
});

test('shows wind, rain and cloud tags from forecast data', async ({ page }) => {
  await expect(page.locator('#tagWind')).toBeVisible();
  await expect(page.locator('#tagRain')).toBeVisible();
  await expect(page.locator('#tagCloud')).toBeVisible();
  await expect(page.locator('#tagCloud')).toHaveText('40/20');
});

test('switching city updates the active card and chart title', async ({ page }) => {
  await page.locator('.city-button', { hasText: 'London' }).click();
  await expect(page.locator('.city-card.active')).toContainText('London');
  await expect(page.locator('#chartTitle')).toHaveText('EGLC');
  await expect(page.locator('#forecastMaxTemp')).not.toBeEmpty();
});

test('temperature highlight marks matching periods', async ({ page }) => {
  const input = page.locator('#targetTempInput');
  await input.fill('12C');
  await expect(page.locator('#targetTempStatus')).toHaveClass(/match/);
  await expect(page.locator('#targetTempStatus')).toContainText('12C:');

  await page.locator('#targetTempClear').click();
  await expect(page.locator('#targetTempStatus')).not.toHaveClass(/match/);
});

test('tomorrow toggle requests the next day forecast', async ({ page }) => {
  const tomorrow = tomorrowKey('Asia/Shanghai');
  const respPromise = page.waitForResponse((response) => {
    const url = response.request().url();
    if (!url.includes('/api/forecast')) return false;
    return new URL(url).searchParams.get('date') === tomorrow;
  });

  await page.locator('#forecastDayTomorrow').click();
  await respPromise;
  await expect(page.locator('#forecastDayTomorrow')).toHaveAttribute('aria-pressed', 'true');
  expect(state.forecastDates).toContain(tomorrow);
});

test('copy button writes the max temperature to clipboard', async ({ page }) => {
  await page.waitForFunction(() => document.getElementById('forecastMaxTemp').textContent !== '');
  const text = await page.locator('#forecastMaxTemp').textContent();
  await page.locator('#copyTempBtn').click();
  await expect(page.locator('#copyTempBtn')).toHaveClass(/copied/);
  const copied = await page.evaluate(() => window.__copiedText);
  expect(copied).toBe(text.replace(/°C/g, '').trim());
});

test('model settings save posts to the test-models endpoint and updates the dock', async ({ page }) => {
  await page.locator('#modelSettingsBtn').click();
  await expect(page.locator('#cityModelSettingsPanel')).toBeVisible();
  await expect(page.locator('#settingsCityName')).toHaveText('Beijing');

  await page.locator('#settingsBasicModel').selectOption('gfs_seamless');
  await page.locator('.city-model-settings-save').click();
  await expect(page.locator('#cityModelSettingsPanel')).toBeHidden();

  await page.waitForFunction(() => document.getElementById('modelDock').textContent.includes('GFS Seamless'));
  expect(state.testModelsPost).toBeTruthy();
  expect(state.testModelsPost.cityId).toBe('beijing');
  expect(state.testModelsPost.models.basic).toBe('gfs_seamless');
});

test('model dock lists the available models for the active city', async ({ page }) => {
  const count = await page.locator('.model-chip').count();
  expect(count).toBeGreaterThanOrEqual(10);
  await expect(page.locator('.model-button.active')).toContainText('Best match');
});