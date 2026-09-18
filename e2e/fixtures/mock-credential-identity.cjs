'use strict'

/* eslint-disable @typescript-eslint/no-require-imports -- Electron source-test preload. */
const { app } = require('electron')
const { join } = require('node:path')

// Chromium's mock Keychain supplies a deterministic key across test-process restarts. Match
// its metadata without querying the host Keychain. Only source E2E explicitly loads this file;
// production and packaged certification retain the real native probe and its recovery guards.
if (
  process.platform !== 'darwin' ||
  app.isPackaged ||
  !app.commandLine.hasSwitch('use-mock-keychain')
) {
  throw new Error('The credential metadata fixture requires a source macOS mock-Keychain launch.')
}
require('@aipoch/credential-identity-probe-native').executablePath = join(
  __dirname,
  'mock-credential-identity.sh'
)
