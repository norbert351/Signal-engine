#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  echo "Missing .env. Copy .env.example and set strong secrets first." >&2
  exit 1
fi

docker compose build
docker compose up -d --remove-orphans
docker compose ps

PORT="$(sed -n 's/^API_PORT=//p' .env | tail -1)"
PORT="${PORT:-4400}"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null; then
    echo "API healthy on http://127.0.0.1:${PORT}/api/v1/health"
    exit 0
  fi
  sleep 2
done

echo "API did not become healthy in time. Inspect: docker compose logs api" >&2
exit 1
