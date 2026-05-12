let citySearchQuery = '';
let rankedModelIds = [];
let modelScoresById = {};
let averagedModelsById = {};
let rankedCityId = null;
let rankingRunId = 0;

function cityRegionClass(city) {
  if (city.metar?.startsWith('K')) return ' city-region-usa';
  if (city.timezone?.startsWith('Europe/')) return ' city-region-europe';
  if (city.timezone?.startsWith('Asia/')) return ' city-region-asia';
  return ' city-region-other';
}

function cityRegionRank(city) {
  if (city.timezone?.startsWith('Asia/')) return 0;
  if (city.timezone?.startsWith('Europe/')) return 1;
  if (city.metar?.startsWith('K')) return 3;
  return 2;
}

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
  }).sort((a, b) => cityRegionRank(a) - cityRegionRank(b));

  cityList.innerHTML = cities.length ? cities.map((city) => `
    <button class="city-button${cityRegionClass(city)}${city.id === activeCity.id ? ' active' : ''}" id="cityTab-${city.id}" type="button" onclick="switchCity('${city.id}')">
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
  const averagedIds = rankedCityId === activeCity.id ? Object.keys(averagedModelsById) : [];
  if (rankedCityId !== activeCity.id || (!rankedModelIds.length && !averagedIds.length)) return visibleOptions;
  const ranked = rankedModelIds.filter((id) => visibleOptions.includes(id));
  const rest = visibleOptions.filter((id) => !ranked.includes(id));
  return [...averagedIds, ...ranked, ...rest];
}

function renderModelDock() {
  const dock = document.getElementById('modelDock');
  if (!dock) return;
  const options = cityModelOptions();
  if (!options.includes(activeForecastModel)) activeForecastModel = options[0] || 'auto';
  dock.innerHTML = options.map((id) => {
    const score = modelScoresById[id];
    const averaged = averagedModelsById[id];
    const rankedClass = rankedCityId === activeCity.id && score ? ' ranked' : '';
    const title = score
      ? `MAE ${score.mae.toFixed(1)}${tempUnitLabel()} / ${score.matches} matches`
      : averaged?.label || WEATHER_MODELS[id] || id;
    const scoreText = score ? `<span class="model-score">${score.mae.toFixed(1)}${tempUnitLabel()}</span>` : '';
    return `
    <button class="model-button${id === activeForecastModel ? ' active' : ''}${rankedClass}" title="${title}" type="button" onclick="selectForecastModel('${id}')">
      ${averaged?.label || WEATHER_MODELS[id] || id}
      ${scoreText}
    </button>
  `;
  }).join('');
}

function setCityChrome() {
  const pageTitle = document.getElementById('pageTitle');
  const stationLabel = document.getElementById('stationLabel');
  if (pageTitle) pageTitle.textContent = `${activeCity.name} Weather`;
  if (stationLabel) stationLabel.textContent = `${activeCity.metar} · ${activeCity.airport}`;
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
  averagedModelsById = {};
  rankedCityId = null;
  const button = document.getElementById('modelRankBtn');
  const comboButton = document.getElementById('modelComboRankBtn');
  const status = document.getElementById('modelRankStatus');
  if (button) button.disabled = false;
  if (comboButton) comboButton.disabled = false;
  if (status) status.textContent = '';
}

function setRankingButtonsDisabled(disabled) {
  const button = document.getElementById('modelRankBtn');
  const comboButton = document.getElementById('modelComboRankBtn');
  if (button) button.disabled = disabled;
  if (comboButton) comboButton.disabled = disabled;
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

async function fetchModelRows(modelId, runCityId) {
  const res = await fetch(forecastUrlForModel(modelId), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${WEATHER_MODELS[modelId] || modelId}: HTTP ${res.status}`);
  const data = await res.json();
  if (runCityId !== activeCity.id) return null;
  const rows = parseHourlyRows(data.hourly || {}, cityTodayKey(activeCity.timezone), modelId);
  return rows.length ? { id: modelId, rows } : null;
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

function averagedModelId(modelIds) {
  return `avg_${modelIds.join('__')}`;
}

function averagedModelLabel(modelIds) {
  return `Avg ${modelIds.length}: ${modelIds.map((id) => WEATHER_MODELS[id] || id).join(' + ')}`;
}

async function rankForecastModels() {
  const runId = ++rankingRunId;
  const runCityId = activeCity.id;
  const status = document.getElementById('modelRankStatus');
  const baseOptions = activeCity.modelOptions?.length ? activeCity.modelOptions : US_MODELS.slice(0, 10);
  const candidates = baseOptions.slice(0, baseOptions.length >= 20 ? 20 : 10);

  setRankingButtonsDisabled(true);
  if (status) status.textContent = 'Loading observations...';

  if (metarToday.length < 3) await loadMetar();
  if (runId !== rankingRunId || runCityId !== activeCity.id) return;
  if (metarToday.length < 3) {
    if (status) status.textContent = 'Need more observations';
    setRankingButtonsDisabled(false);
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

  setRankingButtonsDisabled(false);
}

async function rankForecastModelAverages() {
  const runId = ++rankingRunId;
  const runCityId = activeCity.id;
  const status = document.getElementById('modelRankStatus');
  const baseOptions = activeCity.modelOptions?.length ? activeCity.modelOptions : US_MODELS.slice(0, 10);
  const candidates = baseOptions.slice(0, baseOptions.length >= 20 ? 20 : 10);

  rankedModelIds = [];
  modelScoresById = {};
  averagedModelsById = {};
  rankedCityId = null;
  renderModelDock();

  setRankingButtonsDisabled(true);
  if (status) status.textContent = 'Reloading observations...';

  metarToday = [];
  await loadMetar();
  if (runId !== rankingRunId || runCityId !== activeCity.id) return;
  if (metarToday.length < 3) {
    if (status) status.textContent = 'Need more observations';
    setRankingButtonsDisabled(false);
    return;
  }

  const modelRows = [];
  for (let index = 0; index < candidates.length; index += 4) {
    if (runId !== rankingRunId || runCityId !== activeCity.id) return;
    const batch = candidates.slice(index, index + 4);
    if (status) status.textContent = `Loading ${Math.min(index + batch.length, candidates.length)}/${candidates.length} models...`;
    const settled = await Promise.allSettled(batch.map((id) => fetchModelRows(id, runCityId)));
    settled.forEach((item) => {
      if (item.status === 'fulfilled' && item.value) modelRows.push(item.value);
    });
  }

  const singles = modelRows
    .map((item) => {
      const score = scoreForecastRows(item.rows);
      return score ? { id: item.id, rows: item.rows, ...score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  if (!singles.length) {
    if (status) status.textContent = 'No comparable models';
    setRankingButtonsDisabled(false);
    return;
  }

  const comboPool = singles;
  let bestCombo = null;
  let tested = 0;
  const total = [2, 3, 4].reduce((sum, size) => sum + combinations(comboPool, size).length, 0);

  for (const size of [2, 3, 4]) {
    const combos = combinations(comboPool, size);
    for (const combo of combos) {
      if (runId !== rankingRunId || runCityId !== activeCity.id) return;
      tested += 1;
      if (status && (tested === 1 || tested % 25 === 0 || tested === total)) {
        status.textContent = `Testing averages ${tested}/${total}...`;
      }
      const rows = averageForecastRows(combo);
      const score = scoreForecastRows(rows);
      if (!score) continue;
      const result = {
        id: averagedModelId(combo.map((item) => item.id)),
        modelIds: combo.map((item) => item.id),
        rows,
        ...score,
      };
      if (!bestCombo || result.score < bestCombo.score) bestCombo = result;
    }
  }

  if (runId !== rankingRunId || runCityId !== activeCity.id) return;
  const bestSingle = singles[0];
  rankedCityId = activeCity.id;
  rankedModelIds = singles.slice(0, 5).map((item) => item.id);
  modelScoresById = Object.fromEntries(singles.slice(0, 5).map((item) => [item.id, item]));

  if (bestCombo && bestCombo.score < bestSingle.score) {
    averagedModelsById[bestCombo.id] = {
      id: bestCombo.id,
      modelIds: bestCombo.modelIds,
      label: averagedModelLabel(bestCombo.modelIds),
      rows: bestCombo.rows,
    };
    modelScoresById[bestCombo.id] = bestCombo;
    activeForecastModel = bestCombo.id;
    hourlyOmState = {
      dateKey: cityTodayKey(activeCity.timezone),
      rows: bestCombo.rows,
      sourceLabel: 'Avg',
    };
    omData = null;
    if (status) {
      status.textContent = `Best average: ${bestCombo.modelIds.length} models / MAE ${bestCombo.mae.toFixed(1)}${tempUnitLabel()}`;
    }
    renderModelDock();
    drawChart();
  } else {
    activeForecastModel = bestSingle.id;
    if (status) {
      status.textContent = `No average improved on ${WEATHER_MODELS[bestSingle.id] || bestSingle.id}`;
    }
    hourlyOmState = null;
    omData = null;
    renderModelDock();
    fetchOpenMeteo().catch(console.error);
  }

  setRankingButtonsDisabled(false);
}

function selectForecastModel(modelId) {
  if (activeForecastModel === modelId) return;
  activeForecastModel = modelId;
  const averaged = averagedModelsById[modelId];
  if (averaged) {
    hourlyOmState = {
      dateKey: cityTodayKey(activeCity.timezone),
      rows: averaged.rows,
      sourceLabel: 'Avg',
    };
    omData = null;
  } else {
    hourlyOmState = null;
    omData = null;
  }
  renderModelDock();
  document.getElementById('omLoading').style.display = '';
  document.getElementById('omLoading').textContent = averaged ? '' : 'Loading...';
  drawChart();
  if (averaged) {
    document.getElementById('omLoading').style.display = 'none';
    setOmHeader();
  } else {
    fetchOpenMeteo().catch(console.error);
  }
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
