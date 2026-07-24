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

Injects a reversible Agent recovery failure by setting the selected app-managed
runtime entry to mode 000. Manual and system-wide runtimes are refused.

Run inject while Open Science is closed. Restore may run while the app is open,
then use Re-detect in Settings > Agent.

The selected app-managed runtime must be the only runnable installation of that
framework, otherwise detection may fall back to another installation.
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

file_identity() {
  /usr/bin/stat -f '%d:%i' "$1" 2>/dev/null || fail "Cannot identify $1"
}

validate_mode() {
  [[ "$1" =~ ^[0-7]{3,4}$ ]] || fail "Invalid saved permission mode: $1"
}

plist_value() {
  local key="$1"
  /usr/bin/plutil -extract "$key" raw -o - "$SETTINGS_FILE" 2>/dev/null ||
    fail "Cannot read $key from $SETTINGS_FILE"
}

runtime_path_for() {
  case "$1" in
    claude-code) plist_value 'claude.resolvedPath' ;;
    opencode) plist_value 'opencodePath' ;;
    codex) plist_value 'codex.resolvedPath' ;;
    *) fail "Unsupported selected agent framework: $1" ;;
  esac
}

validate_managed_target() {
  local framework="$1" target="$2" parent resolved_target expected_prefix
  [[ "$target" == /* && "$target" != *$'\n'* ]] || fail 'Runtime path is not a safe absolute path.'
  [[ -f "$target" && ! -L "$target" ]] || fail "Runtime entry is missing or is a symlink: $target"

  parent="$(cd "$(dirname "$target")" && pwd -P)" || fail 'Runtime parent cannot be resolved.'
  resolved_target="$parent/$(basename "$target")"

  case "$framework" in
    claude-code) expected_prefix="$CONFIG_ROOT/claude-code/bin/" ;;
    opencode) expected_prefix="$CONFIG_ROOT/opencode-managed/bin/" ;;
    codex) expected_prefix="$CONFIG_ROOT/codex-managed/adapter/" ;;
    *) fail "Unsupported framework in state: $framework" ;;
  esac

  [[ "$resolved_target" == "$expected_prefix"* ]] ||
    fail "Refusing to modify a manual or system runtime: $resolved_target"
}

read_state() {
  STATE_FRAMEWORK="$(/usr/bin/sed -n '1p' "$STATE_FILE")"
  STATE_TARGET="$(/usr/bin/sed -n '2p' "$STATE_FILE")"
  STATE_MODE="$(/usr/bin/sed -n '3p' "$STATE_FILE")"
  STATE_IDENTITY="$(/usr/bin/sed -n '4p' "$STATE_FILE")"
  [[ -n "$STATE_FRAMEWORK" && -n "$STATE_TARGET" && -n "$STATE_IDENTITY" ]] ||
    fail 'Agent permission state is incomplete.'
  validate_mode "$STATE_MODE"
}

ensure_non_root

readonly HOME_DIR="$(resolved_home)"
readonly CONFIG_ROOT="$HOME_DIR/.open-science"
readonly SETTINGS_FILE="$CONFIG_ROOT/settings.json"
readonly STATE_ROOT="$HOME_DIR/.open-science-recovery-test"
readonly STATE_FILE="$STATE_ROOT/agent-permission.state"
readonly RENAME_STATE_FILE="$STATE_ROOT/agent-rename.state"

ensure_safe_state_root

STATE_FRAMEWORK=''
STATE_TARGET=''
STATE_MODE=''
STATE_IDENTITY=''

inject() {
  ensure_app_stopped
  [[ -d "$CONFIG_ROOT" && ! -L "$CONFIG_ROOT" && -f "$SETTINGS_FILE" ]] ||
    fail "Packaged Open Science settings were not found at $SETTINGS_FILE"
  [[ ! -e "$STATE_FILE" ]] || fail 'Agent permission failure is already injected.'
  [[ ! -e "$RENAME_STATE_FILE" ]] ||
    fail 'Restore the Agent rename failure before using the permission injector.'

  local framework target original_mode original_identity state_tmp
  framework="$(plist_value 'agentFrameworkId')"
  target="$(runtime_path_for "$framework")"
  validate_managed_target "$framework" "$target"
  original_mode="$(file_mode "$target")"
  original_identity="$(file_identity "$target")"
  validate_mode "$original_mode"

  umask 077
  /bin/mkdir -p "$STATE_ROOT"
  state_tmp="$STATE_FILE.tmp.$$"
  printf '%s\n%s\n%s\n%s\n' \
    "$framework" "$target" "$original_mode" "$original_identity" >"$state_tmp"
  /bin/mv "$state_tmp" "$STATE_FILE"

  if ! /bin/chmod 000 "$target"; then
    /bin/rm -f "$STATE_FILE"
    fail 'Could not disable the selected runtime entry.'
  fi

  if [[ -r "$target" || -x "$target" ]]; then
    /bin/chmod "$original_mode" "$target"
    /bin/rm -f "$STATE_FILE"
    fail 'The runtime entry remains accessible; original permissions were restored.'
  fi

  printf 'Injected Agent recovery failure for %s\n' "$framework"
  printf 'Disabled runtime entry: %s\n' "$target"
  printf 'Start Open Science and use the Home repair action.\n'
  printf 'If Agent still passes, another installation of %s was detected.\n' "$framework"
}

status() {
  if [[ -f "$STATE_FILE" ]]; then
    read_state
    printf 'Agent permission failure: injected\n'
    printf 'Framework: %s\n' "$STATE_FRAMEWORK"
    printf 'Runtime entry: %s\n' "$STATE_TARGET"
    printf 'Saved mode: %s\n' "$STATE_MODE"
    [[ -e "$STATE_TARGET" ]] && printf 'Current mode: %s\n' "$(file_mode "$STATE_TARGET")"
  else
    printf 'Agent permission failure: not injected\n'
  fi
}

restore() {
  [[ -f "$STATE_FILE" ]] || fail 'No Agent permission state is available to restore.'
  read_state
  validate_managed_target "$STATE_FRAMEWORK" "$STATE_TARGET"

  local current_identity
  current_identity="$(file_identity "$STATE_TARGET")"
  if [[ "$current_identity" == "$STATE_IDENTITY" ]]; then
    /bin/chmod "$STATE_MODE" "$STATE_TARGET"
    printf 'Restored runtime permissions to %s\n' "$STATE_MODE"
  else
    printf 'Repair replaced the runtime entry; keeping its new permissions unchanged.\n'
  fi

  /bin/rm -f "$STATE_FILE"
  /bin/rmdir "$STATE_ROOT" 2>/dev/null || true
  printf 'In the open app, choose Re-detect in Settings > Agent.\n'
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
