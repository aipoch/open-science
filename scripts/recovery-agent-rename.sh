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

Injects an Agent recovery failure by moving the selected app-managed runtime
tree into ~/.open-science-recovery-test. No runtime files are deleted.

Run inject while Open Science is closed. Restore refuses to overwrite a new
runtime created by Repair.

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

managed_root_for() {
  case "$1" in
    claude-code) printf '%s\n' "$CONFIG_ROOT/claude-code" ;;
    opencode) printf '%s\n' "$CONFIG_ROOT/opencode-managed" ;;
    codex) printf '%s\n' "$CONFIG_ROOT/codex-managed" ;;
    *) fail "Unsupported framework in state: $1" ;;
  esac
}

validate_managed_runtime() {
  local framework="$1" target="$2" runtime_root="$3" parent resolved_target
  [[ "$target" == /* && "$target" != *$'\n'* ]] || fail 'Runtime path is not a safe absolute path.'
  [[ -f "$target" && ! -L "$target" ]] || fail "Runtime entry is missing or is a symlink: $target"
  [[ -d "$runtime_root" && ! -L "$runtime_root" ]] ||
    fail "Managed runtime root is missing or unsafe: $runtime_root"

  parent="$(cd "$(dirname "$target")" && pwd -P)" || fail 'Runtime parent cannot be resolved.'
  resolved_target="$parent/$(basename "$target")"
  [[ "$resolved_target" == "$runtime_root/"* ]] ||
    fail "Refusing to move a manual or system runtime: $resolved_target"

  case "$framework" in
    claude-code | opencode | codex) ;;
    *) fail "Unsupported selected agent framework: $framework" ;;
  esac
}

read_state() {
  STATE_FRAMEWORK="$(/usr/bin/sed -n '1p' "$STATE_FILE")"
  STATE_RUNTIME_ROOT="$(/usr/bin/sed -n '2p' "$STATE_FILE")"
  STATE_BACKUP_ROOT="$(/usr/bin/sed -n '3p' "$STATE_FILE")"
  [[ -n "$STATE_FRAMEWORK" && -n "$STATE_RUNTIME_ROOT" && -n "$STATE_BACKUP_ROOT" ]] ||
    fail 'Agent rename state is incomplete.'
}

ensure_non_root

readonly HOME_DIR="$(resolved_home)"
readonly CONFIG_ROOT="$HOME_DIR/.open-science"
readonly SETTINGS_FILE="$CONFIG_ROOT/settings.json"
readonly STATE_ROOT="$HOME_DIR/.open-science-recovery-test"
readonly STATE_FILE="$STATE_ROOT/agent-rename.state"
readonly PERMISSION_STATE_FILE="$STATE_ROOT/agent-permission.state"

ensure_safe_state_root

STATE_FRAMEWORK=''
STATE_RUNTIME_ROOT=''
STATE_BACKUP_ROOT=''

inject() {
  ensure_app_stopped
  [[ -d "$CONFIG_ROOT" && ! -L "$CONFIG_ROOT" && -f "$SETTINGS_FILE" ]] ||
    fail "Packaged Open Science settings were not found at $SETTINGS_FILE"
  [[ ! -e "$STATE_FILE" ]] || fail 'Agent rename failure is already injected.'
  [[ ! -e "$PERMISSION_STATE_FILE" ]] ||
    fail 'Restore the Agent permission failure before using the rename injector.'

  local framework target runtime_root backup_root state_tmp
  framework="$(plist_value 'agentFrameworkId')"
  target="$(runtime_path_for "$framework")"
  runtime_root="$(managed_root_for "$framework")"
  backup_root="$STATE_ROOT/agent-rename-backup-$framework"
  validate_managed_runtime "$framework" "$target" "$runtime_root"
  [[ ! -e "$backup_root" ]] || fail "Backup path already exists: $backup_root"

  umask 077
  /bin/mkdir -p "$STATE_ROOT"
  state_tmp="$STATE_FILE.tmp.$$"
  printf '%s\n%s\n%s\n' "$framework" "$runtime_root" "$backup_root" >"$state_tmp"
  /bin/mv "$state_tmp" "$STATE_FILE"

  if ! /bin/mv "$runtime_root" "$backup_root"; then
    /bin/rm -f "$STATE_FILE"
    fail 'Could not move the managed runtime into the recovery-test backup.'
  fi

  [[ ! -e "$runtime_root" && -d "$backup_root" ]] ||
    fail 'Runtime move did not reach the expected post-injection state; keep the state file for recovery.'

  printf 'Injected Agent recovery failure for %s\n' "$framework"
  printf 'Runtime backup: %s\n' "$backup_root"
  printf 'Start Open Science and use the Home repair action.\n'
  printf 'If Agent still passes, another installation of %s was detected.\n' "$framework"
}

status() {
  if [[ -f "$STATE_FILE" ]]; then
    read_state
    printf 'Agent rename failure: injected\n'
    printf 'Framework: %s\n' "$STATE_FRAMEWORK"
    printf 'Original runtime root: %s\n' "$STATE_RUNTIME_ROOT"
    printf 'Backup runtime root: %s\n' "$STATE_BACKUP_ROOT"
    [[ -e "$STATE_RUNTIME_ROOT" ]] && printf 'A runtime currently exists at the original path.\n'
  else
    printf 'Agent rename failure: not injected\n'
  fi
}

restore() {
  [[ -f "$STATE_FILE" ]] || fail 'No Agent rename state is available to restore.'
  read_state

  local expected_runtime_root expected_backup_root
  expected_runtime_root="$(managed_root_for "$STATE_FRAMEWORK")"
  expected_backup_root="$STATE_ROOT/agent-rename-backup-$STATE_FRAMEWORK"
  [[ "$STATE_RUNTIME_ROOT" == "$expected_runtime_root" ]] || fail 'Saved runtime root is unsafe.'
  [[ "$STATE_BACKUP_ROOT" == "$expected_backup_root" ]] || fail 'Saved backup root is unsafe.'
  [[ -d "$STATE_BACKUP_ROOT" && ! -L "$STATE_BACKUP_ROOT" ]] ||
    fail "Runtime backup is missing or unsafe: $STATE_BACKUP_ROOT"

  if [[ -e "$STATE_RUNTIME_ROOT" ]]; then
    fail "A repaired runtime now exists at $STATE_RUNTIME_ROOT; refusing to overwrite it. The original remains at $STATE_BACKUP_ROOT"
  fi

  /bin/mv "$STATE_BACKUP_ROOT" "$STATE_RUNTIME_ROOT"
  /bin/rm -f "$STATE_FILE"
  /bin/rmdir "$STATE_ROOT" 2>/dev/null || true

  printf 'Restored the original %s runtime tree.\n' "$STATE_FRAMEWORK"
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
