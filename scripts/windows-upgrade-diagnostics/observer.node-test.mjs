import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const directory = fileURLToPath(new URL('.', import.meta.url))
const output = resolve(process.env.UPGRADE_DIAGNOSTIC_OUTPUT || 'test-results/upgrade-diagnostics')

for (const [name, script, args, utf8Input] of [
  ['account residual classification', 'test-account-classification.ps1', []],
  ['operation binding', 'test-observer-operation.ps1', []],
  ['fallback operation binding', 'test-observer-operation.ps1', ['-Fallback']],
  ['operation binding with UTF-8 input', 'test-observer-operation.ps1', [], true],
  ['limited query rights', 'test-observer-read-access.ps1', []],
  ['image query recovery and strict completion', 'test-observer-pending-image.ps1', []],
  ...['before-open', 'after-open', 'exited-access-error', 'observation-error'].map((stage) => [
    `exit race ${stage}`,
    'test-observer-exit-race.ps1',
    ['-Stage', stage]
  ])
]) {
  test(name, { skip: process.platform !== 'win32' }, () => {
    mkdirSync(output, { recursive: true })
    const evidence = resolve(output, `${name.replaceAll(' ', '-')}.json`)
    const scriptLiteral = `'${resolve(directory, script).replaceAll("'", "''")}'`
    const evidenceLiteral = `'${evidence.replaceAll("'", "''")}'`
    const invocation = utf8Input
      ? [
          '-Command',
          `[Console]::InputEncoding = [Text.UTF8Encoding]::new($true); & ${scriptLiteral} -Output ${evidenceLiteral}`
        ]
      : ['-File', resolve(directory, script), '-Output', evidence, ...args]
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...invocation],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 }
    )
    assert.equal(result.error, undefined, `Probe failed; retain fixtures/evidence: ${result.error}`)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const record = JSON.parse(readFileSync(evidence, 'utf8').replace(/^\uFEFF/, ''))
    assert.equal(record.status || record.result, 'PASS')
  })
}
