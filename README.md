# Weather Dashboard

Single-page weather dashboard with METAR observations, multi-model forecast comparison, automated model ranking, and per-city weather archive snapshots.

## Quick start

```bash
npm install
npm start
# Open http://localhost:3000
```

## Architecture

- `server.js` — Express server with API proxying and the archive scheduler
- `lib/` — Shared backend logic (Open-Meteo, city ranking, archive store)
- `assets/` — Frontend: CSS, JS dashboard
- `data/` — Station coordinates database, plus `data/archives/` for stored snapshots (gitignored)

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/forecast?station=&model=&date=` | Open-Meteo forecast proxy |
| `GET /api/metar?station=&hours=` | METAR observations |
| `GET /api/city-ranking` | City ranking (green/blue/yellow/red) |
| `GET /api/test-models` | Test model configuration |
| `POST /api/test-models` | Update test model configuration |
| `GET /api/archive/settings` | Archive settings for all cities |
| `POST /api/archive/settings` | Update archive settings for a city (`{cityId, enabled, time, model}`) |
| `GET /api/archive/snapshots` | List archived snapshots (optional `?city=`) |
| `GET /api/archive/snapshots/:id` | Fetch a single snapshot |
| `POST /api/archive/snapshots` | Store a manual snapshot |
| `DELETE /api/archive/snapshots/:id` | Delete a snapshot |

## Weather archive

Each city can be configured (via the gear settings panel) to automatically save a
weather snapshot once per day at a chosen local time. The server-side scheduler
runs on the VPS and works even when no browser tab is open. You can also save a
snapshot manually with the **Save** button and browse saved snapshots with the
**Archive** button — each opens with the same interface the graph shows at save
time. Snapshots are never modified after saving.

- Settings are per city: enable + local `HH:MM` time (+ optional forecast model).
- Each snapshot stores the full METAR observations plus the forecast rows for **every
  model available to that city** (the same list shown in the model dock), so the
  archive can be browsed and models switched offline.
- Data persists to `data/archives/` on the VPS (a Docker volume survives redeploys).
- Auto-save catches up if the configured time has already passed today.

## Environment variables

- `ARCHIVE_DATA_DIR` — optional directory for archive data (default `data/archives`)

## Deployment

Deployed on a VPS with Docker. `docker-compose.yml` mounts a volume so archive
data survives container rebuilds.
