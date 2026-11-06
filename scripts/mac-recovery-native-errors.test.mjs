import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'

const root = fs.mkdtempSync(join(tmpdir(), 'mac-recovery-errors-'))
const executable = join(root, 'classifier')
after(() => fs.rmSync(root, { recursive: true, force: true }))
if (process.platform === 'darwin')
  execFileSync('/usr/bin/xcrun', [
    'clang',
    '-fobjc-arc',
    '-DOPEN_SCIENCE_MAC_ENTRY_TESTING=1',
    '-Wno-deprecated-declarations',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-framework',
    'AppKit',
    '-framework',
    'Security',
    '-lsqlite3',
    resolve('build/mac-recovery-launcher.m'),
    '-o',
    executable
  ])

for (const [stage, category, action] of [
  ['recovery-original-package-unavailable', 'package', /network connection/],
  ['recovery-target-publish-failed', 'storage', /disk space.*whether this account can write/],
  ['recovery-owner-still-active', 'coordination', /Quit other copies normally/],
  ['recovery-request-binding-mismatch', 'identity', /Copy diagnostics for support/],
  ['entry-runtime-launch-failed', 'startup', /Retry/]
])
  test(
    `native error ${category} gives an effective action without exposing the raw stage`,
    { skip: process.platform !== 'darwin' },
    () => {
      const result = JSON.parse(
        execFileSync(executable, ['--explain-stage', stage], { encoding: 'utf8' })
      )
      assert.equal(result.category, category)
      assert.match(result.description, action)
      assert.equal(result.description.includes(stage), false)
      assert.match(result.diagnostics, new RegExp(`stage=${stage}`))
      for (const key of ['launcherVersion', 'targetVersion', 'operationId'])
        assert.ok(result.diagnostics.includes(`${key}=unknown`))
      assert.doesNotMatch(result.description, /permission denied|external process|files are in use/)
    }
  )

test('native bootstrap has independent complete strings and placeholder parity in all eight locales', () => {
  createRequire(import.meta.url)('../build/mac-recovery-localizations.cjs')(root)
  const native = fs.readFileSync(resolve('build/mac-recovery-launcher.m'), 'utf8')
  const expected = [
    ...new Set([...native.matchAll(/NSLocalizedString\(@"([^"]+)"/g)].map((match) => match[1]))
  ].sort()
  for (const locale of ['en', 'de', 'es', 'fr', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'ru']) {
    const values = new Map(
      fs
        .readFileSync(join(root, `${locale}.lproj/Localizable.strings`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
          const match = /^(".*") = (".*");$/.exec(line)
          assert.ok(match, `${locale}: valid native strings entry`)
          return [JSON.parse(match[1]), JSON.parse(match[2])]
        })
    )
    assert.deepEqual([...values.keys()].sort(), expected, `${locale}: complete source keys`)
    for (const [key, value] of values) {
      assert.ok(value.trim(), `${locale}: nonempty ${key}`)
      assert.deepEqual(
        value.match(/\{\{[^}]+\}\}/g) ?? [],
        key.match(/\{\{[^}]+\}\}/g) ?? [],
        `${locale}: placeholders ${key}`
      )
    }
  }
})
