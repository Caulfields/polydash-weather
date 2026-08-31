const fs = require('fs');
const path = require('path');

const ARCHIVE_VERSION = 1;
const MAX_ARCHIVES_PER_CITY = 60;
const SNAPSHOT_CATEGORIES = new Set(['green', 'red']);

function pad2(value) {
  return String(value).padStart(2, '0');
}

function cityTodayKey(timezone, date = new Date()) {
  try {
    return date.toLocaleDateString('en-CA', { timeZone: timezone });
  } catch (error) {
    return date.toISOString().slice(0, 10);
  }
}

function cityDateKeyForOffset(timezone, offsetDays = 0, date = new Date()) {
  const [year, month, day] = cityTodayKey(timezone, date).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + offsetDays));
  return shifted.toISOString().slice(0, 10);
}

function cityLocalHourFrac(timezone, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return parseInt(parts.hour, 10) + parseInt(parts.minute, 10) / 60 + parseInt(parts.second, 10) / 3600;
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

function parseMetarWeather(rawOb) {
  if (!rawOb) return '\u2014';
  const tokens = rawOb.split(' ');
  const wxMap = {
    TSRA: 'thunderstorm with rain', TSSN: 'thunderstorm with snow', TSGS: 'thunderstorm with hail',
    TS: 'thunderstorm', '+RA': 'heavy rain', RA: 'rain', '-RA': 'light rain',
    '+SN': 'heavy snow', SN: 'snow', '-SN': 'light snow', RASN: 'rain and snow', SNRA: 'snow and rain',
    '+DZ': 'heavy drizzle', DZ: 'drizzle', '-DZ': 'light drizzle',
    FZRA: 'freezing rain', FZDZ: 'freezing drizzle', '+GR': 'heavy hail', GR: 'hail', GS: 'small hail',
    BLSN: 'blowing snow', DRSN: 'drifting snow', FG: 'fog', FZFG: 'freezing fog', MIFG: 'shallow fog',
    BR: 'mist', HZ: 'haze', FU: 'smoke', DU: 'dust', SA: 'sand', SQ: 'squalls', FC: 'funnel cloud',
  };
  const skyPriority = { FEW: 1, SCT: 2, BKN: 3, OVC: 4 };
  const skyLabel = { FEW: 'mostly clear', SCT: 'partly cloudy', BKN: 'cloudy', OVC: 'overcast' };
  for (const token of tokens) if (wxMap[token]) return wxMap[token];
  for (const token of tokens) if (/^(SKC|CLR|NSC|NCD|CAVOK)$/.test(token)) return 'clear';
  let bestPriority = 0;
  let bestLabel = null;
  for (const token of tokens) {
    const match = token.match(/^(FEW|SCT|BKN|OVC)\d{3}/);
    if (match && skyPriority[match[1]] > bestPriority) {
      bestPriority = skyPriority[match[1]];
      bestLabel = skyLabel[match[1]];
    }
  }
  return bestLabel || '--';
}

function parseObsDate(value) {
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  return new Date(value);
}

function normalizeMetarPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload && payload.data)) return payload.data;
  if (Array.isArray(payload && payload.value)) return payload.value;
  return [];
}

function parseMetarRowsFromPayload(payload, city) {
  const raw = normalizeMetarPayload(payload);
  return raw
    .filter((row) => row.temp != null)
    .map((row) => {
      const precise = city.usesUsMetarTenths ? parseUsMetarTenths(row.rawOb) : null;
      const time = parseObsDate(row.reportTime || row.obsTime);
      return {
        timeMs: time.getTime(),
        temp: precise && precise.tempC != null ? precise.tempC : row.temp,
        dewp: precise && precise.dewpC != null ? precise.dewpC : row.dewp,
        wspd: row.wspd,
        wdir: row.wdir,
        rawOb: row.rawOb,
        weather: parseMetarWeather(row.rawOb),
      };
    })
    .filter((row) => Number.isFinite(row.timeMs) && Number.isFinite(row.temp))
    .sort((a, b) => a.timeMs - b.timeMs);
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

function parseForecastRows(hourly, dateKey, modelId) {
  const times = hourly.time || [];
  const temps = hourlyField(hourly, 'temperature_2m', modelId);
  const rain = hourlyField(hourly, 'precipitation', modelId);
  const rainProb = hourlyField(hourly, 'precipitation_probability', modelId);
  const windSpeed = hourlyField(hourly, 'wind_speed_10m', modelId);
  const windDir = hourlyField(hourly, 'wind_direction_10m', modelId);
  const cloudCover = hourlyField(hourly, 'cloud_cover', modelId);
  const cloudCoverLow = hourlyField(hourly, 'cloud_cover_low', modelId);
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
        cloudCoverLow: typeof cloudCoverLow[index] === 'number' ? cloudCoverLow[index] : null,
        weatherCode: typeof weatherCode[index] === 'number' ? weatherCode[index] : null,
      };
    })
    .filter(Boolean);
}

function maxTempOfRows(rows) {
  if (!rows.length) return null;
  return Math.max(...rows.map((r) => r.temp));
}

function modelLabel(modelId) {
  return modelId || 'auto';
}

function cityModelIds(city) {
  const options = city && Array.isArray(city.modelOptions) ? city.modelOptions : [];
  return options.filter((id) => id && id !== 'auto');
}

function buildSnapshotFromPayloads({
  city,
  dateKey,
  forecastDay = 'today',
  model = 'auto',
  metarPayload,
  forecastPayload,
  additionalPayload = null,
  testPayload = null,
  modelsPayloads = null,
  now = new Date(),
  temperatureHighlight = null,
}) {
  const metarRows = parseMetarRowsFromPayload(metarPayload || [], city);
  const forecastRows = parseForecastRows((forecastPayload && forecastPayload.hourly) || {}, dateKey, model);
  const additionalMaxTempC = additionalPayload
    ? maxTempOfRows(parseForecastRows(additionalPayload.hourly || {}, dateKey, 'auto'))
    : null;
  const testMaxTempC = testPayload
    ? maxTempOfRows(parseForecastRows(testPayload.hourly || {}, dateKey, 'auto'))
    : null;

  const models = {};
  if (modelsPayloads && typeof modelsPayloads === 'object') {
    for (const [modelId, payload] of Object.entries(modelsPayloads)) {
      const rows = parseForecastRows((payload && payload.hourly) || {}, dateKey, modelId);
      if (rows.length) models[modelId] = rows;
    }
  }
  if (model !== 'auto' && !models[model] && forecastRows.length) {
    models[model] = forecastRows;
  }

  return {
    version: ARCHIVE_VERSION,
    id: null,
    cityId: city.id,
    cityName: city.name,
    metar: city.metar,
    timezone: city.timezone,
    savedAtISO: now.toISOString(),
    savedAtMs: now.getTime(),
    dateKey,
    savedHourFrac: cityLocalHourFrac(city.timezone, now),
    forecastDay,
    model,
    modelLabel: modelLabel(model),
    sourceLabel: city.omSourceLabel || 'Open-Meteo',
    omBadge: city.omBadge || 'OM',
    metarObsTime: metarRows.length ? metarRows[metarRows.length - 1].timeMs : null,
    metarRows,
    forecastRows,
    models,
    temperatureHighlight,
    additionalMaxTempC,
    testMaxTempC,
  };
}

function sanitizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  if (!snapshot.cityId || !snapshot.cityName || !snapshot.timezone) return null;
  if (!Array.isArray(snapshot.metarRows)) snapshot.metarRows = [];
  if (!Array.isArray(snapshot.forecastRows)) snapshot.forecastRows = [];
  if (!snapshot.models || typeof snapshot.models !== 'object' || Array.isArray(snapshot.models)) snapshot.models = {};
  if (snapshot.category != null && !SNAPSHOT_CATEGORIES.has(snapshot.category)) snapshot.category = '';
  snapshot.keepForever = snapshot.keepForever === true;
  if (!snapshot.id) snapshot.id = snapshot.savedAtMs ? `s_${snapshot.savedAtMs}` : `s_${Date.now()}`;
  return snapshot;
}

function shouldRunScheduledSave(settings, timezone, now = new Date()) {
  if (!settings || !settings.enabled) return false;
  const time = `${settings.time || ''}`.trim();
  if (!/^\d{1,2}:\d{2}$/.test(time)) return false;

  const [hour, minute] = time.split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const targetFrac = hour + minute / 60;
  const nowFrac = cityLocalHourFrac(timezone, now);
  if (nowFrac < targetFrac) return false;

  const today = cityTodayKey(timezone, now);
  const lastDate = settings.lastSavedDate || '';
  return lastDate !== today;
}

function createArchiveStore(dir) {
  const settingsPath = path.join(dir, 'settings.json');
  const snapshotsDir = path.join(dir, 'snapshots');

  fs.mkdirSync(snapshotsDir, { recursive: true });

  const inMemory = { settings: {}, snapshots: new Map() };
  // summary cache: listSnapshots runs every automation cycle, so avoid
  // re-parsing every snapshot file when it has not changed on disk
  const summaryCache = new Map();

  function loadSettingsFromDisk() {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (error) {
      // ignore
    }
    return {};
  }

  function saveSettingsToDisk(settings) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (error) {
      // ignore
    }
  }

  function loadSnapshotIds() {
    const ids = [];
    try {
      for (const entry of fs.readdirSync(snapshotsDir)) {
        if (entry.endsWith('.json')) ids.push(entry.slice(0, -5));
      }
    } catch (error) {
      // ignore
    }
    return ids;
  }

  function snapshotFileStatMs(id) {
    try {
      return fs.statSync(path.join(snapshotsDir, `${id}.json`)).mtimeMs;
    } catch (error) {
      return null;
    }
  }

  function readSnapshotFile(id) {
    try {
      const raw = fs.readFileSync(path.join(snapshotsDir, `${id}.json`), 'utf8');
      return sanitizeSnapshot(JSON.parse(raw));
    } catch (error) {
      return null;
    }
  }

  function writeSnapshotFile(snapshot) {
    fs.mkdirSync(snapshotsDir, { recursive: true });
    fs.writeFileSync(path.join(snapshotsDir, `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2), 'utf8');
  }

  async function getSettings() {
    return { ...inMemory.settings };
  }

  async function setSettings(cityId, raw) {
    if (!cityId || typeof cityId !== 'string') throw new Error('Invalid cityId');
    const current = inMemory.settings[cityId] || { enabled: false, time: '', lastSavedDate: '', retentionDays: null, category: '', keepForever: false };
    const enabled = raw && raw.enabled === true;
    const time = `${(raw && raw.time) || ''}`.trim();
    if (enabled && !/^\d{1,2}:\d{2}$/.test(time)) throw new Error('Invalid time (use HH:MM)');
    const num = Number(raw && raw.retentionDays);
    const retentionDays = Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
    const category = SNAPSHOT_CATEGORIES.has(raw && raw.category) ? raw.category : '';
    const keepForever = !!(raw && raw.keepForever === true);
    const next = {
      enabled,
      time,
      lastSavedDate: current.lastSavedDate || '',
      retentionDays,
      category,
      keepForever,
      // preserve the wd1-automation flag across full settings saves
      auto: current.auto === true ? (raw && raw.enabled === true) : false,
    };
    inMemory.settings[cityId] = next;
    saveSettingsToDisk(inMemory.settings);
    return { ...next };
  }

  // Partial update: only the provided fields change (used by the wd1
  // automation bootstrap to set `auto: true` without wiping user fields).
  async function patchSettings(cityId, patch) {
    if (!cityId || typeof cityId !== 'string') throw new Error('Invalid cityId');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid patch');
    const current = inMemory.settings[cityId] || {
      enabled: false,
      time: '',
      lastSavedDate: '',
      retentionDays: null,
      category: '',
      keepForever: false,
      auto: false,
    };
    const next = { ...current };
    if ('enabled' in patch) next.enabled = patch.enabled === true;
    if ('time' in patch) {
      const time = `${patch.time == null ? '' : patch.time}`.trim();
      if (next.enabled && !/^\d{1,2}:\d{2}$/.test(time)) throw new Error('Invalid time (use HH:MM)');
      next.time = time;
    }
    if ('retentionDays' in patch) {
      const num = Number(patch.retentionDays);
      next.retentionDays = Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
    }
    if ('category' in patch) next.category = SNAPSHOT_CATEGORIES.has(patch.category) ? patch.category : '';
    if ('keepForever' in patch) next.keepForever = patch.keepForever === true;
    if ('auto' in patch) next.auto = patch.auto === true;
    inMemory.settings[cityId] = next;
    saveSettingsToDisk(inMemory.settings);
    return { ...next };
  }

  async function listSnapshots(cityId = null) {
    const ids = loadSnapshotIds();
    const all = [];
    for (const id of ids) {
      const mtimeMs = snapshotFileStatMs(id);
      const cached = mtimeMs != null ? summaryCache.get(id) : null;
      if (cached && cached.mtimeMs === mtimeMs) {
        all.push(cached.summary);
        continue;
      }
      const snapshot = readSnapshotFile(id);
      if (!snapshot) continue;
      const sum = summary(snapshot);
      if (mtimeMs != null) summaryCache.set(id, { mtimeMs, summary: sum });
      all.push(sum);
    }
    all.sort((a, b) => b.savedAtMs - a.savedAtMs);
    const filtered = cityId ? all.filter((s) => s.cityId === cityId) : all;
    return filtered;
  }

  async function getSnapshot(id) {
    if (!id || typeof id !== 'string') return null;
    if (inMemory.snapshots.has(id)) return inMemory.snapshots.get(id);
    const snapshot = readSnapshotFile(id);
    if (snapshot) inMemory.snapshots.set(id, snapshot);
    return snapshot;
  }

  async function addSnapshot(raw) {
    const snapshot = sanitizeSnapshot(raw);
    if (!snapshot) throw new Error('Invalid snapshot');
    if (!snapshot.id || snapshot.id === `s_${snapshot.savedAtMs}`) {
      snapshot.id = `s_${snapshot.savedAtMs}_${snapshot.cityId}`;
    }
    const settings = inMemory.settings[snapshot.cityId];
    if (settings) {
      if (snapshot.category == null) snapshot.category = settings.category || '';
      if (!snapshot.keepForever) snapshot.keepForever = settings.keepForever === true;
    }
    if (snapshot.category == null) snapshot.category = '';
    writeSnapshotFile(snapshot);
    inMemory.snapshots.set(snapshot.id, snapshot);

    if (settings && settings.enabled) {
      settings.lastSavedDate = snapshot.dateKey;
      saveSettingsToDisk(inMemory.settings);
    }

    await pruneCity(snapshot.cityId);
    return snapshot;
  }

  async function deleteSnapshot(id) {
    if (!id || typeof id !== 'string') return;
    try {
      fs.unlinkSync(path.join(snapshotsDir, `${id}.json`));
    } catch (error) {
      // ignore
    }
    inMemory.snapshots.delete(id);
    summaryCache.delete(id);
  }

  async function pruneCity(cityId) {
    const ids = loadSnapshotIds();
    const citySnapshots = ids
      .map((id) => ({ id, snapshot: readSnapshotFile(id) }))
      .filter((item) => item.snapshot && item.snapshot.cityId === cityId)
      .sort((a, b) => b.snapshot.savedAtMs - a.snapshot.savedAtMs);

    const doomed = new Set();
    const keptForever = new Set(citySnapshots.filter((i) => i.snapshot.keepForever).map((i) => i.id));

    // Retention in days: drop snapshots older than settings.retentionDays (kept-forever exempt).
    const settings = inMemory.settings[cityId] || {};
    if (settings.retentionDays && settings.retentionDays > 0) {
      const cutoffMs = Date.now() - settings.retentionDays * 86400000;
      for (const item of citySnapshots) {
        if (keptForever.has(item.id)) continue;
        if (item.snapshot.savedAtMs < cutoffMs) doomed.add(item.id);
      }
    }

    // Keep only the newest MAX_ARCHIVES_PER_CITY per city (kept-forever exempt).
    let keptNew = 0;
    for (const item of citySnapshots) {
      if (keptForever.has(item.id)) continue;
      keptNew += 1;
      if (keptNew > MAX_ARCHIVES_PER_CITY) doomed.add(item.id);
    }

    for (const id of doomed) {
      try {
        fs.unlinkSync(path.join(snapshotsDir, `${id}.json`));
      } catch (error) {
        // ignore
      }
      inMemory.snapshots.delete(id);
      summaryCache.delete(id);
    }
  }

  function summary(snapshot) {
    return {
      id: snapshot.id,
      cityId: snapshot.cityId,
      cityName: snapshot.cityName,
      metar: snapshot.metar,
      dateKey: snapshot.dateKey,
      savedAtISO: snapshot.savedAtISO,
      savedAtMs: snapshot.savedAtMs,
      savedHourFrac: snapshot.savedHourFrac,
      model: snapshot.model,
      modelLabel: snapshot.modelLabel,
      metarCount: snapshot.metarRows.length,
      forecastCount: snapshot.forecastRows.length,
      modelCount: snapshot.models ? Object.keys(snapshot.models).length : 0,
      category: snapshot.category || '',
      keepForever: snapshot.keepForever === true,
    };
  }

  async function updateSnapshot(id, patch) {
    if (!id || typeof id !== 'string') throw new Error('Invalid snapshot id');
    const snapshot = await getSnapshot(id);
    if (!snapshot) return null;
    if (patch && 'category' in patch) {
      snapshot.category = SNAPSHOT_CATEGORIES.has(patch.category) ? patch.category : '';
    }
    if (patch && 'keepForever' in patch) {
      snapshot.keepForever = patch.keepForever === true;
    }
    writeSnapshotFile(snapshot);
    inMemory.snapshots.set(id, snapshot);
    return snapshot;
  }

  return {
    getSettings,
    setSettings,
    patchSettings,
    listSnapshots,
    getSnapshot,
    addSnapshot,
    deleteSnapshot,
    updateSnapshot,
    summary,
    sanitizeSnapshot,
  };
}

module.exports = {
  ARCHIVE_VERSION,
  MAX_ARCHIVES_PER_CITY,
  cityTodayKey,
  cityDateKeyForOffset,
  cityLocalHourFrac,
  parseUsMetarTenths,
  parseMetarWeather,
  parseMetarRowsFromPayload,
  parseForecastRows,
  buildSnapshotFromPayloads,
  cityModelIds,
  shouldRunScheduledSave,
  sanitizeSnapshot,
  createArchiveStore,
};
