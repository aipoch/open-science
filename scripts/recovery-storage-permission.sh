#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename "$0")"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<EOF
Usage: $SCRIPT_NAME <inject|status|restore>

Injects a reversible Storage recovery failure into a packaged Open Science
installation by removing write permission from ~/.open-science.

Run inject while Open Science is closed. Restore may run while the app is open,
then use Check again in Settings > Storage.
EOF
}

resolved_home() {
  [[ -n "${HOME:-}" && "$HOME" != "/" ]] || fail 'HOME is missing or unsafe.'
  (cd "$HOME" && pwd -P) || fail 'HOME cannot be resolved.'
}

ensure_non_root() {
  [[ "${EUID:-$(id -u)}" -ne 0 ]] || fail 'Do not run this recovery test as root or with sudo.'
}

ensure_app_stopped() {
  if command -v pgrep >/dev/null 2>&1 &&
    { pgrep -x 'Open Science' >/dev/null 2>&1 ||
      pgrep -f '/Open Science\.app/Contents/MacOS/' >/dev/null 2>&1; }; then
    fail 'Quit Open Science before injecting the failure.'
  fi
}

ensure_safe_state_root() {
  [[ ! -e "$STATE_ROOT" || (-d "$STATE_ROOT" && ! -L "$STATE_ROOT") ]] ||
    fail "Recovery-test state path is unsafe: $STATE_ROOT"
}

file_mode() {
  /usr/bin/stat -f '%Lp' "$1" 2>/dev/null || fail "Cannot read permissions for $1"
}

validate_mode() {
  [[ "$1" =~ ^[0-7]{3,4}$ ]] || fail "Invalid saved permission mode: $1"
}

ensure_non_root

readonly HOME_DIR="$(resolved_home)"
readonly CONFIG_ROOT="$HOME_DIR/.open-science"
readonly STATE_ROOT="$HOME_DIR/.open-science-recovery-test"
readonly STATE_FILE="$STATE_ROOT/storage-permission.state"

ensure_safe_state_root

inject() {
  ensure_app_stopped
  [[ -d "$CONFIG_ROOT" && ! -L "$CONFIG_ROOT" ]] ||
    fail "Expected a real packaged-app config directory at $CONFIG_ROOT"
  [[ ! -e "$STATE_FILE" ]] || fail 'Storage permission failure is already injected.'

  umask 077
  /bin/mkdir -p "$STATE_ROOT"

  local original_mode state_tmp probe
  original_mode="$(file_mode "$CONFIG_ROOT")"
  validate_mode "$original_mode"
  state_tmp="$STATE_FILE.tmp.$$"
  probe="$CONFIG_ROOT/.recovery-storage-probe-$$"

  printf '%s\n' "$original_mode" >"$state_tmp"
  /bin/mv "$state_tmp" "$STATE_FILE"

  if ! /bin/chmod a-w "$CONFIG_ROOT"; then
    /bin/rm -f "$STATE_FILE"
    fail 'Could not remove write permission from the config directory.'
  fi

  # Confirm the current user really cannot create the sentinel used by environment-check.ts.
  if (umask 077; : >"$probe") 2>/dev/null; then
    /bin/rm -f "$probe"
    /bin/chmod "$original_mode" "$CONFIG_ROOT"
    /bin/rm -f "$STATE_FILE"
    fail 'The directory is still writable; original permissions were restored.'
  fi

  printf 'Injected Storage recovery failure at %s\n' "$CONFIG_ROOT"
  printf 'Start Open Science and use the Home repair action.\n'
  printf 'Restore with: %s restore\n' "$0"
}

status() {
  if [[ -f "$STATE_FILE" ]]; then
    local original_mode
    IFS= read -r original_mode <"$STATE_FILE" || fail 'Cannot read the Storage state file.'
    validate_mode "$original_mode"
    printf 'Storage permission failure: injected\n'
    printf 'Config directory: %s\n' "$CONFIG_ROOT"
    printf 'Saved mode: %s\n' "$original_mode"
    [[ -e "$CONFIG_ROOT" ]] && printf 'Current mode: %s\n' "$(file_mode "$CONFIG_ROOT")"
  else
    printf 'Storage permission failure: not injected\n'
  fi
}

restore() {
  [[ -f "$STATE_FILE" ]] || fail 'No Storage permission state is available to restore.'
  [[ -d "$CONFIG_ROOT" && ! -L "$CONFIG_ROOT" ]] ||
    fail "Config directory is missing or unsafe: $CONFIG_ROOT"

  local original_mode
  IFS= read -r original_mode <"$STATE_FILE" || fail 'Cannot read the Storage state file.'
  validate_mode "$original_mode"

  /bin/chmod "$original_mode" "$CONFIG_ROOT"
  /bin/rm -f "$STATE_FILE"
  /bin/rmdir "$STATE_ROOT" 2>/dev/null || true

  printf 'Restored Storage permissions on %s to %s\n' "$CONFIG_ROOT" "$original_mode"
  printf 'In the open app, choose Check again in Settings > Storage.\n'
}

[[ $# -eq 1 ]] || {
  usage
  exit 2
}

case "$1" in
  inject) inject ;;
  status) status ;;
  restore) restore ;;
  *)
    usage
    exit 2
    ;;
esac
