const { WEATHER_MODELS, US_MODELS, CITIES } = require('../assets/js/dashboard/config');
const { STATIONS, normalizeStation } = require('../data/weather-stations');
const { resolveCity } = require('./weather-ranking');
const { computeCityCategories } = require('./city-ranking');
const { getTestModels } = require('../data/test-models');

const SCHEMA_VERSION = '2.0';
const METAR_HOURS = 168;
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_MODEL_CANDIDATES = 10;

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

function parseUsMetarTenths(rawOb) {
  if (!rawOb) return null;
  const match = rawOb.match(/\bT([01])(\d{3})([01])(\d{3})\b/);
  if (!match) return null;
  const parseSignedTenths = (sign, digits) => (sign === '1' ? -1 : 1) * (parseInt(digits, 10) / 10);
  return {
    tempC: parseSignedTenths(match[1], match[2]),
    dewpC: parseSignedTenths(match[3], match[4]),
  };
}

function parseObsDate(value) {
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  return new Date(value);
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

function formatInZone(date, timezone) {
  if (!date || !Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offsetForZone(timezone, date)}`;
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

async function fetchMetarRows(station) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json&taf=false&hours=${METAR_HOURS}`;
  const json = await fetchJson(url);
  if (!Array.isArray(json) && !Array.isArray(json.data)) throw new Error('Invalid METAR response');
  return Array.isArray(json) ? json : json.data;
}

function normalizeMetarRows(rows, city, date) {
  return rows
    .map((row) => {
      const time = parseObsDate(row.reportTime ?? row.obsTime);
      const precise = city.usesUsMetarTenths ? parseUsMetarTenths(row.rawOb) : null;
      const temp = precise?.tempC ?? row.temp;
      return {
        time,
        temp: Number(temp),
        raw: row.rawOb || null,
      };
    })
    .filter((row) => (
      Number.isFinite(row.time.getTime()) &&
      Number.isFinite(row.temp) &&
      dateKeyForZone(row.time, city.timezone) === date
    ))
    .sort((a, b) => a.time - b.time);
}

async function fetchForecast(city, date, modelId = 'auto') {
  const params = new URLSearchParams({
    latitude: city.coords.lat,
    longitude: city.coords.lon,
    hourly: 'temperature_2m',
    start_date: date,
    end_date: date,
    timezone: city.timezone,
  });
  if (modelId !== 'auto') params.set('models', modelId);
  const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!data.hourly?.time?.length) throw new Error('Open-Meteo missing hourly data');
  return data;
}

function hourlyTemps(hourly, modelId) {
  if (modelId && modelId !== 'auto') {
    const modelField = `temperature_2m_${modelId}`;
    if (Array.isArray(hourly[modelField])) return hourly[modelField];
  }
  if (Array.isArray(hourly.temperature_2m)) return hourly.temperature_2m;
  const match = Object.keys(hourly).find((key) => (
    key.startsWith('temperature_2m_') && Array.isArray(hourly[key])
  ));
  return match ? hourly[match] : [];
}

function forecastRows30Min(hourly, timezone, modelId = 'auto') {
  const times = hourly.time || [];
  const temps = hourlyTemps(hourly, modelId);
  const rows = [];

  for (let index = 0; index < times.length; index += 1) {
    if (typeof temps[index] !== 'number') continue;
    rows.push({
      time: localIsoWithOffset(times[index], timezone),
      temp_c: round1(temps[index]),
    });

    const nextTemp = temps[index + 1];
    if (typeof nextTemp === 'number') {
      const halfTime = new Date(`${times[index]}:00Z`);
      halfTime.setUTCMinutes(halfTime.getUTCMinutes() + 30);
      const halfLocal = halfTime.toISOString().slice(0, 16);
      rows.push({
        time: localIsoWithOffset(halfLocal, timezone),
        temp_c: round1((temps[index] + nextTemp) / 2),
      });
    }
  }

  return rows;
}

function averageForecastSeries(series) {
  if (!series.length) return [];
  const maps = series.map((rows) => new Map(rows.map((row) => [row.time, row.temp_c])));
  return series[0]
    .filter((row) => maps.every((map) => Number.isFinite(map.get(row.time))))
    .map((row) => ({
      time: row.time,
      temp_c: round1(maps.reduce((sum, map) => sum + map.get(row.time), 0) / maps.length),
    }));
}

function maxByTemp(rows) {
  return rows.reduce((best, row) => (
    !best || row.temp_c > best.temp_c ? row : best
  ), null);
}

function cityTimeParts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
}

function hasRecentOvercast(rows, timezone, windowHours = 4) {
  const cutoffMs = Date.now() - windowHours * 3600 * 1000;

  for (const row of rows) {
    if (!row.raw) continue;
    if (row.time.getTime() < cutoffMs) continue;
    if (/\bOVC\d{0,3}(?:CB|TCU)?\b/.test(row.raw)) {
      return true;
    }
  }

  return false;
}

function toHourFrac(date, timezone) {
  const parts = cityTimeParts(date, timezone);
  return parseInt(parts.hour, 10) + parseInt(parts.minute, 10) / 60 + parseInt(parts.second, 10) / 3600;
}

function forecastCandidates(city) {
  const options = city.modelOptions?.length ? city.modelOptions : US_MODELS.slice(0, MAX_MODEL_CANDIDATES);
  return options.slice(0, MAX_MODEL_CANDIDATES);
}

function hourlyForecastRows(hourly, modelId) {
  const times = hourly.time || [];
  const temps = hourlyTemps(hourly, modelId);
  return times.map((time, index) => {
    const temp = temps[index];
    if (typeof temp !== 'number') return null;
    const hour = parseInt(time.substring(11, 13), 10);
    const minute = parseInt(time.substring(14, 16), 10);
    return {
      time,
      hourFrac: hour + minute / 60,
      temp,
    };
  }).filter(Boolean);
}

function nearestObservedByHour(rows, timezone) {
  const byHour = new Map();
  rows.forEach((row) => {
    const hour = Math.round(toHourFrac(row.time, timezone));
    if (hour < 0 || hour > 23) return;
    const distance = Math.abs(toHourFrac(row.time, timezone) - hour);
    const previous = byHour.get(hour);
    if (!previous || distance < previous.distance) byHour.set(hour, { row, distance });
  });
  return byHour;
}

function scoreForecastRows(forecastRows, observationRows, timezone) {
  const observedByHour = nearestObservedByHour(observationRows, timezone);
  const errors = [];

  forecastRows.forEach((row) => {
    const hour = Math.round(row.hourFrac);
    const observed = observedByHour.get(hour)?.row;
    if (!observed || Math.abs(row.hourFrac - hour) > 0.35) return;
    errors.push(Math.abs(row.temp - observed.temp));
  });

  if (errors.length < 3) return null;
  const mae = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const rmse = Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length);
  return {
    mae_c: Number(mae.toFixed(2)),
    rmse_c: Number(rmse.toFixed(2)),
    matches: errors.length,
    score: Number((mae + rmse * 0.25).toFixed(3)),
  };
}

function combinations(items, size) {
  const result = [];
  const combo = [];
  function walk(start) {
    if (combo.length === size) {
      result.push(combo.slice());
      return;
    }
    for (let index = start; index <= items.length - (size - combo.length); index += 1) {
      combo.push(items[index]);
      walk(index + 1);
      combo.pop();
    }
  }
  walk(0);
  return result;
}

function averageHourlyRows(combo) {
  const maps = combo.map((item) => new Map(item.rows.map((row) => [row.time, row])));
  return combo[0].rows
    .filter((row) => maps.every((map) => map.has(row.time)))
    .map((row) => ({
      time: row.time,
      hourFrac: row.hourFrac,
      temp: maps.reduce((sum, map) => sum + map.get(row.time).temp, 0) / maps.length,
    }));
}

function forecastWindowMax(rows, minutes) {
  const count = Math.max(1, Math.floor(minutes / 30));
  return round1(Math.max(...rows.slice(0, count).map((row) => row.temp_c).filter(Number.isFinite)));
}

function peakForecastWindow(rows, timezone, date, dayMax, warnings) {
  if (!dayMax) return [];

  const requestedToday = dateKeyForZone(new Date(), timezone) === date;
  const nowMs = requestedToday ? Date.now() : new Date(rows[0]?.time || dayMax.time).getTime();
  const peakMs = new Date(dayMax.time).getTime();
  const endMs = peakMs + 60 * 60 * 1000;

  if (requestedToday && peakMs < nowMs) {
    warnings.push('Peak is over for the requested local date.');
    return [];
  }

  return rows.filter((row) => {
    const rowMs = new Date(row.time).getTime();
    return rowMs >= nowMs && rowMs <= endMs;
  });
}

async function observationSummary(city, date, warnings) {
  try {
    const rows = normalizeMetarRows(await fetchMetarRows(city.metar), city, date);
    const latest = rows[rows.length - 1] || null;
    const high = rows.reduce((best, row) => (!best || row.temp > best.temp ? row : best), null);
    if (!latest) warnings.push('No METAR observations found for requested date.');
    const summary = {
      source: 'aviationweather',
      used_fallback: false,
      latest_time: latest ? formatInZone(latest.time, city.timezone) : null,
      latest_temp_c: latest ? round1(latest.temp) : null,
      current_high_c: high ? round1(high.temp) : null,
      current_high_time: high ? formatInZone(high.time, city.timezone) : null,
      latest_age_minutes: latest ? Math.max(0, Math.round((Date.now() - latest.time.getTime()) / 60000)) : null,
      raw: latest?.raw || null,
    };
    return { summary, rows };
  } catch (error) {
    warnings.push(`METAR unavailable, using forecast fallback: ${error.message}`);
    return { summary: {
      source: 'open-meteo',
      used_fallback: true,
      latest_time: null,
      latest_temp_c: null,
      current_high_c: null,
      current_high_time: null,
      latest_age_minutes: null,
      raw: null,
    }, rows: [] };
  }
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

async function selectForecastModel(city, requestedDate, observationRows, warnings) {
  const fallback = {
    id: 'auto',
    name: WEATHER_MODELS.auto || 'Best match',
    type: 'single',
    model_ids: ['auto'],
    accuracy: null,
  };

  if (observationRows.length < 3) {
    warnings.push('Best-model search needs at least 3 observations; using auto forecast.');
    return fallback;
  }

  const settled = await Promise.allSettled(forecastCandidates(city).map(async (modelId) => {
    const forecast = await fetchForecast(city, requestedDate, modelId);
    const rows = hourlyForecastRows(forecast.hourly, modelId);
    const accuracy = scoreForecastRows(rows, observationRows, city.timezone);
    return accuracy ? { id: modelId, rows, accuracy } : null;
  }));

  const singles = settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value)
    .sort((a, b) => a.accuracy.score - b.accuracy.score);

  if (!singles.length) {
    warnings.push('Best-model search found no comparable models; using auto forecast.');
    return fallback;
  }

  const bestSingle = singles[0];
  let bestAverage = null;
  const averagePool = singles.slice(0, 6);
  for (const size of [2, 3, 4]) {
    for (const combo of combinations(averagePool, size)) {
      const rows = averageHourlyRows(combo);
      const accuracy = scoreForecastRows(rows, observationRows, city.timezone);
      if (!accuracy) continue;
      const candidate = {
        id: `avg_${combo.map((item) => item.id).join('__')}`,
        type: 'average',
        model_ids: combo.map((item) => item.id),
        accuracy,
      };
      if (!bestAverage || candidate.accuracy.score < bestAverage.accuracy.score) bestAverage = candidate;
    }
  }

  const selected = bestAverage?.accuracy.score < bestSingle.accuracy.score
    ? bestAverage
    : {
      id: bestSingle.id,
      type: 'single',
      model_ids: [bestSingle.id],
      accuracy: bestSingle.accuracy,
    };

  return {
    id: selected.id,
    name: WEATHER_MODELS[selected.id] || selected.id,
    type: selected.type,
    model_ids: selected.model_ids,
    accuracy: selected.accuracy,
  };
}

async function selectedForecastRows(city, date, selectedModel) {
  const modelIds = selectedModel.model_ids?.length ? selectedModel.model_ids : ['auto'];
  if (modelIds.length === 1) {
    const data = await fetchForecast(city, date, modelIds[0]);
    return forecastRows30Min(data.hourly, city.timezone, modelIds[0]);
  }

  const series = await Promise.all(modelIds.map(async (modelId) => {
    const data = await fetchForecast(city, date, modelId);
    return forecastRows30Min(data.hourly, city.timezone, modelId);
  }));
  return averageForecastSeries(series);
}

async function buildWeatherItem(input, fetchJsonFn) {
  if (!fetchJsonFn) fetchJsonFn = fetchJson;
  const date = normalizeDate(input.date);
  if (!date) throw new Error('Invalid or missing date. Use YYYY-MM-DD.');

  const city = resolveBotCity(input);
  if (!city) throw new Error('Unknown city or station.');

  const warnings = [];
  const observations = await observationSummary(city, date, warnings);
  const recentlyOvercast = observations.rows.length ? hasRecentOvercast(observations.rows, city.timezone, 4) : false;
  const selectedModel = await selectForecastModel(city, date, observations.rows, warnings);
  const rows30 = await selectedForecastRows(city, date, selectedModel);
  const dayMax = maxByTemp(rows30);
  const windowRows = peakForecastWindow(rows30, city.timezone, date, dayMax, warnings);

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
    observations: { ...observations.summary, overcast_recent_4h: recentlyOvercast },
    forecast: {
      source: 'open-meteo',
      model_id: selectedModel.id,
      model_type: selectedModel.type,
      model_ids: selectedModel.model_ids,
      day_max_c: dayMax?.temp_c ?? null,
      day_max_time: dayMax?.time ?? null,
      forecast_30min: windowRows,
      next_30m_max_c: forecastWindowMax(windowRows, 30),
      next_60m_max_c: forecastWindowMax(windowRows, 60),
      next_90m_max_c: forecastWindowMax(windowRows, 90),
      next_120m_max_c: forecastWindowMax(windowRows, 120),
    },
    best_model: selectedModel,
    category,
    category_label: ['green', 'blue', 'yellow', 'red'][category - 1] || 'green',
    models: modelsBlock,
    data_quality: {
      status: warnings.some((warning) => warning.includes('Peak is over')) ? 'peak_over' : (warnings.length ? 'warning' : 'ok'),
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
