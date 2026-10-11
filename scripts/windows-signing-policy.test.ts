import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { windowsSigningBuildDefines } from './windows-signing-policy.mjs'

describe('Windows signing build policy', () => {
  it('serializes the release publisher as data and preserves punctuation', () => {
    const publisher = 'Example "Company" O\'Brien'
    expect(
      JSON.parse(
        windowsSigningBuildDefines({ AZURE_SIGNING_PUBLISHER: ` ${publisher} ` })
          .__OPEN_SCIENCE_WINDOWS_SIGNING_PUBLISHER__
      )
    ).toBe(publisher)
  })
  it.each([undefined, '', '  '])('omits trust when release publisher is %j', (publisher) => {
    expect(windowsSigningBuildDefines({ AZURE_SIGNING_PUBLISHER: publisher })).toEqual({
      __OPEN_SCIENCE_WINDOWS_SIGNING_PUBLISHER__: 'null'
    })
  })
  it.each(['electron.vite.config.ts', 'scripts/build-backend.mjs'])(
    'binds release trust in %s',
    (file) => {
      expect(readFileSync(resolve(file), 'utf8')).toContain(
        '...windowsSigningBuildDefines(process.env)'
      )
    }
  )
})

it('embeds trust in a consumed host bundle independently of runtime configuration', async () => {
  const { build } = await import('esbuild')
  const { createRequire } = await import('node:module')
  const { runInNewContext } = await import('node:vm')
  for (const publisher of ['Configured Release Company', undefined]) {
    const output = await build({
      entryPoints: ['src/main/windows-executable-trust.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      define: windowsSigningBuildDefines({ AZURE_SIGNING_PUBLISHER: publisher })
    })
    const module = { exports: {} as typeof import('../src/main/windows-executable-trust') }
    runInNewContext(output.outputFiles[0].text, {
      module,
      exports: module.exports,
      require: createRequire(import.meta.url)
    })
    const verify = module.exports.createWindowsExecutableVerifier({
      env: { SystemRoot: 'C:\\Windows', AZURE_SIGNING_PUBLISHER: 'Runtime Override' },
      execute: (async () => ({
        stdout: JSON.stringify({
          status: 'Valid',
          publisher: 'Configured Release Company',
          timestamped: true
        }),
        stderr: ''
      })) as never
    })
    if (publisher) await expect(verify('candidate.exe')).resolves.toBeUndefined()
    else await expect(verify('candidate.exe')).rejects.toThrow(/configured publisher/)
  }
})
