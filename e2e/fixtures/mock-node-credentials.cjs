'use strict'
/* eslint-disable @typescript-eslint/no-require-imports -- Explicit source-test preload only. */
if (!process.versions.electron) {
  if (process.platform !== 'darwin' || !process.env.OPEN_SCIENCE_E2E_STORAGE_ROOT)
    throw new Error('The Node credential fixture requires an isolated macOS source E2E run.')
  const { join } = require('node:path')
  const probe = require('@aipoch/credential-identity-probe-native')
  probe.executablePath = join(__dirname, 'mock-credential-identity.sh')
  probe.secretExecutablePath = join(__dirname, 'mock-node-secret.sh')
}
