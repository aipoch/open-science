'use strict'

// Resolve the standalone executable only. Importing this package never accesses the keychain.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Native packages expose CommonJS entry points.
const { join } = require('node:path')
module.exports.executablePath = join(
  __dirname,
  'build',
  'Release',
  process.platform === 'win32' ? 'credential_identity_probe.exe' : 'credential_identity_probe'
)
module.exports.validatorExecutablePath = join(
  __dirname,
  'build',
  'Release',
  process.platform === 'win32' ? 'credential_key_validator.exe' : 'credential_key_validator'
)
