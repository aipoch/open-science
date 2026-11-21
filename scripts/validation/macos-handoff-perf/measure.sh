#!/bin/bash
set -euo pipefail
test "$RUNNER_ENVIRONMENT" = github-hosted
probe="$PWD/timing/scripts/validation/mac-quit-probe.mjs"
feed="$RUNNER_TEMP/feed"
cache="$HOME/Library/Caches/com.aipoch.open-science.ShipIt"
results="$RUNNER_TEMP/measurements"
mkdir "$results"
# Change only the SDK's pending ZIP read on the native loopback request.
python3 scripts/validation/macos-handoff-perf/instrument.py "$probe"
run_probe(){ node "$probe" "$1" "$d" "$feed" "$ARCH"; }
for mode in traced baseline large large baseline; do
  d=$(mktemp -d "$RUNNER_TEMP/perf-$mode.XXXXXX")
  log="$results/${d##*/}"
  mkdir -p "$d/Applications" "$log"
  app="$d/Applications/Open-Science.app"
  ditto -xk "$RUNNER_TEMP/candidate/aipoch-open-science-1.3.1-mac-$ARCH.zip" "$d/Applications"
  codesign --verify --deep --strict "$app"
  codesign -dv --verbose=4 "$app" 2>"$log/a-signature"
  run_probe serve >"$d/server.log" 2>&1 & feed_pid=$!
  trap 'kill "$feed_pid" 2>/dev/null || true' EXIT
  run_probe launch
  for i in {1..90}; do if run_probe status >"$d/status" 2>/dev/null; then break; fi; sleep 1; done
  run_probe configure
  run_probe off
  run_probe manual-download
  if [[ "$mode" = traced ]]; then
    sudo fs_usage -w -f filesys -t 120 ShipIt ditto >"$d/fs.log" 2>"$log/fs-error" & trace_pid=$!
  fi
  MODE="$mode" run_probe native-timing
  run_probe quit
  for i in {1..240}; do
    if [[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || true)" = 1.3.2 ]]; then break; fi
    sleep .25
  done
  test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")" = 1.3.2
  # Measure a real first open at the replaced path, before post-run codesign.
  node -p 'Date.now()' >"$log/open-ms"
  run_probe launch
  for i in {1..120}; do
    if run_probe identity >"$d/identity" 2>/dev/null && grep -q '"version":"1.3.2"' "$d/identity"; then break; fi
    sleep .25
  done
  grep -q '"version":"1.3.2"' "$d/identity"
  run_probe quit
  codesign --verify --deep --strict "$app"
  codesign -dv --verbose=4 "$app" 2>"$log/b-signature"
  cp "$d/"{stderr,events.jsonl,acceptance.jsonl,stream.jsonl} "$log/"
  cp "$cache/ShipIt_stderr.log" "$log/shipit"
  if [[ "$mode" = traced ]]; then
    wait "$trace_pid" || true
    gzip -c "$d/fs.log" >"$log/fs.log.gz"
  fi
  kill "$feed_pid"
  trap - EXIT
done
