#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=${CONTACT_GATEWAY_DIR:-/opt/contact-gateway}
REPO=RusAbk/contact-gateway
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ "$ROOT" == /* && "$ROOT" != / && "$ROOT" != /opt ]] || { echo 'Invalid installation directory.' >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'The image supports x86-64 servers.' >&2; exit 1; }
if ! command -v curl >/dev/null || ! command -v python3 >/dev/null || ! command -v openssl >/dev/null || ! command -v flock >/dev/null; then
  apt-get update
  apt-get install -y curl ca-certificates python3 openssl util-linux
fi
mkdir -p "$ROOT"
chmod 700 "$ROOT"
if [[ ! -f "$ROOT/.github-token" ]]; then
  if [[ -z "${GH_TOKEN:-}" ]]; then read -rsp 'GitHub token (repo + read:packages): ' GH_TOKEN; echo; fi
  [[ -n "${GH_TOKEN:-}" ]] || { echo 'A GitHub token is required.' >&2; exit 1; }
  printf '%s' "$GH_TOKEN" > "$ROOT/.github-token"
  chmod 600 "$ROOT/.github-token"
fi
GH_TOKEN=$(<"$ROOT/.github-token")
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  . /etc/os-release
  [[ "$ID" == debian || "$ID" == ubuntu ]] || { echo 'Automatic Docker installation supports Debian and Ubuntu.' >&2; exit 1; }
  docker_installer=$(mktemp)
  curl -fsSL --proto '=https' --tlsv1.2 https://get.docker.com -o "$docker_installer"
  sh "$docker_installer"
  rm -f "$docker_installer"
fi
systemctl enable --now docker
if [[ ! -f "$ROOT/.github-user" ]]; then
  curl -fsSL --proto '=https' --tlsv1.2 -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github+json' https://api.github.com/user | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])' > "$ROOT/.github-user"
fi
if [[ ! -f "$ROOT/.env" ]]; then
  read -rp 'Domain for contact page (for example contact.example.com): ' DOMAIN
  [[ "$DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{2,252}$ && "$DOMAIN" == *.* ]] || { echo 'Invalid domain.' >&2; exit 1; }
  read -rsp 'Telegram bot token: ' BOT_TOKEN; echo
  [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || { echo 'Invalid bot token.' >&2; exit 1; }
  read -rp 'Telegram chat ID (number or @name): ' BOT_CHAT_ID
  [[ "$BOT_CHAT_ID" =~ ^-?[0-9]+$ || "$BOT_CHAT_ID" =~ ^@[A-Za-z0-9_]{5,32}$ ]] || { echo 'Invalid chat ID.' >&2; exit 1; }
  read -rsp 'Admin password (at least 12 characters): ' ADMIN_PASSWORD; echo
  read -rsp 'Repeat admin password: ' ADMIN_PASSWORD_CONFIRM; echo
  [[ ${#ADMIN_PASSWORD} -ge 12 && "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD_CONFIRM" ]] || { echo 'Passwords do not match or are too short.' >&2; exit 1; }
  ADMIN_PASSWORD_HASH=$(printf '%s' "$ADMIN_PASSWORD" | docker run --rm -i --network none node:24-bookworm-slim node -e 'const {randomBytes,scryptSync}=require("node:crypto");const fs=require("node:fs");const s=randomBytes(16).toString("hex");const p=fs.readFileSync(0,"utf8");process.stdout.write(s+":"+scryptSync(p,Buffer.from(s,"hex"),64).toString("hex"))')
  unset ADMIN_PASSWORD ADMIN_PASSWORD_CONFIRM
  SESSION_SECRET=$(openssl rand -hex 32)
  LOCAL_PORT=$(python3 -c 'import socket
for port in range(38080,38120):
 s=socket.socket();
 try: s.bind(("127.0.0.1",port)); print(port); break
 except OSError: pass
 finally: s.close()')
  [[ -n "$LOCAL_PORT" ]] || { echo 'No free local port found.' >&2; exit 1; }
  cat > "$ROOT/.env" <<EOF
DOMAIN=$DOMAIN
PUBLIC_ORIGIN=https://$DOMAIN
BOT_TOKEN=$BOT_TOKEN
BOT_CHAT_ID=$BOT_CHAT_ID
ADMIN_PASSWORD_HASH=$ADMIN_PASSWORD_HASH
SESSION_SECRET=$SESSION_SECRET
LOCAL_PORT=$LOCAL_PORT
PORT=8080
NODE_ENV=production
EOF
  chmod 600 "$ROOT/.env"
  mkdir -p "$ROOT/data"
  chown 1000:1000 "$ROOT/data"
  chmod 700 "$ROOT/data"
fi
curl -fsSL --proto '=https' --tlsv1.2 -H "Authorization: Bearer $GH_TOKEN" -H 'Accept: application/vnd.github.raw+json' "https://api.github.com/repos/$REPO/contents/deployment/deploy.sh?ref=main" -o "$ROOT/deploy.sh"
chmod 700 "$ROOT/deploy.sh"
exec bash "$ROOT/deploy.sh"
