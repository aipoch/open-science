import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Exercise the actual shell lifecycle without accessing the host's Keychain.
describe.skipIf(process.platform === 'win32')('packaged macOS test Keychain', () => {
  it.each(['success', 'test-failure', 'setup-failure', 'restore-failure'])(
    'restores the search list and deletes only its own Keychain after %s',
    (scenario) => {
      const root = mkdtempSync(join(tmpdir(), 'packaged-keychain-contract-'))
      try {
        const security = join(root, 'security')
        const log = join(root, 'calls.jsonl')
        writeFileSync(
          security,
          `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.KEYCHAIN_TEST_LOG, JSON.stringify(args) + '\\n')
if (args[0] === 'list-keychains' && !args.includes('-s')) {
  console.log('    "/original/login.keychain-db"\\n    "/original/with spaces.keychain-db"')
}
if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), '')
if (args[0] === 'delete-keychain') fs.unlinkSync(args.at(-1))
if (process.env.KEYCHAIN_TEST_SCENARIO === 'setup-failure' && args[0] === 'add-generic-password') process.exit(7)
if (process.env.KEYCHAIN_TEST_SCENARIO === 'restore-failure' && args.includes('-s') && args.includes('/original/login.keychain-db')) process.exit(8)
`
        )
        chmodSync(security, 0o755)
        const result = spawnSync(
          'bash',
          [
            resolve('scripts/ci/run-macos-packaged-e2e.sh'),
            process.execPath,
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'ran'))}, 'yes'); process.exit(${scenario === 'test-failure' ? 9 : 0})`
          ],
          {
            env: {
              ...process.env,
              GITHUB_ACTIONS: 'true',
              RUNNER_OS: 'macOS',
              RUNNER_TEMP: root,
              OPEN_SCIENCE_E2E_EXECUTABLE: process.execPath,
              PATH: `${root}${delimiter}${process.env.PATH}`,
              KEYCHAIN_TEST_LOG: log,
              KEYCHAIN_TEST_SCENARIO: scenario
            },
            encoding: 'utf8'
          }
        )
        expect(result.status, result.stderr).toBe(
          { success: 0, 'test-failure': 9, 'setup-failure': 7, 'restore-failure': 1 }[scenario]
        )
        const calls: string[][] = readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const created = calls.find((args) => args[0] === 'create-keychain')!.at(-1)!
        expect(created.startsWith(join(root, 'open-science-p0-keychain.'))).toBe(true)
        expect(calls.at(-2)).toEqual([
          'list-keychains',
          '-d',
          'user',
          '-s',
          '/original/login.keychain-db',
          '/original/with spaces.keychain-db'
        ])
        expect(calls.filter((args) => args[0] === 'delete-keychain')).toEqual([
          ['delete-keychain', created]
        ])
        const seed = calls.find((args) => args[0] === 'add-generic-password')!
        expect(seed.slice(0, 5)).toEqual([
          'add-generic-password',
          '-a',
          'Open-Science Key',
          '-s',
          'Open-Science Safe Storage'
        ])
        expect(seed.slice(-3)).toEqual(['-T', process.execPath, created])
        expect(seed).not.toContain('-A')
        expect(readdirSync(root).some((name) => name.startsWith('open-science-p0-keychain.'))).toBe(
          false
        )
        expect(readdirSync(root).includes('ran')).toBe(scenario !== 'setup-failure')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
