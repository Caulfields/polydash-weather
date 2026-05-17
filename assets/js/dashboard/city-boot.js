const FAVORITE_CITIES_STORAGE_KEY = 'polydash.favoriteCityIds';
const GREEN_CITIES_STORAGE_KEY = 'polydash.greenCityIds';
const RED_CITIES_STORAGE_KEY = 'polydash.redCityIds';
const CITY_NOTES_STORAGE_KEY = 'polydash.cityNotes';
const CITY_NOTES_OPEN_STORAGE_KEY = 'polydash.cityNotesOpen';
const SAVED_AVERAGE_MODELS_STORAGE_KEY = 'polydash.savedAverageModelsByCity';
let citySearchQuery = '';
let favoriteCityIds = loadStoredCityIdSet(FAVORITE_CITIES_STORAGE_KEY);
let greenCityIds = loadStoredCityIdSet(GREEN_CITIES_STORAGE_KEY);
let redCityIds = loadStoredCityIdSet(RED_CITIES_STORAGE_KEY);
let cityNotesById = loadCityNotes();
let savedAverageModelsByCity = loadSavedAverageModels();
let locationNotesOpen = loadLocationNotesOpen();
let cityFilterMode = 'all';
let rankedModelIds = [];
let modelScoresById = {};
let averagedModelsById = {};
let rankedCityId = null;
let rankingRunId = 0;

function loadStoredCityIdSet(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    const ids = JSON.parse(raw || '[]');
    return new Set(Array.isArray(ids) ? ids.filter((id) => CITIES[id]) : []);
  } catch (error) {
    return new Set();
  }
}

function saveStoredCityIdSet(storageKey, values) {
  localStorage.setItem(storageKey, JSON.stringify([...values]));
}

function cityListMembership(cityId) {
  return {
    favorite: favoriteCityIds.has(cityId),
    green: greenCityIds.has(cityId),
    red: redCityIds.has(cityId),
  };
}

function citySetForType(listType) {
  const lists = {
    favorite: {
      values: favoriteCityIds,
      storageKey: FAVORITE_CITIES_STORAGE_KEY,
      label: 'favorites',
    },
    green: {
      values: greenCityIds,
      storageKey: GREEN_CITIES_STORAGE_KEY,
      label: 'green list',
    },
    red: {
      values: redCityIds,
      storageKey: RED_CITIES_STORAGE_KEY,
      label: 'red list',
    },
  };
  return lists[listType] || null;
}

function cityFilterMatches(city) {
  if (cityFilterMode === 'favorite') return favoriteCityIds.has(city.id);
  if (cityFilterMode === 'green') return greenCityIds.has(city.id);
  if (cityFilterMode === 'red') return redCityIds.has(city.id);
  return true;
}

function cityEmptyStateText() {
  if (cityFilterMode === 'favorite') return 'No favorite cities match';
  if (cityFilterMode === 'green') return 'No green-list cities match';
  if (cityFilterMode === 'red') return 'No red-list cities match';
  return 'No matching cities';
}

function renderCityListControls() {
  const controls = document.getElementById('activeCityListControls');
  if (!controls) return;
  const membership = cityListMembership(activeCity.id);
  controls.innerHTML = [
    {
      type: 'green',
      icon: '&#9679;',
      active: membership.green,
      shortLabel: 'Green',
    },
    {
      type: 'red',
      icon: '&#9679;',
      active: membership.red,
      shortLabel: 'Red',
    },
  ].map((item) => {
    const config = citySetForType(item.type);
    return `
      <button class="city-list-control city-list-control-${item.type}${item.active ? ' active' : ''}" type="button" title="${item.active ? `Remove from ${config.label}` : `Add to ${config.label}`}" aria-label="${item.active ? 'Remove ' : 'Add '}${activeCity.name} ${item.active ? 'from' : 'to'} ${config.label}" aria-pressed="${item.active}" onclick="toggleCityList('${activeCity.id}', '${item.type}')">
        <span class="city-list-control-icon" aria-hidden="true">${item.icon}</span>
        <span>${item.shortLabel}</span>
      </button>
    `;
  }).join('');
}

function loadCityNotes() {
  try {
    const raw = localStorage.getItem(CITY_NOTES_STORAGE_KEY);
    const notes = JSON.parse(raw || '{}');
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) return {};
    return Object.fromEntries(
      Object.entries(notes).filter(([id, value]) => CITIES[id] && typeof value === 'string')
    );
  } catch (error) {
    return {};
  }
}

function saveCityNotes() {
  localStorage.setItem(CITY_NOTES_STORAGE_KEY, JSON.stringify(cityNotesById));
}

function savedAverageId(cityId, modelIds) {
  return `saved_avg_${cityId}_${modelIds.join('__')}`;
}

function validSavedAverage(cityId, item) {
  if (!CITIES[cityId] || !item || !Array.isArray(item.modelIds)) return null;
  const modelIds = item.modelIds.filter((id) => WEATHER_MODELS[id]);
  if (modelIds.length < 2) return null;
  const uniqueModelIds = [...new Set(modelIds)];
  return {
    id: savedAverageId(cityId, uniqueModelIds),
    modelIds: uniqueModelIds,
    label: item.label || averagedModelLabel(uniqueModelIds),
    saved: true,
    createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
  };
}

function loadSavedAverageModels() {
  try {
    const raw = localStorage.getItem(SAVED_AVERAGE_MODELS_STORAGE_KEY);
    const parsed = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([cityId, items]) => [
          cityId,
          Array.isArray(items)
            ? items.map((item) => validSavedAverage(cityId, item)).filter(Boolean)
            : [],
        ])
        .filter(([cityId, items]) => CITIES[cityId] && items.length),
    );
  } catch (error) {
    return {};
  }
}

function saveSavedAverageModels() {
  localStorage.setItem(SAVED_AVERAGE_MODELS_STORAGE_KEY, JSON.stringify(savedAverageModelsByCity));
}

function currentSavedAverageModels() {
  return savedAverageModelsByCity[activeCity.id] || [];
}

function artificialAverageModel(modelId) {
  return averagedModelsById[modelId] || currentSavedAverageModels().find((item) => item.id === modelId) || null;
}

function latestRuntimeAverageModel() {
  return Object.values(averagedModelsById).find((item) => item?.modelIds?.length) || null;
}

function saveLatestAverageModel() {
  const status = document.getElementById('modelRankStatus');
  const average = latestRuntimeAverageModel();
  if (!average) {
    if (status) status.textContent = 'No average to save yet';
    return;
  }

  const modelIds = [...new Set(average.modelIds)];
  const saved = {
    id: savedAverageId(activeCity.id, modelIds),
    modelIds,
    label: averagedModelLabel(modelIds),
    saved: true,
    createdAt: Date.now(),
  };
  const existing = currentSavedAverageModels().filter((item) => item.id !== saved.id);
  savedAverageModelsByCity[activeCity.id] = [saved, ...existing];
  saveSavedAverageModels();
  activeForecastModel = saved.id;
  renderModelDock();
  if (status) status.textContent = `Saved: ${saved.label}`;
  fetchOpenMeteo().catch(console.error);
}

function deleteSavedAverageModel(modelId) {
  const saved = currentSavedAverageModels().find((item) => item.id === modelId);
  if (!saved) return;
  savedAverageModelsByCity[activeCity.id] = currentSavedAverageModels().filter((item) => item.id !== modelId);
  if (!savedAverageModelsByCity[activeCity.id].length) delete savedAverageModelsByCity[activeCity.id];
  saveSavedAverageModels();
  if (activeForecastModel === modelId) {
    activeForecastModel = cityModelOptions()[0] || 'auto';
    hourlyOmState = null;
    omData = null;
    fetchOpenMeteo().catch(console.error);
  }
  renderModelDock();
}

function loadLocationNotesOpen() {
  return localStorage.getItem(CITY_NOTES_OPEN_STORAGE_KEY) !== 'false';
}

function saveLocationNotesOpen() {
  localStorage.setItem(CITY_NOTES_OPEN_STORAGE_KEY, `${locationNotesOpen}`);
}

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
    if (!cityFilterMatches(city)) return false;
    if (!query) return true;
    return [
      city.name,
      city.metar,
      city.airport,
      city.timezone,
    ].some((value) => `${value || ''}`.toLowerCase().includes(query));
  }).sort((a, b) => cityRegionRank(a) - cityRegionRank(b));

  cityList.innerHTML = cities.length ? cities.map((city) => `
    <div class="city-card${cityRegionClass(city)}${city.id === activeCity.id ? ' active' : ''}" id="cityTab-${city.id}">
      <button class="city-button" type="button" onclick="switchCity('${city.id}')">
        <span class="city-name-row">
          <span class="city-name">${city.name}</span>
          <span class="city-station">${city.metar}</span>
        </span>
        <span class="city-airport">${city.airport}</span>
      </button>
      <button class="city-favorite-btn${favoriteCityIds.has(city.id) ? ' active' : ''}" type="button" title="${favoriteCityIds.has(city.id) ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${favoriteCityIds.has(city.id) ? 'Remove ' : 'Add '}${city.name} ${favoriteCityIds.has(city.id) ? 'from' : 'to'} favorites" aria-pressed="${favoriteCityIds.has(city.id)}" onclick="toggleFavoriteCity('${city.id}')">
        ${favoriteCityIds.has(city.id) ? '&#9733;' : '&#9734;'}
      </button>
    </div>
  `).join('') : `<div class="city-empty">${cityEmptyStateText()}</div>`;

  ['favorite', 'green', 'red'].forEach((mode) => {
    const button = document.getElementById(`city${mode.charAt(0).toUpperCase()}${mode.slice(1)}sFilter`);
    if (!button) return;
    const active = cityFilterMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', `${active}`);
  });
}

function cityModelOptions() {
  const options = activeCity.modelOptions?.length ? activeCity.modelOptions : US_MODELS.slice(0, 10);
  const visibleOptions = options.slice(0, options.length >= 20 ? 20 : 10);
  const averagedIds = rankedCityId === activeCity.id ? Object.keys(averagedModelsById) : [];
  const savedIds = currentSavedAverageModels().map((item) => item.id);
  if (rankedCityId !== activeCity.id || (!rankedModelIds.length && !averagedIds.length)) {
    return [...savedIds, ...visibleOptions];
  }
  const ranked = rankedModelIds.filter((id) => visibleOptions.includes(id));
  const rest = visibleOptions.filter((id) => !ranked.includes(id));
  return [...savedIds, ...averagedIds, ...ranked, ...rest];
}

function renderModelDock() {
  const dock = document.getElementById('modelDock');
  if (!dock) return;
  const options = cityModelOptions();
  if (!options.includes(activeForecastModel)) activeForecastModel = options[0] || 'auto';
  dock.innerHTML = options.map((id) => {
    const score = modelScoresById[id];
    const averaged = artificialAverageModel(id);
    const rankedClass = rankedCityId === activeCity.id && score ? ' ranked' : '';
    const savedClass = averaged?.saved ? ' saved' : '';
    const title = score
      ? `MAE ${score.mae.toFixed(1)}${tempUnitLabel()} / ${score.matches} matches`
      : averaged?.label || WEATHER_MODELS[id] || id;
    const scoreText = score ? `<span class="model-score">${score.mae.toFixed(1)}${tempUnitLabel()}</span>` : '';
    const deleteButton = averaged?.saved
      ? `<button class="model-delete-button" type="button" title="Delete saved average" aria-label="Delete ${title}" onclick="deleteSavedAverageModel('${id}')">×</button>`
      : '';
    return `
    <span class="model-chip${savedClass}">
      <button class="model-button${id === activeForecastModel ? ' active' : ''}${rankedClass}${savedClass}" title="${title}" type="button" onclick="selectForecastModel('${id}')">
        ${averaged?.label || WEATHER_MODELS[id] || id}
        ${scoreText}
      </button>
      ${deleteButton}
    </span>
  `;
  }).join('');
}

function renderForecastDayControls() {
  ['today', 'tomorrow'].forEach((day) => {
    const button = document.getElementById(`forecastDay${day.charAt(0).toUpperCase()}${day.slice(1)}`);
    if (!button) return;
    const active = activeForecastDay === day;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', `${active}`);
  });
}

function setCityChrome(options = {}) {
  const resetObservations = options.resetObservations !== false;
  const pageTitle = document.getElementById('pageTitle');
  const stationLabel = document.getElementById('stationLabel');
  if (pageTitle) pageTitle.textContent = `${activeCity.name} Weather`;
  if (stationLabel) stationLabel.textContent = `${activeCity.metar} · ${activeCity.airport}`;
  document.getElementById('chartTitle').textContent = `${activeCity.metar} Temperature ${forecastDayLabel()}`;
  if (resetObservations) {
    document.getElementById('tempNow').innerHTML = `--<span class="temp-unit">${tempUnitLabel()}</span>`;
    document.getElementById('metarRaw').textContent = isTodayForecastSelected() ? 'loading...' : 'METAR is today-only';
    document.getElementById('cfMin').textContent = '--';
    document.getElementById('cfMax').textContent = '--';
    document.getElementById('cfWeather').textContent = '--';
    document.getElementById('cfWind').textContent = '--';
    document.getElementById('metarUpd').textContent = '--';
  } else if (metarToday.length) {
    updateMetarUI();
  }
  document.getElementById('omLoading').style.display = '';
  document.getElementById('omLoading').textContent = 'Loading...';

  document.querySelectorAll('.city-card').forEach((button) => {
    button.classList.toggle('active', button.id === `cityTab-${activeCity.id}`);
  });
  renderModelDock();
  renderForecastDayControls();
  renderLocationNotes();
  renderCityListControls();

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

function toggleCityList(cityId, listType) {
  if (!CITIES[cityId]) return;
  const target = citySetForType(listType);
  if (!target) return;
  if (target.values.has(cityId)) {
    target.values.delete(cityId);
  } else {
    target.values.add(cityId);
  }
  saveStoredCityIdSet(target.storageKey, target.values);
  renderCityList();
  renderCityListControls();
}

function toggleFavoriteCity(cityId) {
  if (!CITIES[cityId]) return;
  if (favoriteCityIds.has(cityId)) {
    favoriteCityIds.delete(cityId);
  } else {
    favoriteCityIds.add(cityId);
  }
  saveStoredCityIdSet(FAVORITE_CITIES_STORAGE_KEY, favoriteCityIds);
  renderCityList();
}

function toggleCityFilter(filterMode) {
  cityFilterMode = cityFilterMode === filterMode ? 'all' : filterMode;
  renderCityList();
}

function updateCityNote(cityId, value) {
  if (!CITIES[cityId]) return;
  const note = `${value || ''}`;
  if (note.trim()) {
    cityNotesById[cityId] = note;
  } else {
    delete cityNotesById[cityId];
  }
  saveCityNotes();
}

function updateActiveCityNote(value) {
  updateCityNote(activeCity.id, value);
}

function renderLocationNotes() {
  const notesPanel = document.getElementById('locationNotes');
  const notesTitle = document.getElementById('locationNotesTitle');
  const notesInput = document.getElementById('locationNotesInput');
  const toggle = document.getElementById('locationNotesToggle');
  const toggleText = document.getElementById('locationNotesToggleText');
  if (!notesPanel || !notesTitle || !notesInput || !toggle || !toggleText) return;

  notesTitle.textContent = `${activeCity.name} notes`;
  notesInput.value = cityNotesById[activeCity.id] || '';
  notesPanel.classList.toggle('collapsed', !locationNotesOpen);
  toggle.setAttribute('aria-expanded', `${locationNotesOpen}`);
  toggleText.textContent = locationNotesOpen ? 'Hide' : 'Open';
}

function toggleLocationNotes() {
  locationNotesOpen = !locationNotesOpen;
  saveLocationNotesOpen();
  renderLocationNotes();
}

function resetModelRanking() {
  rankedModelIds = [];
  modelScoresById = {};
  averagedModelsById = {};
  rankedCityId = null;
  const button = document.getElementById('modelRankBtn');
  const comboButton = document.getElementById('modelComboRankBtn');
  const dayButton = document.getElementById('modelRankDayBtn');
  const dayComboButton = document.getElementById('modelComboRankDayBtn');
  const status = document.getElementById('modelRankStatus');
  const rankingAvailable = isTodayForecastSelected();
  if (button) button.disabled = !rankingAvailable;
  if (comboButton) comboButton.disabled = !rankingAvailable;
  if (dayButton) dayButton.disabled = !rankingAvailable;
  if (dayComboButton) dayComboButton.disabled = !rankingAvailable;
  if (status) status.textContent = rankingAvailable ? '' : 'Model ranking is available for today only';
}

function setRankingButtonsDisabled(disabled) {
  const button = document.getElementById('modelRankBtn');
  const comboButton = document.getElementById('modelComboRankBtn');
  const dayButton = document.getElementById('modelRankDayBtn');
  const dayComboButton = document.getElementById('modelComboRankDayBtn');
  const unavailable = disabled || !isTodayForecastSelected();
  if (button) button.disabled = unavailable;
  if (comboButton) comboButton.disabled = unavailable;
  if (dayButton) dayButton.disabled = unavailable;
  if (dayComboButton) dayComboButton.disabled = unavailable;
}

function forecastUrlForModel(modelId) {
  const params = new URLSearchParams({
    station: activeCity.metar,
    model: modelId,
    date: activeForecastDateKey(activeCity.timezone),
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

function scoreForecastRowsFromHour(forecastRows, startHour) {
  const observedByHour = nearestObservedByHour(metarToday);
  const errors = [];
  const windErrors = [];

  forecastRows.forEach((row) => {
    const hour = Math.round(row.hourFrac);
    if (hour < startHour) return;
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
  const rows = parseHourlyRows(data.hourly || {}, activeForecastDateKey(activeCity.timezone), modelId);
  const score = scoreForecastRows(rows);
  return score ? { id: modelId, ...score } : null;
}

async function fetchModelScoreFromHour(modelId, runCityId, startHour) {
  const res = await fetch(forecastUrlForModel(modelId), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${WEATHER_MODELS[modelId] || modelId}: HTTP ${res.status}`);
  const data = await res.json();
  if (runCityId !== activeCity.id) return null;
  const rows = parseHourlyRows(data.hourly || {}, activeForecastDateKey(activeCity.timezone), modelId);
  const score = scoreForecastRowsFromHour(rows, startHour);
  return score ? { id: modelId, ...score } : null;
}

async function fetchModelRows(modelId, runCityId) {
  const res = await fetch(forecastUrlForModel(modelId), { cache: 'no-store' });
  if (!res.ok) throw new Error(`${WEATHER_MODELS[modelId] || modelId}: HTTP ${res.status}`);
  const data = await res.json();
  if (runCityId !== activeCity.id) return null;
  const rows = parseHourlyRows(data.hourly || {}, activeForecastDateKey(activeCity.timezone), modelId);
  return rows.length ? { id: modelId, rows } : null;
}

async function fetchAverageModelRows(modelIds, runCityId) {
  const settled = await Promise.allSettled(modelIds.map((id) => fetchModelRows(id, runCityId)));
  const modelRows = settled
    .map((item) => item.status === 'fulfilled' ? item.value : null)
    .filter(Boolean);
  if (modelRows.length !== modelIds.length) {
    throw new Error('Could not load every saved average member');
  }
  return averageForecastRows(modelRows);
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
  if (!isTodayForecastSelected()) return;
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
  if (!isTodayForecastSelected()) return;
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
      dateKey: activeForecastDateKey(activeCity.timezone),
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

async function rankForecastModelsFromFive() {
  if (!isTodayForecastSelected()) return;
  const startHour = 5;
  const runId = ++rankingRunId;
  const runCityId = activeCity.id;
  const status = document.getElementById('modelRankStatus');
  const baseOptions = activeCity.modelOptions?.length ? activeCity.modelOptions : US_MODELS.slice(0, 10);
  const candidates = baseOptions.slice(0, baseOptions.length >= 20 ? 20 : 10);

  setRankingButtonsDisabled(true);
  if (status) status.textContent = 'Loading observations from 05:00...';

  if (metarToday.length < 3) await loadMetar();
  if (runId !== rankingRunId || runCityId !== activeCity.id) return;
  if (metarToday.filter((item) => Math.round(toHourFrac(item.time)) >= startHour).length < 3) {
    if (status) status.textContent = 'Need more observations from 05:00';
    setRankingButtonsDisabled(false);
    return;
  }

  const results = [];
  for (let index = 0; index < candidates.length; index += 4) {
    if (runId !== rankingRunId || runCityId !== activeCity.id) return;
    const batch = candidates.slice(index, index + 4);
    if (status) status.textContent = `Testing from 05:00 ${Math.min(index + batch.length, candidates.length)}/${candidates.length} models...`;
    const settled = await Promise.allSettled(batch.map((id) => fetchModelScoreFromHour(id, runCityId, startHour)));
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
      status.textContent = `Best from 05:00: ${WEATHER_MODELS[top[0].id] || top[0].id} / MAE ${top[0].mae.toFixed(1)}${tempUnitLabel()}`;
    }
    hourlyOmState = null;
    omData = null;
    renderModelDock();
    fetchOpenMeteo().catch(console.error);
  } else if (status) {
    status.textContent = 'No comparable models from 05:00';
  }

  setRankingButtonsDisabled(false);
}

async function rankForecastModelAveragesFromFive() {
  if (!isTodayForecastSelected()) return;
  const startHour = 5;
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
  if (status) status.textContent = 'Reloading observations from 05:00...';

  metarToday = [];
  await loadMetar();
  if (runId !== rankingRunId || runCityId !== activeCity.id) return;
  if (metarToday.filter((item) => Math.round(toHourFrac(item.time)) >= startHour).length < 3) {
    if (status) status.textContent = 'Need more observations from 05:00';
    setRankingButtonsDisabled(false);
    return;
  }

  const modelRows = [];
  for (let index = 0; index < candidates.length; index += 4) {
    if (runId !== rankingRunId || runCityId !== activeCity.id) return;
    const batch = candidates.slice(index, index + 4);
    if (status) status.textContent = `Loading from 05:00 ${Math.min(index + batch.length, candidates.length)}/${candidates.length} models...`;
    const settled = await Promise.allSettled(batch.map((id) => fetchModelRows(id, runCityId)));
    settled.forEach((item) => {
      if (item.status === 'fulfilled' && item.value) modelRows.push(item.value);
    });
  }

  const singles = modelRows
    .map((item) => {
      const score = scoreForecastRowsFromHour(item.rows, startHour);
      return score ? { id: item.id, rows: item.rows, ...score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  if (!singles.length) {
    if (status) status.textContent = 'No comparable models from 05:00';
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
        status.textContent = `Testing averages from 05:00 ${tested}/${total}...`;
      }
      const rows = averageForecastRows(combo);
      const score = scoreForecastRowsFromHour(rows, startHour);
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
      dateKey: activeForecastDateKey(activeCity.timezone),
      rows: bestCombo.rows,
      sourceLabel: 'Avg',
    };
    omData = null;
    if (status) {
      status.textContent = `Best average from 05:00: ${bestCombo.modelIds.length} models / MAE ${bestCombo.mae.toFixed(1)}${tempUnitLabel()}`;
    }
    renderModelDock();
    drawChart();
  } else {
    activeForecastModel = bestSingle.id;
    if (status) {
      status.textContent = `No 05:00 average improved on ${WEATHER_MODELS[bestSingle.id] || bestSingle.id}`;
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
  const averaged = artificialAverageModel(modelId);
  if (averaged?.rows?.length) {
    hourlyOmState = {
      dateKey: activeForecastDateKey(activeCity.timezone),
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
  document.getElementById('omLoading').textContent = 'Loading...';
  drawChart();
  if (averaged?.rows?.length) {
    document.getElementById('omLoading').style.display = 'none';
    setOmHeader();
  } else {
    fetchOpenMeteo().catch(console.error);
  }
}

function setForecastDay(day) {
  const nextDay = day === 'tomorrow' ? 'tomorrow' : 'today';
  if (activeForecastDay === nextDay) return;
  activeForecastDay = nextDay;
  rankingRunId += 1;
  rankedModelIds = [];
  modelScoresById = {};
  averagedModelsById = {};
  rankedCityId = null;
  hourlyOmState = null;
  omData = null;
  chartState = null;
  setCityChrome({ resetObservations: false });
  setRankingButtonsDisabled(false);
  const status = document.getElementById('modelRankStatus');
  if (status) status.textContent = isTodayForecastSelected() ? '' : 'Model ranking is available for today only';
  drawChart();
  if (isTodayForecastSelected()) loadMetar().catch(console.error);
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
  const requests = [fetchOpenMeteo()];
  if (isTodayForecastSelected()) requests.push(loadMetar());
  Promise.all(requests).catch(console.error);
}

setupCitySearch();
renderCityList();
setCityChrome();
buildLegend();
setupChartMouse();
if (isTodayForecastSelected()) loadMetar().catch(console.error);
fetchOpenMeteo().catch(console.error);
setInterval(() => {
  if (isTodayForecastSelected()) loadMetar().catch(console.error);
}, METAR_REFRESH_MS);
setInterval(fetchOpenMeteo, OM_REFRESH_MS);
setInterval(tickCityClock, 1000);
