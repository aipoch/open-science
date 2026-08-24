import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookEnvironmentPackage } from '../../shared/notebook'
import { environmentCaptureProcessEnv, EnvironmentStateTracker } from './environment-state-tracker'

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

const bindingPath = async (root: string): Promise<string> => {
  const inventoryRoot = join(root, 'runtime', 'provenance', 'environment-inventory')
  const [targetKey] = await readdir(inventoryRoot)
  return join(inventoryRoot, targetKey, 'binding.json')
}

const readBinding = async (
  root: string
): Promise<{
  operationLog: Array<{ operationId: string; timestamp: string }>
  operationLogTruncation?: { omittedCount: number; earliestRetainedAt?: string }
  dirtyOperationId?: string
}> => {
  return JSON.parse(await readFile(await bindingPath(root), 'utf8'))
}

describe('EnvironmentStateTracker', () => {
  it('activates the complete Windows Conda DLL path for managed R probes', () => {
    const inherited = { Path: 'C:\\Windows\\System32', KEEP_ME: 'yes' }
    const prefix = 'C:\\Users\\Helix\\OpenScience\\runtime\\envs\\.r'

    expect(
      environmentCaptureProcessEnv(
        {
          language: 'r',
          environmentName: 'default-r',
          runtimeSource: 'managed',
          command: `${prefix}\\Lib\\R\\bin\\Rscript.exe`,
          args: [],
          condaPrefix: prefix
        },
        inherited,
        'win32'
      )
    ).toEqual({
      KEEP_ME: 'yes',
      PATH: [
        prefix,
        `${prefix}\\Library\\mingw-w64\\bin`,
        `${prefix}\\Library\\usr\\bin`,
        `${prefix}\\Library\\bin`,
        `${prefix}\\Scripts`,
        `${prefix}\\bin`,
        'C:\\Windows\\System32'
      ].join(';')
    })
  })

  it('passes the activated Windows Conda DLL path to default R inventory and fingerprint spawns', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-r-spawn-'))
    const prefix = 'C:\\Users\\Helix\\OpenScience\\runtime\\envs\\.r'
    const execute = vi.fn(
      async (
        _command: string,
        _args: string[],
        options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }
      ) => ({
        stdout:
          options.maxBuffer === 8 * 1024 * 1024
            ? 'FILE\tconda-meta/history\t1\t1\n'
            : 'RUNTIME\t4.5.1\twin32\tx86_64\n' +
              'PACKAGE\tggplot2\t4.0.0.9000\t\t4.5.1\t1\tenvironment\tgithub\tapi.github.com\ttidyverse\tggplot2\tmain\ta7b92f1\n' +
              'PACKAGE\tfakepkg\t1.0.0\t\t4.5.1\t1\tenvironment\tgitlab\tgitlab.com\tgroup\tfakepkg\tmain\tdeadbeef\n',
        stderr: ''
      })
    )
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      platform: 'win32',
      execFile: execute
    })

    const rTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: `${prefix}\\Lib\\R\\bin\\Rscript.exe`,
      args: [],
      condaPrefix: prefix
    }
    await expect(tracker.prepareRun(rTarget)).resolves.toMatchObject({ inventoryRefreshed: true })
    await expect(tracker.inspectPackages(rTarget, ['ggplot2'])).resolves.toMatchObject({
      packages: [
        {
          name: 'ggplot2',
          version: '4.0.0.9000',
          source: {
            type: 'github',
            repository: 'tidyverse/ggplot2',
            ref: 'main',
            commit: 'a7b92f1'
          }
        }
      ]
    })
    await expect(tracker.inspectPackages(rTarget, ['fakepkg'])).resolves.toMatchObject({
      packages: [{ name: 'fakepkg', version: '1.0.0', status: 'installed' }]
    })
    const fakePackage = (await tracker.inspectPackages(rTarget, ['fakepkg'])).packages[0]
    expect(fakePackage).not.toHaveProperty('source')

    expect(execute).toHaveBeenCalledTimes(6)
    expect(execute.mock.calls.map(([, , options]) => options.maxBuffer)).toEqual([
      8 * 1024 * 1024,
      16 * 1024 * 1024,
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      8 * 1024 * 1024,
      8 * 1024 * 1024
    ])
    for (const [command, , options] of execute.mock.calls) {
      expect(command).toBe(`${prefix}\\Lib\\R\\bin\\Rscript.exe`)
      expect(options.env.PATH).toContain(`${prefix}\\Library\\bin`)
    }
  })

  it('logs bounded child-process diagnostics when an inventory probe fails', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-probe-log-'))
    const warn = vi.fn()
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      logger: { warn, error: vi.fn() },
      inspectInstalled: vi.fn().mockRejectedValue(
        Object.assign(new Error('Rscript failed'), {
          code: 3221225781,
          stderr: 'token=super-secret libgcc_s_seh-1.dll missing',
          stdout: 'probe output'
        })
      ),
      captureFingerprint: vi.fn().mockResolvedValue('stable-r')
    })

    await expect(
      tracker.prepareRun({
        language: 'r',
        environmentName: 'default-r',
        runtimeSource: 'managed',
        command: 'C:\\runtime\\envs\\.r\\Lib\\R\\bin\\Rscript.exe',
        args: [],
        condaPrefix: 'C:\\runtime\\envs\\.r'
      })
    ).resolves.toMatchObject({ inventoryRefreshed: false })

    expect(warn).toHaveBeenCalledWith(
      'environment inventory probe failed',
      expect.objectContaining({
        language: 'r',
        environmentName: 'default-r',
        code: 3221225781,
        stderr: expect.objectContaining({ text: expect.stringContaining('token=[redacted]') })
      })
    )
  })

  it('inspects requested packages from the current installed inventory without importing them', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-inspect-'))
    const inspectInstalled = vi.fn().mockResolvedValue({
      runtimeVersion: '3.13.2',
      packages: [
        {
          name: 'NumPy',
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

    const first = await tracker.inspectPackages(target, ['numpy', 'pandas'])
    const second = await tracker.inspectPackages(target, ['numpy'])

    expect(first).toMatchObject({
      inventory: { source: 'full-scan', validation: 'full-scan' },
      packages: [
        {
          requested: 'numpy',
          name: 'NumPy',
          status: 'installed',
          version: '2.2.0',
          versionStatus: 'known'
        },
        { requested: 'pandas', name: 'pandas', status: 'missing' }
      ]
    })
    expect(second.inventory).toMatchObject({ source: 'cache-reused', validation: 'best-effort' })
    expect(inspectInstalled).toHaveBeenCalledOnce()
  })

  it('inspects an R GitHub spec by repository and ref', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-inspect-github-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'ggplot2',
            version: '4.0.0.9000',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            source: {
              type: 'github',
              repository: 'tidyverse/ggplot2',
              ref: 'main',
              commit: 'abc123'
            }
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-r')
    })
    const rTarget = { ...target, language: 'r' as const, command: '/opt/r/bin/Rscript' }

    const result = await tracker.inspectPackages(rTarget, ['tidyverse/ggplot2@main'])

    expect(result.packages).toEqual([
      expect.objectContaining({
        requested: 'tidyverse/ggplot2@main',
        name: 'ggplot2',
        status: 'installed',
        version: '4.0.0.9000',
        source: expect.objectContaining({ repository: 'tidyverse/ggplot2', ref: 'main' })
      })
    ])
  })

  it('reports unknown instead of missing when installed inventory cannot be read', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-inspect-unavailable-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('interpreter unavailable')),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    const result = await tracker.inspectPackages(target, ['numpy'])

    expect(result).toMatchObject({
      inventory: { source: 'unavailable', validation: 'unavailable' },
      packages: [{ requested: 'numpy', name: 'numpy', status: 'unknown' }]
    })
    expect(result.warnings?.join('\n')).toContain('interpreter unavailable')
  })

  it('captures a baseline before the first package mutation so installs have a verified change', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-first-mutation-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
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

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-first-install',
      operation: 'install',
      packages: ['numpy']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-first-install',
      operation: 'install',
      packages: ['numpy'],
      result: 'success'
    })

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    expect(verification.packageChanges).toEqual([
      expect.objectContaining({
        name: 'numpy',
        relationship: 'requested',
        change: 'installed',
        afterVersion: '2.2.0'
      })
    ])
  })

  it('rejects an installed Python package whose inventory version differs from the exact request', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-version-mismatch-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.1.0',
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

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-version-mismatch',
      operation: 'install',
      packages: ['numpy==2.0.0']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-version-mismatch',
      operation: 'install',
      packages: ['numpy==2.0.0'],
      result: 'success'
    })

    expect(verification).toMatchObject({
      result: 'failure',
      unsatisfiedPackages: ['numpy==2.0.0']
    })
  })

  it('accepts equivalent normalized Python versions for an exact request', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-version-normalized-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.0',
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

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-version-normalized',
      operation: 'install',
      packages: ['numpy==2.0.0']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-version-normalized',
      operation: 'install',
      packages: ['numpy==2.0.0'],
      result: 'success'
    })

    expect(verification.result).toBe('success')
  })

  it('matches a GitHub request to the installed R package source and retains related changes', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-github-mutation-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({ runtimeVersion: '4.5.1', packages: [] })
      .mockResolvedValueOnce({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'ggplot2',
            version: '4.0.0.9000',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages'],
            source: {
              type: 'github',
              repository: 'tidyverse/ggplot2',
              ref: 'main',
              commit: 'a7b92f1'
            }
          },
          {
            name: 'S7',
            version: '0.2.0',
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
      ...target,
      language: 'r' as const,
      command: '/opt/r/bin/Rscript'
    }

    await tracker.markPackageMutationDirty(rTarget, {
      operationId: 'operation-github-install',
      operation: 'install',
      packages: ['tidyverse/ggplot2@main']
    })
    const verification = await tracker.refreshAfterPackageMutation(rTarget, {
      operationId: 'operation-github-install',
      operation: 'install',
      packages: ['tidyverse/ggplot2@main'],
      result: 'success'
    })

    expect(verification).toMatchObject({
      result: 'success',
      packageChanges: [
        {
          name: 'ggplot2',
          relationship: 'requested',
          change: 'installed',
          afterVersion: '4.0.0.9000',
          source: {
            type: 'github',
            repository: 'tidyverse/ggplot2',
            ref: 'main',
            commit: 'a7b92f1'
          }
        },
        {
          name: 'S7',
          relationship: 'unattributed',
          change: 'installed',
          afterVersion: '0.2.0'
        }
      ]
    })
  })

  it('rejects a GitHub package when the installed source has a different requested ref', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-github-ref-mismatch-'))
    const installedPackage = {
      name: 'ggplot2',
      version: '4.0.0.9000',
      versionStatus: 'known' as const,
      ecosystem: 'r' as const,
      evidenceSources: ['r-installed-packages' as const],
      source: {
        type: 'github' as const,
        repository: 'tidyverse/ggplot2',
        ref: 'release'
      }
    }
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi
        .fn()
        .mockResolvedValueOnce({ runtimeVersion: '4.5.1', packages: [] })
        .mockResolvedValueOnce({ runtimeVersion: '4.5.1', packages: [installedPackage] }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-r')
    })
    const rTarget = { ...target, language: 'r' as const, command: '/opt/r/bin/Rscript' }

    await tracker.markPackageMutationDirty(rTarget, {
      operationId: 'operation-github-ref-mismatch',
      operation: 'install',
      packages: ['tidyverse/ggplot2@main']
    })
    const verification = await tracker.refreshAfterPackageMutation(rTarget, {
      operationId: 'operation-github-ref-mismatch',
      operation: 'install',
      packages: ['tidyverse/ggplot2@main'],
      result: 'success'
    })

    expect(verification).toMatchObject({
      result: 'failure',
      unsatisfiedPackages: ['tidyverse/ggplot2@main']
    })
  })

  it('does not classify a Python path package as a GitHub source request', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-python-path-mutation-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi
        .fn()
        .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
        .mockResolvedValueOnce({
          runtimeVersion: '3.13.2',
          packages: [
            {
              name: 'localpkg',
              version: '1.0.0',
              versionStatus: 'known',
              ecosystem: 'python',
              evidenceSources: ['python-importlib-metadata']
            }
          ]
        }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-python-path-install',
      operation: 'install',
      packages: ['./localpkg']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-python-path-install',
      operation: 'install',
      packages: ['./localpkg'],
      result: 'success'
    })

    expect(verification.result).toBe('success')
  })

  it('reports a GitHub ref or commit mutation when the package version is unchanged', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-github-source-change-'))
    const githubPackage = (ref: string, commit: string): NotebookEnvironmentPackage => ({
      name: 'ggplot2',
      version: '4.0.0.9000',
      versionStatus: 'known' as const,
      ecosystem: 'r' as const,
      evidenceSources: ['r-installed-packages' as const],
      source: { type: 'github' as const, repository: 'tidyverse/ggplot2', ref, commit }
    })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi
        .fn()
        .mockResolvedValueOnce({
          runtimeVersion: '4.5.1',
          packages: [githubPackage('main', 'abc123')]
        })
        .mockResolvedValueOnce({
          runtimeVersion: '4.5.1',
          packages: [githubPackage('release', 'def456')]
        }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-r')
    })
    const rTarget = { ...target, language: 'r' as const, command: '/opt/r/bin/Rscript' }

    await tracker.markPackageMutationDirty(rTarget, {
      operationId: 'operation-github-source-change',
      operation: 'install',
      packages: ['tidyverse/ggplot2@release']
    })
    const verification = await tracker.refreshAfterPackageMutation(rTarget, {
      operationId: 'operation-github-source-change',
      operation: 'install',
      packages: ['tidyverse/ggplot2@release'],
      result: 'success'
    })

    expect(verification.packageChanges).toEqual([
      expect.objectContaining({
        name: 'ggplot2',
        relationship: 'requested',
        change: 'updated',
        beforeVersion: '4.0.0.9000',
        afterVersion: '4.0.0.9000',
        source: expect.objectContaining({ ref: 'release', commit: 'def456' })
      })
    ])
  })

  it('captures a baseline before the first package mutation so uninstalls have a verified change', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-first-uninstall-'))
    const inspectInstalled = vi
      .fn()
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
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
      .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled,
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-first-uninstall',
      operation: 'uninstall',
      packages: ['numpy']
    })
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-first-uninstall',
      operation: 'uninstall',
      packages: ['numpy'],
      result: 'success'
    })

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    expect(verification.packageChanges).toEqual([
      expect.objectContaining({
        name: 'numpy',
        relationship: 'requested',
        change: 'removed',
        beforeVersion: '2.2.0'
      })
    ])
  })

  it('keeps the first package mutation repairable when the baseline inventory is unavailable', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-unavailable-baseline-'))
    const inspectInstalled = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime metadata is temporarily unavailable'))
      .mockResolvedValueOnce({
        runtimeVersion: '3.13.2',
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

    await expect(
      tracker.markPackageMutationDirty(target, {
        operationId: 'operation-repair-install',
        operation: 'install',
        packages: ['numpy']
      })
    ).resolves.toBeUndefined()
    const verification = await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-repair-install',
      operation: 'install',
      packages: ['numpy'],
      result: 'success'
    })

    expect(inspectInstalled).toHaveBeenCalledTimes(2)
    expect(verification).toMatchObject({
      result: 'success',
      packageChanges: [
        expect.objectContaining({
          name: 'numpy',
          relationship: 'requested',
          change: 'observed',
          afterVersion: '2.2.0'
        })
      ]
    })
  })

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
    const verification = await tracker.refreshAfterPackageMutation(rTarget, {
      operationId: 'operation-1',
      operation: 'install',
      packages: ['ggplot2'],
      result: 'success',
      source: { type: 'bioconductor', version: '3.21' },
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
    expect(verification.packageChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'ggplot2',
          relationship: 'requested',
          change: 'installed',
          afterVersion: '3.5.2',
          source: { type: 'bioconductor', version: '3.21' }
        }),
        expect.objectContaining({
          name: 'rlang',
          relationship: 'unattributed',
          change: 'updated',
          beforeVersion: '1.1.4',
          afterVersion: '1.1.5'
        })
      ])
    )
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
            afterVersion: '3.5.2',
            source: { type: 'bioconductor', version: '3.21' }
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

  it('retains only the newest completed operations within the entry budget', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-log-count-'))
    let timestamp = Date.parse('2026-07-27T10:00:00.000Z')
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '3.13.2',
        packages: [
          {
            name: 'numpy',
            version: '2.2.0',
            versionStatus: 'known',
            ecosystem: 'python',
            evidenceSources: ['python-importlib-metadata']
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python'),
      now: () => new Date((timestamp += 1_000)),
      operationLogLimits: { maxEntries: 3, maxBytes: 1_000_000 }
    })

    for (let index = 1; index <= 5; index += 1) {
      const operationId = `operation-${index}`
      await tracker.markPackageMutationDirty(target, {
        operationId,
        operation: 'install',
        packages: ['numpy']
      })
      await tracker.refreshAfterPackageMutation(target, {
        operationId,
        operation: 'install',
        packages: ['numpy'],
        result: 'success'
      })
    }

    const capture = await tracker.captureCompletedRun(target)
    expect(capture.manifest.operationLog?.map((operation) => operation.operationId)).toEqual([
      'operation-3',
      'operation-4',
      'operation-5'
    ])
    expect(capture.manifest.operationLogTruncation).toEqual({
      omittedCount: 2,
      earliestRetainedAt: capture.manifest.operationLog?.[0].timestamp
    })
    await expect(readBinding(dataRoot)).resolves.toMatchObject({
      operationLog: [
        { operationId: 'operation-3' },
        { operationId: 'operation-4' },
        { operationId: 'operation-5' }
      ],
      operationLogTruncation: { omittedCount: 2 }
    })
  })

  it('bounds byte-heavy completed operation history by serialized size', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-log-bytes-'))
    const maxBytes = 2_500
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({ runtimeVersion: '3.13.2', packages: [] }),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python'),
      operationLogLimits: { maxEntries: 20, maxBytes }
    })

    for (let index = 1; index <= 4; index += 1) {
      const operationId = `large-operation-${index}`
      const packageSpec = `missing-${index}-${'x'.repeat(300)}`
      await tracker.markPackageMutationDirty(target, {
        operationId,
        operation: 'install',
        packages: [packageSpec]
      })
      await tracker.refreshAfterPackageMutation(target, {
        operationId,
        operation: 'install',
        packages: [packageSpec],
        result: 'failure'
      })
    }

    const binding = await readBinding(dataRoot)
    const persistedBytes = Buffer.byteLength(await readFile(await bindingPath(dataRoot), 'utf8'))
    expect(persistedBytes).toBeLessThanOrEqual(maxBytes)
    expect(binding.operationLog.at(-1)?.operationId).toBe('large-operation-4')
    expect(binding.operationLogTruncation?.omittedCount).toBeGreaterThan(0)
  })

  it('retains the recovery-critical operation even when it exceeds both budgets', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-log-recovery-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('inventory unavailable')),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python'),
      operationLogLimits: { maxEntries: 0, maxBytes: 0 }
    })

    await tracker.markPackageMutationDirty(target, {
      operationId: 'operation-pending-recovery',
      operation: 'install',
      packages: ['numpy']
    })
    await tracker.refreshAfterPackageMutation(target, {
      operationId: 'operation-pending-recovery',
      operation: 'install',
      packages: ['numpy'],
      result: 'success'
    })

    await expect(readBinding(dataRoot)).resolves.toMatchObject({
      dirtyOperationId: 'operation-pending-recovery',
      operationLog: [{ operationId: 'operation-pending-recovery' }]
    })
  })

  it('marks a successful installer process as failed when the requested R package is absent', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-unverified-mutation-'))
    const inspectInstalled = vi.fn().mockResolvedValue({
      runtimeVersion: '4.4.3',
      packages: [
        {
          name: 'ggplot2',
          version: '4.0.3',
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

    await tracker.markPackageMutationDirty(rTarget, {
      operationId: 'operation-missing-dplyr',
      operation: 'install',
      packages: ['dplyr']
    })
    const verification = await tracker.refreshAfterPackageMutation(rTarget, {
      operationId: 'operation-missing-dplyr',
      operation: 'install',
      packages: ['dplyr'],
      result: 'success'
    })
    const capture = await tracker.captureCompletedRun(rTarget)

    expect(verification).toEqual({ result: 'failure', unsatisfiedPackages: ['dplyr'] })
    expect(capture.manifest.operationLog).toEqual([
      expect.objectContaining({
        operationId: 'operation-missing-dplyr',
        result: 'failure',
        packages: ['dplyr']
      })
    ])
    expect(capture.manifest.packages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'dplyr' })])
    )
  })

  it('fails verification when the post-install inventory cannot be refreshed', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-refresh-failure-'))
    const tracker = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi
        .fn()
        .mockResolvedValueOnce({ runtimeVersion: '3.13.2', packages: [] })
        .mockRejectedValueOnce(new Error('inventory unavailable')),
      captureFingerprint: vi.fn().mockResolvedValue('stable-python')
    })
    const pythonTarget = {
      language: 'python' as const,
      environmentName: 'default-python',
      runtimeSource: 'managed' as const,
      command: '/runtime/default-python/bin/python',
      args: []
    }

    await tracker.markPackageMutationDirty(pythonTarget, {
      operationId: 'operation-inventory-failed',
      operation: 'install',
      packages: ['numpy']
    })

    await expect(
      tracker.refreshAfterPackageMutation(pythonTarget, {
        operationId: 'operation-inventory-failed',
        operation: 'install',
        packages: ['numpy'],
        result: 'success'
      })
    ).resolves.toEqual({ result: 'failure', reason: 'inventory-refresh-failed' })
  })

  it('retains installer source when a failed refresh is completed during recovery', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-source-recovery-'))
    const rTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: '/runtime/default-r/bin/Rscript',
      args: []
    }
    const initial = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi
        .fn()
        .mockResolvedValueOnce({ runtimeVersion: '4.5.1', packages: [] })
        .mockRejectedValueOnce(new Error('inventory unavailable')),
      captureFingerprint: vi.fn().mockResolvedValue('before-install')
    })
    await initial.markPackageMutationDirty(rTarget, {
      operationId: 'operation-bioc-recovery',
      operation: 'install',
      packages: ['DESeq2']
    })
    await expect(
      initial.refreshAfterPackageMutation(rTarget, {
        operationId: 'operation-bioc-recovery',
        operation: 'install',
        packages: ['DESeq2'],
        result: 'success',
        source: { type: 'bioconductor', version: '3.21' }
      })
    ).resolves.toEqual({ result: 'failure', reason: 'inventory-refresh-failed' })

    const recovered = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({
        runtimeVersion: '4.5.1',
        packages: [
          {
            name: 'DESeq2',
            version: '1.48.1',
            versionStatus: 'known',
            ecosystem: 'r',
            evidenceSources: ['r-installed-packages']
          }
        ]
      }),
      captureFingerprint: vi.fn().mockResolvedValue('after-install')
    })
    const start = await recovered.prepareRun(rTarget)
    const capture = await recovered.captureCompletedRun(
      rTarget,
      { runtimeVersion: '4.5.1', packages: [] },
      start
    )

    expect(capture.manifest.operationLog).toEqual([
      expect.objectContaining({
        operationId: 'operation-bioc-recovery',
        packageChanges: [
          expect.objectContaining({
            name: 'DESeq2',
            relationship: 'requested',
            source: { type: 'bioconductor', version: '3.21' }
          })
        ]
      })
    ])
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

  it('keeps pre-activation R recovery state visible after adding a Conda prefix', async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'open-science-env-r-upgrade-recovery-'))
    const legacyTarget = {
      language: 'r' as const,
      environmentName: 'default-r',
      runtimeSource: 'managed' as const,
      command: 'C:\\runtime\\envs\\.r\\Lib\\R\\bin\\Rscript.exe',
      args: []
    }
    const initial = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockResolvedValue({ runtimeVersion: '4.5.1', packages: [] }),
      captureFingerprint: vi.fn().mockResolvedValue('before-install')
    })
    await initial.markPackageMutationDirty(legacyTarget, {
      operationId: 'operation-from-older-nightly',
      operation: 'install',
      packages: ['ggplot2']
    })

    const upgraded = new EnvironmentStateTracker({
      dataRoot,
      inspectInstalled: vi.fn().mockRejectedValue(new Error('environment still locked')),
      captureFingerprint: vi.fn().mockResolvedValue('unknown')
    })

    await expect(
      upgraded.prepareRun({
        ...legacyTarget,
        condaPrefix: 'C:\\runtime\\envs\\.r'
      })
    ).rejects.toThrow(/recovery failed before Notebook/)
  })
})
