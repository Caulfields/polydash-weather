// METAR proxy with short in-memory cache and in-flight request reuse.
const { STATIONS, normalizeStation } = require('../data/weather-stations');

const METAR_TTL_MS = 15 * 60_000;
const metarCache = new Map();
const metarInflight = new Map();

function isSafeOrigin(req) {
  const origin = req.headers.origin || '';
  const host   = req.headers.host   || '';
  return !origin || origin.includes(host) || origin.includes('localhost');
}

async function fetchOpenMeteo(station, hours) {
  const coords = STATIONS[station];
  if (!coords) throw new Error('No coordinates for station');

  const now = Math.floor(Date.now() / 1000);
  const startTime = now - (hours * 3600);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&hourly=temperature_2m&start=${startTime}&end=${now}&timezone=auto`;
  const upstream = await fetch(url, { headers: { 'User-Agent': 'weather-dashboard/1.0' } });
  if (!upstream.ok) throw new Error('Open-Meteo HTTP ' + upstream.status);
  const json = await upstream.json();
  if (!json.hourly) throw new Error('Open-Meteo missing hourly data');
  return (json.hourly.temperature_2m || []).map((temp, i) => ({
    obsTime: json.hourly.time[i],
    temp: Math.round(Number(temp) * 10) / 10,
    rawOb: `${temp}C`,
  }));
}

function normalizeMetarResponse(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.value)) return json.value;
  throw new Error('Invalid METAR response');
}

async function fetchMetar(station, hours) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json&taf=false&hours=${hours}`;
  const upstream = await fetch(url, { headers: { 'User-Agent': 'weather-dashboard/1.0' } });
  if (!upstream.ok) throw new Error('HTTP ' + upstream.status);
  const json = await upstream.json();
  return normalizeMetarResponse(json);
}

module.exports = async function handler(req, res) {
  if (!isSafeOrigin(req)) {
    res.status(403).end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');

  const station = normalizeStation(req.query.station);
  if (!/^[A-Z0-9]{3,4}$/.test(station) || !STATIONS[station]) {
    res.status(400).end(JSON.stringify({ error: 'Invalid station code' }));
    return;
  }

  const hoursRaw = parseInt(req.query.hours) || 48;
  const hours    = Math.min(Math.max(hoursRaw, 1), 168);
  const cacheKey = `${station}_${hours}`;

  const cache = metarCache.get(cacheKey) || { data: null, ts: 0 };
  if (cache.data && Date.now() - cache.ts < METAR_TTL_MS) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'HIT');
    res.end(JSON.stringify(cache.data));
    return;
  }

  try {
    if (!metarInflight.has(cacheKey)) {
      metarInflight.set(cacheKey, fetchMetar(station, hours).finally(() => metarInflight.delete(cacheKey)));
    }
    const json = await metarInflight.get(cacheKey);
    metarCache.set(cacheKey, { data: json, ts: Date.now() });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'MISS');
    res.end(JSON.stringify(json));
  } catch (e) {
    console.error('[metar]', e.message);
    try {
      const fallback = await fetchOpenMeteo(station, hours);
      metarCache.set(cacheKey, { data: fallback, ts: Date.now() });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Cache', 'FALLBACK');
      res.end(JSON.stringify(fallback));
    } catch (fallbackError) {
      if (cache.data) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-Cache', 'STALE');
        res.end(JSON.stringify(cache.data));
        return;
      }
      res.status(502).end(JSON.stringify({ error: fallbackError.message }));
    }
  }
};
