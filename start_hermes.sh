#!/bin/bash
set -e

cd "$(dirname "$0")"

# The backend authenticates to the gateway with ?token=<HERMES_TOKEN>, which
# Hermes compares against its per-process session token. That token is random
# on every start unless we pin it here, so both sides have to read the same
# value out of .env.
set -a
. ./.env
set +a

export HERMES_DASHBOARD_SESSION_TOKEN="$HERMES_TOKEN"

# Must stay on loopback: a non-loopback bind engages the dashboard auth gate,
# which rejects ?token= outright and demands a browser-minted ticket instead.
# --isolated keeps this gateway from being replaced by the machine-level one,
# which would come back up on 0.0.0.0 without our pinned token.
exec hermes serve --port 9119 --host 127.0.0.1 --isolated
