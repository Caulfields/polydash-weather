# WD1 automation — how this app mirrors the Weather Dashboard Archives

Written for AI agents working on this repo. Read this before touching
`lib/wd1-automation.js`, `lib/archive.js` or the archive routes in `server.js`.

## The two systems

| Name | URL | Repo | What it is |
|------|-----|------|------------|
| **wd1** ("Weather Dashboard") | `http://31.76.245.86:3000` | `Caulfields/auto-table` | Collects forecast + Polymarket rates for city chunks. Its AI contract: `GET /llms.txt`, `GET /PROJECT.md`. |
| **wd2** (this app, "polydash-weather") | `http://31.76.245.86:3001` | `Caulfields/polydash-weather` | Per-city forecast dashboards with a snapshot archive (`lib/archive.js`). |

The automation makes wd2 **mirror wd1's Archives**: when wd1 collects the first
data of a city's market day, wd2 saves its own forecast snapshot for that
city-day; when wd1 collects the day's **control slot**, wd2 classifies the
snapshot **green** (the predicted temperature pair matched) or **red** (it
didn't).

## wd1 data model (what the automation consumes)

`GET /api/config/chunks` (Bearer `WD1_AI_TOKEN` → wd1's `AI_TOKEN` env; GET is
read-only) returns chunk configs with full archives (~2.8 MB):

```
chunk: { id, name: "Asia"|"Europe"|"Others",
         schedule: ["08:30", "11:30", "16:00"],   // UTC+5
         dayStartHour, dayEndHour,                // market-day boundary
         cities: ["beijing", ...],                // wd1 city keys, lowercase
         archives: [...] }
archive: { date: "DD/MM",        // UTC+5 calendar date of collection
           marketDate: "DD/MM",  // logical market day (recent archives only)
           timestamp, slot,      // "HH:MM"
           collectedAt,          // epoch ms — the only reliable ordering
           results: [ { station: "ZBAA", cityName: "Beijing",
                        slots: [ { slot: "basic"|"additional"|"test",
                                   modelKey: "auto"|..., todayMax,
                                   ratesPct: { "27": 49.5, ... } } ] } ] }
```

- `ratesPct` maps temperature threshold → Polymarket YES rate (%). The
  thresholds are a pair of consecutive integers starting at
  `roundHalfDown(todayMax)` of the `basic`/`auto` slot (wd1's
  `RATES_RULES.txt`: 25.5 → 25, 29.8 → 30, 24.3 → 24).
- **Control slot** = the LAST scheduled slot of the chunk's day
  (Asia 16:00, Europe 22:00, Others 03:22 UTC+5 — read from `schedule`, never hardcode).
- **Boundary chunk** (Others: `dayStart 6`, `dayEnd 3`): the market day OPENS
  with the 18:32 UTC+5 slot (that is morning in São Paulo) and CLOSES with the
  03:22 UTC+5 slot of the next UTC+5 calendar day. Grouping archives by
  `marketDate` handles this; no date arithmetic is needed — for all current
  chunks the city-local date at slot times equals the market date.
- **Manual refreshes** in wd1 are stamped with their own time (`10:42`) instead
  of the scheduled slot. Therefore: never match by slot label, order by
  `collectedAt`.

## Rules (owner-confirmed, 01.09.2026)

The classifier compares **temperature pairs**, not Polymarket rates:

- **Position** (what was predicted): the `basic`/`auto` slot's `todayMax` of
  the day's FIRST collection, rounded half-down → an integer temperature
  (e.g. 23.1 → "23, 24").
- **Save**: when wd1 has ANY collection for the current market day of a chunk,
  every city with `settings.auto === true` gets one snapshot per city-day
  (`dateKey` = market day, dedup by `dateKey`).
- **Classify** (once the control archive exists): round the `basic`/`auto`
  `todayMax` of the control collection the same way and compare:
  - equal to the initial pair → `category: "green"` (предсказатель совпал)
  - different → `category: "red"`
  - missing basic temperature in the initial or control collection → the
    snapshot stays `""` and is not retried (in-memory guard set).
- Classification only touches snapshots whose `dateKey` is **today or
  yesterday** (city-local). Older unclassified snapshots are never rewritten.

## Runtime behaviour

- `ensureAutoSettings()` runs once on boot: for every city currently in wd1
  chunks without an explicit `auto` field it sets
  `patchSettings({ enabled: true, time: "00:00", auto: true })`.
  `time: "00:00"` is a marker — the legacy wall-clock scheduler skips
  `auto: true` cities. A city the user disabled (`auto: false`) is **never
  re-enabled**.
- `wd1AutomationCycle()` runs every 30 s (`SCHEDULE_INTERVAL_MS`):
  fetch chunks (cached 5 min) → SAVE pass → CLASSIFY pass.
  Without `WD1_AI_TOKEN` the cycle is a no-op (logged once per restart).
- Chunk fetch: `WD1_BASE_URL` (default `http://host.docker.internal:3000`;
  docker-compose adds `extra_hosts: host.docker.internal:host-gateway` so the
  container reaches wd1 on the same host). Token goes to the VPS `.env`:
  `WD1_AI_TOKEN=<AI_TOKEN value from wd1>`.
- Snapshots persist in the `archive-data` volume; settings in
  `data/archives/settings.json`.

## Interaction with the UI / user edits

- Auto-saved snapshots look exactly like manual ones in the archive panel.
- The user can re-tag 🟢/🔴 any snapshot — automation only considers snapshots
  with `category === ""`, so explicit categories (manual or automatic) are
  never overwritten. Clearing a tag hands the snapshot back to the automation
  while it is within the today/yesterday window.
- `PATCH /api/archive/settings` (partial update, `patchSettings`) exists for
  the bootstrap; `POST` still replaces the whole per-city object (the UI uses
  it and preserves `auto`).

## Code map

| File | Role |
|------|------|
| `lib/wd1-automation.js` | All automation logic, pure + injectable (`wd1Fetch`, `log`), unit-tested |
| `server.js` | Wiring: `saveSnapshotForCity`, both schedulers, `PATCH /api/archive/settings` |
| `lib/archive.js` | Snapshot store: `patchSettings`, `auto` flag, mtime-cached `listSnapshots` |
| `test/unit/wd1-automation.test.js` | 19 tests: schedule/position/control/grouping/runOnce flows |

Constants to know: `CHUNKS_CACHE_MS = 5 min`, `CONTROL_FALLBACK_GRACE_MS = 15
min` (an archive collected at/after control-moment-minus-grace with a basic
temperature counts as control if the scheduled closer slot was not collected),
`SKEW_TOLERANCE_MS = 15 min`.
