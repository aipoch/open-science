#!/usr/bin/env bash
# Fetch the same reviewed tools and framework for packaging and patch generation.
set -euo pipefail
dest=$1
mkdir -p "$dest"
archive="$dest/Sparkle-2.10.1.tar.xz"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 --output "$archive" \
    https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-2.10.1.tar.xz
fi
echo "1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27  $archive" | shasum -a 256 --check
tar -xf "$archive" -C "$dest" ./Sparkle.framework ./bin ./LICENSE
