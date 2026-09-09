import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

// Requires the real versioned NSIS fixture built by fixtures/windows-update-notice/build.mjs.
// Opt in on a Windows desktop at medium integrity. Portable CI does not certify native dialogs.
const fixture = process.env.OPEN_SCIENCE_UPDATE_NOTICE_FIXTURE
describe.skipIf(process.platform !== 'win32' || !fixture)('Windows update failure notice', () => {
  const root = resolve(fixture ?? '.')
  const runner = join(root, 'notice-regression.exe')
  const env = { ...process.env }
  beforeAll(() => {
    expect(
      readFileSync(join(root, '0.26.0/installer.nsh'), 'utf8'),
      'Rebuild the native fixture after changing build/installer.nsh.'
    ).toBe(readFileSync('build/installer.nsh', 'utf8'))
    for (const [key, directory] of Object.entries({
      TEMP: 'temp',
      TMP: 'temp',
      APPDATA: 'profile/roaming',
      LOCALAPPDATA: 'profile/local'
    })) {
      env[key] = join(root, directory)
      mkdirSync(env[key]!, { recursive: true })
    }
    const compiler = join(process.env.WINDIR!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
    const result = spawnSync(
      compiler,
      [
        '/nologo',
        `/out:${runner}`,
        resolve('scripts/fixtures/windows-update-notice/NoticeRegression.cs')
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })
  it.each(['denied', 'locked', 'locked-retry', 'denied-silent', 'locked-silent'])(
    '%s: explains interactive failure and preserves safe installer behavior',
    (scenario) => {
      const result = spawnSync(runner, [root, scenario], {
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 90000
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain(`PASS: ${scenario}`)
    },
    95000
  )
})
