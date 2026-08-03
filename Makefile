.PHONY: start stop install dev-be dev-fe dev-cam wake-test wake-diag wake-sep clean

start:
	bash start.sh

install:
	cd backend && uv sync
	cd frontend && npm install
	cd camera && uv sync
	cd wakeword && uv sync

dev-be:
	cd backend && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

dev-fe:
	cd frontend && npm run dev

dev-cam:
	cd camera && uv run python service.py

# Wake-word calibration against the local mic. These need a real microphone, so
# they are not part of `start`.
wake-test:
	cd wakeword && uv run python test_model.py --threshold 0.01

wake-diag:
	cd wakeword && uv run python diag.py

wake-sep:
	cd wakeword && uv run python separation.py

stop:
	@lsof -ti:8000 | xargs kill -9 2>/dev/null || true
	@lsof -ti:8001 | xargs kill -9 2>/dev/null || true
	@lsof -ti:3000 | xargs kill -9 2>/dev/null || true
	@echo "Stopped"

clean:
	rm -rf backend/.venv camera/.venv wakeword/.venv frontend/node_modules
