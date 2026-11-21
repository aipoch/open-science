#!/bin/bash
set -euo pipefail
: "${D:?}" "${A:?}" "${FEED:?}" "${PROBE:?}" "${ARCH:?}" "${DMG:?}"
mkdir -p "$D"
export OS_ACCEPT_APP="$D/mount/Open-Science.app"
mkdir "$D/mount"
hdiutil attach -readonly -nobrowse -mountpoint "$D/mount" "$DMG"
probe(){ node "$PROBE" "$1" "$D" "$FEED" "$ARCH"; }
probe serve >"$D/server.log" 2>&1 & server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
boot(){
  probe launch
  for i in {1..180}; do if probe status >"$D/status" 2>"$D/errors"; then return; fi; sleep 1; done
  cat "$D/errors"; return 1
}
boot
probe configure
probe hide
sleep 65
! grep -q '\.zip"' "$D/server.log" || exit 1
open -a "$OS_ACCEPT_APP"
probe manual-download
sleep 2
probe windows > "$D/readonly-windows"
grep -q 'installation-assistant.html' "$D/readonly-windows"
probe quit
for i in {1..30}; do if ! curl -sf http://127.0.0.1:19365/json/list >/dev/null; then break; fi; sleep 1; done
hdiutil detach "$D/mount" || hdiutil detach -force "$D/mount"
unset OS_ACCEPT_APP
mkdir "$D/Applications"
ditto -x -k "$A" "$D/Applications"
boot
probe configure
probe off
probe manual-download
probe status >"$D/manual-status"
node -e "const s=JSON.parse(require('fs').readFileSync(process.argv[1])).details.status;if(s.state!=='ready'||s.automaticDownloads!==false)throw Error('manual download failed')" "$D/manual-status"
probe restart
for i in {1..100}; do
  if [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$D/Applications/Open-Science.app/Contents/Info.plist" 2>/dev/null || true)" = '1.3.2' ]]; then break;fi
  sleep 1
done
test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$D/Applications/Open-Science.app/Contents/Info.plist")" = 1.3.2
codesign --verify --strict --deep "$D/Applications/Open-Science.app"
/usr/bin/lsappinfo list > "$D/running-apps.txt"
node - "$D" <<'JS'
const fs=require('fs'),dir=process.argv[2],s=fs.readFileSync(dir+'/running-apps.txt','utf8'),lines=s.split('\n')
const index=lines.findIndex(l=>l.includes('bundle path=')&&l.includes(dir+'/Applications/Open-Science.app'))
if(index<0 || !lines.slice(index,index+5).some(l=>l.includes('Version="1.3.2"'))) throw Error('Manual relaunch did not Run B')
fs.writeFileSync(dir+'/manual-running',lines.slice(index,index+4).join('\n'))
JS
echo SIGNED_MANUAL_AND_READONLY_PASSED
