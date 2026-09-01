const { test } = require('node:test');
const assert = require('node:assert');
const CITIES = require('../../assets/js/dashboard/config').CITIES;
const {
  AUTO_SAVE_TIME,
  RATE_HIT_MIN,
  buildAvgSlot,
  controlArchive,
  createWd1Automation,
  ensureAutoSettings,
  makeSchedule,
  marketDayGroups,
  rateHit,
  rateNumbers,
  slotArchive,
  wd1CityId,
} = require('../../lib/wd1-automation');

const U5 = 5 * 3600 * 1000;
const pad2 = (v) => String(v).padStart(2, '0');
const ddMm = (ms) => {
  const u = new Date(ms + U5);
  return `${pad2(u.getUTCDate())}/${pad2(u.getUTCMonth() + 1)}`;
};
const u5moment = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - U5;

// ------------------------------------------------------------- fixtures

function mkSlot(name, modelKey, max, low, rates) {
  return { slot: name, modelKey, compact: true, todayMax: max, todayLowCloudAvg: low, ratesPct: rates || {} };
}
// two base slots with data => the avg model exists (same max, like real wd1 rows)
function slotsFor(max, low, rates) {
  return [mkSlot('basic', 'auto', max, low, rates), mkSlot('additional', 'ecmwf_ifs', max, low, rates)];
}
function wd1Archive({
  collectedAtMs,
  slot,
  marketDateKey,
  station = 'ZBAA',
  cityName = 'Beijing',
  max = 27.4,
  low = 10,
  rates = {},
  noSlots = false,
  oneSlot = false,
}) {
  const slots = noSlots ? [] : oneSlot ? [mkSlot('basic', 'auto', max, low, rates)] : slotsFor(max, low, rates);
  return {
    id: `arch_${collectedAtMs}_${slot}`,
    date: ddMm(collectedAtMs),
    marketDate: marketDateKey ? ddMm(marketDateKey) : undefined,
    timestamp: slot,
    slot,
    collectedAt: collectedAtMs,
    results: [{ station, cityName, slots }],
  };
}

// ------------------------------------------------------------------ avg

test('buildAvgSlot: average of base slots, needs 2+, merges ratesPct', () => {
  const avg = buildAvgSlot([mkSlot('basic', 'auto', 21.3, 10, { 21: 50 }), mkSlot('additional', 'gfs', 21.5, 30, { 22: 20 })]);
  assert.strictEqual(avg.modelKey, 'avg');
  assert.strictEqual(avg.todayMax, 21.4);
  assert.strictEqual(avg.todayLowCloudAvg, 20);
  assert.deepStrictEqual(avg.ratesPct, { 21: 50, 22: 20 });
  assert.strictEqual(buildAvgSlot([mkSlot('basic', 'auto', 21.3, 10)]), null);
  assert.strictEqual(buildAvgSlot([]), null);
});

// ----------------------------------------------------------- rateNumbers

test('rateNumbers: pair from avg todayMax, roundHalfDown (auto-table RATES_RULES)', () => {
  const mk = (max, low) => rateNumbers(buildAvgSlot(slotsFor(max, low)));
  assert.deepStrictEqual(mk(29.8, 10), [30, 31]);
  assert.deepStrictEqual(mk(24.3, 10), [24, 25]);
  assert.deepStrictEqual(mk(25.5, 10), [25, 26]); // .5 rounds DOWN
  assert.deepStrictEqual(mk(21.4, 10), [21, 22]); // Moscow initial pair
});

test('rateNumbers: null when low clouds >= 50% or data missing', () => {
  assert.strictEqual(rateNumbers(buildAvgSlot(slotsFor(21.4, 50))), null);
  assert.strictEqual(rateNumbers(buildAvgSlot(slotsFor(21.4, 70))), null);
  assert.strictEqual(rateNumbers(null), null);
  const noMax = buildAvgSlot([mkSlot('basic', 'auto', null, 10), mkSlot('additional', 'gfs', 21, 10)]);
  assert.strictEqual(rateNumbers(noMax), null); // avg todayMax null (one slot has no data... but still 2 with modelKey)
});

// --------------------------------------------------------------- rateHit

test('rateHit: green when control ratesPct on any pair number >= 96 (auto-table detailRateHit)', () => {
  assert.strictEqual(RATE_HIT_MIN, 96);
  assert.strictEqual(rateHit([32, 33], { ratesPct: { 32: 100, 33: 0 } }), true); // Tel Aviv
  assert.strictEqual(rateHit([32, 33], { ratesPct: { 32: 0, 33: 100 } }), true);
  assert.strictEqual(rateHit([32, 33], { ratesPct: { 32: 96, 33: 0 } }), true); // boundary
  assert.strictEqual(rateHit([32, 33], { ratesPct: { 32: 95.9, 33: 0 } }), false);
  assert.strictEqual(rateHit([21, 22], { ratesPct: { 21: 0, 22: 0 } }), false); // Moscow
  assert.strictEqual(rateHit([21, 22], { ratesPct: {} }), false);
  assert.strictEqual(rateHit(null, { ratesPct: { 21: 100 } }), false);
});

// -------------------------------------------------------- control slot

test('controlArchive: exact closer slot wins', () => {
  const day = {
    dateKey: '2026-08-31',
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30' }),
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00' }),
    ],
  };
  const s = makeSchedule({ schedule: ['08:30', '16:00'] });
  assert.strictEqual(controlArchive(day, s, CITIES.beijing).slot, '16:00');
});

test('controlArchive: falls back to a late collection with an avg slot', () => {
  const closerMs = u5moment(2026, 8, 31, 16, 0);
  const day = {
    dateKey: '2026-08-31',
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30' }),
      wd1Archive({ collectedAtMs: closerMs + 10 * 60_000, slot: '16:12' }),
    ],
  };
  const s = makeSchedule({ schedule: ['08:30', '16:00'] });
  assert.strictEqual(controlArchive(day, s, CITIES.beijing).slot, '16:12');
});

test('controlArchive: early collection before the control moment is not used', () => {
  const day = {
    dateKey: '2026-08-31',
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30' }),
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 11, 30), slot: '11:30' }),
    ],
  };
  const s = makeSchedule({ schedule: ['08:30', '11:30', '16:00'] });
  assert.strictEqual(controlArchive(day, s, CITIES.beijing), null);
});

// -------------------------------------------------------------- grouping

test('marketDayGroups: groups by marketDate with year, Others boundary included', () => {
  const chunk = {
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 30, 18, 32), slot: '18:32', marketDateKey: u5moment(2026, 8, 30, 12, 0) }),
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 3, 22), slot: '03:22', marketDateKey: u5moment(2026, 8, 30, 12, 0) }),
    ],
  };
  const groups = marketDayGroups(chunk, 2026);
  assert.strictEqual(groups.size, 1);
  const day = groups.get('2026-08-30');
  assert.strictEqual(day.archives.length, 2);
  assert.strictEqual(slotArchive(day.archives, 18 * 60 + 32).slot, '18:32');
  assert.strictEqual(slotArchive(day.archives, 3 * 60 + 22).slot, '03:22');
});

// -------------------------------------------------------------- city map

test('wd1CityId maps spaced keys to app ids', () => {
  assert.strictEqual(wd1CityId('sao paulo', CITIES), 'saopaulo');
  assert.strictEqual(wd1CityId('hong kong', CITIES), 'hongkong');
  assert.strictEqual(wd1CityId('paris', CITIES), 'paris');
  assert.strictEqual(wd1CityId('atlantis', CITIES), null);
});

// ------------------------------------------------------ ensureAutoSettings

function fakeStore() {
  const settings = {};
  const snapshots = [];
  return {
    settings,
    snapshots,
    async getSettings() {
      return JSON.parse(JSON.stringify(settings));
    },
    async setSettings(cityId, raw) {
      settings[cityId] = {
        enabled: raw && raw.enabled === true,
        time: (raw && raw.time) || '',
        lastSavedDate: (settings[cityId] && settings[cityId].lastSavedDate) || '',
        retentionDays: (raw && raw.retentionDays) || null,
        category: (raw && raw.category) || '',
        keepForever: !!(raw && raw.keepForever === true),
      };
      return { ...settings[cityId] };
    },
    async patchSettings(cityId, patch) {
      const cur = settings[cityId] || {
        enabled: false,
        time: '',
        lastSavedDate: '',
        retentionDays: null,
        category: '',
        keepForever: false,
      };
      settings[cityId] = { ...cur, ...patch };
      return { ...settings[cityId] };
    },
    async listSnapshots(cityId) {
      return snapshots.filter((s) => !cityId || s.cityId === cityId);
    },
    async updateSnapshot(id, patch) {
      const snap = snapshots.find((s) => s.id === id);
      if (!snap) return null;
      Object.assign(snap, patch);
      return snap;
    },
  };
}

test('ensureAutoSettings enables wd1 cities once and never re-enables disabled ones', async () => {
  const store = fakeStore();
  let changed = await ensureAutoSettings({ archiveStore: store, CITIES, log: () => {} });
  assert.strictEqual(changed, 26); // 27 wd1 cities, seoul already had settings
  assert.strictEqual(store.settings.paris.auto, true);
  assert.strictEqual(store.settings.paris.time, AUTO_SAVE_TIME);

  await store.patchSettings('paris', { auto: false });
  changed = await ensureAutoSettings({ archiveStore: store, CITIES, log: () => {} });
  assert.strictEqual(changed, 0);
  assert.strictEqual(store.settings.paris.auto, false);
});

// ----------------------------------------------------------------- runOnce

function fakeSave(store) {
  return async (city, dateKey) => {
    const snap = {
      id: `snap_${city.id}_${dateKey}`,
      cityId: city.id,
      cityName: city.name,
      dateKey,
      category: '',
      savedAtMs: Date.now(),
    };
    store.snapshots.push(snap);
    return snap;
  };
}

function makeTestAutomation(store, wd1Chunks, { token = 'test-token' } = {}) {
  return createWd1Automation({
    archiveStore: store,
    CITIES,
    saveSnapshotForCity: fakeSave(store),
    token,
    wd1Fetch: async () => wd1Chunks,
  });
}

test('runOnce: Igor examples — moscow red (0/0), telaviv green (100)', async () => {
  const store = fakeStore();
  await store.patchSettings('moscow', { auto: true });
  await store.patchSettings('telaviv', { auto: true });

  const now = new Date(u5moment(2026, 8, 31, 22, 30)); // after Europe control 22:00
  // real wd1 archives hold ALL cities of the chunk in one results array
  const row = (station, cityName, max, low, rates) => ({ station, cityName, slots: slotsFor(max, low, rates) });
  const chunks = [
    {
      id: 'europe',
      name: 'Europe',
      cities: ['moscow', 'tel aviv'],
      schedule: ['13:40', '22:00'],
      archives: [
        {
          id: 'arch_initial',
          date: '31/08',
          marketDate: '31/08',
          timestamp: '13:40',
          slot: '13:40',
          collectedAt: u5moment(2026, 8, 31, 13, 40),
          results: [
            row('UUWW', 'Moscow', 21.4, 10, {}),
            row('LLBG', 'Tel Aviv', 32.1, 5, {}),
          ],
        },
        {
          id: 'arch_control',
          date: '31/08',
          marketDate: '31/08',
          timestamp: '22:00',
          slot: '22:00',
          collectedAt: u5moment(2026, 8, 31, 22, 0),
          results: [
            row('UUWW', 'Moscow', 19.6, 10, { 21: 0, 22: 0 }),
            row('LLBG', 'Tel Aviv', 31.8, 5, { 32: 100, 33: 0 }),
          ],
        },
      ],
    },
  ];
  const result = await makeTestAutomation(store, chunks).runOnce(now);

  assert.strictEqual(result.saved.length, 2);
  const moscow = result.classified.find((c) => c.cityId === 'moscow');
  const telaviv = result.classified.find((c) => c.cityId === 'telaviv');
  assert.strictEqual(moscow.category, 'red'); // all models 0/0
  assert.strictEqual(moscow.attempts.length, 3); // basic, additional, avg
  assert.strictEqual(telaviv.category, 'green'); // 100 on 32
  assert.strictEqual(store.snapshots.find((s) => s.cityId === 'moscow').category, 'red');
  assert.strictEqual(store.snapshots.find((s) => s.cityId === 'telaviv').category, 'green');
});

test('runOnce: green when ANY model hits, red only when all models miss', async () => {
  const store = fakeStore();
  await store.patchSettings('seoul', { auto: true });
  await store.patchSettings('tokyo', { auto: true });

  const now = new Date(u5moment(2026, 8, 31, 22, 30));
  const row = (station, cityName, slots) => ({ station, cityName, slots });
  // Seoul: basic misses (0/0) but test model hits (100) -> green.
  // Tokyo: every model has rates but none >= 96 -> red.
  const chunks = [
    {
      id: 'asia',
      name: 'Asia',
      cities: ['seoul', 'tokyo'],
      schedule: ['08:30', '16:00'],
      archives: [
        {
          id: 'a_init',
          date: '31/08',
          marketDate: '31/08',
          slot: '08:30',
          collectedAt: u5moment(2026, 8, 31, 8, 30),
          results: [
            row('RKSS', 'Seoul', [
              mkSlot('basic', 'icon_seamless', 25.2, 10, {}),
              mkSlot('additional', 'ecmwf_ifs025', 24.8, 10, {}),
              mkSlot('test', 'cma_grapes_global', 26.3, 10, {}),
            ]),
            row('RJTT', 'Tokyo', [
              mkSlot('basic', 'auto', 27.7, 10, {}),
              mkSlot('additional', 'ecmwf_aifs025_single', 26.7, 10, {}),
              mkSlot('test', 'gfs_seamless', 27.3, 10, {}),
            ]),
          ],
        },
        {
          id: 'a_ctrl',
          date: '31/08',
          marketDate: '31/08',
          slot: '16:00',
          collectedAt: u5moment(2026, 8, 31, 16, 0),
          results: [
            row('RKSS', 'Seoul', [
              mkSlot('basic', 'icon_seamless', 25.0, 10, { 25: 0, 26: 0 }),
              mkSlot('additional', 'ecmwf_ifs025', 24.8, 10, { 24: 0, 25: 0 }),
              mkSlot('test', 'cma_grapes_global', 26.3, 10, { 26: 99.95, 27: 0.05 }),
            ]),
            row('RJTT', 'Tokyo', [
              mkSlot('basic', 'auto', 28.1, 10, { 27: 55, 28: 40 }),
              mkSlot('additional', 'ecmwf_aifs025_single', 26.7, 10, { 26: 30, 27: 45 }),
              mkSlot('test', 'gfs_seamless', 27.3, 10, { 27: 12, 28: 60 }),
            ]),
          ],
        },
      ],
    },
  ];
  const result = await makeTestAutomation(store, chunks).runOnce(now);
  const seoul = result.classified.find((c) => c.cityId === 'seoul');
  const tokyo = result.classified.find((c) => c.cityId === 'tokyo');
  assert.strictEqual(seoul.category, 'green'); // test model 26 -> 99.95
  assert.strictEqual(seoul.attempts.find((a) => a.key === 'basic').category ?? 'attempt-ok', 'attempt-ok');
  assert.strictEqual(tokyo.category, 'red'); // rates everywhere, no 96+
});

test('runOnce: saves on first collection and classifies green/red, no duplicates', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  await store.patchSettings('paris', { auto: true });
  await store.patchSettings('saopaulo', { auto: true });

  const now = new Date(u5moment(2026, 8, 31, 22, 30)); // after all control slots incl. Paris 22:00
  const chunks = [
    {
      id: 'asia',
      name: 'Asia',
      cities: ['beijing'],
      schedule: ['08:30', '16:00'],
      archives: [
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', max: 28.7, low: 10, rates: {} }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', max: 28.9, low: 10, rates: { 29: 100, 30: 0 } }),
      ],
    },
    {
      id: 'europe',
      name: 'Europe',
      cities: ['paris'],
      schedule: ['13:40', '22:00'],
      archives: [
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 13, 40), slot: '13:40', station: 'LFPB', cityName: 'Paris', max: 23.1, low: 10, rates: {} }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 22, 0), slot: '22:00', station: 'LFPB', cityName: 'Paris', max: 24.6, low: 10, rates: { 23: 0, 24: 0 } }),
      ],
    },
    {
      id: 'others',
      name: 'Others',
      cities: ['sao paulo'],
      schedule: ['03:22', '18:32'],
      dayStartHour: 6,
      dayEndHour: 3,
      archives: [
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 30, 18, 32), slot: '18:32', marketDateKey: u5moment(2026, 8, 30, 12, 0), station: 'SBGR', cityName: 'Sao Paulo', max: 26.4, low: 8, rates: {} }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 3, 22), slot: '03:22', marketDateKey: u5moment(2026, 8, 30, 12, 0), station: 'SBGR', cityName: 'Sao Paulo', max: 26.1, low: 8, rates: { 26: 96, 27: 0 } }),
      ],
    },
  ];
  const automation = makeTestAutomation(store, chunks);
  const result = await automation.runOnce(now);

  assert.strictEqual(result.saved.length, 3);
  const byCity = Object.fromEntries(result.classified.map((c) => [c.cityId, c]));
  assert.strictEqual(byCity.beijing.category, 'green'); // 29 -> 100
  assert.strictEqual(byCity.paris.category, 'red'); // 23/24 -> 0/0
  assert.strictEqual(byCity.saopaulo.category, 'green'); // 96 counts as hit
  assert.strictEqual(store.snapshots.find((s) => s.cityId === 'beijing').category, 'green');
  assert.strictEqual(store.snapshots.find((s) => s.cityId === 'paris').category, 'red');
  assert.strictEqual(store.snapshots.find((s) => s.cityId === 'saopaulo').category, 'green');

  // second run: no duplicates, no re-classification
  const again = await automation.runOnce(now);
  assert.strictEqual(again.saved.length, 0);
  assert.strictEqual(again.classified.length, 0);
  assert.strictEqual(store.snapshots.length, 3);
});

test('runOnce: no save before the opener slot', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const openMs = u5moment(2026, 8, 31, 8, 30);
  const automation = makeTestAutomation(store, [
    {
      id: 'asia',
      name: 'Asia',
      cities: ['beijing'],
      schedule: ['08:30', '16:00'],
      archives: [wd1Archive({ collectedAtMs: openMs, slot: '08:30' })],
    },
  ]);
  const now = new Date(u5moment(2026, 8, 31, 7, 0)); // 08:30 UTC+5 not reached
  const result = await automation.runOnce(now);
  assert.strictEqual(result.saved.length, 0);
  assert.strictEqual(store.snapshots.length, 0);
});

test('runOnce: no save until wd1 collects the opener archive', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const automation = makeTestAutomation(store, [
    { id: 'asia', name: 'Asia', cities: ['beijing'], schedule: ['08:30', '16:00'], archives: [] },
  ]);
  const result = await automation.runOnce(new Date(u5moment(2026, 8, 31, 9, 0)));
  assert.strictEqual(result.saved.length, 0);
});

test('runOnce: no classification until the control archive appears', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const openMs = u5moment(2026, 8, 31, 8, 30);
  const automation = makeTestAutomation(store, [
    {
      id: 'asia',
      name: 'Asia',
      cities: ['beijing'],
      schedule: ['08:30', '16:00'],
      archives: [wd1Archive({ collectedAtMs: openMs, slot: '08:30' })],
    },
  ]);
  const result = await automation.runOnce(new Date(u5moment(2026, 8, 31, 9, 0)));
  assert.strictEqual(result.saved.length, 1);
  assert.strictEqual(result.classified.length, 0);
  assert.strictEqual(store.snapshots[0].category, '');
});

test('runOnce: initial avg pair missing (low clouds >= 50%) stays unclassified', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const automation = makeTestAutomation(store, [
    {
      id: 'asia',
      name: 'Asia',
      cities: ['beijing'],
      schedule: ['08:30', '16:00'],
      archives: [
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', max: 27.4, low: 60 }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', max: 27.9, low: 10, rates: { 27: 100 } }),
      ],
    },
  ]);
  const result = await automation.runOnce(new Date(u5moment(2026, 8, 31, 17, 0)));
  assert.strictEqual(result.classified.length, 0);
  assert.strictEqual(store.snapshots[0].category, '');
});

test('runOnce: control without rates for the pair stays unclassified', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const automation = makeTestAutomation(store, [
    {
      id: 'asia',
      name: 'Asia',
      cities: ['beijing'],
      schedule: ['08:30', '16:00'],
      archives: [
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', max: 27.4, low: 10 }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', max: 27.9, low: 10, rates: { 25: 100 } }),
      ],
    },
  ]);
  const result = await automation.runOnce(new Date(u5moment(2026, 8, 31, 17, 0)));
  assert.strictEqual(result.classified.length, 0);
  assert.strictEqual(store.snapshots[0].category, '');
});

test('runOnce: control without any model slots stays unclassified', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const automation = makeTestAutomation(store, [
    {
      id: 'asia',
      name: 'Asia',
      cities: ['beijing'],
      schedule: ['08:30', '16:00'],
      archives: [
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', max: 27.4, low: 10 }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', max: 27.9, low: 10, rates: { 27: 100 }, noSlots: true }),
      ],
    },
  ]);
  const result = await automation.runOnce(new Date(u5moment(2026, 8, 31, 17, 0)));
  assert.strictEqual(result.classified.length, 0);
  assert.strictEqual(store.snapshots[0].category, '');
});

test('runOnce: without token it is skipped', async () => {
  const store = fakeStore();
  const automation = createWd1Automation({
    archiveStore: store,
    CITIES,
    saveSnapshotForCity: fakeSave(store),
    token: '',
  });
  const result = await automation.runOnce();
  assert.strictEqual(result.ok, false);
  assert.match(result.skipped, /WD1_AI_TOKEN/);
});
