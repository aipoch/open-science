import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { beforeAll, describe, it } from 'vitest'

const require = createRequire(import.meta.url)
describe.skipIf(process.platform !== 'win32')('native Windows update presentation', () => {
  beforeAll(() => {
    execFileSync(
      process.execPath,
      [
        require.resolve('node-gyp/bin/node-gyp.js'),
        'rebuild',
        '--directory',
        resolve('build/windows-update-progress')
      ],
      { stdio: 'pipe', timeout: 120_000 }
    )
  }, 130_000)
  it.each(['success', 'installer-failure', 'cancel', 'unconfirmed'])(
    'runs the real native companion through %s',
    (scenario) => {
      execFileSync(
        process.execPath,
        [resolve('scripts/fixtures/windows-update-progress/run.mjs'), scenario],
        { stdio: 'pipe', timeout: 120_000 }
      )
    },
    130_000
  )
})
