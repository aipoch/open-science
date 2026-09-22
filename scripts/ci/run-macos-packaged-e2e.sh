#!/bin/bash
set -euo pipefail

# Only disposable hosted jobs may replace the user's Keychain search list.
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS ]]
[[ -n "${RUNNER_TEMP:-}" && -x "${OPEN_SCIENCE_E2E_EXECUTABLE:-}" && $# -gt 0 ]]

original_search_list=$(security list-keychains -d user)
original_keychains=()
while IFS= read -r entry; do
  entry="${entry#*\"}"
  entry="${entry%\"*}"
  [[ -z "$entry" ]] || original_keychains+=("$entry")
done <<< "$original_search_list"
[[ ${#original_keychains[@]} -gt 0 ]]

keychain_root=$(mktemp -d "$RUNNER_TEMP/open-science-p0-keychain.XXXXXX")
keychain="$keychain_root/test.keychain-db"
cleanup() {
  local status=$?
  security list-keychains -d user -s "${original_keychains[@]}" || status=1
  if [[ -f "$keychain" ]]; then
    security delete-keychain "$keychain" || status=1
  fi
  rmdir "$keychain_root" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

password=$(openssl rand -base64 32)
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security list-keychains -d user -s "$keychain"
# Seed only this signed test executable's real OSCrypt identity. Source E2E has a separate mock.
security add-generic-password -a 'Open-Science Key' -s 'Open-Science Safe Storage' \
  -w "$(openssl rand -base64 32)" -T "$OPEN_SCIENCE_E2E_EXECUTABLE" "$keychain"

"$@"
