import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildNotebookHost, prepareBackendStage } from './build-notebook-host.mjs'

describe('Windows backend staging preparation', () => {
  it.each(['out/desktop-backend', 'out/standalone'])(
    'builds the helper before replacing %s',
    async (stage) => {
      const calls: string[] = []
      await prepareBackendStage({
        platform: 'win32',
        stage,
        buildHost: () => calls.push('build'),
        removeStage: async () => calls.push('remove')
      })
      expect(calls).toEqual(['build', 'remove'])
    }
  )

  it('preserves the existing stage when the helper build fails', async () => {
    const calls: string[] = []
    await expect(
      prepareBackendStage({
        platform: 'win32',
        stage: 'out/standalone',
        buildHost: () => {
          calls.push('build')
          throw new Error('compiler unavailable')
        },
        removeStage: async () => calls.push('remove')
      })
    ).rejects.toThrow('compiler unavailable')
    expect(calls).toEqual(['build'])
  })

  it('leaves non-Windows staging unchanged', async () => {
    const calls: string[] = []
    await prepareBackendStage({
      platform: 'darwin',
      stage: 'out/standalone',
      buildHost: () => calls.push('build'),
      removeStage: async () => calls.push('remove')
    })
    expect(calls).toEqual(['remove'])
  })

  it('builds the target architecture and reports missing tools with recovery steps', () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = []
    expect(
      buildNotebookHost({
        platform: 'win32',
        architecture: 'arm64',
        run: (command: string, args: string[], options: unknown) => {
          calls.push({ command, args, options })
        }
      })
    ).toBe(true)
    expect(calls).toEqual([
      {
        command: process.execPath,
        args: [resolve('packages/notebook-network-sandbox/vendor/windows/build.mjs'), 'arm64'],
        options: { stdio: 'inherit', windowsHide: true }
      }
    ])

    expect(() =>
      buildNotebookHost({
        platform: 'win32',
        run: () => {
          throw new Error('spawnSync cargo ENOENT')
        }
      })
    ).toThrow('Install Rust Cargo and the Microsoft C++ build tools')
  })
})
