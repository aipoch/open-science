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
pid=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).details.pid)" "$D/last-status")
gui="$RUNNER_TEMP/gui-launch"
test "$RUNNER_ENVIRONMENT" = github-hosted
test "$D" = "$RUNNER_TEMP/quit-acceptance"
launchctl setenv OPEN_SCIENCE_CONFIG_ROOT "$D/config"
launchctl setenv OPEN_SCIENCE_USER_DATA "$D/profile"
trap 'kill "$feed_pid" 2>/dev/null || true; launchctl unsetenv OPEN_SCIENCE_CONFIG_ROOT; launchctl unsetenv OPEN_SCIENCE_USER_DATA' EXIT
wait_pid() {
python3 - "$pid" "$D/$wait_name" <<'WAIT_PID'
import os,sys,time
from pathlib import Path
start=time.monotonic()
while time.monotonic()-start<120:
    try: os.kill(int(sys.argv[1]),0)
    except ProcessLookupError:
        Path(sys.argv[2]).write_text(str(time.time()))
        break
    time.sleep(0.025)
else: raise RuntimeError('initial GUI still running; no cold open attempted')
WAIT_PID
}
press_quit() {
  open -a "$app"
  sleep 1
  "$gui" quit "$app"
  wait_pid
}
check_window() {
  local name="$1" expected="${2:-1.3.2}"
  for n in {1..480}; do
    if pid=$("$gui" visible "$app" 2>/dev/null); then break; fi
    sleep .2
  done
  if [[ -z "$pid" ]]; then /usr/bin/lsappinfo list > "$D/gui-unobserved-apps"; echo "No visible window following $name"; return 1; fi
  /usr/bin/lsappinfo list > "$D/registered-apps"
  python3 - "$D" "$app" "$pid" "$name" "$expected" <<'CHECK'
import sys,re
from pathlib import Path
d=Path(sys.argv[1]); app,pid,name,expected=sys.argv[2:]
lines=(d/'registered-apps').read_text().splitlines()
for i,line in enumerate(lines):
 if line.strip()==f'bundle path="{app}"':
  record='\n'.join(lines[i:i+3])
  if re.search(rf'pid = {pid}\b',record):
   (d/f'gui-{name}').write_text(record)
   print(record,flush=True)
   assert f'Version="{expected}"' in record
   break
else: raise RuntimeError('visible PID not registered at the expected path')
CHECK
}
# Install a kept-in-Dock tile in this disposable runner before the bundle is replaced.
"$gui" bookmark "$app" > "$D/bookmark"
python3 - "$app" "$D/bookmark" <<'PIN'
import pathlib,plistlib,subprocess,sys,base64
url=pathlib.Path(sys.argv[1]).as_uri()+'/'
tile={'tile-type':'file-tile','tile-data':{'file-data':{'_CFURLString':url,'_CFURLStringType':15},'file-label':'Open-Science','book':base64.b64decode(pathlib.Path(sys.argv[2]).read_bytes())}}
xml=plistlib.dumps(tile).decode()
subprocess.run(['defaults','write','com.apple.dock','persistent-apps','-array-add',xml],check=True)
PIN
defaults write com.apple.dock magnification -bool false
defaults write com.apple.dock autohide -bool false
killall Dock
sleep 3
restore() {
  "$gui" dock "$app"
  for n in {1..60}; do
    if actual=$("$gui" visible "$app" 2>/dev/null) && test "$actual" = "$pid"; then return 0; fi
    sleep .25
  done
  echo "Dock did not restore original PID"
  return 1
}
# Positive control: the exact same pinned tile must cold-launch A before it can qualify a replacement.
wait_name=gui-baseline-quit
probe quit
wait_pid
"$gui" dock "$app" | tee "$D/gui-baseline-click"
if ! check_window Dock-before 1.3.1; then
  open -R "$app"; sleep 1; "$gui" finder "$app"; check_window Finder-before 1.3.1
  echo "Dock control did not launch A before any update"; exit 1
fi
wait_name=gui-baseline-Dock-quit
"$gui" terminate "$app"
wait_pid
probe launch
wait_status 's.automaticDownloads===true'
probe configure
probe hide
wait_status 's.state==="ready"'
test "$(zip_requests)" = 1
pid=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).details.pid)" "$D/last-status")

restore
probe close
sleep 1
restore
echo "$pid" > "$D/gui-same-process-restore"
wait_name=gui-A-quit
probe quit
wait_pid
"$gui" dock "$app" | tee "$D/gui-first-click"
if check_window Dock; then
  codesign --verify --strict --deep "$app"
  exit 0
fi
version > "$D/gui-version-after-missed-click"
codesign --verify --strict --deep "$app"
"$gui" dock "$app" | tee "$D/gui-control-click"
check_window Dock-control
echo 'Control click opened B; the initial click missed' >&2
exit 1
