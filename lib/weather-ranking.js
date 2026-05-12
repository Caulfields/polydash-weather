const { WEATHER_MODELS, US_MODELS, CITIES } = require('../assets/js/dashboard/config');

const METAR_TTL_MS = 90_000;
const FORECAST_TTL_MS = 10 * 60_000;
const RESULT_TTL_MS = 5 * 60_000;

const metarCache = new Map();
const forecastCache = new Map();
const resultCache = new Map();
const metarInflight = new Map();
const forecastInflight = new Map();
const resultInflight = new Map();

function normalizeLookup(value) {
  return `${value || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveCity(value) {
  const lookup = normalizeLookup(value);
  if (!lookup) return CITIES.beijing;

  const city = Object.values(CITIES).find((item) => (
    normalizeLookup(item.id) === lookup ||
    normalizeLookup(item.name) === lookup ||
    normalizeLookup(item.metar) === lookup
  ));
  return city || null;
}

function forecastCandidates(city) {
  const options = city.modelOptions?.length ? city.modelOptions : US_MODELS.slice(0, 10);
  return options.slice(0, options.length >= 20 ? 20 : 10);
}

function cityDateKey(timezone, date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

function cityTimeParts(date, timezone) {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
}

function toHourFrac(date, timezone) {
  const parts = cityTimeParts(date, timezone);
  return parseInt(parts.hour, 10) + parseInt(parts.minute, 10) / 60 + parseInt(parts.second, 10) / 3600;
}

function parseObsDate(value) {
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  return new Date(value);
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

async function fetchJson(url) {
  const upstream = await fetch(url, { headers: { 'User-Agent': 'weather-dashboard/1.0' } });
  if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
  return upstream.json();
}

async function fetchMetarRaw(station, hours) {
  const url = `https://aviationweather.gov/api/data/metar?ids=${station}&format=json&taf=false&hours=${hours}`;
  const json = await fetchJson(url);
  if (!Array.isArray(json) && !json.data) throw new Error('Invalid METAR response');
  return Array.isArray(json) ? json : json.data;
}

async function fetchMetar(city, hours = 48) {
  const cacheKey = `${city.metar}_${hours}`;
  const cache = metarCache.get(cacheKey) || { data: null, ts: 0 };
  if (cache.data && Date.now() - cache.ts < METAR_TTL_MS) return cache.data;

  if (!metarInflight.has(cacheKey)) {
    metarInflight.set(cacheKey, fetchMetarRaw(city.metar, hours).finally(() => metarInflight.delete(cacheKey)));
  }
  const data = await metarInflight.get(cacheKey);
  metarCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

function parseMetarToday(raw, city) {
  const todayKey = cityDateKey(city.timezone);
  return raw
    .filter((row) => row.temp != null)
    .map((row) => {
      const precise = city.usesUsMetarTenths ? parseUsMetarTenths(row.rawOb) : null;
      return {
        time: parseObsDate(row.reportTime ?? row.obsTime),
        temp: precise?.tempC ?? row.temp,
        wspd: row.wspd,
      };
    })
    .filter((row) => (
      Number.isFinite(row.time.getTime()) &&
      Number.isFinite(row.temp) &&
      cityDateKey(city.timezone, row.time) === todayKey
    ))
    .sort((a, b) => a.time - b.time);
}

async function fetchForecast(city, modelId) {
  const cacheKey = `${city.metar}_${modelId}`;
  const cache = forecastCache.get(cacheKey) || { data: null, ts: 0 };
  if (cache.data && Date.now() - cache.ts < FORECAST_TTL_MS) return cache.data;

  const params = new URLSearchParams({
    latitude: city.coords.lat,
    longitude: city.coords.lon,
    hourly: 'temperature_2m,precipitation,precipitation_probability,wind_speed_10m,wind_direction_10m',
    forecast_days: '1',
    timezone: city.timezone,
  });
  if (modelId !== 'auto') params.set('models', modelId);

  if (!forecastInflight.has(cacheKey)) {
    forecastInflight.set(cacheKey, fetchJson(`https://api.open-meteo.com/v1/forecast?${params.toString()}`)
      .finally(() => forecastInflight.delete(cacheKey)));
  }
  const data = await forecastInflight.get(cacheKey);
  if (!data.hourly?.time?.length) throw new Error('Open-Meteo missing hourly data');
  forecastCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

function hourlyField(hourly, base, modelId) {
  if (modelId && modelId !== 'auto') {
    const modelField = `${base}_${modelId}`;
    if (Array.isArray(hourly[modelField])) return hourly[modelField];
  }
  if (Array.isArray(hourly[base])) return hourly[base];
  const match = Object.keys(hourly).find((key) => key.startsWith(`${base}_`) && Array.isArray(hourly[key]));
  return match ? hourly[match] : [];
}

function parseHourlyRows(hourly, dateKey, modelId) {
  const times = hourly.time || [];
  const temps = hourlyField(hourly, 'temperature_2m', modelId);
  const rain = hourlyField(hourly, 'precipitation', modelId);
  const rainProb = hourlyField(hourly, 'precipitation_probability', modelId);
  const windSpeed = hourlyField(hourly, 'wind_speed_10m', modelId);
  const windDir = hourlyField(hourly, 'wind_direction_10m', modelId);

  return times.map((time, index) => {
    if (!time.startsWith(dateKey)) return null;
    const temp = temps[index];
    if (typeof temp !== 'number') return null;
    const hour = parseInt(time.substring(11, 13), 10);
    const minute = parseInt(time.substring(14, 16), 10);
    return {
      time,
      hour,
      minute,
      hourFrac: hour + minute / 60,
      label: time.substring(11, 16),
      temp,
      rain: typeof rain[index] === 'number' ? rain[index] : 0,
      rainProb: typeof rainProb[index] === 'number' ? rainProb[index] : null,
      windSpeed: typeof windSpeed[index] === 'number' ? windSpeed[index] : null,
      windDir: typeof windDir[index] === 'number' ? windDir[index] : null,
    };
  }).filter(Boolean);
}

function nearestObservedByHour(rows, timezone) {
  const byHour = new Map();
  rows.forEach((row) => {
    const hour = Math.round(toHourFrac(row.time, timezone));
    if (hour < 0 || hour > 23) return;
    const prev = byHour.get(hour);
    const distance = Math.abs(toHourFrac(row.time, timezone) - hour);
    if (!prev || distance < prev.distance) byHour.set(hour, { row, distance });
  });
  return byHour;
}

function scoreForecastRows(forecastRows, observations, timezone) {
  const observedByHour = nearestObservedByHour(observations, timezone);
  const errors = [];
  const windErrors = [];

  forecastRows.forEach((row) => {
    const hour = Math.round(row.hourFrac);
    const observed = observedByHour.get(hour)?.row;
    if (!observed || Math.abs(row.hourFrac - hour) > 0.35) return;
    errors.push(Math.abs(row.temp - observed.temp));
    if (typeof row.windSpeed === 'number' && typeof observed.wspd === 'number') {
      windErrors.push(Math.abs(row.windSpeed - observed.wspd * 1.852));
    }
  });

  if (errors.length < 3) return null;
  const mae = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const rmse = Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length);
  const windMae = windErrors.length
    ? windErrors.reduce((sum, value) => sum + value, 0) / windErrors.length
    : 0;
  return {
    mae,
    rmse,
    windMae,
    matches: errors.length,
    score: mae + rmse * 0.25 + windMae * 0.04,
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

function averageDirection(degrees) {
  const valid = degrees.filter((value) => typeof value === 'number');
  if (!valid.length) return null;
  const vector = valid.reduce((acc, value) => {
    const radians = value * Math.PI / 180;
    acc.x += Math.cos(radians);
    acc.y += Math.sin(radians);
    return acc;
  }, { x: 0, y: 0 });
  const angle = Math.atan2(vector.y / valid.length, vector.x / valid.length) * 180 / Math.PI;
  return (angle + 360) % 360;
}

function averageForecastRows(combo) {
  const rowsByModel = combo.map((item) => new Map(item.rows.map((row) => [row.time, row])));
  const sharedTimes = combo[0].rows
    .map((row) => row.time)
    .filter((time) => rowsByModel.every((rows) => rows.has(time)));

  return sharedTimes.map((time) => {
    const rows = rowsByModel.map((rows) => rows.get(time));
    const first = rows[0];
    const average = (key, fallback = null) => {
      const values = rows.map((row) => row[key]).filter((value) => typeof value === 'number');
      return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : fallback;
    };
    return {
      time,
      hour: first.hour,
      minute: first.minute,
      hourFrac: first.hourFrac,
      label: first.label,
      temp: average('temp'),
      rain: average('rain', 0),
      rainProb: average('rainProb'),
      windSpeed: average('windSpeed'),
      windDir: averageDirection(rows.map((row) => row.windDir)),
    };
  }).filter((row) => typeof row.temp === 'number');
}

function maxTemperature(rows) {
  if (!rows.length) return null;
  return rows.reduce((best, row) => (!best || row.temp > best.temp ? row : best), null);
}

function tempFromCelsius(tempC, unit) {
  if (!Number.isFinite(tempC)) return null;
  return unit === 'F'
    ? Number(((tempC * 9) / 5 + 32).toFixed(1))
    : Number(tempC.toFixed(1));
}

function formatResultModel(item, city, unit) {
  const max = maxTemperature(item.rows);
  return {
    id: item.id,
    name: WEATHER_MODELS[item.id] || item.id,
    modelIds: item.modelIds || [item.id],
    modelNames: (item.modelIds || [item.id]).map((id) => WEATHER_MODELS[id] || id),
    maxTemperature: max ? {
      celsius: Number(max.temp.toFixed(1)),
      value: tempFromCelsius(max.temp, unit),
      unit,
      time: max.time,
      label: max.label,
    } : null,
    accuracy: {
      maeC: Number(item.mae.toFixed(2)),
      rmseC: Number(item.rmse.toFixed(2)),
      windMaeKmh: Number(item.windMae.toFixed(2)),
      matches: item.matches,
      score: Number(item.score.toFixed(3)),
    },
  };
}

async function rankTemperature(city, options = {}) {
  const unit = options.unit === 'F' || options.unit === 'C' ? options.unit : (city.tempUnit || 'C');
  const cacheKey = `${city.id}_${unit}`;
  const cache = resultCache.get(cacheKey) || { data: null, ts: 0 };
  if (cache.data && Date.now() - cache.ts < RESULT_TTL_MS) return cache.data;
  if (resultInflight.has(cacheKey)) return resultInflight.get(cacheKey);

  const promise = (async () => {
    const observations = parseMetarToday(await fetchMetar(city, 48), city);
    if (observations.length < 3) {
      throw new Error('Need at least 3 same-day METAR observations to score model accuracy');
    }

    const dateKey = cityDateKey(city.timezone);
    const candidates = forecastCandidates(city);
    const modelRows = [];

    for (let index = 0; index < candidates.length; index += 4) {
      const batch = candidates.slice(index, index + 4);
      const settled = await Promise.allSettled(batch.map(async (id) => {
        const data = await fetchForecast(city, id);
        const rows = parseHourlyRows(data.hourly || {}, dateKey, id);
        return rows.length ? { id, rows } : null;
      }));
      settled.forEach((item) => {
        if (item.status === 'fulfilled' && item.value) modelRows.push(item.value);
      });
    }

    const singles = modelRows
      .map((item) => {
        const score = scoreForecastRows(item.rows, observations, city.timezone);
        return score ? { id: item.id, rows: item.rows, ...score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);

    if (!singles.length) throw new Error('No comparable forecast models');

    let bestAverage = null;
    for (const size of [2, 3, 4]) {
      for (const combo of combinations(singles, size)) {
        const rows = averageForecastRows(combo);
        const score = scoreForecastRows(rows, observations, city.timezone);
        if (!score) continue;
        const result = {
          id: `avg_${combo.map((item) => item.id).join('__')}`,
          modelIds: combo.map((item) => item.id),
          rows,
          ...score,
        };
        if (!bestAverage || result.score < bestAverage.score) bestAverage = result;
      }
    }

    const data = {
      city: {
        id: city.id,
        name: city.name,
        station: city.metar,
        timezone: city.timezone,
      },
      date: dateKey,
      unit,
      generatedAt: new Date().toISOString(),
      observations: {
        count: observations.length,
        latestTime: observations[observations.length - 1]?.time.toISOString() || null,
      },
      bestModel: formatResultModel(singles[0], city, unit),
      bestAverageModel: bestAverage ? formatResultModel(bestAverage, city, unit) : null,
      averageImprovesBestModel: Boolean(bestAverage && bestAverage.score < singles[0].score),
    };
    resultCache.set(cacheKey, { data, ts: Date.now() });
    return data;
  })().finally(() => resultInflight.delete(cacheKey));

  resultInflight.set(cacheKey, promise);
  return promise;
}

module.exports = {
  CITIES,
  resolveCity,
  rankTemperature,
};
