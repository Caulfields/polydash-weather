const { CITIES } = require('../assets/js/dashboard/config');
const { cachedFetchForecast } = require('./open-meteo');

const RESULT_TTL_MS = 10 * 60_000;
const resultCache = new Map();

function cityDateKey(timezone) {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

function hourlyField(hourly, base) {
  if (Array.isArray(hourly[base])) return hourly[base];
  const match = Object.keys(hourly).find((key) => key.startsWith(`${base}_`) && Array.isArray(hourly[key]));
  return match ? hourly[match] : [];
}

function parseHourlyRows(hourly, dateKey) {
  const times = hourly.time || [];
  const temps = hourlyField(hourly, 'temperature_2m');
  const cloudCover = hourlyField(hourly, 'cloud_cover');
  const cloudCoverLow = hourlyField(hourly, 'cloud_cover_low');
  const precipitation = hourlyField(hourly, 'precipitation');

  return times.map((time, index) => {
    if (!time.startsWith(dateKey)) return null;
    const temp = temps[index];
    if (typeof temp !== 'number') return null;
    const hour = parseInt(time.substring(11, 13), 10);
    return {
      time,
      hour,
      temp,
      cloudCover: typeof cloudCover[index] === 'number' ? cloudCover[index] : null,
      cloudCoverLow: typeof cloudCoverLow[index] === 'number' ? cloudCoverLow[index] : null,
      precipitation: typeof precipitation[index] === 'number' ? precipitation[index] : 0,
    };
  }).filter(Boolean);
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function computeCityCategory(rows) {
  if (!rows.length) return 1;

  const avgCloudCover = average(rows.map((r) => r.cloudCover).filter((v) => typeof v === 'number'));
  const avgCloudCoverLow = average(rows.map((r) => r.cloudCoverLow).filter((v) => typeof v === 'number'));
  const rainPoints = rows.filter((r) => r.precipitation > 0).length;
  const hasRain3 = rainPoints >= 3;

  if (hasRain3) return 4;
  if (avgCloudCoverLow > 50) return 3;
  if (avgCloudCover > 50 && avgCloudCoverLow < 50) return 2;
  return 1;
}

async function computeCityCategories(fetchJson) {
  const cache = resultCache.get('categories') || { data: null, ts: 0 };
  if (cache.data && Date.now() - cache.ts < RESULT_TTL_MS) return cache.data;

  const cityIds = Object.keys(CITIES);
  const result = {};

  for (let index = 0; index < cityIds.length; index += 4) {
    const batch = cityIds.slice(index, index + 4);
    const settled = await Promise.allSettled(batch.map(async (cityId) => {
      const city = CITIES[cityId];
      const date = cityDateKey(city.timezone);
      const data = await cachedFetchForecast(fetchJson, city.metar, 'auto', date);
      const rows = parseHourlyRows(data.hourly || {}, date)
        .filter((r) => r.hour >= 7 && r.hour <= 20);
      return { cityId, category: computeCityCategory(rows) };
    }));

    settled.forEach((item) => {
      if (item.status === 'fulfilled') {
        result[item.value.cityId] = { category: item.value.category };
      }
    });
  }

  cityIds.forEach((cityId) => {
    if (!result[cityId]) {
      result[cityId] = { category: 1 };
    }
  });

  resultCache.set('categories', { data: result, ts: Date.now() });
  return result;
}

module.exports = { computeCityCategories };
