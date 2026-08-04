#!/bin/bash
set -e

cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
# Nothing below works without uv (both Python services) and npm (the UI), so
# fail loudly here rather than three cd's later with a bare "command not found".

if [ ! -f ./.env ]; then
  echo "ERROR: .env is missing. Copy your keys into ./.env before starting." >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "==> uv not found, installing it (per-user, into ~/.local/bin)..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # The installer only patches your shell profile; this process still has the
  # old PATH.
  export PATH="$HOME/.local/bin:$PATH"
  command -v uv >/dev/null 2>&1 || {
    echo "ERROR: uv still not on PATH. Open a new shell and re-run." >&2
    exit 1
  }
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm not found. Install Node.js first:" >&2
  echo "         brew install node        # macOS" >&2
  echo "         https://nodejs.org       # anywhere else" >&2
  exit 1
fi

# The camera reads its config from bare os.environ — unlike the backend, which
# loads .env itself via dotenv. Export .env here so CAMERA_RTSP_URL and friends
# reach service.py.
set -a
. ./.env
set +a

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
# Installing on every start costs seconds we don't need to spend, so each check
# compares the lockfile against the installed tree and only syncs when it moved.
# FORCE_INSTALL=1 ./start.sh reinstalls regardless.

# newer <file> <reference> — true when <reference> is missing or older.
newer() { [ ! -e "$2" ] || [ "$1" -nt "$2" ]; }

sync_python() {
  local dir="$1"
  if [ -n "$FORCE_INSTALL" ] \
     || [ ! -x "$dir/.venv/bin/python" ] \
     || newer "$dir/uv.lock" "$dir/.venv/pyvenv.cfg" \
     || newer "$dir/pyproject.toml" "$dir/.venv/pyvenv.cfg"; then
    echo "==> Installing $dir deps..."
    (cd "$dir" && uv sync)
    touch "$dir/.venv/pyvenv.cfg"
  else
    echo "==> $dir deps up to date"
  fi
}

sync_python backend
sync_python camera

if [ -n "$FORCE_INSTALL" ] \
   || [ ! -d frontend/node_modules ] \
   || newer frontend/package.json frontend/node_modules/.package-lock.json \
   || newer frontend/package-lock.json frontend/node_modules/.package-lock.json; then
  echo "==> Installing frontend deps..."
  (cd frontend && npm install)
else
  echo "==> frontend deps up to date"
fi

echo ""
echo "==> Starting backend on :8000, camera on :8001, frontend on :3000"
echo ""

# Start backend in background
cd backend
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 &
BE_PID=$!
cd ..

# Start God Eye camera service in background (Nova can boot it on demand via
# the MCP server, but having it up makes the UI button work immediately)
cd camera
uv run python service.py &
CAM_PID=$!
cd ..

# Start frontend in background
cd frontend
npm run dev &
FE_PID=$!
cd ..

# Trap to kill everything on exit
trap "kill $BE_PID $FE_PID $CAM_PID 2>/dev/null; exit" INT TERM EXIT

echo ""
echo "==> Open http://localhost:3000"
echo "==> Press Ctrl+C to stop"
echo ""

wait
