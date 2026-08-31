'use strict';

// WD1 automation — mirrors the "Weather Dashboard" (:3000) Archives into this
// app's per-city archive store and classifies each city-day green/red.
//
// How it works (rule confirmed by Igor, 31.08.2026):
// - wd1 city-days are grouped per chunk (Asia / Europe / Others) by the
//   archive's marketDate. The FIRST collection of a market day is the "initial
//   snapshot": the position is the basic/auto slot's Polymarket ratesPct
//   argmax, only when the max rate is above POSITION_MIN_RATE (10%). Manual
//   wd1 refreshes are stamped with their own time and often carry no rates,
//   so everything here works on collectedAt chronology, not slot labels.
// - When wd1's first collection for the current market day appears, a
//   snapshot is saved automatically for every city whose archive settings
//   have { auto: true } (unless one already exists for that city-day).
// - The LAST scheduled slot is the "control slot" (post-market rates: ~100% on
//   a threshold = market resolved YES there, ~0% = landed below). When the
//   control archive appears, the day's snapshot is classified by the rate on
//   the INITIAL threshold: >= GREEN_MIN_RATE -> 'green' (прогноз совпал),
//   <= RED_MAX_RATE -> 'red' (не совпал), in between -> left unclassified.
// - Boundary chunks (Others: dayStart 6 / dayEnd 3): the market day opens with
//   the 18:32 slot (morning in São Paulo) and closes with the 03:22 slot of
//   the next UTC+5 calendar day. Grouping by the archive's marketDate handles
//   this; the snapshot's city-local date equals the market date for all
//   current chunks, so no date shifting is needed anywhere.

const { cityTodayKey } = require('./archive');

const DEFAULT_BASE = 'http://host.docker.internal:3000';
const CHUNKS_CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
// control-slot fallback: an archive counts as "control" only if it was
// collected at/after the scheduled control moment minus this grace period
const CONTROL_FALLBACK_GRACE_MS = 15 * 60_000;
// archives stamped slightly in the future (clock skew) are still grouped
const SKEW_TOLERANCE_MS = 15 * 60_000;

// Marker time for automated cities: their snapshots are triggered by wd1's
// first collection, not by a wall-clock time, so the legacy scheduler never
// fires for them (server skips cfg.auto cities).
const AUTO_SAVE_TIME = '00:00';

const POSITION_MIN_RATE = 10;
const GREEN_MIN_RATE = 95;
const RED_MAX_RATE = 5;

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

function basicRates(archive, city) {
  const r = cityResult(archive, city);
  const slots = r && Array.isArray(r.slots) ? r.slots : [];
  const basic =
    slots.find((s) => s && s.slot === 'basic') ||
    slots.find((s) => s && s.modelKey === 'auto') ||
    slots[0] ||
    null;
  return basic && basic.ratesPct && typeof basic.ratesPct === 'object' ? basic.ratesPct : null;
}

// Argmax of ratesPct. Returns { threshold, rate } or null.
function bestThreshold(rates) {
  let best = null;
  for (const [key, value] of Object.entries(rates || {})) {
    const threshold = Number(key);
    const rate = Number(value);
    if (!Number.isFinite(threshold) || !Number.isFinite(rate)) continue;
    if (!best || rate > best.rate) best = { threshold, rate };
  }
  return best;
}

// The position taken at the initial slot: argmax of the basic/auto rates,
// only meaningful when the max rate is above the noise floor.
function positionFromArchive(archive, city) {
  const best = bestThreshold(basicRates(archive, city));
  return best && best.rate > POSITION_MIN_RATE ? best : null;
}

// First collection of the market day that carries a usable position (manual
// refreshes often have no rates, so fall through chronologically). The
// control archive is excluded — its rates are post-market, not a position.
function positionFromGroup(archives, city, excludeArchive = null) {
  for (const a of sortedByCollected(archives)) {
    if (excludeArchive && a === excludeArchive) continue;
    const pos = positionFromArchive(a, city);
    if (pos) return pos;
  }
  return null;
}

function controlRateOn(rates, threshold) {
  if (!rates) return null;
  let raw = rates[String(threshold)];
  if (raw === undefined) {
    const key = Object.keys(rates).find((k) => Number(k) === threshold);
    if (key === undefined) return null;
    raw = rates[key];
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// Resolve the day's control archive: the scheduled closer slot if collected,
// otherwise a late collection (manual refresh after the control moment).
function controlArchive(day, schedule, city) {
  const closer = schedule.closer;
  const exact = slotArchive(day.archives, closer.min);
  if (exact && basicRates(exact, city)) return exact;
  // UTC+5 calendar date of the control moment: for boundary chunks the closer
  // runs on the morning of the next UTC+5 day after the market date.
  const closerDateKey = schedule.boundary ? shiftDateKey(day.dateKey, 1) : day.dateKey;
  const closerMs = momentOfDateKey(closerDateKey, Math.floor(closer.min / 60), closer.min % 60);
  if (closerMs == null) return exact || null;
  const cutoff = closerMs - CONTROL_FALLBACK_GRACE_MS;
  let fallback = null;
  for (const a of sortedByCollected(day.archives)) {
    if ((Number(a.collectedAt) || 0) < cutoff) continue;
    if (!basicRates(a, city)) continue;
    if (!fallback || (Number(a.collectedAt) || 0) > (Number(fallback.collectedAt) || 0)) fallback = a;
  }
  return fallback || exact || null;
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
          const control = controlArchive(day, ch.schedule, city);
          if (!control) {
            if (!loggedNoControl.has(snap.id)) {
              loggedNoControl.add(snap.id);
              log(`${cityId} ${snap.dateKey}: control slot ${ch.schedule.closer.label} not collected yet`);
            }
            continue;
          }
          const pos = positionFromGroup(day.archives, city, control);
          if (!pos) {
            decidedIds.add(snap.id);
            log(`${cityId} ${snap.dateKey}: no initial position (rates <= ${POSITION_MIN_RATE}%) — left unclassified`);
            continue;
          }
          const rate = controlRateOn(basicRates(control, city), pos.threshold);
          if (rate == null) {
            decidedIds.add(snap.id);
            log(`${cityId} ${snap.dateKey}: control slot has no rate for ${pos.threshold}\u00B0`);
            continue;
          }
          const category = rate >= GREEN_MIN_RATE ? 'green' : rate <= RED_MAX_RATE ? 'red' : '';
          if (category) {
            await archiveStore.updateSnapshot(snap.id, { category });
          }
          decidedIds.add(snap.id); // edge cases are not rewritten every cycle
          classified.push({ cityId, dateKey: snap.dateKey, category, threshold: pos.threshold, rate });
          log(
            `classified ${cityId} ${snap.dateKey} -> ${category || 'edge (no category)'} ` +
            `(initial position ${pos.threshold}\u00B0, control rate ${rate}%)`,
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
  CONTROL_FALLBACK_GRACE_MS,
  GREEN_MIN_RATE,
  POSITION_MIN_RATE,
  RED_MAX_RATE,
  WD1_AUTOMATED_CITY_KEYS,
  WD1_CITY_ID_MAP,
  automatedCityIds,
  basicRates,
  bestThreshold,
  cityResult,
  controlArchive,
  controlRateOn,
  createWd1Automation,
  ensureAutoSettings,
  hhmmToMin,
  loadChunkStates,
  makeSchedule,
  marketDayGroups,
  parseDdMm,
  positionFromArchive,
  positionFromGroup,
  shiftDateKey,
  slotArchive,
  utc5Parts,
  wd1CityId,
};
