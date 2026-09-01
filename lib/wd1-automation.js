'use strict';

// WD1 automation — mirrors the "Weather Dashboard" (:3000) Archives into this
// app's per-city archive store and classifies each city-day green/red.
//
// Classification rule = auto-table's own green highlight from its day-detail
// view (`detailRateHit` in auto-table public/js/render.js, ported verbatim):
// - take the market day's FIRST collection ("start") and the CONTROL collection
//   (last scheduled slot);
// - in both, build the "avg" slot = average of the basic/additional/test
//   model slots (auto-table lib/shared/weather-utils.js `buildAvgSlot`);
// - pair = rateNumbers(avg): [roundHalfDown(todayMax), +1], null when low
//   clouds >= 50% or data missing (auto-table RATES_RULES);
// - GREEN when the control avg slot's ratesPct on ANY number of the start
//   pair is >= RATE_HIT_MIN (96, same constant as auto-table);
// - RED when the control has rates for the pair but none >= 96;
//   no rates at all -> left unclassified.
// Manual wd1 refreshes are stamped with their own time, so everything works
// on collectedAt chronology, not slot labels.
// Boundary chunks (Others: dayStart 6 / dayEnd 3): the market day opens with
// the 18:32 slot (morning in São Paulo) and closes with the 03:22 slot of the
// next UTC+5 calendar day; grouping by the archive's marketDate handles it.

const { cityTodayKey } = require('./archive');

const DEFAULT_BASE = 'http://host.docker.internal:3000';
const CHUNKS_CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
// control-slot fallback: an archive counts as "control" only if it was
// collected at/after the scheduled control moment minus this grace period
const CONTROL_FALLBACK_GRACE_MS = 15 * 60_000;
// archives stamped slightly in the future (clock skew) are still grouped
const SKEW_TOLERANCE_MS = 15 * 60_000;

// auto-table's green-highlight threshold: a pair number with control
// Rates% >= this counts as "hit" (public/js/render.js detailRateHit)
const RATE_HIT_MIN = 96;

// Marker time for automated cities: their snapshots are triggered by wd1's
// first collection, not by a wall-clock time, so the legacy scheduler never
// fires for them (server skips cfg.auto cities).
const AUTO_SAVE_TIME = '00:00';

// wd1 city key (lowercase, spaces) -> this app's CITIES id.
const WD1_CITY_ID_MAP = {
  'hong kong': 'hongkong',
  'sao paulo': 'saopaulo',
  'buenos aires': 'buenosaires',
  'tel aviv': 'telaviv',
  'kuala lumpur': 'kualalumpur',
};

// Cities currently in wd1 Archives chunks (snapshot of 31.08.2026):
// Asia 10, Europe 13, Others 3. Used only by ensureAutoSettings bootstrap;
// save/classify always use the live chunk config instead.
const WD1_AUTOMATED_CITY_KEYS = [
  'beijing', 'seoul', 'hong kong', 'singapore', 'shanghai', 'chongqing',
  'tokyo', 'lucknow', 'busan', 'qingdao',
  'london', 'paris', 'milan', 'madrid', 'ankara', 'warsaw', 'munich',
  'amsterdam', 'moscow', 'istanbul', 'tel aviv', 'helsinki', 'jeddah',
  'sao paulo', 'toronto', 'buenos aires',
];

const BASE_SLOT_KEYS = ['basic', 'additional', 'test'];

function wd1CityId(cityKey, CITIES) {
  const id = WD1_CITY_ID_MAP[cityKey] || cityKey;
  return CITIES && CITIES[id] ? id : null;
}

function automatedCityIds(CITIES) {
  const ids = [];
  for (const key of WD1_AUTOMATED_CITY_KEYS) {
    const id = wd1CityId(key, CITIES);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// First-time setup: give every automated city archive settings with auto:true.
// Only touches cities with no settings yet or with no explicit auto field, so
// a city the user later disabled (auto:false via patch) is never re-enabled.
async function ensureAutoSettings({ archiveStore, CITIES, log = () => {} }) {
  const settings = await archiveStore.getSettings();
  let changed = 0;
  for (const cityId of automatedCityIds(CITIES)) {
    const cur = settings[cityId];
    if (cur && cur.auto !== undefined) continue;
    await archiveStore.patchSettings(cityId, {
      enabled: true,
      time: AUTO_SAVE_TIME,
      retentionDays: (cur && cur.retentionDays) != null ? cur.retentionDays : null,
      category: (cur && cur.category) || '',
      keepForever: (cur && cur.keepForever) === true,
      auto: true,
    });
    changed += 1;
  }
  if (changed) log(`auto-archiving enabled for ${changed} cities (wd1 automation)`);
  return changed;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function hhmmToMin(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function parseDdMm(value) {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(value == null ? '' : value).trim());
  return m ? { d: Number(m[1]), m: Number(m[2]) } : null;
}

function shiftDateKey(dateKey, days) {
  const [y, m, d] = String(dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// UTC+5 ("user local") calendar parts of an absolute moment.
function utc5Parts(date = new Date()) {
  const d = new Date(date.getTime() + 5 * 3600 * 1000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
  };
}

function momentOfDateKey(dateKey, hour, minute) {
  const [y, m, d] = String(dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d, hour, minute) - 5 * 3600 * 1000;
}

function makeSchedule(chunk) {
  const dayStartHour = Number.isFinite(chunk.dayStartHour) ? chunk.dayStartHour : 0;
  const dayEndHour = Number.isFinite(chunk.dayEndHour) ? chunk.dayEndHour : 0;
  const entries = [];
  for (const raw of Array.isArray(chunk.schedule) ? chunk.schedule : []) {
    const min = hhmmToMin(raw);
    if (min == null) continue;
    entries.push({
      label: String(raw).trim(),
      min,
      // position of the slot inside the market day, counting from dayStart
      offset: (min - dayStartHour * 60 + 1440) % 1440,
    });
  }
  entries.sort((a, b) => a.offset - b.offset);
  return {
    slots: entries,
    opener: entries[0] || null,
    closer: entries[entries.length - 1] || null,
    dayStartHour,
    dayEndHour,
    boundary: dayStartHour > dayEndHour,
  };
}

// Group a chunk's archives by logical market day ('YYYY-MM-DD', year taken
// from the run date — DD/MM strings carry no year). Archives without a sane
// collectedAt, from the future (beyond clock-skew tolerance) or older than
// ~370 days are ignored.
function marketDayGroups(chunk, year, nowMs = Infinity) {
  const groups = new Map();
  for (const a of Array.isArray(chunk.archives) ? chunk.archives : []) {
    const collectedAt = Number(a.collectedAt) || 0;
    if (!collectedAt || collectedAt > nowMs + SKEW_TOLERANCE_MS) continue;
    if (Number.isFinite(nowMs) && collectedAt < nowMs - 370 * 86400000) continue;
    const p = parseDdMm(a.marketDate || a.date);
    if (!p) continue;
    const dateKey = `${year}-${pad2(p.m)}-${pad2(p.d)}`;
    let group = groups.get(dateKey);
    if (!group) {
      group = { dateKey, archives: [] };
      groups.set(dateKey, group);
    }
    group.archives.push(a);
  }
  return groups;
}

function archiveSlotMin(a) {
  return hhmmToMin(a.slot || a.timestamp);
}

function sortedByCollected(archives) {
  return (archives || [])
    .slice()
    .sort((a, b) => (Number(a.collectedAt) || 0) - (Number(b.collectedAt) || 0));
}

// The archive collected for a given scheduled slot (latest collectedAt wins —
// manual refreshes can duplicate a slot).
function slotArchive(archives, slotMin) {
  let best = null;
  let bestCollectedAt = -Infinity;
  for (const a of archives || []) {
    if (archiveSlotMin(a) !== slotMin) continue;
    const ca = Number(a.collectedAt) || 0;
    if (!best || ca > bestCollectedAt) {
      best = a;
      bestCollectedAt = ca;
    }
  }
  return best;
}

function cityResult(archive, city) {
  const rows = archive && Array.isArray(archive.results) ? archive.results : [];
  return (
    rows.find((r) => r && r.station === city.metar) ||
    rows.find((r) => String((r && r.cityName) || '').toLowerCase() === String(city.name || '').toLowerCase()) ||
    null
  );
}

// ---------------------------------------------------------------- avg slot
// Ported from auto-table lib/shared/weather-utils.js (slotHasData,
// slotAggregates, buildAvgSlot) so classification matches its day-detail view.

function avgOf(values) {
  const valid = (values || []).filter((v) => v != null);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function slotHasData(slot) {
  if (!slot || !slot.modelKey) return false;
  if (slot.compact) return slot.todayMax != null;
  return !!(slot.hours && slot.hours.today && slot.hours.today.length);
}

function slotMaxTemp(slot) {
  if (slot.compact) return slot.todayMax != null ? slot.todayMax : null;
  return slot.hours && slot.hours.todayMax != null ? slot.hours.todayMax : null;
}

function slotLowCloudAvg(slot) {
  if (slot.compact) return slot.todayLowCloudAvg != null ? slot.todayLowCloudAvg : null;
  const hours = (slot.hours && slot.hours.today) || [];
  return hours.length ? hours.reduce((s, h) => s + (h.cloud_cover_low || 0), 0) / hours.length : null;
}

// The "avg" model: mean of the base slots that have data (needs >= 2),
// ratesPct merged per key (first non-null value wins).
function buildAvgSlot(slots) {
  const withData = (slots || []).filter(slotHasData);
  if (withData.length < 2) return null;
  const ratesPct = {};
  for (const s of withData) {
    const pct = s.ratesPct || {};
    for (const [k, v] of Object.entries(pct)) {
      if (v == null) continue;
      if (!(k in ratesPct)) ratesPct[k] = v;
    }
  }
  return {
    slot: 'avg',
    modelKey: 'avg',
    compact: true,
    todayMax: avgOf(withData.map(slotMaxTemp)),
    todayLowCloudAvg: avgOf(withData.map(slotLowCloudAvg)),
    ratesPct,
  };
}

function avgSlotOfArchive(archive, city) {
  const r = cityResult(archive, city);
  const slots = r && Array.isArray(r.slots) ? r.slots : [];
  return buildAvgSlot(BASE_SLOT_KEYS.map((k) => slots.find((s) => s && s.slot === k) || null));
}

// auto-table rateNumbers: the pair [roundHalfDown(todayMax), +1]; null when
// low clouds >= 50% (no rates are bet) or data is missing. Same rounding as
// wd1 RATES_RULES: .5 rounds DOWN (25.5 -> 25), otherwise nearest.
function roundHalfDown(val) {
  const frac = val - Math.floor(val);
  if (Math.abs(frac - 0.5) < 0.0001) return Math.floor(val);
  return Math.round(val);
}

function rateNumbers(slot) {
  if (!slot || !slot.modelKey) return null;
  if (slot.compact) {
    if (slot.todayMax == null || slot.todayLowCloudAvg == null) return null;
    if (slot.todayLowCloudAvg >= 50) return null;
    const r = roundHalfDown(slot.todayMax);
    return [r, r + 1];
  }
  if (!slot.hours || !slot.hours.today.length || slot.hours.todayMax == null) return null;
  const lowCloudAvg = slot.hours.today.reduce((s, h) => s + (h.cloud_cover_low || 0), 0) / slot.hours.today.length;
  if (lowCloudAvg >= 50) return null;
  const r = roundHalfDown(slot.hours.todayMax);
  return [r, r + 1];
}

// The market day's initial collection: earliest by collectedAt.
function initialArchive(day) {
  return sortedByCollected(day && day.archives)[0] || null;
}

// Resolve the day's control archive: the scheduled closer slot if collected,
// otherwise a late collection (manual refresh after the control moment).
function controlArchive(day, schedule, city) {
  const closer = schedule.closer;
  const exact = slotArchive(day.archives, closer.min);
  if (exact && avgSlotOfArchive(exact, city)) return exact;
  // UTC+5 calendar date of the control moment: for boundary chunks the closer
  // runs on the morning of the next UTC+5 day after the market date.
  const closerDateKey = schedule.boundary ? shiftDateKey(day.dateKey, 1) : day.dateKey;
  const closerMs = momentOfDateKey(closerDateKey, Math.floor(closer.min / 60), closer.min % 60);
  if (closerMs == null) return exact || null;
  const cutoff = closerMs - CONTROL_FALLBACK_GRACE_MS;
  let fallback = null;
  for (const a of sortedByCollected(day.archives)) {
    if ((Number(a.collectedAt) || 0) < cutoff) continue;
    if (!avgSlotOfArchive(a, city)) continue;
    if (!fallback || (Number(a.collectedAt) || 0) > (Number(fallback.collectedAt) || 0)) fallback = a;
  }
  return fallback || exact || null;
}

// auto-table detailRateHit: green when the control avg slot's ratesPct on
// ANY number of the start pair is >= RATE_HIT_MIN.
function rateHit(startPair, controlAvgSlot) {
  if (!startPair || !startPair.length || !controlAvgSlot) return false;
  const pct = controlAvgSlot.ratesPct || {};
  return startPair.some((n) => pct[n] != null && Number(pct[n]) >= RATE_HIT_MIN);
}

async function makeWd1Fetch(base, token) {
  return async function wd1Fetch(pathname) {
    const res = await fetch(base + pathname, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`wd1 ${pathname} -> HTTP ${res.status}`);
    return res.json();
  };
}

async function loadChunkStates(wd1Fetch) {
  const chunks = await wd1Fetch('/api/config/chunks');
  const states = [];
  for (const ch of Array.isArray(chunks) ? chunks : []) {
    const schedule = makeSchedule(ch);
    if (!schedule.opener || !schedule.closer) continue;
    states.push({
      id: ch.id,
      name: ch.name,
      cityKeys: Array.isArray(ch.cities) ? ch.cities.map(String) : [],
      schedule,
      archives: Array.isArray(ch.archives) ? ch.archives : [],
    });
  }
  return states;
}

function createWd1Automation({
  archiveStore,
  CITIES,
  saveSnapshotForCity,
  token = process.env.WD1_AI_TOKEN || '',
  base = (process.env.WD1_BASE_URL || DEFAULT_BASE).replace(/\/+$/, ''),
  wd1Fetch = null,
  log = (msg) => console.log(`[wd1] ${msg}`),
}) {
  let chunksCache = null;
  let chunksCacheAt = 0;
  // in-memory guards so unresolved/edge days don't spam the log every 30s
  const decidedIds = new Set();
  const loggedNoControl = new Set();

  async function fetchWithCache() {
    if (!wd1Fetch && !token) return null;
    if (chunksCache && Date.now() - chunksCacheAt < CHUNKS_CACHE_MS) return chunksCache;
    const fetcher = wd1Fetch || (await makeWd1Fetch(base, token));
    chunksCache = await loadChunkStates(fetcher);
    chunksCacheAt = Date.now();
    return chunksCache;
  }

  async function runOnce(now = new Date()) {
    if (!token && !wd1Fetch) return { ok: false, skipped: 'WD1_AI_TOKEN is not set' };
    const settings = await archiveStore.getSettings();
    const autoCities = Object.keys(settings || {}).filter((id) => settings[id] && settings[id].auto === true && CITIES[id]);
    if (!autoCities.length) return { ok: true, saved: [], classified: [] };

    let chunks;
    try {
      chunks = await fetchWithCache();
    } catch (error) {
      log(`wd1 fetch failed: ${error.message}`);
      return { ok: false, error: error.message };
    }
    if (!chunks) return { ok: true, saved: [], classified: [] };

    const chunkByCity = new Map();
    for (const ch of chunks) {
      for (const key of ch.cityKeys) {
        const id = wd1CityId(key, CITIES);
        if (id) chunkByCity.set(id, ch);
      }
    }
    for (const id of autoCities) {
      if (!chunkByCity.has(id)) log(`${id}: not found in wd1 chunks — skipped`);
    }

    const nowMs = now.getTime();
    const year = utc5Parts(now).y;
    const saved = [];
    const classified = [];

    // ---- SAVE pass: the current market day's first wd1 collection appeared
    for (const cityId of autoCities) {
      const city = CITIES[cityId];
      const ch = chunkByCity.get(cityId);
      if (!city || !ch) continue;
      try {
        const groups = marketDayGroups(ch, year, nowMs);
        // newest market day that has any collection so far
        let current = null;
        for (const day of groups.values()) {
          const first = Math.min(...day.archives.map((a) => Number(a.collectedAt) || 0));
          if (!current || first > current.first) current = { day, first };
        }
        if (!current) continue;
        const mdDateKey = current.day.dateKey;
        const existing = (await archiveStore.listSnapshots(cityId)).find((s) => s.dateKey === mdDateKey);
        if (existing) continue;
        const snapshot = await saveSnapshotForCity(city, mdDateKey, now);
        saved.push({ cityId, dateKey: mdDateKey, id: snapshot && snapshot.id });
        log(`saved initial snapshot ${cityId} ${mdDateKey} (${ch.name})`);
      } catch (error) {
        log(`${cityId}: save failed: ${error.message}`);
      }
    }

    // ---- CLASSIFY pass: the market day's control archive has been collected
    for (const cityId of autoCities) {
      const city = CITIES[cityId];
      const ch = chunkByCity.get(cityId);
      if (!city || !ch) continue;
      try {
        const snaps = (await archiveStore.listSnapshots(cityId)).filter((s) => s.category === '' && !decidedIds.has(s.id));
        if (!snaps.length) continue;
        const todayKey = cityTodayKey(city.timezone, now);
        const groups = marketDayGroups(ch, year, nowMs);
        for (const snap of snaps) {
          // classify only fresh snapshots (today or yesterday, city-local);
          // older unclassified ones are left alone
          if (snap.dateKey !== todayKey && snap.dateKey !== shiftDateKey(todayKey, -1)) continue;
          const day = groups.get(snap.dateKey);
          if (!day) continue;
          const initial = initialArchive(day);
          const initialAvg = initial ? avgSlotOfArchive(initial, city) : null;
          const pair = rateNumbers(initialAvg);
          if (!pair) {
            decidedIds.add(snap.id);
            log(`${cityId} ${snap.dateKey}: initial avg pair missing (low clouds >= 50% or < 2 models) — left unclassified`);
            continue;
          }
          const control = controlArchive(day, ch.schedule, city);
          if (!control) {
            if (!loggedNoControl.has(snap.id)) {
              loggedNoControl.add(snap.id);
              log(`${cityId} ${snap.dateKey}: control slot ${ch.schedule.closer.label} not collected yet`);
            }
            continue;
          }
          const controlAvg = avgSlotOfArchive(control, city);
          if (!controlAvg) {
            decidedIds.add(snap.id);
            log(`${cityId} ${snap.dateKey}: control avg slot missing — left unclassified`);
            continue;
          }
          const pct = controlAvg.ratesPct || {};
          const values = pair.map((n) => (pct[n] != null ? Number(pct[n]) : null));
          const hasAny = values.some((v) => v != null);
          const hit = rateHit(pair, controlAvg);
          const category = hit ? 'green' : hasAny ? 'red' : '';
          if (category) {
            await archiveStore.updateSnapshot(snap.id, { category });
            classified.push({ cityId, dateKey: snap.dateKey, category, pair, rates: values });
          }
          decidedIds.add(snap.id); // never re-classified by later cycles
          log(
            `classified ${cityId} ${snap.dateKey} -> ${category || 'no data (unclassified)'} ` +
            `(initial pair ${pair[0]}-${pair[1]}, control rates ` +
            `${values.map((v) => (v == null ? '\u2014' : v)).join('/')})`,
          );
        }
      } catch (error) {
        log(`${cityId}: classify failed: ${error.message}`);
      }
    }

    return { ok: true, saved, classified };
  }

  return { runOnce, fetchWithCache };
}

module.exports = {
  AUTO_SAVE_TIME,
  BASE_SLOT_KEYS,
  CONTROL_FALLBACK_GRACE_MS,
  RATE_HIT_MIN,
  WD1_AUTOMATED_CITY_KEYS,
  WD1_CITY_ID_MAP,
  automatedCityIds,
  avgOf,
  avgSlotOfArchive,
  buildAvgSlot,
  cityResult,
  controlArchive,
  createWd1Automation,
  ensureAutoSettings,
  hhmmToMin,
  initialArchive,
  loadChunkStates,
  makeSchedule,
  marketDayGroups,
  parseDdMm,
  rateHit,
  rateNumbers,
  shiftDateKey,
  slotArchive,
  slotHasData,
  utc5Parts,
  wd1CityId,
};
