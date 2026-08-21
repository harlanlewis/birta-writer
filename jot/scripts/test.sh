#!/usr/bin/env bash
# `swift test` for both Jot targets, the core and the app. XCTest ships with
# Xcode, not with the Command Line Tools, so when the active developer
# directory is the CLT and Xcode is installed, point the toolchain at Xcode for
# this run. No sudo, nothing changes on the machine.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! xcode-select -p 2>/dev/null | grep -q "Xcode.app" && [ -d /Applications/Xcode.app/Contents/Developer ]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
exec swift test "$@"
