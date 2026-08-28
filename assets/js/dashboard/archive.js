let archiveSettingsByCity = {};
let archivePanelOpen = false;
let archiveSnapshotModels = {};

function getArchiveView() {
  return window.__archiveView || null;
}

function setArchiveView(value) {
  window.__archiveView = value || null;
}

function archiveModelRows(modelId) {
  return archiveSnapshotModels[modelId] || null;
}

function archiveSaveEnabled() {
  const s = archiveSettingsByCity[activeCity.id];
  return !!(s && s.enabled);
}

function formatArchiveTime(hourFrac) {
  const totalMinutes = Math.round(hourFrac * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

function archiveTimeLabel(hourFrac) {
  return `${formatArchiveTime(hourFrac)} ${activeCity.name}`;
}

function formatArchiveDateStamp(ms) {
  const d = new Date(ms);
  const tz = getArchiveView() && getArchiveView().snapshot
    ? getArchiveView().snapshot.timezone
    : activeCity.timezone;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function updateArchiveStamp() {
  const stamp = document.getElementById('archiveStamp');
  const toggle = document.getElementById('metarToggle');
  if (!stamp || !toggle) return;
  const arch = getArchiveView();
  if (arch && arch.snapshot) {
    stamp.textContent = formatArchiveDateStamp(arch.snapshot.savedAtMs);
    stamp.style.display = '';
    toggle.style.display = 'none';
  } else {
    stamp.textContent = '';
    stamp.style.display = 'none';
    toggle.style.display = '';
  }
}

async function fetchArchiveSettings() {
  try {
    const res = await fetch('/api/archive/settings', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    archiveSettingsByCity = await res.json();
  } catch (error) {
    archiveSettingsByCity = {};
  }
}

async function saveArchiveSettings() {
  const enabled = document.getElementById('archiveEnabled').checked;
  const time = document.getElementById('archiveTime').value;
  const retentionEl = document.getElementById('archiveRetentionDays');
  const retentionDays = retentionEl && retentionEl.value !== ''
    ? Math.max(0, Math.floor(Number(retentionEl.value)))
    : null;
  try {
    const res = await fetch('/api/archive/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cityId: activeCity.id, enabled, time, retentionDays }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    archiveSettingsByCity[activeCity.id] = body.settings || body;
    const status = document.getElementById('archiveStatus');
    if (status) {
      const ret = body.settings && body.settings.retentionDays;
      status.textContent = enabled
        ? `Scheduled daily at ${time}${ret ? ` · keep ${ret} days` : ''}`
        : 'Archive off';
    }
  } catch (error) {
    const status = document.getElementById('archiveStatus');
    if (status) status.textContent = 'Failed to save archive settings';
  }
  renderArchiveSaveButton();
}

function buildSnapshotFromLiveState() {
  const dateKey = activeForecastDateKey(activeCity.timezone);
  return {
    version: 1,
    id: null,
    cityId: activeCity.id,
    cityName: activeCity.name,
    metar: activeCity.metar,
    timezone: activeCity.timezone,
    savedAtISO: new Date().toISOString(),
    savedAtMs: Date.now(),
    dateKey,
    savedHourFrac: currentCityHourFrac(),
    forecastDay: activeForecastDay,
    model: activeForecastModel,
    modelLabel: activeForecastModel === 'auto'
      ? (activeCity.omBadge || 'Best match')
      : (WEATHER_MODELS[activeForecastModel] || activeForecastModel),
    sourceLabel: hourlyOmState?.sourceLabel || activeCity.omSourceLabel || 'Open-Meteo',
    omBadge: activeCity.omBadge || 'OM',
    metarObsTime: metarObsTime,
    metarRows: metarToday.map((item) => ({
      timeMs: item.time.getTime(),
      temp: item.temp,
      dewp: item.dewp,
      wspd: item.wspd,
      wdir: item.wdir,
      rawOb: item.rawOb,
      weather: item.weather,
    })),
    forecastRows: (hourlyOmState?.rows || []).map((row) => ({ ...row })),
    temperatureHighlight: temperatureHighlight
      ? { ...temperatureHighlight }
      : null,
    additionalMaxTempC: additionalModelMaxTempC,
    testMaxTempC: testModelMaxTempC,
  };
}

async function manualArchiveSave() {
  const btn = document.getElementById('manualSaveBtn');
  const status = document.getElementById('archiveStatus');
  if (btn) btn.disabled = true;
  try {
    const snapshot = buildSnapshotFromLiveState();
    const res = await fetch('/api/archive/snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    if (status) status.textContent = `Saved ${formatArchiveTime(body.snapshot.savedHourFrac)}`;
    if (archivePanelOpen) await renderArchivePanel();
  } catch (error) {
    if (status) status.textContent = 'Save failed';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function metarItemFromSnapshotRow(row) {
  return {
    time: new Date(row.timeMs),
    temp: row.temp,
    dewp: row.dewp,
    wspd: row.wspd,
    wdir: row.wdir,
    rawOb: row.rawOb,
    weather: row.weather,
  };
}

function enterArchiveView(snapshot) {
  suspendPolling();
  setArchiveView({
    snapshot,
    savedHourFrac: snapshot.savedHourFrac,
  });
  archiveSnapshotModels = (snapshot.models && typeof snapshot.models === 'object')
    ? snapshot.models
    : {};

  if (CITIES[snapshot.cityId]) activeCity = CITIES[snapshot.cityId];
  activeForecastDay = snapshot.forecastDay === 'tomorrow' ? 'tomorrow' : 'today';
  activeForecastModel = snapshot.model;

  metarToday = snapshot.metarRows.map(metarItemFromSnapshotRow);
  metarObsTime = snapshot.metarObsTime || null;
  hourlyOmState = {
    dateKey: snapshot.dateKey,
    rows: snapshot.forecastRows.map((row) => ({ ...row })),
    sourceLabel: snapshot.sourceLabel || snapshot.modelLabel || 'Archive',
  };
  omData = null;
  chartState = null;
  temperatureHighlight = snapshot.temperatureHighlight ? { ...snapshot.temperatureHighlight } : null;
  additionalModelMaxTempC = snapshot.additionalMaxTempC != null ? snapshot.additionalMaxTempC : null;
  testModelMaxTempC = snapshot.testMaxTempC != null ? snapshot.testMaxTempC : null;

  setCityChrome({ resetObservations: false });
  document.getElementById('omLoading').style.display = 'none';
  renderArchiveSaveButton();
  renderModelDock();
  renderForecastDayControls();
  drawChart();
  updateMetarUI();
  updateForecastMaxTemp();
  updateWeatherCodeUI();
  updateTagsDOM(snapshot.forecastRows);
  updateArchiveBanner();
  updateArchiveStamp();
  if (temperatureHighlight) {
    const input = document.getElementById('targetTempInput');
    if (input) input.value = `${temperatureHighlight.target}${temperatureHighlight.unit}`;
    updateTemperatureHighlightStatus();
  }
}

function exitArchiveView() {
  if (!getArchiveView()) return;
  setArchiveView(null);
  archiveSnapshotModels = {};
  resumePolling();
  metarAgeInterval = setInterval(() => {
    if (metarObsTime) {
      if (!cachedMetarUpd) cachedMetarUpd = document.getElementById('metarUpd');
      if (cachedMetarUpd) cachedMetarUpd.textContent = fmtMetarAge(metarObsTime);
    }
  }, 30000);
  updateArchiveBanner();
  updateArchiveStamp();

  const cityId = activeCity.id;
  clearWeatherTags();
  resetModelRanking();
  rankingRunId += 1;
  const settings = cityModelSettings[cityId];
  const options = cityModelOptions();
  if (settings && settings.basic && options.includes(settings.basic)) {
    activeForecastModel = settings.basic;
  } else {
    activeForecastModel = options[0] || 'auto';
  }
  metarToday = [];
  metarObsTime = null;
  chartState = null;
  hourlyOmState = null;
  omData = null;
  temperatureHighlight = null;
  additionalModelMaxTempC = null;
  testModelMaxTempC = null;
  const input = document.getElementById('targetTempInput');
  if (input) input.value = '';

  setCityChrome();
  drawChart();
  renderArchiveSaveButton();
  renderModelDock();
  renderForecastDayControls();

  const requests = [fetchOpenMeteo(), fetchEcmwfTags()];
  if (isTodayForecastSelected()) requests.push(loadMetar());
  Promise.all(requests).catch(console.error);
  fetchAdditionalAndTestMaxTemp();
}

async function openSnapshot(snapshotId) {
  try {
    const res = await fetch(`/api/archive/snapshots/${snapshotId}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    enterArchiveView(body.snapshot);
    toggleArchivePanel(false);
  } catch (error) {
    console.warn('Open snapshot:', error.message);
  }
}

async function deleteSnapshot(snapshotId) {
  try {
    await fetch(`/api/archive/snapshots/${snapshotId}`, { method: 'DELETE' });
    if (archivePanelOpen) await renderArchivePanel();
  } catch (error) {
    console.warn('Delete snapshot:', error.message);
  }
}

function archiveSummaryLine(s) {
  const modelCount = s.modelCount != null ? s.modelCount : 0;
  const models = modelCount ? ` · ${modelCount} models` : '';
  return `${s.cityName} ${s.dateKey} ${formatArchiveTime(s.savedHourFrac)} · ${s.modelLabel || s.model}${models}`;
}

async function renderArchivePanel() {
  const panel = document.getElementById('archivePanel');
  if (!panel) return;
  panel.style.display = archivePanelOpen ? '' : 'none';
  if (!archivePanelOpen) return;

  const listEl = document.getElementById('archiveList');
  listEl.innerHTML = 'Loading...';
  try {
    const res = await fetch('/api/archive/snapshots', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const snapshots = body.snapshots || [];
    if (!snapshots.length) {
      listEl.innerHTML = '<div class="archive-empty">No saved snapshots yet</div>';
      return;
    }
    listEl.innerHTML = snapshots.map((s) => `
      <div class="archive-row" data-id="${s.id}">
        <button class="archive-open" type="button" onclick="openSnapshot('${s.id}')">
          <span class="archive-row-title">${archiveSummaryLine(s)}</span>
          <span class="archive-row-meta">${s.metarCount} obs · ${s.forecastCount} fc</span>
        </button>
        <button class="archive-delete" type="button" title="Delete" aria-label="Delete snapshot" onclick="deleteSnapshot('${s.id}')">×</button>
      </div>
    `).join('');
  } catch (error) {
    listEl.innerHTML = '<div class="archive-empty">Failed to load archive</div>';
  }
}

function toggleArchivePanel(forceOpen) {
  archivePanelOpen = forceOpen != null ? forceOpen : !archivePanelOpen;
  renderArchivePanel();
}

function renderArchiveSaveButton() {
  const btn = document.getElementById('manualSaveBtn');
  if (!btn) return;
  btn.disabled = inArchiveView();
}

function updateArchiveBanner() {
  const banner = document.getElementById('archiveBanner');
  if (!banner) return;
  const archiveView = getArchiveView();
  if (!archiveView) {
    banner.style.display = 'none';
    return;
  }
  const s = archiveView.snapshot;
  banner.style.display = '';
  document.getElementById('archiveBannerLabel').textContent =
    `${s.cityName} · ${s.dateKey} · ${formatArchiveTime(s.savedHourFrac)} · ${s.modelLabel || s.model}`;
}

function renderArchiveSettingsControls() {
  const panel = document.getElementById('cityModelSettingsPanel');
  if (!panel) return;
  const enabled = document.getElementById('archiveEnabled');
  const time = document.getElementById('archiveTime');
  const retention = document.getElementById('archiveRetentionDays');
  if (!enabled || !time) return;

  const s = archiveSettingsByCity[activeCity.id] || {};
  enabled.checked = !!s.enabled;
  time.value = s.time || '09:00';
  time.disabled = !s.enabled;
  if (retention) {
    retention.value = s.retentionDays != null ? s.retentionDays : '';
    retention.disabled = !s.enabled;
  }
}

function archiveEnabledToggled() {
  const enabled = document.getElementById('archiveEnabled');
  const time = document.getElementById('archiveTime');
  const retention = document.getElementById('archiveRetentionDays');
  const on = enabled.checked;
  if (time) time.disabled = !on;
  if (retention) retention.disabled = !on;
}

fetchArchiveSettings().then(renderArchiveSaveButton);
