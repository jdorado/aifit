#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(dirname "$APP_DIR")"
API_DIR="$APP_DIR/api"
WEB_DIR="$APP_DIR/web"
PRIVATE_DEPLOY_DIR="$ROOT_DIR/aifit-private/deploy"
COMPOSE_FILE="$PRIVATE_DEPLOY_DIR/compose.local.yml"
API_ENV_FILE="${AIFIT_API_ENV_FILE:-$PRIVATE_DEPLOY_DIR/api.env}"
WEB_ENV_FILE="${AIFIT_WEB_ENV_FILE:-$PRIVATE_DEPLOY_DIR/web.env}"
export PNPM_HOME="${PNPM_HOME:-$HOME/Library/pnpm}"
export PATH="$PNPM_HOME:$PATH"
# Agent QA needs the standard local Ez relay: /chat/models and the Telegram
# admission bridge both call the deployment bound in the binding registry
# (see DEV_INDEX). Start it by default so `yarn dev` is QA-ready; set
# AIFIT_WITH_RELAY=0 for API + app only.
AIFIT_WITH_RELAY="${AIFIT_WITH_RELAY:-1}"

if [ -z "${AIFIT_EZ_STATE_DIR:-}" ] && [ -f "$PRIVATE_DEPLOY_DIR/.env.local" ]; then
  # Local credentials and runtime state live outside the checkout.
  set -a
  # shellcheck disable=SC1091
  source "$PRIVATE_DEPLOY_DIR/.env.local"
  set +a
fi

if [ -z "${AIFIT_EZ_STATE_DIR:-}" ]; then
  echo "AIFIT_EZ_STATE_DIR must point to the absolute private AIFit Ez state directory." >&2
  exit 1
fi
case "$AIFIT_EZ_STATE_DIR" in
  /*) ;;
  *)
    echo "AIFIT_EZ_STATE_DIR must be an absolute path: $AIFIT_EZ_STATE_DIR" >&2
    exit 1
    ;;
esac
if [ ! -d "$AIFIT_EZ_STATE_DIR" ]; then
  echo "AIFIT_EZ_STATE_DIR does not exist: $AIFIT_EZ_STATE_DIR" >&2
  exit 1
fi
# The local run always wires the frontend to the API it starts: an explicit
# shell value wins (for example http://10.98.0.2:8100 when testing from the
# phone over the private network), otherwise the default keeps a stale web.env
# API base (e.g. an expired ngrok URL) from breaking local work. No ngrok for
# local runs; the private network covers phone testing.
export API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8100}"
# The agent workspace is Juan's data mirror, not a directory under the private
# state dir. It is only required when the relay runs.
if [ "$AIFIT_WITH_RELAY" = "1" ]; then
  export AIFIT_EZ_WORKSPACE="${AIFIT_EZ_WORKSPACE:-$ROOT_DIR/../data_mirrors/aifit-juan}"
  case "$AIFIT_EZ_WORKSPACE" in
    /*) ;;
    *)
      echo "AIFIT_EZ_WORKSPACE must be an absolute path: $AIFIT_EZ_WORKSPACE" >&2
      exit 1
      ;;
  esac
if [ ! -d "$AIFIT_EZ_WORKSPACE" ]; then
  echo "AIFIT_EZ_WORKSPACE does not exist: $AIFIT_EZ_WORKSPACE" >&2
  exit 1
fi
# Single image source: the deployment docker.env owns the relay image. Forcing
  # it here (instead of trusting the shell environment) stops a stale export
  # from silently downgrading the shared relay container on `up`.
  AIFIT_EZ_IMAGE="$(sed -n 's/^EZ_RELAY_IMAGE=//p' "$AIFIT_EZ_STATE_DIR/docker.env" | tr -d "'\"" | head -n 1)"
  export AIFIT_EZ_IMAGE
  if [ -z "$AIFIT_EZ_IMAGE" ]; then
    echo "EZ_RELAY_IMAGE is missing from $AIFIT_EZ_STATE_DIR/docker.env." >&2
    exit 1
  fi
  if [ ! -f "$AIFIT_EZ_STATE_DIR/purpose.md" ]; then
    echo "Purpose file not found: $AIFIT_EZ_STATE_DIR/purpose.md (required to initialize the relay workspace)." >&2
    exit 1
  fi
fi
if [ ! -x "$API_DIR/.venv/bin/uvicorn" ] || [ ! -f "$API_ENV_FILE" ]; then
  echo "New AIFit API dependencies or the external API env file were not found. Set up the API first." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1 || [ ! -f "$WEB_DIR/node_modules/webpack-cli/bin/cli.js" ] || [ ! -f "$WEB_ENV_FILE" ]; then
  echo "New AIFit frontend dependencies or the external web env file were not found. Set up the frontend first." >&2
  exit 1
fi
if [ "$AIFIT_WITH_RELAY" = "1" ]; then
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose is required to run the standard Ez container." >&2
    exit 1
  fi
  if [ ! -f "$COMPOSE_FILE" ]; then
    echo "AIFit local Compose file was not found: $COMPOSE_FILE" >&2
    exit 1
  fi
  if ! docker compose -f "$COMPOSE_FILE" config --quiet >/dev/null 2>&1; then
    echo "The AIFit local Ez Compose configuration is invalid." >&2
    exit 1
  fi
fi
if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required to check the development ports." >&2
  exit 1
fi
for port in 8100 5175; do
  pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    echo "Port $port is occupied (pids: $(echo $pids | tr '\n' ' ')). Stopping existing listeners..." >&2
    kill -TERM $pids 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
      remaining="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
      [ -z "$remaining" ] && break
      sleep 0.2
    done
    remaining="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "$remaining" ]; then
      echo "Port $port still occupied, forcing kill..." >&2
      # shellcheck disable=SC2086
      kill -KILL $remaining 2>/dev/null || true
      sleep 0.5
    fi
    remaining="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "$remaining" ]; then
      echo "Port $port is still occupied. Stop the existing server before running pnpm dev:" >&2
      lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null >&2 || true
      exit 1
    fi
  fi
done

export AIFIT_EZ_STATE_DIR

api_pid=''
app_pid=''
relay_started=0
cleanup() {
  exit_code=$?
  trap - EXIT INT TERM
  for pid in "$api_pid" "$app_pid"; do
    if [ -n "$pid" ]; then kill -TERM -- "-$pid" 2>/dev/null || true; fi
  done
  wait 2>/dev/null || true
  if [ "$relay_started" = "1" ]; then
    if ! (cd "$ROOT_DIR" && docker compose "${compose_args[@]}" stop relay); then
      echo "Failed to stop the local Ez relay." >&2
      exit_code=1
    fi
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$AIFIT_WITH_RELAY" = "1" ]; then
  # Local web/agent QA uses the application channel. Production owns Telegram;
  # loading the local bot override would make both relays poll the same bot.
  compose_args=(-f "$COMPOSE_FILE")
  relay_started=1
  (
    cd "$ROOT_DIR"
    exec docker compose "${compose_args[@]}" up -d --wait
  )
else
  echo "Skipping Ez relay (AIFIT_WITH_RELAY=0). Chat endpoints will report 503." >&2
fi

# Separate process groups let cleanup stop only this launch's servers and workers.
set -m

(
  cd "$API_DIR"
  export EZ_BINDINGS_FILE="$AIFIT_EZ_STATE_DIR/ez-bindings.json"
  exec .venv/bin/uvicorn --env-file "$API_ENV_FILE" aifit_api.main:app --host 0.0.0.0 --port 8100 --reload
) &
api_pid=$!

(
  cd "$WEB_DIR"
  export AIFIT_WEB_ENV_FILE="$WEB_ENV_FILE"
  exec pnpm exec webpack serve --config webpack.config.cjs --mode development --host 0.0.0.0 --port 5175
) &
app_pid=$!

echo "Starting API on http://127.0.0.1:8100 and app on http://localhost:5175"
while kill -0 "$api_pid" 2>/dev/null && kill -0 "$app_pid" 2>/dev/null; do
  sleep 1
done

# Wait only for the exited server; EXIT cleanup stops its still-running sibling.
exit_code=0
if ! kill -0 "$api_pid" 2>/dev/null; then
  wait "$api_pid" || exit_code=$?
  echo "Backend exited; stopping the frontend." >&2
else
  wait "$app_pid" || exit_code=$?
  echo "Frontend exited; stopping the backend." >&2
fi
exit "$exit_code"
