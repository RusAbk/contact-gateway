#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=${CONTACT_GATEWAY_DIR:-/opt/contact-gateway}
REPO=RusAbk/contact-gateway
cd "$ROOT"
[[ $(id -u) == 0 && -f .env && -f .github-token ]] || { echo 'Run install.sh first.' >&2; exit 1; }
exec 9> "$ROOT/.deploy.lock"
flock -n 9 || { echo 'Another contact-gateway deployment is running.' >&2; exit 1; }
GH_TOKEN=$(<.github-token)
export DOCKER_CONFIG="$ROOT/.docker-auth"
mkdir -p "$DOCKER_CONFIG" data backups
chmod 700 "$DOCKER_CONFIG" data backups
chown 1000:1000 data
github_api() { curl -fsSL --proto '=https' --tlsv1.2 -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github+json' "$1"; }
download() { curl -fsSL --proto '=https' --tlsv1.2 -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github.raw+json' "https://api.github.com/repos/$REPO/contents/deployment/$1?ref=$sha" -o "$2"; }
sha=$(github_api "https://api.github.com/repos/$REPO/commits/main" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Could not resolve the latest commit.' >&2; exit 1; }
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
for file in compose.yaml caddy.sh update.sh deploy.sh; do download "$file" "$stage/$file"; done
bash -n "$stage/caddy.sh" "$stage/update.sh" "$stage/deploy.sh"
cp "$stage/caddy.sh" "$ROOT/caddy.sh"
bash "$ROOT/caddy.sh" detect
source "$ROOT/.proxy-env"
image="ghcr.io/rusabk/contact-gateway:sha-$sha"
printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$(<.github-user)" --password-stdin >/dev/null
echo "Waiting for GitHub Actions image $image"
ready=false
for attempt in $(seq 1 40); do
  if docker pull "$image" >/dev/null 2>&1; then ready=true; break; fi
  sleep 15
done
[[ "$ready" == true ]] || { echo 'The image is not published yet. Re-run update.sh after GitHub Actions finishes.' >&2; exit 1; }
backup="$ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$backup"
cp .env "$backup/.env"
if [[ -f compose.yaml ]]; then cp compose.yaml "$backup/compose.yaml"; fi
python3 - "$image" "$CADDY_NETWORK" <<'PY'
import pathlib, sys
path = pathlib.Path('.env')
values = {'IMAGE': sys.argv[1], 'CADDY_NETWORK': sys.argv[2]}
lines = [line for line in path.read_text().splitlines() if line.split('=', 1)[0] not in values]
path.write_text('\n'.join([*lines, *(f'{key}={value}' for key, value in values.items())]) + '\n')
path.chmod(0o600)
PY
cp "$stage/compose.yaml" "$ROOT/compose.yaml"
if ! docker compose --env-file .env -f compose.yaml up -d --pull never; then
  cp "$backup/.env" .env
  if [[ -f "$backup/compose.yaml" ]]; then cp "$backup/compose.yaml" compose.yaml; docker compose --env-file .env -f compose.yaml up -d --pull never || true; fi
  exit 1
fi
healthy=false
for attempt in $(seq 1 30); do
  if [[ $(docker inspect --format '{{.State.Health.Status}}' contact-gateway-app-1 2>/dev/null || true) == healthy ]]; then healthy=true; break; fi
  sleep 2
done
if [[ "$healthy" != true ]] || ! bash "$ROOT/caddy.sh" register; then
  echo 'Deployment health check or Caddy registration failed.' >&2
  cp "$backup/.env" .env
  if [[ -f "$backup/compose.yaml" ]]; then cp "$backup/compose.yaml" compose.yaml; docker compose --env-file .env -f compose.yaml up -d --pull never || true; fi
  exit 1
fi
cp "$stage/update.sh" "$ROOT/update.sh"
cp "$stage/deploy.sh" "$ROOT/deploy.sh"
chmod 700 "$ROOT/update.sh" "$ROOT/deploy.sh" "$ROOT/caddy.sh"
echo "Contact gateway deployed: https://$(sed -n 's/^DOMAIN=//p' .env | head -1)"
echo "For updates: sudo bash $ROOT/update.sh"
