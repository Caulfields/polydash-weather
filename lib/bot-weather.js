const { WEATHER_MODELS, CITIES } = require('../assets/js/dashboard/config');
const { STATIONS, normalizeStation } = require('../data/weather-stations');
const { computeCityCategories } = require('./city-ranking');
const { getTestModels } = require('../data/test-models');

const SCHEMA_VERSION = '2.0';
const UPSTREAM_TIMEOUT_MS = 10_000;

function normalizeLookup(value) {
  return `${value || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeDate(value) {
  const date = `${value || ''}`.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function round1(value) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : null;
}

function offsetForZone(timezone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const value = parts.find((part) => part.type === 'timeZoneName')?.value || 'GMT';
  const match = value.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return '+00:00';
  const sign = match[1];
  const hours = match[2].padStart(2, '0');
  const minutes = (match[3] || '00').padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function localIsoWithOffset(localTime, timezone) {
  const probe = new Date(`${localTime}:00Z`);
  return `${localTime}:00${offsetForZone(timezone, probe)}`;
}

function dateKeyForZone(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'weather-dashboard/1.0' },
      signal: controller.signal,
    });
    if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
    return upstream.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Upstream request timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function stationCityFallback(cityValue, station) {
  const stationInfo = STATIONS[station];
  if (!stationInfo) return null;
  const name = `${cityValue || station}`.trim() || station;
  return {
    id: normalizeLookup(name) || station.toLowerCase(),
    name,
    metar: station,
    timezone: stationInfo.timezone,
    coords: { lat: stationInfo.lat, lon: stationInfo.lon },
    modelOptions: [],
  };
}

function resolveCity(value) {
  const lookup = normalizeLookup(value);
  if (!lookup) return null;

  const city = Object.values(CITIES).find((item) => (
    normalizeLookup(item.id) === lookup ||
    normalizeLookup(item.name) === lookup ||
    normalizeLookup(item.metar) === lookup
  ));
  return city || null;
}

function resolveBotCity(input = {}) {
  const cityValue = input.city || input.city_id || input.id;
  const station = input.station ? normalizeStation(input.station) : '';
  const city = resolveCity(cityValue);

  if (city) {
    if (!station || !STATIONS[station]) return city;
    const stationInfo = STATIONS[station];
    return {
      ...city,
      metar: station,
      timezone: stationInfo.timezone || city.timezone,
      coords: { lat: stationInfo.lat, lon: stationInfo.lon },
    };
  }

  if (station) return stationCityFallback(cityValue, station);
  return null;
}

async function fetchTestModelData(city, modelIds, fetchJsonFn) {
  if (!modelIds || !modelIds.length) return {};
  const today = dateKeyForZone(new Date(), city.timezone);
  const tomorrowDate = new Date(Date.now() + 86400000);
  const tomorrow = dateKeyForZone(tomorrowDate, city.timezone);

  const modelsParam = modelIds.join(',');
  const fields = 'temperature_2m,cloud_cover,cloud_cover_low,precipitation';
  const params = new URLSearchParams({
    latitude: city.coords.lat,
    longitude: city.coords.lon,
    hourly: fields,
    models: modelsParam,
    start_date: today,
    end_date: tomorrow,
    timezone: city.timezone,
  });

  try {
    const data = await fetchJsonFn(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
    if (!data.hourly?.time?.length) return {};

    const times = data.hourly.time || [];
    const result = {};

    for (const modelId of modelIds) {
      const isAuto = modelId === 'auto';
      const suffix = isAuto ? '' : `_${modelId}`;

      const temps = isAuto
        ? (Array.isArray(data.hourly.temperature_2m) ? data.hourly.temperature_2m : [])
        : (Array.isArray(data.hourly[`temperature_2m${suffix}`]) ? data.hourly[`temperature_2m${suffix}`] : (isAuto && Array.isArray(data.hourly.temperature_2m) ? data.hourly.temperature_2m : []));
      const clouds = isAuto
        ? (Array.isArray(data.hourly.cloud_cover) ? data.hourly.cloud_cover : [])
        : (Array.isArray(data.hourly[`cloud_cover${suffix}`]) ? data.hourly[`cloud_cover${suffix}`] : (isAuto && Array.isArray(data.hourly.cloud_cover) ? data.hourly.cloud_cover : []));
      const cloudsLow = isAuto
        ? (Array.isArray(data.hourly.cloud_cover_low) ? data.hourly.cloud_cover_low : [])
        : (Array.isArray(data.hourly[`cloud_cover_low${suffix}`]) ? data.hourly[`cloud_cover_low${suffix}`] : (isAuto && Array.isArray(data.hourly.cloud_cover_low) ? data.hourly.cloud_cover_low : []));
      const precip = isAuto
        ? (Array.isArray(data.hourly.precipitation) ? data.hourly.precipitation : [])
        : (Array.isArray(data.hourly[`precipitation${suffix}`]) ? data.hourly[`precipitation${suffix}`] : (isAuto && Array.isArray(data.hourly.precipitation) ? data.hourly.precipitation : []));

      const todayRows = [];
      const tomorrowRows = [];
      let maxTempToday = null;
      let maxTempTodayTime = null;
      let maxTempTomorrow = null;
      let maxTempTomorrowTime = null;

      for (let i = 0; i < times.length; i++) {
        const timeStr = times[i];
        const hour = parseInt(timeStr.substring(11, 13), 10);
        if (hour < 8 || hour > 22) continue;

        const datePart = timeStr.substring(0, 10);
        const isToday = datePart === today;
        const isTomorrow = datePart === tomorrow;
        if (!isToday && !isTomorrow) continue;

        const temp = typeof temps[i] === 'number' ? temps[i] : null;
        const row = {
          hour,
          time: localIsoWithOffset(timeStr, city.timezone),
          temperature_c: temp !== null ? round1(temp) : null,
          cloud_cover: typeof clouds[i] === 'number' ? Math.round(clouds[i]) : null,
          cloud_cover_low: typeof cloudsLow[i] === 'number' ? Math.round(cloudsLow[i]) : null,
          precipitation: typeof precip[i] === 'number' ? round1(precip[i]) : null,
        };

        if (isToday) {
          todayRows.push(row);
          if (temp !== null && (maxTempToday === null || temp > maxTempToday)) {
            maxTempToday = temp;
            maxTempTodayTime = row.time;
          }
        } else if (isTomorrow) {
          tomorrowRows.push(row);
          if (temp !== null && (maxTempTomorrow === null || temp > maxTempTomorrow)) {
            maxTempTomorrow = temp;
            maxTempTomorrowTime = row.time;
          }
        }
      }

      result[modelId] = {
        today: todayRows,
        tomorrow: tomorrowRows,
        max_temp_today_c: maxTempToday !== null ? round1(maxTempToday) : null,
        max_temp_today_time: maxTempTodayTime,
        max_temp_tomorrow_c: maxTempTomorrow !== null ? round1(maxTempTomorrow) : null,
        max_temp_tomorrow_time: maxTempTomorrowTime,
      };
    }

    return result;
  } catch (error) {
    return {};
  }
}

async function getCityCategory(cityId, fetchJsonFn) {
  try {
    const categories = await computeCityCategories(fetchJsonFn);
    return (categories[cityId] && typeof categories[cityId].category === 'number')
      ? categories[cityId].category
      : 1;
  } catch (error) {
    return 1;
  }
}

async function buildModelsBlock(city, testModels, fetchJsonFn) {
  const slots = { basic: null, additional: null, test: null };
  const modelIds = ['basic', 'additional', 'test']
    .map((key) => testModels[key])
    .filter((id) => id && typeof id === 'string' && id.length > 0);

  if (!modelIds.length) return slots;

  const modelData = await fetchTestModelData(city, modelIds, fetchJsonFn);

  for (const key of ['basic', 'additional', 'test']) {
    const modelId = testModels[key];
    if (!modelId || typeof modelId !== 'string' || modelId.length === 0) continue;

    const data = modelData[modelId];
    if (!data) {
      slots[key] = { id: modelId, name: WEATHER_MODELS[modelId] || modelId, hourly: { today: [], tomorrow: [] } };
      continue;
    }

    slots[key] = {
      id: modelId,
      name: WEATHER_MODELS[modelId] || modelId,
      max_temp_today_c: data.max_temp_today_c,
      max_temp_today_time: data.max_temp_today_time,
      max_temp_tomorrow_c: data.max_temp_tomorrow_c,
      max_temp_tomorrow_time: data.max_temp_tomorrow_time,
      hourly: {
        today: data.today,
        tomorrow: data.tomorrow,
      },
    };
  }

  return slots;
}

async function buildWeatherItem(input, fetchJsonFn) {
  if (!fetchJsonFn) fetchJsonFn = fetchJson;
  const date = normalizeDate(input.date);
  if (!date) throw new Error('Invalid or missing date. Use YYYY-MM-DD.');

  const city = resolveBotCity(input);
  if (!city) throw new Error('Unknown city or station.');

  const warnings = [];
  const [category, testModels] = await Promise.all([
    getCityCategory(city.id, fetchJsonFn),
    Promise.resolve(getTestModels(city.id)),
  ]);
  const modelsBlock = await buildModelsBlock(city, testModels, fetchJsonFn);

  return {
    city: {
      id: city.id,
      name: city.name,
      station: city.metar,
      timezone: city.timezone,
    },
    date,
    unit: 'C',
    category,
    category_label: ['green', 'blue', 'yellow', 'red'][category - 1] || 'green',
    models: modelsBlock,
    data_quality: {
      status: warnings.length ? 'warning' : 'ok',
      warnings,
    },
  };
}

function baseResponse() {
  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    items: [],
    errors: [],
  };
}

async function buildSingleWeatherResponse(input, fetchJsonFn) {
  const response = baseResponse();
  response.items.push(await buildWeatherItem(input, fetchJsonFn));
  return response;
}

async function buildBatchWeatherResponse(input = {}, fetchJsonFn) {
  const response = baseResponse();
  const cityInputs = Array.isArray(input.cities) ? input.cities : [];
  const cityIdInputs = Array.isArray(input.city_ids) ? input.city_ids : [];
  const requests = cityInputs.length
    ? cityInputs.map((city) => ({ city }))
    : cityIdInputs.map((city_id) => ({ city_id }));

  if (!requests.length) throw new Error('Batch request requires cities or city_ids.');

  for (let index = 0; index < requests.length; index += 1) {
    try {
      response.items.push(await buildWeatherItem({
        ...requests[index],
        date: input.date,
      }, fetchJsonFn));
    } catch (error) {
      response.errors.push({
        index,
        input: requests[index],
        error: error.message || 'Weather lookup failed.',
      });
    }
  }

  return response;
}

module.exports = {
  CITIES,
  buildSingleWeatherResponse,
  buildBatchWeatherResponse,
  buildWeatherItem,
  fetchTestModelData,
  buildModelsBlock,
  getCityCategory,
};
