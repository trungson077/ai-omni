#!/bin/bash
set -e

cd "$(dirname "$0")"

# Install backend deps
echo "==> Installing backend..."
cd backend
uv sync
cd ..

# Install camera deps
echo "==> Installing camera..."
cd camera
uv sync
cd ..

# Install frontend deps
echo "==> Installing frontend..."
cd frontend
npm install
cd ..

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
