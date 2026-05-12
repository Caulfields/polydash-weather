const { STATIONS, normalizeStation } = require('../data/weather-stations');

const FORECAST_TTL_MS = 10 * 60_000;
const forecastCache = new Map();
const forecastInflight = new Map();

function isSafeOrigin(req) {
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  return !origin || origin.includes(host) || origin.includes('localhost');
}

function normalizeModel(value) {
  const model = `${value || 'auto'}`.trim();
  if (model === 'auto') return 'auto';
  return /^[a-z0-9_]+$/.test(model) ? model : '';
}

async function fetchForecast(station, model) {
  const location = STATIONS[station];
  const params = new URLSearchParams({
    latitude: location.lat,
    longitude: location.lon,
    hourly: 'temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m',
    forecast_days: '1',
    timezone: location.timezone,
  });
  if (model !== 'auto') params.set('models', model);

  const upstream = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
    headers: { 'User-Agent': 'weather-dashboard/1.0' },
  });
  if (!upstream.ok) throw new Error('Open-Meteo HTTP ' + upstream.status);
  const json = await upstream.json();
  if (!json.hourly?.time?.length) throw new Error('Open-Meteo missing hourly data');
  return json;
}

module.exports = async function handler(req, res) {
  if (!isSafeOrigin(req)) {
    res.status(403).end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  const station = normalizeStation(req.query.station);
  const model = normalizeModel(req.query.model);
  if (!STATIONS[station]) {
    res.status(400).end(JSON.stringify({ error: 'Invalid station code' }));
    return;
  }
  if (!model) {
    res.status(400).end(JSON.stringify({ error: 'Invalid forecast model' }));
    return;
  }

  const cacheKey = `${station}_${model}`;
  const cache = forecastCache.get(cacheKey) || { data: null, ts: 0 };
  if (cache.data && Date.now() - cache.ts < FORECAST_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.end(JSON.stringify(cache.data));
    return;
  }

  try {
    if (!forecastInflight.has(cacheKey)) {
      forecastInflight.set(cacheKey, fetchForecast(station, model).finally(() => forecastInflight.delete(cacheKey)));
    }
    const data = await forecastInflight.get(cacheKey);
    forecastCache.set(cacheKey, { data, ts: Date.now() });
    res.setHeader('X-Cache', 'MISS');
    res.end(JSON.stringify(data));
  } catch (error) {
    console.error('[forecast]', error.message);
    if (cache.data) {
      res.setHeader('X-Cache', 'STALE');
      res.end(JSON.stringify(cache.data));
      return;
    }
    res.status(502).end(JSON.stringify({ error: error.message }));
  }
};
