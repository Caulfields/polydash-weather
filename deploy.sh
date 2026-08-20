#!/usr/bin/env bash
# Auto-deploy helper: pull latest main from GitHub and rebuild the container.
# Runs on the VPS via polydash-weather-updater.timer (systemd), every 2 minutes.
set -euo pipefail
cd "$(dirname "$0")"

git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[$(date -Is)] no update ($LOCAL)"
  exit 0
fi

echo "[$(date -Is)] updating $LOCAL -> $REMOTE"
git reset --hard origin/main
docker compose up -d --build --remove-orphans
docker image prune -f --filter "dangling=true" >/dev/null 2>&1 || true
echo "[$(date -Is)] deployed $REMOTE"
