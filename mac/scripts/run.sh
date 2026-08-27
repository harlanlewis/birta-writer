#!/usr/bin/env bash
# Run the built app in the foreground with its stderr on the terminal
# (measurement lines under BIRTA_MAC_MEASURE=1). `pnpm mac:run` builds first
# and uses `open`, which detaches; this is the debugging path.
#
#   bash mac/scripts/run.sh                 # foreground, Ctrl-C to quit
#   BIRTA_MAC_MEASURE=1 bash mac/scripts/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
APP="${BIRTA_MAC_APP:-mac/build/Birta Writer.app}"
if [ ! -x "$APP/Contents/MacOS/BirtaWriter" ]; then
    echo "no app at $APP: run bash mac/scripts/build-app.sh first" >&2
    exit 1
fi
exec "$APP/Contents/MacOS/BirtaWriter" "$@"
