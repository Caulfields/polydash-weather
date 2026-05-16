// Local development server. On Vercel, api/* serverless functions handle proxying.

const express = require('express');
const https = require('https');
const path = require('path');
const { STATIONS, normalizeStation } = require('./data/weather-stations');
const { resolveCity, rankTemperature } = require('./lib/weather-ranking');
const { buildSingleWeatherResponse, buildBatchWeatherResponse } = require('./lib/bot-weather');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '64kb' }));

const METAR_TTL_MS = 90_000;
const FORECAST_TTL_MS = 10 * 60_000;
const metarCache = new Map();
const forecastCache = new Map();
const metarInflight = new Map();
const forecastInflight = new Map();

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'weather-dashboard/1.0' } }, (res) => {
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

function hasValidApiKey(req) {
  const secret = process.env.API_SECRET;
  if (!secret) return false;
  const headerKey = req.get('x-api-key');
  const auth = req.get('authorization') || '';
  const bearerKey = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return headerKey === secret || bearerKey === secret;
}

async function fetchMetarData(station, hours) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json&taf=false&hours=${hours}`;
  const json = await fetchJson(url);
  return normalizeMetarResponse(json);
}

async function fetchForecastData(station, model) {
  const location = STATIONS[station];
  const params = new URLSearchParams({
    latitude: location.lat,
    longitude: location.lon,
    hourly: 'temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m',
    forecast_days: '1',
    timezone: location.timezone,
  });
  if (model !== 'auto') params.set('models', model);

  const json = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!json.hourly?.time?.length) throw new Error('Open-Meteo missing hourly data');
  return json;
}

app.get('/api/metar', async (req, res) => {
  const station = normalizeStation(req.query.station);
  if (!/^[A-Z0-9]{3,4}$/.test(station) || !STATIONS[station]) {
    res.status(400).json({ error: 'Invalid station' });
    return;
  }

  const hoursRaw = parseInt(req.query.hours, 10) || 48;
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

app.get('/api/forecast', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const station = normalizeStation(req.query.station);
  const model = normalizeModel(req.query.model);
  if (!STATIONS[station]) {
    res.status(400).json({ error: 'Invalid station' });
    return;
  }
  if (!model) {
    res.status(400).json({ error: 'Invalid forecast model' });
    return;
  }

  const cacheKey = `${station}_${model}`;
  const cache = forecastCache.get(cacheKey) || { data: null, ts: 0 };
  if (cache.data && Date.now() - cache.ts < FORECAST_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.json(cache.data);
    return;
  }

  try {
    if (!forecastInflight.has(cacheKey)) {
      forecastInflight.set(cacheKey, fetchForecastData(station, model).finally(() => forecastInflight.delete(cacheKey)));
    }
    const data = await forecastInflight.get(cacheKey);
    forecastCache.set(cacheKey, { data, ts: Date.now() });
    res.setHeader('X-Cache', 'MISS');
    res.json(data);
  } catch (error) {
    if (cache.data) {
      res.setHeader('X-Cache', 'STALE');
      res.json(cache.data);
      return;
    }
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/temperature', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (!process.env.API_SECRET) {
    res.status(500).json({ error: 'API_SECRET is not configured' });
    return;
  }
  if (!hasValidApiKey(req)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const city = resolveCity(req.query.city || req.query.station);
  const unit = `${req.query.unit || ''}`.toUpperCase();
  if (!city) {
    res.status(400).json({
      error: 'Unknown city or station',
      hint: 'Use ?city=London, ?city=london, or ?station=EGLC',
    });
    return;
  }
  if (unit && !['C', 'F'].includes(unit)) {
    res.status(400).json({ error: 'Invalid unit. Use C or F.' });
    return;
  }

  try {
    res.json(await rankTemperature(city, { unit }));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get('/api/bot/weather', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    res.json(await buildSingleWeatherResponse({
      city: req.query.city,
      station: req.query.station,
      date: req.query.date,
    }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/bot/weather/batch', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    res.json(await buildBatchWeatherResponse(req.body || {}));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Weather dashboard running at http://localhost:${PORT}`);
});
