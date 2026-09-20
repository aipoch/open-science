import { describe, expect, it, vi } from 'vitest'

import type { NotebookProcessSandbox } from '../notebook/process-sandbox'
import { runPackagedWsl2RestartCertification } from './wsl2-packaged-restart-certification'

const certificationEnvironment = (): Record<string, string | undefined> => ({
  OPEN_SCIENCE_E2E_STORAGE_ROOT: 'C:\\certification\\data',
  OPEN_SCIENCE_E2E_WSL2_RESTART_CERTIFICATION: '1',
  OPEN_SCIENCE_E2E_WSL2_PROFILE_ID: 'packaged-preview-v1',
  OPEN_SCIENCE_E2E_WSL2_DISTRO: 'Ubuntu-22.04',
  OPEN_SCIENCE_E2E_WSL2_USER: 'researcher'
})

const admittedInput = (
  processSandbox: NotebookProcessSandbox
): Parameters<typeof runPackagedWsl2RestartCertification>[0] => ({
  appPackaged: true,
  headless: true,
  platform: 'win32' as const,
  arch: 'x64',
  previewAvailable: true,
  storageRoot: 'C:\\certification\\data',
  environment: certificationEnvironment(),
  processSandbox
})

describe('packaged WSL2 restart certification', () => {
  it('is inert unless the explicit E2E certification switch is present', async () => {
    const wrap = vi.fn<NotebookProcessSandbox['wrap']>()
    const input = { ...admittedInput({ wrap }), environment: {} }

    await expect(runPackagedWsl2RestartCertification(input)).resolves.toBe(false)
    expect(wrap).not.toHaveBeenCalled()
  })

  it.each([
    { appPackaged: false },
    { headless: false },
    { platform: 'linux' as const },
    { arch: 'arm64' },
    { previewAvailable: false },
    { storageRoot: 'C:\\different\\data' }
  ])('fails closed when certification authority is incomplete: %j', async (override) => {
    const input = {
      ...admittedInput({ wrap: vi.fn<NotebookProcessSandbox['wrap']>() }),
      ...override
    }

    await expect(runPackagedWsl2RestartCertification(input)).rejects.toThrow(
      /Packaged WSL2 restart certification is unavailable/
    )
  })

  it.skipIf(process.platform !== 'win32')(
    'runs real sandbox preparation without spawning a command and verifies cleanup',
    async () => {
      const notStarted = vi.fn()
      const cleanup = vi.fn().mockResolvedValue({
        processesTerminated: true,
        networkClosed: true,
        temporaryResourcesRemoved: true
      })
      const wrap = vi.fn<NotebookProcessSandbox['wrap']>().mockResolvedValue({
        executable: 'wsl.exe',
        args: [],
        env: {},
        beginSpawn: () => ({ started: vi.fn(), notStarted }),
        annotateStderr: (value: string) => value,
        cleanup
      })

      await expect(runPackagedWsl2RestartCertification(admittedInput({ wrap }))).resolves.toBe(true)

      expect(wrap).toHaveBeenCalledWith(
        expect.objectContaining({
          target: {
            kind: 'wsl2',
            profileId: 'packaged-preview-v1',
            distro: 'Ubuntu-22.04',
            user: 'researcher'
          },
          executable: '/bin/bash',
          args: ['-c', 'true'],
          cwd: 'C:\\certification\\data'
        })
      )
      expect(notStarted).toHaveBeenCalledOnce()
      expect(cleanup).toHaveBeenCalledWith('spawn-failed', { processesTerminated: true })
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'fails closed when sandbox cleanup cannot be fully verified',
    async () => {
      const wrap = vi.fn<NotebookProcessSandbox['wrap']>().mockResolvedValue({
        executable: 'wsl.exe',
        args: [],
        env: {},
        beginSpawn: () => ({ started: vi.fn(), notStarted: vi.fn() }),
        annotateStderr: (value: string) => value,
        cleanup: vi.fn().mockResolvedValue({
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: false
        })
      })

      await expect(runPackagedWsl2RestartCertification(admittedInput({ wrap }))).rejects.toThrow(
        'SHELL_CLEANUP_INCOMPLETE'
      )
    }
  )
})
