#!/bin/bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "$D" = "$RUNNER_TEMP/quit-abort"
mkdir -p "$D/Applications"
ditto -x -k "$A" "$D/Applications"
probe(){ node "$PROBE" "$1" "$D" "$FEED" "$ARCH"; }
probe serve >"$D/server.log" & fp=$!
trap 'kill "$fp" || true' EXIT
probe launch
for i in {1..45}; do if probe status >"$D/status" 2>/dev/null; then break; fi; sleep 1; done
probe configure
probe hide
for i in {1..52}; do if probe status >"$D/status" && grep -q '"state":"ready"' "$D/status"; then break; fi; sleep 2; done
grep -q '"state":"ready"' "$D/status"
pid=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).details.pid)" "$D/status")
nativeLog="$HOME/Library/Caches/com.aipoch.open-science.ShipIt/ShipIt_stderr.log"
wc -c < "$nativeLog" > "$D/log-offset" || echo 0 > "$D/log-offset"
probe quit
while kill -0 "$pid" 2>/dev/null; do sleep 0.025; done
app="$D/Applications/Open-Science.app"
# Hold a freshly opened GUI process at startup so the native installer's final in-use check refuses.
open -n -a "$app" --env OPEN_SCIENCE_CONFIG_ROOT="$D/config" --env OPEN_SCIENCE_USER_DATA="$D/profile" --args --inspect-brk=127.0.0.1:19367
for i in {1..110}; do
  if node - "$D" <<'JS'
const fs=require('node:fs'),{fileURLToPath}=require('node:url'),{dirname,basename,join}=require('node:path'),{homedir}=require('node:os')
const d=process.argv[2],c=join(homedir(),'Library/Caches/com.aipoch.open-science.ShipIt'),r=JSON.parse(fs.readFileSync(join(c,'ShipItState.plist')))
if(fs.realpathSync(fileURLToPath(r.targetBundleURL))!==fs.realpathSync(join(d,'Applications/Open-Science.app')))process.exit(1)
const dir=dirname(fileURLToPath(r.updateBundleURL).replace(/\/$/,''))
if(dirname(dir)!==c || !/^update\.[A-Za-z0-9]+$/.test(basename(dir)) || fs.existsSync(dir))process.exit(1)
const log=fs.readFileSync(join(c,'ShipIt_stderr.log')).subarray(Number(fs.readFileSync(join(d,'log-offset'),'utf8'))).toString()
if(!log.includes('Aborting update attempt because there are 1 running instances'))process.exit(1)
fs.writeFileSync(join(d,'orphan-result.json'),JSON.stringify({target:r.targetBundleURL,directory:dir,removed:true,refusal:true}))
JS
  then break; fi; sleep 0.5
done
test -s "$D/orphan-result.json"
test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")" = 1.3.1
echo SIGNED_ABORT_CLEANUP_PASSED
