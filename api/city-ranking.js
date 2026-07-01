const { computeCityCategories } = require('../lib/city-ranking');

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'weather-dashboard/1.0' },
      signal: controller.signal,
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    return upstream.json();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }
  try {
    const categories = await computeCityCategories(fetchJson);
    sendJson(res, 200, categories);
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
};
