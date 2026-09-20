'use strict'

/* eslint-disable @typescript-eslint/no-require-imports -- Compile native fake-API fixtures with Node without starting Electron. */
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')

test(
  'Windows key validator verifies and clears only injected CryptoAPI output',
  {
    skip: process.platform !== 'darwin' && process.platform !== 'linux'
  },
  () => {
    const source = join(__dirname, '..', 'src', 'credential_key_validator.cc')
    assert.ok(existsSync(source), 'missing standalone Windows key validator')
    const temporary = mkdtempSync(join(tmpdir(), 'credential-validator-fixtures-'))
    const command = process.platform === 'darwin' ? 'xcrun' : 'c++'
    const compiler = process.platform === 'darwin' ? ['clang++'] : []
    try {
      const fixture = join(temporary, 'credential-validator-fixtures')
      execFileSync(
        command,
        [
          ...compiler,
          '-std=c++17',
          '-Wall',
          '-Wextra',
          '-Werror',
          join(__dirname, 'crypto_fixture.cc'),
          '-o',
          fixture
        ],
        { stdio: 'pipe' }
      )
      assert.match(
        execFileSync(fixture, [], { encoding: 'utf8' }),
        /passed 10 CryptoAPI fixture scenarios/
      )
      // Link the production entry point without running it. Windows linkage requires Windows CI.
      execFileSync(
        command,
        [
          ...compiler,
          '-std=c++17',
          '-Wall',
          '-Wextra',
          '-Werror',
          source,
          '-o',
          join(temporary, 'credential_key_validator')
        ],
        { stdio: 'pipe' }
      )
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
)
