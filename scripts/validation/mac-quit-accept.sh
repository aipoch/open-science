#!/bin/bash
set -euo pipefail
: "${D:?}" "${A:?}" "${FEED:?}" "${ARCH:?}" "${PROBE:?}"
app="$D/Applications/Open-Science.app"
mkdir -p "$D/Applications"
ditto -x -k "$A" "$D/Applications"
codesign --verify --strict --deep "$app"
codesign -dv --verbose=4 "$app" 2>"$D/signature-A.txt"
probe() { node "$PROBE" "$1" "$D" "$FEED" "$ARCH"; }
version() { /usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist"; }
wait_status() {
  for i in {1..80}; do
    if probe status >"$D/last-status" 2>"$D/last-error" && node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1])).details.status;process.exit(($1)?0:1)" "$D/last-status"; then return; fi
    sleep 2
  done
  cat "$D/last-status" "$D/last-error"; return 1
}
wait_exit() {
  for i in {1..45}; do
    if ! curl -sf --max-time 1 http://127.0.0.1:19365/json/list >/dev/null; then return; fi
    sleep 1
  done
  return 1
}
zip_requests() { awk '/"served"/ && /\.zip"/ {i++} END {print i+0}' "$D/acceptance.jsonl"; }
probe serve >"$D/server.log" 2>&1 & feed_pid=$!
trap 'kill "$feed_pid" 2>/dev/null || true' EXIT
test "$(version)" = '1.3.1'
probe launch
wait_status 's.automaticDownloads===true'
probe configure
probe settings
probe off
probe hide
sleep 65
test "$(zip_requests)" = 0
probe quit
wait_exit
probe launch
wait_status 's.automaticDownloads===false'
probe configure
probe on
# Denying helper execution models a failed NWPath probe while keeping the signed bytes intact.
chmod u-x "$app/Contents/MacOS/mac-update-network"
trap 'chmod u+x "$app/Contents/MacOS/mac-update-network"; kill "$feed_pid" 2>/dev/null || true' EXIT
probe hide
sleep 65
test "$(zip_requests)" = 0
chmod u+x "$app/Contents/MacOS/mac-update-network"
trap 'kill "$feed_pid" 2>/dev/null || true' EXIT
codesign --verify --strict --deep "$app"
wait_status 's.state==="ready"'
test "$(zip_requests)" = 1
probe identity
open -a "$app"
sleep 2
probe status
probe close
open -a "$app"
sleep 3
probe status
probe quit
wait_exit
for i in {1..90}; do if [[ "$(version 2>/dev/null || true)" == '1.3.2' ]]; then break; fi; sleep 1; done
test "$(version)" = '1.3.2'
codesign --verify --strict --deep "$app"
codesign -dv --verbose=4 "$app" 2>"$D/signature-B.txt"
probe launch
for i in {1..35}; do if probe identity >"$D/cold-identity" 2>/dev/null; then break; fi; sleep 1; done
node -e "const i=JSON.parse(require('fs').readFileSync(process.argv[1])); if(i.details.version!=='1.3.2') throw Error('Wrong running version')" "$D/cold-identity"
test "$(zip_requests)" = 1
echo 'SIGNED_AUTOMATIC_QUIT_UPGRADE_PASSED'
probe quit
