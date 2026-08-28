// Local development server. Runs the weather dashboard and archive scheduler.

const express = require('express');
const https = require('https');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { STATIONS, normalizeStation } = require('./data/weather-stations');
const { cachedFetchForecast } = require('./lib/open-meteo');
const { computeCityCategories } = require('./lib/city-ranking');
const { TEST_MODELS, getTestModels, setTestModels } = require('./data/test-models');
const { CITIES } = require('./assets/js/dashboard/config');
const {
  createArchiveStore,
  buildSnapshotFromPayloads,
  shouldRunScheduledSave,
  cityTodayKey,
  cityModelIds,
} = require('./lib/archive');

function getSystemProxy() {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (env) return env;
  try {
    const reg = require('child_process').execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
      { encoding: 'utf-8', timeout: 2000 }
    );
    const match = reg.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (match) return 'http://' + match[1];
  } catch {}
  return null;
}

const proxyUrl = getSystemProxy();
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
if (proxyAgent) console.log('Proxy for Open-Meteo:', proxyUrl);

const app = express();
const PORT = process.env.PORT || 3000;

const archiveDir = process.env.ARCHIVE_DATA_DIR || path.join(__dirname, 'data', 'archives');
const archiveStore = createArchiveStore(archiveDir);

async function fetchAllModelPayloads(city, dateKey, primaryModel) {
  const modelIds = cityModelIds(city);
  const primary = primaryModel && primaryModel !== 'auto' ? primaryModel : null;
  const targets = [...modelIds];
  if (primary && !targets.includes(primary)) targets.push(primary);
  if (!targets.includes('auto')) targets.push('auto');
  const result = {};
  const batchSize = 4;
  for (let index = 0; index < targets.length; index += batchSize) {
    const batch = targets.slice(index, index + batchSize);
    const settled = await Promise.allSettled(
      batch.map((id) => cachedFetchForecast(fetchJson, city.metar, id, dateKey))
    );
    settled.forEach((item, i) => {
      if (item.status === 'fulfilled' && item.value && item.value.hourly) {
        result[batch[i]] = item.value;
      }
    });
  }
  return result;
}

const METAR_TTL_MS = 30 * 60_000;
const metarCache = new Map();
const metarInflight = new Map();

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: { 'User-Agent': 'weather-dashboard/1.0' },
    };
    if (proxyAgent && url.startsWith('https://api.open-meteo.com/')) {
      opts.agent = proxyAgent;
    }
    https.get(url, opts, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function normalizeMetarResponse(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.value)) return json.value;
  throw new Error('Invalid METAR response');
}

function fetchOpenMeteoFallback(station, hours) {
  const coords = STATIONS[station];
  if (!coords) return Promise.reject(new Error('No coordinates for station'));

  const now = Math.floor(Date.now() / 1000);
  const startTime = now - (hours * 3600);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&hourly=temperature_2m&start=${startTime}&end=${now}&timezone=auto`;

  return fetchJson(url).then((json) => {
    if (!json.hourly) throw new Error('No hourly data');
    const temps = json.hourly.temperature_2m || [];
    const times = json.hourly.time || [];
    return temps.map((temp, index) => ({
      obsTime: times[index],
      temp: Math.round(Number(temp) * 10) / 10,
      rawOb: `${temp}C`,
    }));
  });
}

function normalizeModel(value) {
  const model = `${value || 'auto'}`.trim();
  if (model === 'auto') return 'auto';
  return /^[a-z0-9_]+$/.test(model) ? model : '';
}

function normalizeDate(value) {
  const date = `${value || ''}`.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function fetchMetarData(station, hours) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json&taf=false&hours=${hours}`;
  const json = await fetchJson(url);
  return normalizeMetarResponse(json);
}

app.get('/api/forecast', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const station = normalizeStation(req.query.station);
  const model = normalizeModel(req.query.model);
  const date = normalizeDate(req.query.date);
  if (!STATIONS[station]) {
    res.status(400).json({ error: 'Invalid station' });
    return;
  }
  if (!model) {
    res.status(400).json({ error: 'Invalid forecast model' });
    return;
  }
  if (req.query.date && !date) {
    res.status(400).json({ error: 'Invalid forecast date' });
    return;
  }

  try {
    const data = await cachedFetchForecast(fetchJson, station, model, date);
    res.json(data);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/metar', async (req, res) => {
  const station = normalizeStation(req.query.station);
  if (!/^[A-Z0-9]{3,4}$/.test(station) || !STATIONS[station]) {
    res.status(400).json({ error: 'Invalid station' });
    return;
  }

  const hoursRaw = parseInt(req.query.hours, 10) || 24;
  const hours = Math.min(Math.max(hoursRaw, 1), 168);
  const cacheKey = `${station}_${hours}`;
  const cache = metarCache.get(cacheKey) || { data: null, ts: 0 };

  if (cache.data && Date.now() - cache.ts < METAR_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cache.data);
    return;
  }

  try {
    if (!metarInflight.has(cacheKey)) {
      metarInflight.set(cacheKey, fetchMetarData(station, hours).finally(() => metarInflight.delete(cacheKey)));
    }
    const data = await metarInflight.get(cacheKey);
    metarCache.set(cacheKey, { data, ts: Date.now() });
    res.setHeader('X-Cache', 'MISS');
    res.json(data);
  } catch (error) {
    try {
      const data = await fetchOpenMeteoFallback(station, hours);
      metarCache.set(cacheKey, { data, ts: Date.now() });
      res.setHeader('X-Cache', 'FALLBACK');
      res.json(data);
    } catch (fallbackError) {
      if (cache.data) {
        res.setHeader('X-Cache', 'STALE');
        res.json(cache.data);
        return;
      }
      res.status(502).json({ error: error.message || fallbackError.message });
    }
  }
});

app.get('/api/archive/settings', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(await archiveStore.getSettings());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/archive/settings', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const body = await readJsonBody(req);
    const settings = await archiveStore.setSettings(body.cityId, body);
    res.json({ ok: true, settings });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/archive/snapshots', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const cityId = `${req.query.city || ''}`;
    const snapshots = await archiveStore.listSnapshots(cityId || null);
    res.json({ snapshots });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/archive/snapshots/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const snapshot = await archiveStore.getSnapshot(req.params.id);
    if (!snapshot) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ snapshot });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/archive/snapshots', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const body = await readJsonBody(req);
    const city = CITIES[body.cityId];
    if (city) {
      const dateKey = body.dateKey || cityTodayKey(city.timezone);
      const model = body.model || 'auto';
      try {
        const modelsPayloads = await fetchAllModelPayloads(city, dateKey, model);
        const parsed = buildSnapshotFromPayloads({
          city,
          dateKey,
          model,
          modelsPayloads,
          now: new Date(body.savedAtMs || Date.now()),
        });
        body.models = parsed.models;
        if (!body.forecastRows || !body.forecastRows.length) body.forecastRows = parsed.forecastRows;
        body.dateKey = dateKey;
      } catch (error) {
        console.warn('[archive] expand models failed:', error.message);
      }
    }
    const snapshot = await archiveStore.addSnapshot(body);
    res.json({ ok: true, snapshot: archiveStore.summary(snapshot) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete('/api/archive/snapshots/:id', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    await archiveStore.deleteSnapshot(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/city-ranking', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const categories = await computeCityCategories(fetchJson);
    res.json(categories);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/test-models', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(TEST_MODELS);
});

app.post('/api/test-models', async (req, res) => {
  const body = await readJsonBody(req);
  setTestModels(body && body.cityId, body && body.models);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, models: getTestModels(body && body.cityId) });
});

app.use(express.static(path.join(__dirname)));

const SCHEDULE_INTERVAL_MS = 30_000;

async function scheduledArchiveSave() {
  try {
    const settings = await archiveStore.getSettings();
    const now = new Date();
    for (const cityId of Object.keys(settings)) {
      const cfg = settings[cityId];
      const city = CITIES[cityId];
      if (!city || !cfg || !cfg.enabled) continue;
      if (!shouldRunScheduledSave(cfg, city.timezone, now)) continue;

      const dateKey = cityTodayKey(city.timezone, now);
      const model = 'auto';
      try {
        const metarPayload = await fetchMetarData(city.metar, 24);
        const forecastPayload = await cachedFetchForecast(fetchJson, city.metar, model, dateKey);
        const modelsPayloads = await fetchAllModelPayloads(city, dateKey, model);

        let additionalPayload = null;
        let testPayload = null;
        const models = TEST_MODELS[cityId] || {};
        if (models.additional && models.additional !== model) {
          additionalPayload = await cachedFetchForecast(fetchJson, city.metar, models.additional, dateKey);
        }
        if (models.test && models.test !== model && models.test !== models.additional) {
          testPayload = await cachedFetchForecast(fetchJson, city.metar, models.test, dateKey);
        }

        const snapshot = buildSnapshotFromPayloads({
          city,
          dateKey,
          forecastDay: 'today',
          model,
          metarPayload,
          forecastPayload,
          additionalPayload,
          testPayload,
          modelsPayloads,
          now,
        });
        await archiveStore.addSnapshot(snapshot);
        console.log(`[archive] saved ${cityId} ${dateKey} ${snapshot.id}`);
      } catch (error) {
        console.warn(`[archive] ${cityId}:`, error.message);
      }
    }
  } catch (error) {
    console.warn('[archive] scheduled run failed:', error.message);
  }
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Weather dashboard running at http://localhost:${PORT}`);
  });
  scheduledArchiveSave();
  setInterval(scheduledArchiveSave, SCHEDULE_INTERVAL_MS);
}

module.exports = app;
