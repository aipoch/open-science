#!/bin/bash
set -euo pipefail
test "$(uname -m)" = x86_64
app="$D/Applications/Open-Science.app"
mkdir -p "$D/Applications"
ditto -x -k "$A" "$D/Applications"
codesign --verify --deep --strict "$app"
codesign -dv --verbose=4 "$app" 2>"$D/signature-A.txt"
probe(){ node "$PROBE" "$1" "$D" "$FEED" "$ARCH"; }
probe serve >"$D/server.log" 2>&1 & feed=$!
trap 'kill "$feed" || true' EXIT
probe launch
for i in {1..100}; do if probe status >"$D/initial" 2>/dev/null; then break; fi;sleep 1;done
probe configure
probe off
probe manual-download
probe native-timing | tee "$D/native-time"
probe quit
for i in {1..180}; do [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || true)" = 1.3.2 ]] && break; sleep 1;done
test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")" = 1.3.2
codesign --verify --deep --strict "$app"
codesign -dv --verbose=4 "$app" 2>"$D/signature-B.txt"
probe launch
for i in {1..65}; do if probe identity >"$D/cold-identity" 2>/dev/null; then break;fi;sleep 1;done
grep -q '"version":"1.3.2"' "$D/cold-identity"
probe quit
