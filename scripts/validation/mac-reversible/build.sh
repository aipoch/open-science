#!/bin/bash
set -euo pipefail
"${ESBUILD:-$RUNNER_TEMP/tools/node_modules/.bin/esbuild}" scripts/validation/mac-reversible/driver.ts --bundle --platform=node --format=cjs --outfile="$DRIVER" \
  --alias:@aipoch/durable-files=./packages/durable-files/src/index.ts \
  --alias:@aipoch/diagnostics/node=./packages/diagnostics/src/node.ts \
  --alias:zod="$ZOD" --external:@aipoch/process-tree-native --external:electron --external:original-fs
