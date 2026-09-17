'use strict'

/* eslint-disable @typescript-eslint/no-require-imports -- Exercise the native package with Node's CommonJS test runner, without loading Electron. */
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')

test(
  'macOS probe enforces the no-secret and no-interaction contract with fake Security APIs',
  {
    skip: process.platform !== 'darwin'
  },
  (t) => {
    const source = join(__dirname, '..', 'src', 'credential_identity_probe.cc')
    assert.ok(existsSync(source), 'missing native metadata probe implementation')
    const temporary = mkdtempSync(join(tmpdir(), 'credential-probe-fixtures-'))
    try {
      // Only this injected fixture binary is executed; the production helper is never run.
      const fixture = join(temporary, 'credential-probe-fixtures')
      execFileSync(
        'xcrun',
        [
          'clang++',
          '-std=c++17',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Wno-deprecated-declarations',
          '-framework',
          'Security',
          '-framework',
          'CoreFoundation',
          join(__dirname, 'security_fixture.cc'),
          '-o',
          fixture
        ],
        { stdio: 'pipe' }
      )
      const result = execFileSync(fixture, [], { encoding: 'utf8' })
      assert.match(result, /passed \d+ fixture scenarios/)
      t.diagnostic(result.trim())
      // Compile and link the actual entry point without running or querying the user's keychain.
      execFileSync(
        'xcrun',
        [
          'clang++',
          '-std=c++17',
          '-Wall',
          '-Wextra',
          '-Werror',
          '-Wno-deprecated-declarations',
          '-framework',
          'Security',
          '-framework',
          'CoreFoundation',
          source,
          '-o',
          join(temporary, 'credential_identity_probe')
        ],
        { stdio: 'pipe' }
      )
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
  }
)
