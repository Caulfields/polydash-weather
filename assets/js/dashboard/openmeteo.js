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

  if (hasStrongWind) {
    tagWind.style.display = '';
    tagWind.className = 'weather-tag wind';
  }
  if (hasRain) {
    tagRain.style.display = '';
    tagRain.className = 'weather-tag rain';
  }
  if (avgCloud > 0) {
    tagCloud.style.display = '';
    tagCloud.className = 'weather-tag cloud';
    tagCloud.textContent = `${Math.round(avgCloud)}% cloud`;
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
