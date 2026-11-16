#!/usr/bin/env bash
set -euo pipefail
root=$PWD
diag="$root/diag/.github/native-win-diagnostics"
evidence="$root/evidence"
cd "$root"
test "$(node -v)" = v22.23.3
printf 'mode\tversion\tround\tcommit\ttree\texit_code\ttrace_start_exit\ttrace_stop_exit\n' > "$evidence/rounds.tsv"
printf 'mode\tversion\tcommit\ttree\tstep\texit_code\n' > "$evidence/builds.tsv"

checkout_sha() {
  case "$1" in
    b) printf '%s' fd003755abb08fc58c335caa13c2ec0e588128f0 ;;
    c) printf '%s' f73d295b5a14f7408324383c25014c9991b4167c ;;
  esac
}

record_build() {
  local step=$1 status=0
  shift
  "$@" > "$evidence/$mode-$version/$step.log" 2>&1 || status=$?
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$mode" "$version" "$commit" "$tree" "$step" "$status" | tee -a "$evidence/builds.tsv"
  if ((status != 0)); then cat "$evidence/$mode-$version/$step.log"; fi
  return "$status"
}

test_round() {
  local round=$1 status=0 start_exit=0 stop_exit=0
  local prefix="$evidence/$mode-$version/round-$round"
  local session="OSNative4374-$mode-$version-$round"
  local native_prefix
  native_prefix="$(cygpath -aw "$prefix")"
  pwsh -NoProfile -NonInteractive -File "$diag/process-trace.ps1" start "$session" "$native_prefix" > "$prefix-trace.log" 2>&1 || start_exit=$?
  node --test packages/process-tree-native/test/*.cjs > "$prefix.tap" 2>&1 || status=$?
  if ((start_exit == 0)); then
    pwsh -NoProfile -NonInteractive -File "$diag/process-trace.ps1" stop "$session" "$native_prefix" >> "$prefix-trace.log" 2>&1 || stop_exit=$?
  else
    stop_exit=NA
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$mode" "$version" "$round" "$commit" "$tree" "$status" "$start_exit" "$stop_exit" | tee -a "$evidence/rounds.tsv"
  grep -E '^(not ok|# tests|# pass|# fail)|EBUSY|ERR_ASSERTION' "$prefix.tap" || true
}

for mode in original observed; do
  for version in b c; do
    cd "$root/$version"
    commit=$(git rev-parse HEAD)
    tree=$(git rev-parse 'HEAD^{tree}')
    test "$commit" = "$(checkout_sha "$version")"
    mkdir -p "$evidence/$mode-$version"
    git status --short --branch > "$evidence/$mode-$version/worktree-before.txt"
    if [[ $mode == original ]]; then
      test -z "$(git status --porcelain)"
      record_build dependencies npm ci --ignore-scripts --no-audit --no-fund
    else
      python "$diag/instrument.py"
      git diff -- packages/process-tree-native > "$evidence/$mode-$version/observation.patch"
    fi
    record_build build node scripts/produce-native-components.mjs build
    record_build collect node scripts/produce-native-components.mjs collect
    record_build credential-tests node --test packages/credential-identity-probe-native/test/*.test.cjs || true
    record_build smoke-load node -e "require('./packages/process-tree-native'); require('./packages/safe-file-publisher-native')" || true
  done
  for round in 1 2 3; do
    versions=(b c)
    if (( round % 2 == 0 )); then versions=(c b); fi
    for version in "${versions[@]}"; do
      cd "$root/$version"
      commit=$(git rev-parse HEAD)
      tree=$(git rev-parse 'HEAD^{tree}')
      test_round "$round"
    done
  done
done
