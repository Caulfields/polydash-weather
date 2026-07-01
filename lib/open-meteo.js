const { STATIONS } = require('../data/weather-stations');

const FORECAST_TTL_MS = 10 * 60_000;
const forecastCache = new Map();
const forecastInflight = new Map();

function buildOpenMeteoUrl(station, model, date) {
  const location = STATIONS[station];
  const params = new URLSearchParams({
    latitude: location.lat,
    longitude: location.lon,
    hourly: 'temperature_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover,cloud_cover_low',
    timezone: location.timezone,
  });
  if (date) {
    params.set('start_date', date);
    params.set('end_date', date);
  } else {
    params.set('forecast_days', '2');
  }
  if (model && model !== 'auto') params.set('models', model);
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

function fetchForecast(fetchJson, station, model, date) {
  return fetchJson(buildOpenMeteoUrl(station, model, date)).then((json) => {
    if (!json.hourly?.time?.length) throw new Error('Open-Meteo missing hourly data');
    return json;
  });
}

function cachedFetchForecast(fetchJson, station, model, date) {
  const cacheKey = `${station}|${model}|${date}`;
  const cache = forecastCache.get(cacheKey) || { data: null, ts: 0 };
  if (cache.data && Date.now() - cache.ts < FORECAST_TTL_MS) {
    return Promise.resolve(cache.data);
  }

  if (!forecastInflight.has(cacheKey)) {
    forecastInflight.set(
      cacheKey,
      fetchForecast(fetchJson, station, model, date)
        .then((data) => {
          forecastCache.set(cacheKey, { data, ts: Date.now() });
          return data;
        })
        .finally(() => forecastInflight.delete(cacheKey))
    );
  }
  return forecastInflight.get(cacheKey);
}

module.exports = {
  buildOpenMeteoUrl,
  fetchForecast,
  cachedFetchForecast,
};
