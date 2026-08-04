.PHONY: start stop install dev-be dev-fake dev-fe dev-cam wake-test wake-diag wake-sep clean mcp-register mcp-check

start:
	bash start.sh

install: mcp-register
	cd backend && uv sync
	cd frontend && npm install
	cd camera && uv sync
	cd wakeword && uv sync

# Point Hermes at *this* checkout's god-eye server.
#
# Hermes stores the spawn command as an absolute path, so moving or renaming the
# repo breaks it: `uv run --directory <old path>` fails, Hermes drops the server,
# and Nova loses god_eye_show/hide/look. Nothing surfaces that — asking for the
# camera just produces no panel — so this runs as part of `install` rather than
# waiting to be remembered. Re-add rather than edit: `add` on an existing name
# errors out on some versions.
#
# UV is resolved to an absolute path on purpose. Hermes spawns MCP servers from
# its own long-lived process, whose PATH is whatever launched the gateway — not
# an interactive shell. A bare `uv` dies there with
# `FileNotFoundError: No such file or directory: 'uv'`, which reaches the user
# as Nova claiming the camera backend is missing a file.
UV := $(shell command -v uv)

# The `yes |` is load-bearing: after probing the server, `add` asks "Enable all
# 3 tools?" on stdin, and with no tty it reads EOF and cancels the add — having
# already removed the old entry, which leaves god-eye deregistered entirely.
mcp-register:
	@test -n "$(UV)" || { echo "ERROR: uv not on PATH. Install it, then re-run." >&2; exit 1; }
	@hermes mcp remove god-eye >/dev/null 2>&1 || true
	@yes | hermes mcp add god-eye --command $(UV) --connect-timeout 30 \
		--args run --directory $(CURDIR)/camera python mcp_god_eye.py \
		| tail -3
	@echo "==> god-eye registered: $(UV) run --directory $(CURDIR)/camera"

# Does Hermes actually reach the server? `mcp list` only reports what is
# configured, which stays green against a directory that no longer exists.
mcp-check:
	hermes mcp test god-eye

dev-be:
	cd backend && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# The backend plus the UI replay fixture, for exercising panels that a live
# agent can't be made to produce on demand — approvals, tool sequences, the
# camera trigger, mid-turn failures. Open with ?wire=fake&script=S1 (S1..S8).
dev-fake:
	cd backend && NOVA_FAKE_WIRE=1 uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

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
