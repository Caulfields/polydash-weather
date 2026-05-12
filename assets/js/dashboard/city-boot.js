let citySearchQuery = '';
let rankedModelIds = [];
let modelScoresById = {};
let rankedCityId = null;
let rankingRunId = 0;

function renderCityList() {
  const cityList = document.getElementById('cityList');
  const query = citySearchQuery.trim().toLowerCase();
  const cities = Object.values(CITIES).filter((city) => {
    if (!query) return true;
    return [
      city.name,
      city.metar,
      city.airport,
      city.timezone,
    ].some((value) => `${value || ''}`.toLowerCase().includes(query));
  });

  cityList.innerHTML = cities.length ? cities.map((city) => `
    <button class="city-button${city.id === activeCity.id ? ' active' : ''}" id="cityTab-${city.id}" type="button" onclick="switchCity('${city.id}')">
      <span class="city-name-row">
        <span class="city-name">${city.name}</span>
        <span class="city-station">${city.metar}</span>
      </span>
      <span class="city-airport">${city.airport}</span>
    </button>
  `).join('') : '<div class="city-empty">No matching cities</div>';
}

function cityModelOptions() {
  const options = activeCity.modelOptions?.length ? activeCity.modelOptions : US_MODELS.slice(0, 10);
  const visibleOptions = options.slice(0, options.length >= 20 ? 20 : 10);
  if (rankedCityId !== activeCity.id || !rankedModelIds.length) return visibleOptions;
  const ranked = rankedModelIds.filter((id) => visibleOptions.includes(id));
  const rest = visibleOptions.filter((id) => !ranked.includes(id));
  return [...ranked, ...rest];
}

function renderModelDock() {
  const dock = document.getElementById('modelDock');
  if (!dock) return;
  const options = cityModelOptions();
  if (!options.includes(activeForecastModel)) activeForecastModel = options[0] || 'auto';
  dock.innerHTML = options.map((id) => {
    const score = modelScoresById[id];
    const rankedClass = rankedCityId === activeCity.id && score ? ' ranked' : '';
    const title = score
      ? `MAE ${score.mae.toFixed(1)}${tempUnitLabel()} / ${score.matches} matches`
      : WEATHER_MODELS[id] || id;
    const scoreText = score ? `<span class="model-score">${score.mae.toFixed(1)}${tempUnitLabel()}</span>` : '';
    return `
    <button class="model-button${id === activeForecastModel ? ' active' : ''}${rankedClass}" title="${title}" type="button" onclick="selectForecastModel('${id}')">
      ${WEATHER_MODELS[id] || id}
      ${scoreText}
    </button>
  `;
  }).join('');
}

function setCityChrome() {
  document.getElementById('pageTitle').textContent = `${activeCity.name} Weather`;
  document.getElementById('stationLabel').textContent = `${activeCity.metar} · ${activeCity.airport}`;
  document.getElementById('chartTitle').textContent = `${activeCity.metar} Temperature Today`;
  document.getElementById('tempNow').innerHTML = `--<span class="temp-unit">${tempUnitLabel()}</span>`;
  document.getElementById('metarRaw').textContent = 'loading...';
  document.getElementById('cfMin').textContent = '--';
  document.getElementById('cfMax').textContent = '--';
  document.getElementById('cfWeather').textContent = '--';
  document.getElementById('cfWind').textContent = '--';
  document.getElementById('metarUpd').textContent = '--';
  document.getElementById('omLoading').style.display = '';
  document.getElementById('omLoading').textContent = 'Loading...';

  document.querySelectorAll('.city-button').forEach((button) => {
    button.classList.toggle('active', button.id === `cityTab-${activeCity.id}`);
  });
  renderModelDock();

  const overlay = document.getElementById('tempChartOverlay');
  if (overlay) {
    overlay.getContext('2d').clearRect(0, 0, overlay.width, overlay.height);
  }

  tickCityClock();
}

function setupCitySearch() {
  const input = document.getElementById('citySearch');
  if (!input) return;
  input.addEventListener('input', () => {
    citySearchQuery = input.value;
    renderCityList();
  });
}

function resetModelRanking() {
  rankedModelIds = [];
  modelScoresById = {};
  rankedCityId = null;
  const button = document.getElementById('modelRankBtn');
  const status = document.getElementById('modelRankStatus');
  if (button) button.disabled = false;
  if (status) status.textContent = '';
}

function forecastUrlForModel(modelId) {
  const params = new URLSearchParams({
    station: activeCity.metar,
    model: modelId,
  });
  return `/api/forecast?${params.toString()}`;
}

function nearestObservedByHour(rows) {
  const byHour = new Map();
  rows.forEach((row) => {
    const hour = Math.round(toHourFrac(row.time));
    if (hour < 0 || hour > 23) return;
    const prev = byHour.get(hour);
    const distance = Math.abs(toHourFrac(row.time) - hour);
    if (!prev || distance < prev.distance) byHour.set(hour, { row, distance });
  });
  return byHour;
}

function scoreForecastRows(forecastRows) {
  const observedByHour = nearestObservedByHour(metarToday);
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

async function fetchModelScore(modelId, runCityId) {
  const res = await fetch(forecastUrlForModel(modelId), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${WEATHER_MODELS[modelId] || modelId}: HTTP ${res.status}`);
  const data = await res.json();
  if (runCityId !== activeCity.id) return null;
  const rows = parseHourlyRows(data.hourly || {}, cityTodayKey(activeCity.timezone), modelId);
  const score = scoreForecastRows(rows);
  return score ? { id: modelId, ...score } : null;
}

async function rankForecastModels() {
  const runId = ++rankingRunId;
  const runCityId = activeCity.id;
  const button = document.getElementById('modelRankBtn');
  const status = document.getElementById('modelRankStatus');
  const candidates = cityModelOptions().filter((id) => id !== 'auto');

  if (button) button.disabled = true;
  if (status) status.textContent = 'Loading observations...';

  if (metarToday.length < 3) await loadMetar();
  if (runId !== rankingRunId || runCityId !== activeCity.id) return;
  if (metarToday.length < 3) {
    if (status) status.textContent = 'Need more observations';
    if (button) button.disabled = false;
    return;
  }

  const results = [];
  for (let index = 0; index < candidates.length; index += 4) {
    if (runId !== rankingRunId || runCityId !== activeCity.id) return;
    const batch = candidates.slice(index, index + 4);
    if (status) status.textContent = `Testing ${Math.min(index + batch.length, candidates.length)}/${candidates.length} models...`;
    const settled = await Promise.allSettled(batch.map((id) => fetchModelScore(id, runCityId)));
    settled.forEach((item) => {
      if (item.status === 'fulfilled' && item.value) results.push(item.value);
    });
  }

  if (runId !== rankingRunId || runCityId !== activeCity.id) return;
  results.sort((a, b) => a.score - b.score);
  const top = results.slice(0, 5);
  rankedModelIds = top.map((item) => item.id);
  modelScoresById = Object.fromEntries(top.map((item) => [item.id, item]));
  rankedCityId = activeCity.id;

  if (top.length) {
    activeForecastModel = top[0].id;
    if (status) {
      status.textContent = `Best: ${WEATHER_MODELS[top[0].id] || top[0].id} / MAE ${top[0].mae.toFixed(1)}${tempUnitLabel()}`;
    }
    hourlyOmState = null;
    omData = null;
    renderModelDock();
    fetchOpenMeteo().catch(console.error);
  } else if (status) {
    status.textContent = 'No comparable models';
  }

  if (button) button.disabled = false;
}

function selectForecastModel(modelId) {
  if (activeForecastModel === modelId) return;
  activeForecastModel = modelId;
  hourlyOmState = null;
  omData = null;
  renderModelDock();
  document.getElementById('omLoading').style.display = '';
  document.getElementById('omLoading').textContent = 'Loading...';
  drawChart();
  fetchOpenMeteo().catch(console.error);
}

function switchCity(cityId) {
  if (!CITIES[cityId] || activeCity.id === cityId) return;

  activeCity = CITIES[cityId];
  resetModelRanking();
  rankingRunId += 1;
  activeForecastModel = cityModelOptions()[0] || 'auto';
  metarToday = [];
  metarObsTime = null;
  chartState = null;
  hourlyOmState = null;
  omData = null;

  setCityChrome();
  drawChart();
  Promise.all([loadMetar(), fetchOpenMeteo()]).catch(console.error);
}

setupCitySearch();
renderCityList();
setCityChrome();
buildLegend();
setupChartMouse();
loadMetar().catch(console.error);
fetchOpenMeteo().catch(console.error);
setInterval(loadMetar, METAR_REFRESH_MS);
setInterval(fetchOpenMeteo, OM_REFRESH_MS);
setInterval(tickCityClock, 1000);
