#!/bin/sh
# Chromium's source-test mock key. Loaded only by the explicit E2E Node preload.
case "$1" in
  read-key|create-key) printf 'mock_password' ;;
  *) exit 1 ;;
esac
