const { TEST_MODELS, getTestModels, setTestModels } = require('../data/test-models');

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

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, TEST_MODELS);
    return;
  }
  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      setTestModels(body.cityId, body.models);
      sendJson(res, 200, { ok: true, models: getTestModels(body.cityId) });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }
  sendJson(res, 405, { error: 'Method not allowed' });
};
