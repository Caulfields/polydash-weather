function pad2(value) {
  return String(value).padStart(2, '0');
}

function safeTz(timezone) {
  if (!timezone || timezone === 'auto') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return timezone;
  } catch {
    return 'UTC';
  }
}

function dateKeyForTz(timezone, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function todayKey(timezone) {
  return dateKeyForTz(timezone, new Date());
}

function tomorrowKey(timezone) {
  const shifted = new Date(Date.now() + 86400000);
  return dateKeyForTz(timezone, shifted);
}

function timesForDates(dates) {
  const times = [];
  for (const date of dates) {
    for (let i = 0; i < 24; i += 1) {
      times.push(`${date}T${pad2(i)}:00`);
    }
  }
  return times;
}

function seriesFor(times, rule = {}) {
  const {
    base = 16,
    amp = 6,
    rainAt = [],
    cloud = 25,
    low = 15,
    windBase = 12,
    code = null,
  } = rule;
  return times.map((time, index) => {
    const hour = index % 24;
    const temp = Math.round((base + amp * Math.sin(((hour - 8) / 24) * 2 * Math.PI)) * 10) / 10;
    const raining = rainAt.includes(hour);
    return {
      temp,
      rain: raining ? 1.4 : 0,
      rainProb: raining ? 90 : 10,
      weatherCode: code != null ? code : (raining ? 61 : 1),
      windSpeed: windBase + (hour % 6),
      windDir: (hour * 15) % 360,
      cloudCover: cloud,
      cloudCoverLow: low,
    };
  });
}

function hourlyWithModels(times, models, rule = {}) {
  const series = seriesFor(times, rule);
  const keys = [
    'temperature_2m',
    'precipitation',
    'precipitation_probability',
    'weather_code',
    'wind_speed_10m',
    'wind_direction_10m',
    'cloud_cover',
    'cloud_cover_low',
  ];
  const values = [
    series.map((s) => s.temp),
    series.map((s) => s.rain),
    series.map((s) => s.rainProb),
    series.map((s) => s.weatherCode),
    series.map((s) => s.windSpeed),
    series.map((s) => s.windDir),
    series.map((s) => s.cloudCover),
    series.map((s) => s.cloudCoverLow),
  ];

  const hourly = { time: times };
  const includeAuto = !models.length || models.includes('auto');
  if (includeAuto) {
    keys.forEach((key, index) => {
      hourly[key] = values[index];
    });
  }
  for (const model of models.filter((id) => id && id !== 'auto')) {
    keys.forEach((key, index) => {
      hourly[`${key}_${model}`] = values[index];
    });
  }
  return hourly;
}

function buildForecastPayload(urlOrParams, rule = {}) {
  const params = urlOrParams instanceof URL
    ? urlOrParams.searchParams
    : new URLSearchParams(urlOrParams);

  const timezone = safeTz(params.get('timezone') || 'UTC');
  const models = (params.get('models') || 'auto').split(',').filter(Boolean);

  let dates;
  if (params.has('start_date')) {
    dates = [params.get('start_date')];
    const end = params.get('end_date');
    if (end && end !== params.get('start_date')) dates.push(end);
  } else {
    dates = [todayKey(timezone)];
  }

  const hourly = hourlyWithModels(timesForDates(dates), models, rule);
  return { hourly, latitude: 0, longitude: 0, timezone };
}

function metarPayload({ station, hours = 24, timezone = 'UTC', tempBase = 17, includeTenths = false, startHour = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < hours; i += 1) {
    const date = new Date(Date.now() - (hours - i) * 3600000);
    const iso = date.toISOString();
    const temp = tempBase + Math.round(Math.sin(i / hours * Math.PI * 2) * 4 * 10) / 10;
    const tempTenths = Math.round(temp * 10);
    const dewpTenths = Math.round((temp - 4) * 10);
    const sign = (value) => (value < 0 ? '1' : '0');
    const abs = (value) => String(Math.abs(value)).padStart(3, '0');
    const tGroup = `T${sign(tempTenths)}${abs(tempTenths)}${sign(dewpTenths)}${abs(dewpTenths)}`;
    const rawOb = `${station} ${iso.slice(11, 13)}${iso.slice(14, 16)}Z 22008KT 9999 SCT020 ${temp | 0}/${(temp | 0) - 4} Q1018 ${tGroup}`;
    rows.push({
      station,
      rawOb,
      reportTime: iso,
      temp: includeTenths ? Math.round(temp) : temp,
      dewp: temp - 4,
      wdir: 220,
      wspd: 8,
      visibility: 9999,
    });
  }
  return rows;
}

module.exports = {
  pad2,
  dateKeyForTz,
  todayKey,
  tomorrowKey,
  timesForDates,
  seriesFor,
  hourlyWithModels,
  buildForecastPayload,
  metarPayload,
};