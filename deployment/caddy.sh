#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=${CONTACT_GATEWAY_DIR:-/opt/contact-gateway}
cd "$ROOT"
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
DOMAIN=$(sed -n 's/^DOMAIN=//p' .env | head -1)
LOCAL_PORT=$(sed -n 's/^LOCAL_PORT=//p' .env | head -1)
[[ "$DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{2,252}$ && "$LOCAL_PORT" =~ ^[0-9]+$ ]] || exit 1
hook='import /data/contact-gateway/*.caddy'

detect() {
  local proxy='' network=''
  while IFS= read -r candidate; do
    if docker exec "$candidate" caddy version >/dev/null 2>&1; then proxy=$candidate; break; fi
  done < <(docker ps --filter publish=443 --format '{{.Names}}')
  if [[ -n "$proxy" ]]; then
    local networks
    networks=$(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$proxy")
    for candidate in $networks; do if [[ "$candidate" == *_edge || "$candidate" == edge ]]; then network=$candidate; break; fi; done
    if [[ -z "$network" ]]; then for candidate in $networks; do if [[ "$candidate" != bridge && "$candidate" != host ]]; then network=$candidate; break; fi; done; fi
    [[ "$proxy" =~ ^[A-Za-z0-9_.-]+$ && "$network" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo 'Could not identify the Caddy Docker network.' >&2; exit 1; }
    printf 'CADDY_MODE=container\nCADDY_CONTAINER=%s\nCADDY_NETWORK=%s\n' "$proxy" "$network" > .proxy-env
  elif command -v caddy >/dev/null && systemctl is-active --quiet caddy; then
    docker network inspect contact-gateway-edge >/dev/null 2>&1 || docker network create contact-gateway-edge >/dev/null
    printf 'CADDY_MODE=host\nCADDY_NETWORK=contact-gateway-edge\n' > .proxy-env
  else
    echo 'No active Caddy found. Start the existing Caddy on port 443, then retry.' >&2
    exit 1
  fi
  chmod 600 .proxy-env
  echo "Detected Caddy mode: $(sed -n 's/^CADDY_MODE=//p' .proxy-env)"
}

register_container() {
  local proxy=$CADDY_CONTAINER config_host stage had_route=false changed_config=false
  stage=$(mktemp -d)
  docker exec "$proxy" wget -q -O /dev/null http://contact-gateway:8080/health
  docker cp "$proxy:/etc/caddy/Caddyfile" "$stage/original.Caddyfile"
  if docker exec "$proxy" test -f /data/contact-gateway/contact-gateway.caddy; then
    docker cp "$proxy:/data/contact-gateway/contact-gateway.caddy" "$stage/original.route"
    had_route=true
  fi
  printf '%s {\n    encode zstd gzip\n    reverse_proxy contact-gateway:8080\n}\n' "$DOMAIN" > "$stage/route"
  config_host=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{if eq .Type "bind"}}{{.Source}}{{end}}{{end}}{{end}}' "$proxy")
  docker exec "$proxy" mkdir -p /data/contact-gateway
  docker cp "$stage/route" "$proxy:/data/contact-gateway/contact-gateway.caddy"
  if ! grep -Fxq "$hook" "$stage/original.Caddyfile"; then
    changed_config=true
    if [[ -n "$config_host" ]]; then
      [[ -f "$config_host" && ! -L "$config_host" ]] || { echo 'Caddyfile bind mount is not a regular file.' >&2; exit 1; }
      printf '\n%s\n' "$hook" >> "$config_host"
    else
      cp "$stage/original.Caddyfile" "$stage/next.Caddyfile"
      printf '\n%s\n' "$hook" >> "$stage/next.Caddyfile"
      docker cp "$stage/next.Caddyfile" "$proxy:/etc/caddy/Caddyfile"
    fi
  fi
  if ! docker exec "$proxy" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || ! docker exec "$proxy" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    echo 'Caddy rejected the new route; restoring its previous configuration.' >&2
    if [[ "$changed_config" == true ]]; then
      if [[ -n "$config_host" ]]; then cat "$stage/original.Caddyfile" > "$config_host"; else docker cp "$stage/original.Caddyfile" "$proxy:/etc/caddy/Caddyfile"; fi
    fi
    if [[ "$had_route" == true ]]; then docker cp "$stage/original.route" "$proxy:/data/contact-gateway/contact-gateway.caddy"; else docker exec "$proxy" rm -f /data/contact-gateway/contact-gateway.caddy; fi
    docker exec "$proxy" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || true
    rm -rf "$stage"
    exit 1
  fi
  rm -rf "$stage"
}

register_host() {
  local stage route=/etc/caddy/contact-gateway/contact-gateway.caddy hook_host='import /etc/caddy/contact-gateway/*.caddy' had_route=false
  stage=$(mktemp -d)
  curl -fsS "http://127.0.0.1:$LOCAL_PORT/health" >/dev/null
  [[ -f /etc/caddy/Caddyfile && ! -L /etc/caddy/Caddyfile ]] || { echo 'Host Caddyfile is missing.' >&2; exit 1; }
  cp /etc/caddy/Caddyfile "$stage/original.Caddyfile"
  mkdir -p /etc/caddy/contact-gateway
  if [[ -f "$route" ]]; then cp "$route" "$stage/original.route"; had_route=true; fi
  printf '%s {\n    encode zstd gzip\n    reverse_proxy 127.0.0.1:%s\n}\n' "$DOMAIN" "$LOCAL_PORT" > "$route"
  if ! grep -Fxq "$hook_host" /etc/caddy/Caddyfile; then printf '\n%s\n' "$hook_host" >> /etc/caddy/Caddyfile; fi
  if ! caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile || ! systemctl reload caddy; then
    echo 'Caddy rejected the new route; restoring its previous configuration.' >&2
    cat "$stage/original.Caddyfile" > /etc/caddy/Caddyfile
    if [[ "$had_route" == true ]]; then cp "$stage/original.route" "$route"; else rm -f "$route"; fi
    systemctl reload caddy || true
    rm -rf "$stage"
    exit 1
  fi
  rm -rf "$stage"
}

case "${1:-}" in
  detect) detect ;;
  register)
    source .proxy-env
    if [[ "$CADDY_MODE" == container ]]; then register_container; elif [[ "$CADDY_MODE" == host ]]; then register_host; else exit 1; fi
    echo "Caddy route ready: https://$DOMAIN"
    ;;
  *) echo 'Usage: caddy.sh detect|register' >&2; exit 2 ;;
esac
