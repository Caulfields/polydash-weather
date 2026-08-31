const { test } = require('node:test');
const assert = require('node:assert');
const CITIES = require('../../assets/js/dashboard/config').CITIES;
const {
  AUTO_SAVE_TIME,
  controlArchive,
  controlRateOn,
  createWd1Automation,
  ensureAutoSettings,
  makeSchedule,
  marketDayGroups,
  positionFromArchive,
  positionFromGroup,
  slotArchive,
  wd1CityId,
} = require('../../lib/wd1-automation');

const U5 = 5 * 3600 * 1000;
const pad2 = (v) => String(v).padStart(2, '0');
const ddMm = (ms) => {
  const u = new Date(ms + U5);
  return `${pad2(u.getUTCDate())}/${pad2(u.getUTCMonth() + 1)}`;
};

function ratesFor(threshold, rate) {
  return { [String(threshold - 1)]: 0.05, [String(threshold)]: rate, [String(threshold + 1)]: 0.05 };
}

function wd1Archive({ collectedAtMs, slot, marketDateKey, rates, station = 'ZBAA', cityName = 'Beijing' }) {
  return {
    id: `arch_${collectedAtMs}`,
    date: ddMm(collectedAtMs),
    marketDate: marketDateKey ? ddMm(marketDateKey) : undefined,
    timestamp: slot,
    slot,
    collectedAt: collectedAtMs,
    results: [
      {
        station,
        cityName,
        slots: [
          { slot: 'basic', modelKey: 'auto', todayMax: 27.4, ratesPct: rates },
          { slot: 'additional', modelKey: 'ecmwf_ifs', todayMax: 26.8, ratesPct: rates },
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

test('bestThreshold / positionFromArchive: argmax of basic rates', () => {
  const archive = wd1Archive({ collectedAtMs: 0, slot: '08:30', rates: { 26: 12, 27: 49.5, 28: 3 } });
  const pos = positionFromArchive(archive, CITIES.beijing);
  assert.deepStrictEqual(pos, { threshold: 27, rate: 49.5 });
});

test('positionFromArchive: no position when max rate <= 10%', () => {
  const archive = wd1Archive({ collectedAtMs: 0, slot: '08:30', rates: { 26: 5, 27: 10 } });
  assert.strictEqual(positionFromArchive(archive, CITIES.beijing), null);
});

test('positionFromArchive: manual refresh without rates falls through to scheduled slot', () => {
  const noRates = wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 40), slot: '08:30', rates: null });
  noRates.results[0].slots[0].ratesPct = null;
  const withRates = wd1Archive({
    collectedAtMs: u5moment(2026, 8, 31, 8, 30),
    slot: '08:30',
    rates: ratesFor(27, 61),
  });
  const pos = positionFromGroup([noRates, withRates], CITIES.beijing);
  assert.deepStrictEqual(pos, { threshold: 27, rate: 61 });
});

test('controlRateOn: reads threshold as string or number key', () => {
  assert.strictEqual(controlRateOn({ 27: 99.85 }, 27), 99.85);
  assert.strictEqual(controlRateOn({ 27: 0.05 }, 28), null);
});

// ------------------------------------------------------------- control slot

test('controlArchive: exact closer slot wins', () => {
  const day = {
    dateKey: '2026-08-31',
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', rates: ratesFor(27, 61) }),
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', rates: ratesFor(27, 99.9) }),
    ],
  };
  const s = makeSchedule({ schedule: ['08:30', '16:00'] });
  const control = controlArchive(day, s, CITIES.beijing);
  assert.strictEqual(control.slot, '16:00');
});

test('controlArchive: falls back to a late collection with rates', () => {
  const closerMs = u5moment(2026, 8, 31, 16, 0);
  const day = {
    dateKey: '2026-08-31',
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', rates: ratesFor(27, 61) }),
      wd1Archive({ collectedAtMs: closerMs + 10 * 60_000, slot: '16:12', rates: ratesFor(27, 99.9) }),
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
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', rates: ratesFor(27, 61) }),
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 11, 30), slot: '11:30', rates: ratesFor(27, 99.9) }),
    ],
  };
  const s = makeSchedule({ schedule: ['08:30', '11:30', '16:00'] });
  assert.strictEqual(controlArchive(day, s, CITIES.beijing), null);
});

// --------------------------------------------------------------- grouping

test('marketDayGroups: groups by marketDate with year, Others boundary included', () => {
  const chunk = {
    archives: [
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 30, 18, 32), slot: '18:32', marketDateKey: u5moment(2026, 8, 30, 12, 0), rates: ratesFor(30, 40) }),
      wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 3, 22), slot: '03:22', marketDateKey: u5moment(2026, 8, 30, 12, 0), rates: ratesFor(30, 99) }),
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

function asiaWd1Data({ controlRate, openerRates }) {
  const openMs = u5moment(2026, 8, 31, 8, 30);
  const ctrlMs = u5moment(2026, 8, 31, 16, 0);
  return [
    {
      ...ASIA_CHUNK,
      archives: [
        wd1Archive({ collectedAtMs: openMs, slot: '08:30', marketDateKey: openMs, rates: openerRates }),
        wd1Archive({ collectedAtMs: ctrlMs, slot: '16:00', marketDateKey: ctrlMs, rates: ratesFor(27, controlRate) }),
      ],
    },
  ];
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

test('runOnce: saves on opener and classifies green/red/edge, no duplicates', async () => {
  // three cities, three outcomes
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
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', rates: ratesFor(27, 61) }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', rates: ratesFor(27, 99.9) }),
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
          rates: ratesFor(23, 48.5),
          station: 'LFPB',
          cityName: 'Paris',
        }),
        wd1Archive({
          collectedAtMs: u5moment(2026, 8, 31, 22, 0),
          slot: '22:00',
          rates: ratesFor(23, 0.05),
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
          rates: ratesFor(30, 37),
          station: 'SBGR',
          cityName: 'Sao Paulo',
        }),
        wd1Archive({
          collectedAtMs: u5moment(2026, 8, 31, 3, 22),
          slot: '03:22',
          marketDateKey: u5moment(2026, 8, 30, 12, 0),
          rates: ratesFor(30, 42),
          station: 'SBGR',
          cityName: 'Sao Paulo',
        }),
      ],
    },
  ];
  const automation = makeTestAutomation(store, chunks);
  const result = await automation.runOnce(now);

  // beijing green, paris red, sao paulo edge (45% is between 5 and 95)
  assert.strictEqual(result.saved.length, 3);
  assert.deepStrictEqual(result.classified, [
    { cityId: 'beijing', dateKey: '2026-08-31', category: 'green', threshold: 27, rate: 99.9 },
    { cityId: 'paris', dateKey: '2026-08-31', category: 'red', threshold: 23, rate: 0.05 },
    { cityId: 'saopaulo', dateKey: '2026-08-30', category: '', threshold: 30, rate: 42 },
  ]);

  // second run: no duplicates, no re-classification
  const again = await automation.runOnce(now);
  assert.strictEqual(again.saved.length, 0);
  assert.strictEqual(again.classified.length, 0);
  assert.strictEqual(store.snapshots.length, 3);
});

test('runOnce: no save before the opener slot', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const automation = makeTestAutomation(store, asiaWd1Data({ controlRate: 99.9, openerRates: ratesFor(27, 61) }));
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
    { ...ASIA_CHUNK, archives: [wd1Archive({ collectedAtMs: openMs, slot: '08:30', rates: ratesFor(27, 61) })] },
  ]);
  const result = await automation.runOnce(new Date(u5moment(2026, 8, 31, 9, 0)));
  assert.strictEqual(result.saved.length, 1);
  assert.strictEqual(result.classified.length, 0);
  assert.strictEqual(store.snapshots[0].category, '');
});

test('runOnce: position-less initial snapshot stays unclassified', async () => {
  const store = fakeStore();
  await store.patchSettings('beijing', { auto: true });
  const automation = makeTestAutomation(store, [
    {
      ...ASIA_CHUNK,
      archives: [
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 8, 30), slot: '08:30', rates: { 26: 5, 27: 8 } }),
        wd1Archive({ collectedAtMs: u5moment(2026, 8, 31, 16, 0), slot: '16:00', rates: ratesFor(27, 99.9) }),
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
