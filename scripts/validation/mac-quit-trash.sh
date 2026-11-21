#!/bin/bash
set -euo pipefail
test "$RUNNER_ENVIRONMENT" = github-hosted
test "$D" = "$RUNNER_TEMP/quit-trash"
mkdir -p "$D/Applications"
app="$D/Applications/Open-Science.app"
ditto -x -k "$A" "$D/Applications"
codesign --verify --deep --strict "$app"
swiftc scripts/validation/mac-quit-trash.swift -o "$D/trash"
probe(){ node "$PROBE" "$1" "$D" "$FEED" "$ARCH"; }
cache="$HOME/Library/Caches/com.aipoch.open-science.ShipIt"
printf '%s' 'other install' > "$D/Applications/sentinel"
probe serve >"$D/server.log" & feed_pid=$!
trap 'kill "$feed_pid" || true; cp "$cache/ShipIt_stderr.log" "$D/shipit.txt" 2>/dev/null || true; launchctl list com.aipoch.open-science.ShipIt >"$D/job.txt" || true' EXIT
probe launch
for i in {1..90}; do if probe status >"$D/status" 2>/dev/null; then break; fi; sleep 1; done
probe configure
probe hide
for i in {1..90}; do if probe status >"$D/status" && grep -q '"state":"ready"' "$D/status"; then break; fi; sleep 2; done
grep -q '"state":"ready"' "$D/status"
pid=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1])).details.pid)" "$D/status")
probe quit
python3 - "$D" "$pid" "$cache" <<'PY'
import os,sys,time,json,subprocess,urllib.parse
from pathlib import Path
root=Path(sys.argv[1]); pid=int(sys.argv[2]); cache=Path(sys.argv[3]); app=root/'Applications/Open-Science.app'
inode=app.stat().st_ino
for i in range(4500):
    try: os.kill(pid,0)
    except ProcessLookupError: break
    time.sleep(.025)
else: raise RuntimeError('old PID stayed alive')
receipt=json.loads((cache/'ShipItState.plist').read_bytes())
def path(url): return Path(urllib.parse.unquote(urllib.parse.urlparse(url).path))
assert path(receipt['targetBundleURL']).resolve()==app.resolve()
stage=path(receipt['updateBundleURL']).parent
assert stage.parent==cache and stage.name.startswith('update.') and stage.is_dir()
assert app.stat().st_ino==inode
if os.environ['MOVE_KIND']=='trash':
    moved=Path(subprocess.check_output([root/'trash',app],text=True).strip())
else:
    moved=root/'Moved.app'
    app.rename(moved)
assert moved.stat().st_ino==inode
start=time.monotonic()
# Observe through the watcher's full lifetime without launching either installation.
time.sleep(125)
result=dict(destination=str(moved),moveKind=os.environ["MOVE_KIND"],targetRecreated=app.exists(),originalAtDestination=moved.stat().st_ino==inode,stage=str(stage),stageRetained=stage.exists(),elapsedSeconds=round(time.monotonic()-start,2))
(root/'result.json').write_text(json.dumps(result))
print(result,flush=True)
assert (root/'Applications/sentinel').read_text()=='other install'
assert result['originalAtDestination'] and not result['targetRecreated'] and result['stageRetained']==(os.environ['MOVE_KIND']=='ordinary')
PY
