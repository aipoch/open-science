import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { EnvironmentStateTracker } from './environment-state-tracker'

let dataRoot: string | undefined

afterEach(async () => {
  if (dataRoot) await rm(dataRoot, { recursive: true, force: true })
  dataRoot = undefined
})

const target = {
  language: 'python' as const,
  environmentName: 'external-analysis',
  runtimeSource: 'external' as const,
  command: '/opt/python/bin/python',
  args: []
}

describe('EnvironmentStateTracker', () => {
  it('reuses immutable installed inventory while capturing fresh live-Kernel state per run', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-state-'))
    const inspectInstalled = vi.fn().mockResolvedValue({
      runtimeVersion: '3.13.2',
      platform: 'linux',
      architecture: 'aarch64',
      packages: [
        {
          name: 'numpy',
          version: '2.2.0',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-importlib-metadata']
        }
      ]
    })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    const first = await tracker.captureCompletedRun(target, {
      runtimeVersion: '3.13.2',
      packages: [
        {
          name: 'numpy',
          version: '2.2.0',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-kernel-modules'],
          loadedState: 'loaded'
        }
      ]
    })
    const second = await tracker.captureCompletedRun(target, {
      runtimeVersion: '3.13.2',
      packages: [
        {
          name: 'pandas',
          version: '2.2.3',
          versionStatus: 'known',
          ecosystem: 'python',
          evidenceSources: ['python-kernel-modules'],
          loadedState: 'loaded'
        }
      ]
    })

    expect(inspectInstalled).toHaveBeenCalledOnce()
    expect(first.manifest.installedInventory.source).toBe('full-scan')
    expect(second.manifest.installedInventory.source).toBe('cache-reused')
    expect(second.manifest).toMatchObject({
      complete: false,
      captureStatus: 'partial',
      installedInventory: { validation: 'best-effort' }
    })
    expect(second.manifest.warnings).toContain('inventory-cache-best-effort')
    expect(first.manifest).toMatchObject({ platform: 'linux', architecture: 'aarch64' })
    expect(second.manifest.packages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'numpy', loadedState: 'installed-only' }),
        expect.objectContaining({ name: 'pandas', loadedState: 'loaded' })
      ])
    )
    expect(first.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(second.checksum).toMatch(/^[a-f0-9]{64}$/)
    await expect(readFile(first.storagePath, 'utf8')).resolves.toBe(
      `${JSON.stringify(first.manifest, null, 2)}\n`
    )
  })

  it('refreshes the inventory once after one logical package mutation', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-mutation-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'cli',
            version: '3.6.3',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          },
          {
            name: 'rlang',
            version: '1.1.4',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          }
        ]
      })
      .mockResolvedValueOnce({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'cli',
            version: '3.6.3',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          },
          {
            name: 'ggplot2',
            version: '3.5.2',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          },
          {
            name: 'rlang',
            version: '1.1.5',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          },
          {
            name: 'scales',
            version: '1.3.0',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          }
        ]
      })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-r')
    })
    const rTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: '/runtime/default-r/bin/Rscript',
      args: []
    }
    await tracker.captureCompletedRun(rTarget)

    await tracker.markPackageMutationDirty(rTarget, {
      operationId: 'operation-1',
      operation: 'install',
      packages: ['ggplot2']
    })
    await tracker.refreshAfterPackageMutation(rTarget, {
      operationId: 'operation-1',
      operation: 'install',
      packages: ['ggplot2'],
      result: 'success',
      fallbackUsed: true,
      attempts: [
        {
          groupOrdinal: 0,
          installer: 'conda',
          packages: ['r-ggplot2'],
          status: 'failed',
          mutationRisk: 'none',
          reason: 'package-not-found'
        },
        {
          groupOrdinal: 1,
          installer: 'r-install-packages',
          packages: ['ggplot2'],
          status: 'succeeded',
          mutationRisk: 'confirmed'
        }
      ]
    })
    const capture = await tracker.captureCompletedRun(rTarget)

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    expect(capture.manifest.packages).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'ggplot2', version: '3.5.2' })])
    )
    expect(capture.manifest.operationLog).toEqual([
      expect.objectContaining({
        operationId: 'operation-1',
        result: 'success',
        fallbackUsed: true,
        inventoryRefresh: 'published',
        inventoryRefreshAttempts: [expect.objectContaining({ result: 'published' })],
        packageChanges: [
          expect.objectContaining({
            name: 'ggplot2',
            relationship: 'requested',
            change: 'installed',
            afterVersion: '3.5.2'
          }),
          expect.objectContaining({
            name: 'rlang',
            relationship: 'unattributed',
            change: 'updated',
            beforeVersion: '1.1.4',
            afterVersion: '1.1.5'
          }),
          expect.objectContaining({
            name: 'scales',
            relationship: 'unattributed',
            change: 'installed',
            afterVersion: '1.3.0'
          })
        ],
        attempts: [
          expect.objectContaining({ installer: 'conda', status: 'failed' }),
          expect.objectContaining({ installer: 'r-install-packages', status: 'succeeded' })
        ]
      })
    ])
    const manifestDirectory = join(dataRoot, 'runtime', 'provenance', 'environment-manifests')
    const manifests = await Promise.all(
      (await readdir(manifestDirectory)).map(
        async (name) =>
          JSON.parse(await readFile(join(manifestDirectory, name), 'utf8')) as {
            captureKind?: string
            operationLog?: Array<{ operationId?: string }>
          }
      )
    )
    expect(manifests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          captureKind: 'operation',
          operationLog: [expect.objectContaining({ operationId: 'operation-1' })]
        })
      ])
    )
  })

  it('forces a terminal rescan and marks evidence partial when package state changes during a run', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-fingerprint-'))
    const inspectInstalled = vi.fn().mockResolvedValue({
      runtimeVersion: '3.13.2',
      packages: []
    })
    const captureFingerprint = vi
      .fn()
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after')
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint
    })

    const start = await tracker.prepareRun(target)
    const capture = await tracker.captureCompletedRun(
      target,
      { runtimeVersion: '3.13.2', packages: [] },
      start
    )

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    expect(capture.manifest).toMatchObject({
      captureStatus: 'partial',
      complete: false,
      installedInventory: { source: 'full-scan' }
    })
    expect(capture.manifest.warnings).toContain('environment-changed-during-run')
  })

  it('recovers a durable pending package operation before allowing the next run', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-recovery-'))
    const initial = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({ runtimeVersion: '3.13.2', packages: [] }),
      captureFingerprint: vi.fn().mockResolvedValue('before-install')
    })
    await initial.captureCompletedRun(target)
    await initial.markPackageMutationDirty(target, {
      operationId: 'operation-crashed',
      operation: 'install',
      packages: ['pandas']
    })

    const blocked = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('environment still locked')),
      captureFingerprint: vi.fn().mockResolvedValue('unknown')
    })
    await expect(blocked.prepareRun(target)).rejects.toThrow(/recovery failed before Notebook/)

    const recovered = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'pandas',
            version: '2.3.3',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('after-install')
    })
    const recoveredStart = await recovered.prepareRun(target)
    expect(recoveredStart).toMatchObject({
      fingerprint: 'after-install',
      inventoryRefreshed: true
    })
    const recoveredCapture = await recovered.captureCompletedRun(
      target,
      { runtimeVersion: '3.13.2', packages: [] },
      recoveredStart
    )
    expect(recoveredCapture.manifest.operationLog).toEqual([
      expect.objectContaining({
        operationId: 'operation-crashed',
        packageChanges: [
          expect.objectContaining({
            name: 'pandas',
            relationship: 'requested',
            change: 'installed',
            afterVersion: '2.3.3'
          })
        ]
      })
    ])
  })

  it('records an explicit partial manifest when an external Runtime cannot be inspected', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-partial-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('interpreter unavailable')),
      captureFingerprint: vi.fn().mockResolvedValue(undefined)
    })

    const capture = await tracker.captureCompletedRun(target)

    expect(capture.manifest).toMatchObject({
      runtimeSource: 'external',
      complete: false,
      captureStatus: 'partial',
      packages: []
    })
    expect(capture.manifest.warnings?.join(' ')).toMatch(/interpreter unavailable/)
  })

  it('preserves same-named R packages installed in different library ranks', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-r-libraries-'))
    const rTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: '/runtime/default-r/bin/Rscript',
      args: []
    }
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'rlang',
            version: '1.1.6',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            libraryRank: 1,
            libraryScope: 'environment'
          },
          {
            name: 'rlang',
            version: '1.1.5',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            libraryRank: 2,
            libraryScope: 'user'
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-r-libraries')
    })

    const capture = await tracker.captureCompletedRun(rTarget, {
      runtimeVersion: '4.5.1',
      packages: [
        {
          name: 'rlang',
          version: '1.1.6',
          versionStatus: 'known',
          ecosystem: 'r',
          evidenceSources: ['r-session-info'],
          loadedState: 'loaded',
          libraryRank: 1
        }
      ]
    })

    expect(capture.manifest.packages).toEqual([
      expect.objectContaining({
        name: 'rlang',
        version: '1.1.6',
        libraryRank: 1,
        libraryScope: 'environment',
        loadedState: 'loaded'
      }),
      expect.objectContaining({
        name: 'rlang',
        version: '1.1.5',
        libraryRank: 2,
        libraryScope: 'user',
        loadedState: 'installed-only'
      })
    ])
  })
})
