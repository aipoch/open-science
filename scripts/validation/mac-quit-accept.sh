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
probe hide
wait_status 's.state==="ready"'
test "$(zip_requests)" = 1
pid=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).details.pid)" "$D/last-status")
probe quit
for i in {1..1500}; do if ! kill -0 "$pid" 2>/dev/null; then break; fi; sleep 0.03; done
! kill -0 "$pid" 2>/dev/null
date -u > "$D/immediate-reopen"
if [[ "${INTENT:-document}" = link ]]; then
  export FIXTURE_LINK=1
else
  export FIXTURE_FILE="$D/document.science"
  cp src/main/session-package/fixtures/session-package-v0.31.1-minimal.science "$FIXTURE_FILE"
fi
probe launch
cutoff=$((SECONDS+125))
while ((SECONDS<cutoff)); do
  if probe status > "$D/first-workspace" 2>"$D/first-workspace-error"; then break; fi
  sleep 0.25
done
node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1]));if(s.details.version!=='1.3.2')throw Error('First workspace was not B: '+s.details.version)" "$D/first-workspace"
test "$(version)" = '1.3.2'
codesign --verify --strict --deep "$app"
codesign -dv --verbose=4 "$app" 2>"$D/signature-B.txt"
probe identity > "$D/cold-identity"
cutoff=$((SECONDS+150))
while ((SECONDS<cutoff)); do
  if probe workspace >"$D/workspace-ready" 2>"$D/last-error"; then break; fi
  sleep 1
done
node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1])).details;if(s.version!=='1.3.2'||s.data.version!=='1.3.2')process.exit(1)" "$D/workspace-ready"
observe_document() {
  local output="$1"
  for i in {1..30}; do
    if probe "${INTENT:-document}" >"$output" && grep -q '"observed":true' "$output"; then return 0; fi
    sleep 1
  done
  return 1
}
if observe_document "$D/document-at-handoff"; then
  node - "$D/document-at-handoff" <<'JS'
const fs=require('node:fs'), d=JSON.parse(fs.readFileSync(process.argv[2])).details
if(d.version!=='1.3.2'||d.argvHasDocument||d.argvHasUrl||d.count>1)throw Error('invalid handoff')
JS
  exit 0
fi
# Positive control with the very same signed B, target and launch command after replacement.
probe quit
wait_exit
probe launch
observe_document "$D/document-control"
grep -q '"observed":true' "$D/document-at-handoff"
