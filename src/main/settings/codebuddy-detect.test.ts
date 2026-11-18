import { describe, expect, it, vi } from 'vitest'

import { CODEBUDDY_VERSION } from './codebuddy-install'
import { detectCodeBuddy, type CodeBuddyDetectDeps } from './codebuddy-detect'

const deps = (installed: Record<string, string>): CodeBuddyDetectDeps => ({
  env: { PATH: '/usr/bin:/usr/local/bin' },
  homePath: '/home/user',
  platform: 'linux',
  isExecutable: (candidate) => Promise.resolve(candidate in installed),
  getVersion: (candidate) => Promise.resolve(installed[candidate]),
  resolveNpmBinDirs: () => Promise.resolve(['/npm/bin'])
})

describe('codebuddy detection', () => {
  it('finds the primary command on PATH', async () => {
    await expect(
      detectCodeBuddy(deps({ '/usr/local/bin/codebuddy': CODEBUDDY_VERSION }))
    ).resolves.toEqual({ resolvedPath: '/usr/local/bin/codebuddy', version: CODEBUDDY_VERSION })
  })

  it('accepts the package command alias from npm global bin', async () => {
    await expect(
      detectCodeBuddy(deps({ '/npm/bin/codebuddy-code': CODEBUDDY_VERSION }))
    ).resolves.toEqual({
      resolvedPath: '/npm/bin/codebuddy-code',
      version: CODEBUDDY_VERSION
    })
  })

  it('passes cancellation through directory and version probes', async () => {
    const controller = new AbortController()
    const resolveNpmBinDirs = vi.fn().mockResolvedValue(['/npm/bin'])
    const getVersion = vi.fn().mockResolvedValue(CODEBUDDY_VERSION)

    await detectCodeBuddy(
      {
        ...deps({ '/npm/bin/codebuddy': CODEBUDDY_VERSION }),
        resolveNpmBinDirs,
        getVersion
      },
      controller.signal
    )

    expect(resolveNpmBinDirs).toHaveBeenCalledWith(controller.signal)
    expect(getVersion).toHaveBeenCalledWith('/npm/bin/codebuddy', controller.signal)
  })

  it('rejects versions outside the app-pinned release', async () => {
    await expect(
      detectCodeBuddy(deps({ '/usr/local/bin/codebuddy': '2.139.0' }))
    ).resolves.toBeUndefined()
  })
})
