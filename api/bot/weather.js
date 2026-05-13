const { buildSingleWeatherResponse } = require('../../lib/bot-weather');

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const data = await buildSingleWeatherResponse({
      city: req.query.city,
      station: req.query.station,
      date: req.query.date,
    });
    sendJson(res, 200, data);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
};
