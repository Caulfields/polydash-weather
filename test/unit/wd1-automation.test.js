const { test } = require('node:test');
const assert = require('node:assert');
const CITIES = require('../../assets/js/dashboard/config').CITIES;
const {
  AUTO_SAVE_TIME,
  controlArchive,
  createWd1Automation,
  ensureAutoSettings,
  initialArchive,
  makeSchedule,
  marketDayGroups,
  positionFromArchive,
  slotArchive,
  wd1CityId,
} = require('../../lib/wd1-automation');

const U5 = 5 * 3600 * 1000;
const pad2 = (v) => String(v).padStart(2, '0');
const ddMm = (ms) => {
  const u = new Date(ms + U5);
  return `${pad2(u.getUTCDate())}/${pad2(u.getUTCMonth() + 1)}`;
};

function wd1Archive({
  collectedAtMs,
  slot,
  marketDateKey,
  basicTodayMax = 27.4,
  station = 'ZBAA',
  cityName = 'Beijing',
  noBasic = false,
}) {
  return {
    id: `arch_${collectedAtMs}_${slot}`,
    date: ddMm(collectedAtMs),
    marketDate: marketDateKey ? ddMm(marketDateKey) : undefined,
    timestamp: slot,
    slot,
    collectedAt: collectedAtMs,
    results: [
      {
        station,
        cityName,
        slots: noBasic
          ? []
          : [
              { slot: 'basic', modelKey: 'auto', todayMax: basicTodayMax },
              { slot: 'additional', modelKey: 'ecmwf_ifs', todayMax: basicTodayMax + 0.3 },
            ],
      },
    ],
  };
}

const u5moment = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh, mm) - U5;

// ---------------------------------------------------------------- schedule

test('makeSchedule: plain chunk opener/closer', () => {
  const s = makeSchedule({ schedule: ['11:30', '08:30', '16:00'] });
  assert.strictEqual(s.opener.label, '08:30');
  assert.strictEqual(s.closer.label, '16:00');
  assert.strictEqual(s.boundary, false);
});

test('makeSchedule: Others boundary chunk (dayStart 6, dayEnd 3)', () => {
  const s = makeSchedule({ schedule: ['03:22', '18:32'], dayStartHour: 6, dayEndHour: 3 });
  assert.strictEqual(s.boundary, true);
  assert.strictEqual(s.opener.label, '18:32'); // opens the market day (morning in Sao Paulo)
  assert.strictEqual(s.closer.label, '03:22'); // next UTC+5 calendar day
});

// ---------------------------------------------------------------- position

test('positionFromArchive: roundHalfDown of the basic todayMax', () => {
  const mk = (t) => wd1Archive({ collectedAtMs: 0, slot: '08:30', basicTodayMax: t });
  // wd1 RATES_RULES examples: 29.8 -> 30, 24.3 -> 24, 25.5 -> 25 (half DOWN)
  assert.strictEqual(positionFromArchive(mk(29.8), CITIES.beijing), 30);
  assert.strictEqual(positionFromArchive(mk(24.3), CITIES.beijing), 24);
  assert.strictEqual(positionFromArchive(mk(25.5), CITIES.beijing), 25);
  const paris = wd1Archive({ collectedAtMs: 0, slot: '13:40', basicTodayMax: 23.1, station: 'LFPB', cityName: 'Paris' });
  assert.strictEqual(positionFromArchive(paris, CITIES.paris), 23);
});

test('positionFromArchive: no basic temperature -> null', () => {
  assert.strictEqual(positionFromArchive(wd1Archive({ collectedAtMs: 0, slot: '08:30', noBasic: true }), CITIES.beijing), null);
  assert.strictEqual(positionFromArchive(null, CITIES.beijing), null);
});

test('initialArchive: earliest collection of the day wins (manual refreshes included)', () => {
  const day = {
    dateKey: '2026-08-31',
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 10, 42), slot: '10:42', basicTodayMax: 23.2, station: 'LFPB', cityName: 'Paris' }),
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', basicTodayMax: 23.1, station: 'LFPB', cityName: 'Paris' }),
    ],
  };
  assert.strictEqual(initialArchive(day).slot, '08:30');
  assert.strictEqual(positionFromArchive(initialArchive(day), CITIES.paris), 23);
});

// ------------------------------------------------------------- control slot

test('controlArchive: exact closer slot wins', () => {
  const day = {
    dateKey: '2026-08-31',
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30' }),
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00' }),
    ],
  };
  const s = makeSchedule({ schedule: ['08:30', '16:00'] });
  const control = controlArchive(day, s, CITIES.beijing);
  assert.strictEqual(control.slot, '16:00');
});

test('controlArchive: falls back to a late collection with basic temperature', () => {
  const closerMs = u5moment(2026, 8, 31, 16, 0);
  const day = {
    dateKey: '2026-08-31',
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30' }),
      wd1Archive({ collectedAtMs: closerMs + 10 * 60_000, slot: '16:12' }),
    ],
  };
  const s = makeSchedule({ schedule: ['08:30', '16:00'] });
  const control = controlArchive(day, s, CITIES.beijing);
  assert.strictEqual(control.slot, '16:12');
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

// --------------------------------------------------------------- grouping

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

// -------------------------------------------------------- ensureAutoSettings

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
  const logLines = [];
  let changed = await ensureAutoSettings({ archiveStore: store, CITIES, log: (m) => logLines.push(m) });
  assert.strictEqual(changed, 26); // 27 wd1 cities, seoul already had settings
  assert.strictEqual(store.settings.paris.auto, true);
  assert.strictEqual(store.settings.saopaulo.auto, true);
  assert.strictEqual(store.settings.paris.enabled, true);
  assert.strictEqual(store.settings.paris.time, AUTO_SAVE_TIME);

  // a city the user turned off stays off
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

const ASIA_CHUNK = {
  id: 'asia',
  name: 'Asia',
  cities: ['beijing'],
  schedule: ['08:30', '11:30', '16:00'],
};

function makeTestAutomation(store, wd1Chunks, { token = 'test-token' } = {}) {
  return createWd1Automation({
    archiveStore: store,
    CITIES,
    saveSnapshotForCity: fakeSave(store),
    token,
    wd1Fetch: async () => wd1Chunks,
  });
}

test('runOnce: saves on first collection and classifies by temperature pair, no duplicates', async () => {
  // three cities, three outcomes: beijing green (pair matched), paris red
  // (23 vs 25), sao paulo green across the boundary day (18:32 -> 03:22)
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
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', basicTodayMax: 28.7 }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', basicTodayMax: 28.7 }),
      ],
    },
    {
      id: 'europe',
      name: 'Europe',
      cities: ['paris'],
      schedule: ['13:40', '22:00'],
      archives: [
        wd1Archive({
          collectedAtMs: u5moment(2026, 8, 31, 13, 40),
          slot: '13:40',
          basicTodayMax: 23.1,
          station: 'LFPB',
          cityName: 'Paris',
        }),
        wd1Archive({
          collectedAtMs: u5moment(2026, 8, 31, 22, 0),
          slot: '22:00',
          basicTodayMax: 24.6,
          station: 'LFPB',
          cityName: 'Paris',
        }),
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
        wd1Archive({
          collectedAtMs: u5moment(2026, 8, 30, 18, 32),
          slot: '18:32',
          marketDateKey: u5moment(2026, 8, 30, 12, 0),
          basicTodayMax: 26.4,
          station: 'SBGR',
          cityName: 'Sao Paulo',
        }),
        wd1Archive({
          collectedAtMs: u5moment(2026, 8, 31, 3, 22),
          slot: '03:22',
          marketDateKey: u5moment(2026, 8, 30, 12, 0),
          basicTodayMax: 26.4,
          station: 'SBGR',
          cityName: 'Sao Paulo',
        }),
      ],
    },
  ];
  const automation = makeTestAutomation(store, chunks);
  const result = await automation.runOnce(now);

  assert.strictEqual(result.saved.length, 3);
  assert.deepStrictEqual(result.classified, [
    { cityId: 'beijing', dateKey: '2026-08-31', category: 'green', initialTemp: 29, controlTemp: 29 },
    { cityId: 'paris', dateKey: '2026-08-31', category: 'red', initialTemp: 23, controlTemp: 25 },
    { cityId: 'saopaulo', dateKey: '2026-08-30', category: 'green', initialTemp: 26, controlTemp: 26 },
  ]);
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
      ...ASIA_CHUNK,
      archives: [wd1Archive({ collectedAtMs: openMs, slot: '08:30', basicTodayMax: 28.7 })],
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
  const automation = makeTestAutomation(store, [{ ...ASIA_CHUNK, archives: [] }]);
  const now = new Date(u5moment(2026, 8, 31, 9, 0));
  const result = await automation.runOnce(now);
  assert.strictEqual(result.saved.length, 0);
});

test('runOnce: no classification until the control archive appears', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const openMs = u5moment(2026, 8, 31, 8, 30);
  const automation = makeTestAutomation(store, [
    { ...ASIA_CHUNK, archives: [wd1Archive({ collectedAtMs: openMs, slot: '08:30', basicTodayMax: 28.7 })] },
  ]);
  const result = await automation.runOnce(new Date(u5moment(2026, 8, 31, 9, 0)));
  assert.strictEqual(result.saved.length, 1);
  assert.strictEqual(result.classified.length, 0);
  assert.strictEqual(store.snapshots[0].category, '');
});

test('runOnce: initial collection without basic temperature stays unclassified', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const automation = makeTestAutomation(store, [
    {
      ...ASIA_CHUNK,
      archives: [
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', noBasic: true }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', basicTodayMax: 28.7 }),
      ],
    },
  ]);
  const result = await automation.runOnce(new Date(u5moment(2026, 8, 31, 17, 0)));
  assert.strictEqual(result.classified.length, 0);
  assert.strictEqual(store.snapshots[0].category, '');
});

test('runOnce: control collection without basic temperature stays unclassified', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const automation = makeTestAutomation(store, [
    {
      ...ASIA_CHUNK,
      archives: [
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', basicTodayMax: 28.7 }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', noBasic: true }),
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
