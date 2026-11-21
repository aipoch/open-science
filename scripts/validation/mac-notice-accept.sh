#!/bin/bash
set -euo pipefail
test "$RUNNER_ENVIRONMENT" = github-hosted
export NOTICE_LOCALE=zh-Hans
app="$D/Applications/Open-Science.app"
mkdir -p "$D/Applications"
ditto -x -k "$A" "$D/Applications"
codesign --verify --strict --deep "$app"
codesign -dv --verbose=4 "$app" 2>"$D/signature-A.txt"
probe() { node "$PROBE" "$1" "$D" "$FEED" "$ARCH"; }
wait_probe() {
  for i in {1..150}; do
    if probe "$1" >"$D/last-status" 2>"$D/last-error"; then return; fi
    sleep 1
  done
  cat "$D/last-error"; return 1
}
quit_and_wait() {
  probe quit
  for i in {1..60}; do
    if ! curl -sf --max-time 1 http://127.0.0.1:19365/json/list >/dev/null; then return; fi
    sleep 1
  done
  return 1
}
failed_replacement() {
  node --input-type=module - "$D" <<'NODE' &
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {createServer} from 'node:net'
const root=process.argv[2], path=readFileSync(join(root,'fixture-socket'),'utf8')
mkdirSync(dirname(path),{recursive:true,mode:0o700})
const timer=setTimeout(()=>process.exit(2),90000)
const server=createServer(peer=>peer.once('data',data=>{
  if(data.toString()!=='reopen\n') throw Error('unexpected handoff')
  peer.write(JSON.stringify({targetVersion:'1.3.2'})+'\n')
  setTimeout(()=>{server.close();peer.end();clearTimeout(timer)},4000)
})).listen(path,()=>writeFileSync(join(root,'fixture-listening'),'ready'))
NODE
  observer=$!
  for i in {1..50}; do [[ -f "$D/fixture-listening" ]] && break; sleep 0.1; done
  probe launch
  wait "$observer"
  unlink "$D/fixture-listening"
}
probe launch
wait_probe notice-absent
probe socket
quit_and_wait
failed_replacement
wait_probe notice-absent
quit_and_wait
if [[ "$INTENT" = document ]]; then
  export FIXTURE_FILE="$D/document.science"
  cp src/main/session-package/fixtures/session-package-v0.31.1-minimal.science "$FIXTURE_FILE"
  failed_replacement
  wait_probe notice-dismiss
  wait_probe notice-absent
else
  export FIXTURE_LINK=1
  failed_replacement
  wait_probe notice-view
  wait_probe notice-settings
fi
quit_and_wait
