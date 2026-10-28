#!/usr/bin/env bash
set -euo pipefail
umask 077
ROOT=${CONTACT_GATEWAY_DIR:-/opt/contact-gateway}
[[ $(id -u) == 0 && -f "$ROOT/.github-token" ]] || { echo 'Run install.sh first with sudo.' >&2; exit 1; }
exec bash "$ROOT/deploy.sh"
