#!/usr/bin/env bash
# Inputs are completed signed release artifacts. All GitHub operations here are read-only.
set -euo pipefail
artifacts=$1
target=$(node -p 'require("./package.json").version')
previous=$(gh release list --repo "$GITHUB_REPOSITORY" --exclude-drafts --exclude-pre-releases --limit 100 \
  --json tagName --jq '.[].tagName' | python3 -c '
import re, sys
def version(v): return tuple(map(int, v.split(".")))
target = version(sys.argv[1])
candidates = [v[1:] for line in sys.stdin if re.fullmatch(r"v\d+\.\d+\.\d+", v := line.strip()) and version(v[1:]) < target]
print(max(candidates, key=version, default=""))
' "$target")
if [[ -z "$previous" ]]; then
  echo "No previous stable release for Windows delta"
  exit 0
fi
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
gh release download "v$previous" --repo "$GITHUB_REPOSITORY" --pattern '*-win-x64-setup.exe' --pattern latest.yml --dir "$stage/previous"
gh release download v5.1.3 --repo sisong/HDiffPatch --pattern hdiffpatch_v5.1.3_bin_linux64.zip --dir "$stage"
echo "628963bf2ee9108a97260fa5eef44acd9ec94369b76090a957c9182b3abbb558  $stage/hdiffpatch_v5.1.3_bin_linux64.zip" | sha256sum --check
unzip -j "$stage/hdiffpatch_v5.1.3_bin_linux64.zip" '*/hdiffz' -d "$stage"
chmod +x "$stage/hdiffz"
python3 build/windows-delta/build.py "$stage/tools"
node build/windows-delta/publish.mjs "$stage/previous" "$artifacts" "$stage/tools/bin/windows-delta" "$stage/hdiffz"
