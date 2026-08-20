#!/usr/bin/env bash
# Run the built app in the foreground with its stderr on the terminal
# (measurement lines under BIRTA_JOT_MEASURE=1). `pnpm jot:run` builds first
# and uses `open`, which detaches; this is the debugging path.
#
#   bash jot/scripts/run.sh                 # foreground, Ctrl-C to quit
#   BIRTA_JOT_MEASURE=1 bash jot/scripts/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
APP="${JOT_APP:-jot/build/Birta Writer Jot.app}"
if [ ! -x "$APP/Contents/MacOS/BirtaJot" ]; then
    echo "no app at $APP: run bash jot/scripts/build-app.sh first" >&2
    exit 1
fi
exec "$APP/Contents/MacOS/BirtaJot" "$@"
