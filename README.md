# Weather Dashboard

Single-page weather dashboard with METAR observations, multi-model forecast comparison, and automated model ranking.

## Quick start

```bash
npm install
npm start
# Open http://localhost:3000
```

## Architecture

- `server.js` — Express dev server with API proxying
- `api/` — Vercel serverless functions (production deployment)
- `lib/` — Shared backend logic (Open-Meteo, weather bot, model ranking)
- `assets/` — Frontend: CSS, JS dashboard
- `data/` — Station coordinates database

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /api/forecast?station=&model=&date=` | Open-Meteo forecast proxy |
| `GET /api/metar?station=&hours=` | METAR observations |
| `GET /api/temperature?city=` | Model ranking results (API key required) |
| `GET /api/bot/weather?city=&date=` | Single-city bot response with city ranking and 3 model slots (v2.0) |
| `POST /api/bot/weather/batch` | Batch weather bot response |
| `GET /api/city-ranking` | City ranking (green/blue/yellow/red) |
| `GET /api/test-models` | Test model configuration |
| `POST /api/test-models` | Update test model configuration |

## Environment variables

- `API_SECRET` — required for `/api/temperature`
- `HTTPS_PROXY` / `https_proxy` — proxy for outbound requests

## Deployment

Configured for Vercel via `vercel.json`. Runs as Node.js serverless functions.
