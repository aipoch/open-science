#!/bin/sh
# Metadata for Chromium's deterministic mock Keychain; never read the host Keychain.
case "$1" in
  'Open-Science'|'Open-Science (DEV)'|'Open Science'|'Open Science (DEV)') ;;
  *) exit 1 ;;
esac
printf '{"schemaVersion":1,"platform":"darwin","identity":"%s","status":"exists"}\n' "$1"
