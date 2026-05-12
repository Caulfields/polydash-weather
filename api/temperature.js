const { resolveCity, rankTemperature } = require('../lib/weather-ranking');

function isSafeOrigin(req) {
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  return !origin || origin.includes(host) || origin.includes('localhost');
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

  const city = resolveCity(req.query.city || req.query.station);
  const unit = `${req.query.unit || ''}`.toUpperCase();
  if (!city) {
    res.status(400).end(JSON.stringify({
      error: 'Unknown city or station',
      hint: 'Use ?city=London, ?city=london, or ?station=EGLC',
    }));
    return;
  }
  if (unit && !['C', 'F'].includes(unit)) {
    res.status(400).end(JSON.stringify({ error: 'Invalid unit. Use C or F.' }));
    return;
  }

  try {
    const data = await rankTemperature(city, { unit });
    res.end(JSON.stringify(data));
  } catch (error) {
    console.error('[temperature]', error.message);
    res.status(502).end(JSON.stringify({ error: error.message }));
  }
};
