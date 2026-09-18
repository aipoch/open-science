import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

it('signs the unpacked credential executables before signing the outer macOS application', async () => {
  const app = '/fixture/Open-Science.app'
  const calls: string[][] = []
  const exports: { default?: (context: unknown) => Promise<void> } = {}
  runInNewContext(readFileSync('build/adhoc-sign.cjs', 'utf8'), {
    exports,
    __dirname: '/fixture/build',
    console: { log: vi.fn() },
    require: (id: string) => {
      if (id === 'node:path') return { join, basename: (value: string) => value.split('/').at(-1) }
      if (id === 'node:fs') return { existsSync: () => true }
      if (id === 'node:child_process')
        return { execFileSync: (_command: string, args: string[]) => calls.push(args) }
      throw new Error(`Unexpected module ${id}`)
    }
  })
  await exports.default!({
    electronPlatformName: 'darwin',
    appOutDir: '/fixture',
    packager: { appInfo: { productFilename: 'Open-Science' } }
  })
  const packageDirectory = join(
    app,
    'Contents/Resources/app.asar.unpacked/node_modules/@aipoch/credential-identity-probe-native/build/Release'
  )
  for (const executable of ['credential_identity_probe', 'credential_key_validator']) {
    const position = calls.findIndex((args) => args.at(-1) === join(packageDirectory, executable))
    expect(position, executable).toBeGreaterThanOrEqual(0)
    expect(position).toBeLessThan(calls.findIndex((args) => args.at(-1) === app))
  }
})
