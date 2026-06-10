function cityTodayKey(timezone, date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

function cityDateKeyForOffset(timezone, offsetDays = 0, date = new Date()) {
  const [year, month, day] = cityTodayKey(timezone, date).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function forecastDayOffset() {
  return activeForecastDay === 'tomorrow' ? 1 : 0;
}

function activeForecastDateKey(timezone = activeCity.timezone) {
  return cityDateKeyForOffset(timezone, forecastDayOffset());
}

function isTodayForecastSelected() {
  return forecastDayOffset() === 0;
}

function forecastDayLabel() {
  return isTodayForecastSelected() ? 'Today' : 'Tomorrow';
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
  const cloudCover = hourlyField(hourly, 'cloud_cover', modelId);
  const weatherCode = hourlyField(hourly, 'weather_code', modelId);

  return times
    .map((time, index) => {
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
        cloudCover: typeof cloudCover[index] === 'number' ? cloudCover[index] : null,
        weatherCode: typeof weatherCode[index] === 'number' ? weatherCode[index] : null,
      };
    })
    .filter(Boolean);
}

function buildHourlyState(hourly, timezone, sourceLabel, modelId) {
  const dateKey = activeForecastDateKey(timezone);
  return {
    dateKey,
    rows: parseHourlyRows(hourly, dateKey, modelId),
    sourceLabel,
  };
}

function omDisplayTemp(tempC) {
  return tempFromCelsius(tempC, { decimals: activeTempUnit() === 'F' ? 1 : 1 });
}

function setOmMode(mode) {
  omMode = mode === 'average' ? 'average' : 'best';
  setOmHeader();
  if (activeCity.omKind === 'hourly' && hourlyOmState) drawOmChart();
}

function setOmHeader() {
  const badge = document.getElementById('omBadge');
  const switchWrap = document.getElementById('omSwitch');
  const bestBtn = document.getElementById('omModeBest');
  const avgBtn = document.getElementById('omModeAvg');
  if (!badge) return;
  const averaged = artificialAverageModel(activeForecastModel);
  badge.textContent = averaged
    ? averaged.label
    : activeForecastModel === 'auto'
    ? (activeCity.omBadge || 'OM')
    : (WEATHER_MODELS[activeForecastModel] || activeForecastModel);
  badge.classList.remove('om-badge-owm');
  if (switchWrap) switchWrap.style.display = 'none';
  if (bestBtn && avgBtn) {
    bestBtn.className = 'om-mode-btn';
    avgBtn.className = 'om-mode-btn';
  }
}

function drawOmChart() {
  drawChart();
}

const omChartInterval = setInterval(() => {
  if (omData) drawOmChart();
}, 60000);

function windDir(degValue) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(degValue / 22.5) % 16];
}

function compassFromDeg(degValue) {
  if (typeof degValue !== 'number' || !Number.isFinite(degValue)) return null;
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(((degValue % 360) + 360) % 360 / 22.5) % 16];
}

function windTranscript({ speed, dirDeg, unit, variable } = {}) {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) return null;
  const speedText = `${Math.round(speed)} ${unit}`;
  if (variable) return `Variable at ${speedText}`;
  const compass = compassFromDeg(dirDeg);
  if (!compass) return speedText;
  return `${compass} ${speedText}`;
}

async function fetchOpenMeteo() {
  const requestCityId = activeCity.id;
  const requestModel = activeForecastModel;
  const averaged = artificialAverageModel(requestModel);
  try {
    setOmHeader();
    document.getElementById('omLoading').style.display = '';
    document.getElementById('omLoading').textContent = 'Loading...';
    if (averaged?.rows?.length) {
      hourlyOmState = {
        dateKey: activeForecastDateKey(activeCity.timezone),
        rows: averaged.rows,
        sourceLabel: 'Avg',
      };
      omData = null;
      document.getElementById('omLoading').style.display = 'none';
      drawChart();
      updateForecastMaxTemp();
      updateWeatherCodeUI();
      fetchModelStatus();
      if (isTodayForecastSelected()) tryReuseEcmwfTags(hourlyOmState.rows);
      return;
    }
    if (averaged?.modelIds?.length) {
      const rows = await fetchAverageModelRows(averaged.modelIds, requestCityId);
      if (requestCityId !== activeCity.id || requestModel !== activeForecastModel) return;
      if (!rows.length) throw new Error(`${averaged.label} has no shared data for this location`);
      hourlyOmState = {
        dateKey: activeForecastDateKey(activeCity.timezone),
        rows,
        sourceLabel: averaged.saved ? 'Saved avg' : 'Avg',
      };
      omData = null;
      document.getElementById('omLoading').style.display = 'none';
      drawChart();
      updateForecastMaxTemp();
      updateWeatherCodeUI();
      fetchModelStatus();
      if (isTodayForecastSelected()) tryReuseEcmwfTags(hourlyOmState.rows);
      return;
    }
    const res = await fetch(buildOpenMeteoUrl(), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    if (requestCityId !== activeCity.id || requestModel !== activeForecastModel) return;
    omData = data;
    const label = requestModel === 'auto'
      ? 'Best match'
      : (WEATHER_MODELS[requestModel] || requestModel);
    hourlyOmState = buildHourlyState(omData.hourly || {}, activeCity.timezone, label, requestModel);
    if (!hourlyOmState.rows.length) throw new Error(`${label} has no data for this location`);
    document.getElementById('omLoading').style.display = 'none';
    setOmHeader();
    drawChart();
    updateForecastMaxTemp();
    updateWeatherCodeUI();
    fetchModelStatus();
    if (requestModel === 'ecmwf_ifs025') {
      updateEcmwfTagsDOM(hourlyOmState.rows);
    }
  } catch (error) {
    console.warn('Open-Meteo fetch:', error.message);
    document.getElementById('omLoading').textContent = 'Open-Meteo unavailable';
  }
}

function buildOpenMeteoUrl() {
  const params = new URLSearchParams({
    station: activeCity.metar,
    model: activeForecastModel,
    date: activeForecastDateKey(activeCity.timezone),
  });
  return `/api/forecast?${params.toString()}`;
}

window.addEventListener('resize', () => {
  if (omData) drawOmChart();
});

function tryReuseEcmwfTags(rows) {
  if (activeForecastModel === 'ecmwf_ifs025') {
    updateEcmwfTagsDOM(rows);
  }
}

function updateEcmwfTagsDOM(rows) {
  const tagWind = document.getElementById('tagWind');
  const tagRain = document.getElementById('tagRain');
  const tagCloud = document.getElementById('tagCloud');
  if (!tagWind || !tagRain || !tagCloud) return;
  tagWind.style.display = 'none';
  tagRain.style.display = 'none';
  tagCloud.style.display = 'none';
  tagCloud.textContent = '';

  const hasStrongWind = rows.some((row) => row.windSpeed != null && row.windSpeed > 10 && row.hourFrac >= 8);
  const hasRain = rows.some((row) => row.rain != null && row.rain > 0);
  const avgCloud = rows.reduce((sum, r) => sum + (r.cloudCover || 0), 0) / rows.length;
  const avgRainProb = rows.reduce((sum, r) => sum + (r.rainProb || 0), 0) / rows.length;

  if (hasStrongWind) {
    tagWind.style.display = '';
    tagWind.className = 'weather-tag wind';
  }
  if (hasRain) {
    tagRain.style.display = '';
    tagRain.className = 'weather-tag rain';
  }
  let cloudText = '';
  if (avgCloud > 0) cloudText += `${Math.round(avgCloud)}% cloud`;
  if (avgRainProb > 0) {
    if (cloudText) cloudText += ' / ';
    cloudText += `${Math.round(avgRainProb)}% rain`;
  }
  if (cloudText) {
    tagCloud.style.display = '';
    tagCloud.className = 'weather-tag cloud';
    tagCloud.textContent = cloudText;
  }
}

function updateForecastMaxTemp() {
  const el = document.getElementById('forecastMaxTemp');
  if (!el) return;
  if (!hourlyOmState?.rows?.length) {
    el.textContent = '';
    return;
  }
  const maxTemp = Math.max(...hourlyOmState.rows.map((r) => r.temp));
  el.textContent = formatTempFromCelsius(maxTemp, { decimals: 1 });
}

const WMO_WEATHER_CODES = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

const CODE_SEVERITY = {
  0:0, 1:1, 2:2, 3:3,
  45:4, 48:5,
  51:6, 53:7, 55:8,
  56:9, 57:10,
  71:11, 73:12, 75:13, 77:11,
  61:14, 63:15, 65:16,
  66:17, 67:18,
  80:14, 81:15, 82:16,
  85:19, 86:20,
  95:21, 96:22, 99:23,
};

function weatherCodeFromRows(rows) {
  const codes = rows
    .filter((r) => r.weatherCode != null && r.hourFrac >= 8 && r.hourFrac <= 20)
    .map((r) => r.weatherCode);
  if (!codes.length) return null;

  const worst = codes.reduce((a, b) => (CODE_SEVERITY[a] || 0) > (CODE_SEVERITY[b] || 0) ? a : b);
  const worstSev = CODE_SEVERITY[worst] || 0;
  if (worstSev >= 14) return worst;

  const freq = {};
  codes.forEach((c) => { freq[c] = (freq[c] || 0) + 1; });
  return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
}

function updateWeatherCodeUI() {
  const el = document.getElementById('cfWeatherCode');
  if (!el) return;
  const rows = hourlyOmState?.rows;
  if (!rows?.length) { el.style.display = 'none'; return; }
  const code = weatherCodeFromRows(rows);
  if (code == null) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.textContent = WMO_WEATHER_CODES[code] || `Code ${code}`;
  el.className = 'cf-value weather-code';
}

function localHourFrac() {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: activeCity.timezone,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return parseInt(parts.hour, 10) + parseInt(parts.minute, 10) / 60 + parseInt(parts.second, 10) / 3600;
}

let modelStatusData = null;

function estimateModelRun(modelId) {
  const intervalH = MODEL_UPDATE_HOURS[modelId] || 6;
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const intervalMin = intervalH * 60;
  const elapsedMin = utcMin % intervalMin;
  const lastMin = utcMin - elapsedMin;
  const nextMin = lastMin + intervalMin;
  const last = new Date(now);
  last.setUTCHours(Math.floor(lastMin / 60), lastMin % 60, 0, 0);
  const next = new Date(now);
  next.setUTCHours(Math.floor(nextMin / 60), nextMin % 60, 0, 0);
  if (next <= now) next.setTime(next.getTime() + intervalMin * 60000);
  if (last > now) last.setTime(last.getTime() - intervalMin * 60000);
  return { last, next, intervalH };
}

function fetchModelStatus() {
  const modelId = activeForecastModel;
  if (!modelId || modelId === 'auto' || modelId.startsWith('avg_')) { updateModelTimeUI(null); return; }
  const intervalH = MODEL_UPDATE_HOURS[modelId];
  if (!intervalH) { updateModelTimeUI(null); return; }
  const { last, next } = estimateModelRun(modelId);
  updateModelTimeUI({ last, next });
}

function fmtTime(d) {
  return d.toLocaleString('en-GB', {
    timeZone: activeCity.timezone,
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

function updateModelTimeUI(run) {
  const el = document.getElementById('modelUpd');
  if (!el) return;
  if (!run) { el.style.display = 'none'; return; }
  const age = Math.round((Date.now() - run.last.getTime()) / 60000);
  let text = `${fmtTime(run.last)} | ${fmtTime(run.next)}`;
  el.style.display = '';
  el.textContent = text;
}

async function fetchEcmwfTags() {
  const tagWind = document.getElementById('tagWind');
  const tagRain = document.getElementById('tagRain');
  const tagCloud = document.getElementById('tagCloud');
  if (!tagWind || !tagRain || !tagCloud) return;

  if (activeForecastModel === 'ecmwf_ifs025' && hourlyOmState?.rows?.length) {
    updateEcmwfTagsDOM(hourlyOmState.rows);
    return;
  }

  tagWind.style.display = 'none';
  tagRain.style.display = 'none';
  tagCloud.style.display = 'none';
  tagCloud.textContent = '';

  const requestCityId = activeCity.id;
  const dateKey = activeForecastDateKey(activeCity.timezone);
  const params = new URLSearchParams({
    station: activeCity.metar,
    model: 'ecmwf_ifs025',
    date: dateKey,
  });
  try {
    const res = await fetch(`/api/forecast?${params.toString()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (requestCityId !== activeCity.id) return;
    const rows = parseHourlyRows(data.hourly || {}, dateKey, 'ecmwf_ifs025');
    if (!rows.length) return;

    updateEcmwfTagsDOM(rows);
  } catch (e) {
    console.warn('ECMWF tags fetch:', e.message);
  }
}
