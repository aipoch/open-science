import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookPackageAdmittedTarget } from './package-admission'
import { NotebookPackageMutationOwner } from './package-mutation'
import { CHILD_UNCONFIRMED } from './provisioner-runtime'
import {
  operationJournalPath,
  readOperationChild,
  RuntimeOperationJournal
} from './operation-journal'
import { importedEnvironmentLockMarkerPath } from './runtime-paths'

type MutationOptions = ConstructorParameters<typeof NotebookPackageMutationOwner>[0]

const tempRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const admittedTarget = (
  runtimeRoot: string,
  overrides: Partial<NotebookPackageAdmittedTarget> = {}
): NotebookPackageAdmittedTarget => ({
  request: { language: 'python', packages: ['numpy'], environment: 'analysis' },
  environmentName: 'analysis',
  environmentCaptureTarget: {
    language: 'python',
    environmentName: 'analysis',
    runtimeSource: 'managed',
    command: '/runtime/envs/analysis/bin/python'
  },
  repairRuntimeId: 'analysis',
  repairMarkerKey: 'analysis::python',
  journalTarget: join(runtimeRoot, 'envs', 'analysis'),
  receipt: {
    language: 'python',
    selection: 'explicit-binding',
    runtimeSource: 'managed',
    environmentName: 'analysis',
    runtimeId: '/runtime/envs/analysis/bin/python',
    label: 'analysis',
    prefix: join(runtimeRoot, 'envs', 'analysis')
  },
  ...overrides
})

const ownerHarness = (
  optionOverrides: Partial<MutationOptions> = {},
  targetOverrides: Partial<NotebookPackageAdmittedTarget> = {}
): {
  owner: NotebookPackageMutationOwner
  options: MutationOptions
  target: NotebookPackageAdmittedTarget
  runtimeRoot: string
} => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'notebook-package-mutation-'))
  tempRoots.push(storageRoot)
  const runtimeRoot = join(storageRoot, 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })
  const target = admittedTarget(runtimeRoot, targetOverrides)
  const options: MutationOptions = {
    storageRoot,
    runtimeRoot,
    environmentOperations: {
      runMutation: async <T>(_environment: string, operation: () => Promise<T>): Promise<T> =>
        operation(),
      logPackageFailure: vi.fn(),
      logPackageResult: vi.fn()
    },
    environmentStateTracker: {
      inspectPackages: vi.fn().mockResolvedValue({
        inventory: { source: 'unavailable', validation: 'unavailable' },
        packages: []
      }),
      markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
      refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
    },
    installPackages: vi.fn().mockResolvedValue({
      ok: true,
      needsRestart: false,
      log: 'installed',
      method: 'conda'
    }),
    recheckRepair: vi.fn(() => undefined),
    canSkipInstall: vi.fn(() => true),
    runtimeRepair: {
      quarantineProtectedIdentity: vi.fn().mockResolvedValue(undefined),
      completeInterruptedInstall: vi.fn().mockResolvedValue(undefined)
    },
    blockUnconfirmedChild: vi.fn(),
    ...optionOverrides
  }
  return { owner: new NotebookPackageMutationOwner(options), options, target, runtimeRoot }
}

const pending = (runtimeRoot: string): ReturnType<RuntimeOperationJournal['pending']> =>
  RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot)).pending()

describe('NotebookPackageMutationOwner', () => {
  it('retains the install recovery path when repair is required', async () => {
    const { owner, options, target } = ownerHarness({ canSkipInstall: () => false })
    await owner.mutate({ target, mirror: {} })
    expect(options.environmentStateTracker.inspectPackages).not.toHaveBeenCalled()
    expect(options.installPackages).toHaveBeenCalled()
    expect(options.runtimeRepair.completeInterruptedInstall).toHaveBeenCalled()
  })
  it.each([
    ['python', 'numpy==2.0', 'numpy'],
    ['python', 'numpy', 'numpy'],
    ['r', 'ggplot2', 'ggplot2']
  ] as const)('skips all mutation resources for satisfied %s %s', async (language, spec, name) => {
    const retainWorkingCache = vi.fn()
    const { owner, options, target, runtimeRoot } = ownerHarness({ retainWorkingCache })
    const mirror = vi.fn().mockResolvedValue({})
    const request = { ...target.request, language, packages: [spec] }
    const environmentCaptureTarget = { ...target.environmentCaptureTarget, language }
    if (!target.journalTarget) throw new Error('Expected managed prefix')
    mkdirSync(target.journalTarget, { recursive: true })
    const marker = importedEnvironmentLockMarkerPath(target.journalTarget)
    writeFileSync(marker, 'a'.repeat(64))
    let locked = false
    options.environmentOperations.runMutation = async (_name, operation) => {
      locked = true
      try {
        return await operation()
      } finally {
        locked = false
      }
    }
    vi.mocked(options.environmentStateTracker.inspectPackages).mockImplementation(
      async (capture, packages, freshness) => {
        expect(locked).toBe(true)
        expect(capture).toEqual(environmentCaptureTarget)
        expect(packages).toEqual([spec])
        expect(freshness).toEqual({ fresh: true })
        return {
          inventory: { source: 'full-scan', validation: 'full-scan' },
          packages: [
            {
              requested: spec,
              name,
              status: 'installed',
              version: '2.0',
              versionStatus: 'known',
              libraryScope: 'environment'
            }
          ]
        }
      }
    )
    await expect(
      owner.mutate({ target: { ...target, request, environmentCaptureTarget }, mirror })
    ).resolves.toMatchObject({
      ok: true,
      needsRestart: false,
      packageChanges: [{ name, change: 'unchanged', afterVersion: '2.0' }]
    })
    expect(mirror).not.toHaveBeenCalled()
    expect(retainWorkingCache).not.toHaveBeenCalled()
    expect(options.installPackages).not.toHaveBeenCalled()
    expect(options.environmentStateTracker.markPackageMutationDirty).not.toHaveBeenCalled()
    expect(options.runtimeRepair.completeInterruptedInstall).not.toHaveBeenCalled()
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(operationJournalPath(runtimeRoot))).toBe(false)
  })

  it.each(['mismatch', 'missing', 'unknown', 'failed-probe', 'mixed'])(
    'keeps the original installer request for %s evidence',
    async (scenario) => {
      const { owner, options, target } = ownerHarness()
      const request = {
        ...target.request,
        packages: scenario === 'mixed' ? ['numpy==2.0', 'pandas'] : ['numpy==2.0']
      }
      const inspect = vi.mocked(options.environmentStateTracker.inspectPackages)
      inspect.mockResolvedValue({
        inventory: { source: 'full-scan', validation: 'full-scan' },
        packages: [
          {
            requested: 'numpy==2.0',
            name: 'numpy',
            status:
              scenario === 'missing' ? 'missing' : scenario === 'unknown' ? 'unknown' : 'installed',
            version: scenario === 'mismatch' ? '1.0' : '2.0',
            versionStatus: 'known'
          }
        ]
      })
      if (scenario === 'failed-probe') inspect.mockRejectedValue(new Error('metadata unavailable'))
      await owner.mutate({ target: { ...target, request }, mirror: {} })
      expect(options.installPackages).toHaveBeenCalledWith(request, expect.anything())
    }
  )

  it.each(['user', 'system', 'unknown', undefined] as const)(
    'does not satisfy an R install from library scope %s',
    async (libraryScope) => {
      const { owner, options, target } = ownerHarness()
      const request = { ...target.request, language: 'r' as const, packages: ['ggplot2'] }
      vi.mocked(options.environmentStateTracker.inspectPackages).mockResolvedValue({
        inventory: { source: 'full-scan', validation: 'full-scan' },
        packages: [
          {
            requested: 'ggplot2',
            name: 'ggplot2',
            status: 'installed',
            version: '4.0.3',
            versionStatus: 'known',
            libraryScope
          }
        ]
      })
      await owner.mutate({
        target: {
          ...target,
          request,
          environmentCaptureTarget: { ...target.environmentCaptureTarget, language: 'r' }
        },
        mirror: {}
      })
      expect(options.installPackages).toHaveBeenCalledWith(request, expect.anything())
      expect(options.environmentStateTracker.markPackageMutationDirty).toHaveBeenCalled()
    }
  )

  it.each([
    { packages: ['numpy>=2'] },
    { packages: ['numpy[extra]'] },
    { packages: ['--force-reinstall'] },
    { packages: [] },
    { channels: ['bioconda'] },
    { operation: 'uninstall' as const },
    { language: 'r' as const, packages: ['r-ggplot2'] },
    { language: 'r' as const, packages: ['bioconductor-deseq2'] },
    { language: 'r' as const, installer: 'github' as const, packages: ['owner/repo'] }
  ])('does not preflight unsupported request %j', async (overrides) => {
    const { owner, options, target } = ownerHarness()
    await owner.mutate({
      target: { ...target, request: { ...target.request, ...overrides } },
      mirror: {}
    })
    expect(options.environmentStateTracker.inspectPackages).not.toHaveBeenCalled()
    expect(options.installPackages).toHaveBeenCalled()
  })

  it('honors cancellation after the metadata probe without starting an installer', async () => {
    const { owner, options, target } = ownerHarness()
    const controller = new AbortController()
    vi.mocked(options.environmentStateTracker.inspectPackages).mockImplementation(
      async (_target, _packages, probeOptions) => {
        expect(probeOptions?.signal).toBe(controller.signal)
        controller.abort(new Error('cancelled during probe'))
        throw new Error('probe failed')
      }
    )
    await expect(owner.mutate({ target, mirror: {} }, controller.signal)).rejects.toThrow(
      'cancelled during probe'
    )
    expect(options.installPackages).not.toHaveBeenCalled()
  })

  it('passes caller cancellation to the package installer', async () => {
    const installPackages = vi.fn().mockResolvedValue({
      ok: true,
      needsRestart: false,
      log: 'installed',
      method: 'conda'
    })
    const { owner, target } = ownerHarness({ installPackages })
    const cancellation = new AbortController()

    await owner.mutate({ target, mirror: {} }, cancellation.signal)

    expect(installPackages).toHaveBeenCalledWith(
      target.request,
      expect.objectContaining({ signal: cancellation.signal })
    )
  })

  it('invalidates an imported-lock reuse marker before mutating its environment', async () => {
    const { owner, options, target, runtimeRoot } = ownerHarness()
    if (!target.journalTarget) throw new Error('Expected a managed environment target.')
    mkdirSync(target.journalTarget, { recursive: true })
    const markerPath = importedEnvironmentLockMarkerPath(target.journalTarget)
    const checksum = 'a'.repeat(64)
    const lockDirectory = join(runtimeRoot, 'imported-locks')
    const nativeLocksRoot = join(lockDirectory, checksum)
    mkdirSync(nativeLocksRoot, { recursive: true })
    writeFileSync(join(lockDirectory, `${checksum}.txt`), '@EXPLICIT\n')
    writeFileSync(join(nativeLocksRoot, 'requirements.lock'), 'numpy==2.0\n')
    writeFileSync(markerPath, `${checksum}\n`)
    vi.mocked(options.installPackages).mockImplementation(async () => {
      expect(existsSync(markerPath)).toBe(false)
      expect(existsSync(join(lockDirectory, `${checksum}.txt`))).toBe(false)
      expect(existsSync(nativeLocksRoot)).toBe(false)
      return { ok: true, needsRestart: false, log: 'installed', method: 'conda' }
    })

    await expect(owner.mutate({ target, mirror: {} })).resolves.toMatchObject({ ok: true })
    expect(existsSync(markerPath)).toBe(false)
  })

  it('rechecks repair policy after acquiring the mutation lock', async () => {
    const refusal = {
      status: 'refused' as const,
      result: {
        ok: false,
        needsRestart: false,
        repairRequired: true,
        log: '',
        error: 'RUNTIME_REPAIR_REQUIRED'
      }
    }
    const order: string[] = []
    const { owner, options, target, runtimeRoot } = ownerHarness({
      environmentOperations: {
        runMutation: async <T>(_environment: string, operation: () => Promise<T>): Promise<T> => {
          order.push('lock')
          return operation()
        },
        logPackageFailure: vi.fn(),
        logPackageResult: vi.fn()
      },
      recheckRepair: vi.fn(() => {
        order.push('repair-check')
        return refusal
      })
    })

    await expect(owner.mutate({ target, mirror: {} })).resolves.toEqual(refusal.result)

    expect(order).toEqual(['lock', 'repair-check'])
    expect(options.installPackages).not.toHaveBeenCalled()
    expect(options.environmentStateTracker.markPackageMutationDirty).not.toHaveBeenCalled()
    expect(await pending(runtimeRoot)).toEqual([])
  })

  it('owns lock, journal, child evidence, verification and successful repair completion', async () => {
    const order: string[] = []
    let operationId = ''
    const { owner, options, target, runtimeRoot } = ownerHarness({
      environmentOperations: {
        runMutation: async <T>(environment: string, operation: () => Promise<T>): Promise<T> => {
          expect(environment).toBe('analysis')
          order.push('lock')
          const result = await operation()
          order.push('unlock')
          return result
        },
        logPackageFailure: vi.fn(),
        logPackageResult: vi.fn(() => order.push('diagnostic'))
      },
      environmentStateTracker: {
        inspectPackages: vi.fn().mockResolvedValue({
          inventory: { source: 'unavailable', validation: 'unavailable' },
          packages: []
        }),
        markPackageMutationDirty: vi.fn(async (_target, mutation) => {
          operationId = mutation.operationId
          expect((await pending(runtimeRoot))[0]).toMatchObject({
            operationId,
            runtimeId: 'analysis::python',
            targetPath: target.journalTarget,
            repairReason: 'interrupted-install'
          })
          order.push('dirty')
        }),
        refreshAfterPackageMutation: vi.fn(async (_target, outcome) => {
          expect(outcome.source).toEqual({
            type: 'github',
            repository: 'numpy/numpy',
            ref: 'v2.0.0'
          })
          order.push('verify')
          return {
            result: 'success' as const,
            packageChanges: [
              {
                name: 'numpy',
                ecosystem: 'python' as const,
                relationship: 'requested' as const,
                change: 'installed' as const,
                afterVersion: '2.0'
              },
              {
                name: 'python-dateutil',
                ecosystem: 'python' as const,
                relationship: 'dependency' as const,
                change: 'installed' as const,
                afterVersion: '2.9'
              }
            ]
          }
        })
      },
      installPackages: vi.fn(async (request, deps) => {
        expect(request.environment).toBe('analysis')
        expect(deps).toMatchObject({
          storageRoot: expect.any(String),
          condaChannel: 'https://mirror/conda-forge/',
          pypiIndex: 'https://mirror/pypi/simple',
          cranMirror: 'https://mirror/cran/',
          caBundle: '/certs/corporate.pem',
          interpreter: undefined
        })
        order.push('spawn-1')
        deps?.onBeforeSpawn?.()
        expect(readOperationChild(runtimeRoot, operationId)).toMatchObject({ spawning: true })
        deps?.onChild?.(process.pid)
        expect(readOperationChild(runtimeRoot, operationId)).toMatchObject({
          childPid: process.pid
        })
        order.push('spawn-2')
        deps?.onBeforeSpawn?.()
        expect(readOperationChild(runtimeRoot, operationId)).toMatchObject({ spawning: true })
        return {
          ok: true,
          needsRestart: false,
          log: 'installed',
          method: 'github' as const,
          source: { type: 'github' as const, repository: 'numpy/numpy', ref: 'v2.0.0' }
        }
      }),
      runtimeRepair: {
        quarantineProtectedIdentity: vi.fn().mockResolvedValue(undefined),
        completeInterruptedInstall: vi.fn(async () => {
          expect(await pending(runtimeRoot)).toEqual([])
          expect(readOperationChild(runtimeRoot, operationId)).toBeUndefined()
          order.push('repair-complete')
        })
      }
    })

    const result = await owner.mutate({
      target,
      mirror: {
        condaChannel: 'https://mirror/conda-forge/',
        pypiIndex: 'https://mirror/pypi/simple',
        cranMirror: 'https://mirror/cran/',
        caBundle: '/certs/corporate.pem'
      }
    })

    expect(result).toMatchObject({
      ok: true,
      packageChanges: [
        { name: 'numpy', relationship: 'requested' },
        { name: 'python-dateutil', relationship: 'dependency' }
      ]
    })
    expect(order).toEqual([
      'lock',
      'dirty',
      'spawn-1',
      'spawn-2',
      'verify',
      'diagnostic',
      'unlock',
      'repair-complete'
    ])
    expect(options.runtimeRepair.quarantineProtectedIdentity).not.toHaveBeenCalled()
  })

  it('completes a managed conda install without retaining archive publication when no cache retainer exists', async () => {
    const { owner, target, runtimeRoot } = ownerHarness({
      installPackages: vi.fn(async (_request, deps) => {
        deps?.onCondaArchiveAuthorizations?.(
          [{ file: 'numpy-1.conda', algorithm: 'sha256', digest: 'a'.repeat(64) }],
          '/managed-working-cache'
        )
        return { ok: true, needsRestart: false, log: 'installed', method: 'conda' as const }
      })
    })

    await expect(owner.mutate({ target, mirror: {} })).resolves.toMatchObject({ ok: true })
    expect(await pending(runtimeRoot)).toEqual([])
  })

  it('publishes a successful conda transaction before releasing its working cache', async () => {
    let finishPublication!: (published: boolean) => void
    const publication = new Promise<boolean>((resolve) => {
      finishPublication = resolve
    })
    const release = vi.fn(() => publication)
    const retainWorkingCache = vi.fn(() => release)
    const installedPrefix = '/runtime/envs/analysis'
    const archiveAuthorization = {
      file: 'numpy-1.conda',
      algorithm: 'sha256' as const,
      digest: 'a'.repeat(64)
    }
    const workingRoot = '/working-cache'
    const { owner, target, runtimeRoot } = ownerHarness({
      retainWorkingCache,
      installPackages: vi.fn(async (_request, deps) => {
        deps?.onCondaArchiveAuthorizations?.([archiveAuthorization], workingRoot)
        return {
          ok: true,
          needsRestart: false,
          log: 'installed',
          method: 'conda' as const,
          prefix: installedPrefix,
          attempts: [
            {
              groupOrdinal: 0,
              installer: 'conda' as const,
              packages: ['numpy'],
              status: 'succeeded' as const,
              mutationRisk: 'confirmed' as const
            }
          ]
        }
      })
    })

    const mutation = owner.mutate({ target, mirror: {} })

    await vi.waitFor(async () => {
      expect((await pending(runtimeRoot))[0]).toMatchObject({
        archivePublications: [{ workingRoot, authorizations: [archiveAuthorization] }]
      })
    })
    finishPublication(true)
    await expect(mutation).resolves.toMatchObject({ ok: true })
    expect(await pending(runtimeRoot)).toEqual([])

    expect(retainWorkingCache).toHaveBeenCalledWith(runtimeRoot, expect.any(String))
    expect(release).toHaveBeenCalledWith({
      archivePublications: [{ workingRoot, authorizations: [archiveAuthorization] }],
      completedOperationId: expect.any(String),
      retainForRecovery: false
    })
  })

  it('does not persist an empty archive publication', async () => {
    const release = vi.fn().mockResolvedValue(true)
    const { owner, target, runtimeRoot } = ownerHarness({
      retainWorkingCache: vi.fn(() => release),
      installPackages: vi.fn(async (_request, deps) => {
        deps?.onCondaArchiveAuthorizations?.([], '/working-cache')
        return { ok: true, needsRestart: false, log: 'already installed', method: 'conda' as const }
      })
    })

    await expect(owner.mutate({ target, mirror: {} })).resolves.toMatchObject({ ok: true })

    expect(release).toHaveBeenCalledWith({
      archivePublications: [],
      completedOperationId: expect.any(String),
      retainForRecovery: false
    })
    expect(await pending(runtimeRoot)).toEqual([])
  })

  it('retains and blocks when a successful conda result has incomplete archive evidence', async () => {
    const release = vi.fn().mockResolvedValue(false)
    const { owner, options, target, runtimeRoot } = ownerHarness({
      retainWorkingCache: vi.fn(() => release),
      installPackages: vi.fn(async (_request, deps) => {
        deps?.onCondaArchiveAuthorizations?.([], '/working-cache', false)
        return { ok: true, needsRestart: false, log: 'installed', method: 'conda' as const }
      })
    })

    await expect(owner.mutate({ target, mirror: {} })).rejects.toThrow(
      'CACHE_ARCHIVE_EVIDENCE_INCOMPLETE'
    )

    expect(options.blockUnconfirmedChild).toHaveBeenCalledWith(target)
    expect(release).toHaveBeenCalledWith({
      archivePublications: [],
      completedOperationId: expect.any(String),
      retainForRecovery: true
    })
    expect(await pending(runtimeRoot)).toEqual([
      expect.objectContaining({ archivePublicationPending: true })
    ])
  })

  it('keeps external installs on normal repair recovery without retaining micromamba cache state', async () => {
    const retainWorkingCache = vi.fn()
    const { owner, target, runtimeRoot } = ownerHarness(
      {
        retainWorkingCache,
        installPackages: vi.fn(async () => {
          const [record] = await pending(runtimeRoot)
          expect(record).not.toHaveProperty('archivePublicationPending')
          return { ok: true, needsRestart: false, log: 'installed', method: 'pip' as const }
        })
      },
      {
        journalTarget: undefined,
        environmentCaptureTarget: {
          language: 'python',
          environmentName: 'external-python',
          runtimeSource: 'external',
          command: 'C:\\Python\\python.exe'
        }
      }
    )

    await expect(owner.mutate({ target, mirror: {} })).resolves.toMatchObject({ ok: true })

    expect(retainWorkingCache).not.toHaveBeenCalled()
    expect(await pending(runtimeRoot)).toEqual([])
  })

  it('keeps an explicit managed pip install out of archive publication recovery', async () => {
    const retainWorkingCache = vi.fn()
    const { owner, target, runtimeRoot } = ownerHarness(
      {
        retainWorkingCache,
        installPackages: vi.fn(async () => {
          const [record] = await pending(runtimeRoot)
          expect(record).not.toHaveProperty('archivePublicationPending')
          return { ok: true, needsRestart: false, log: 'installed', method: 'pip' as const }
        })
      },
      {
        request: {
          language: 'python',
          packages: ['numpy'],
          environment: 'analysis',
          usePip: true
        }
      }
    )

    await expect(owner.mutate({ target, mirror: {} })).resolves.toMatchObject({ ok: true })

    expect(retainWorkingCache).not.toHaveBeenCalled()
    expect(await pending(runtimeRoot)).toEqual([])
  })

  it('retains and blocks when post-mutation archive authority cannot be persisted', async () => {
    const updateFailure = new Error('journal publication update denied')
    vi.spyOn(RuntimeOperationJournal.prototype, 'update').mockRejectedValueOnce(updateFailure)
    const release = vi.fn().mockResolvedValue(false)
    const archiveAuthorization = {
      file: 'numpy-1.conda',
      algorithm: 'sha256' as const,
      digest: 'a'.repeat(64)
    }
    const { owner, options, target, runtimeRoot } = ownerHarness({
      retainWorkingCache: vi.fn(() => release),
      installPackages: vi.fn(async (_request, deps) => {
        deps?.onCondaArchiveAuthorizations?.([archiveAuthorization], '/working-cache')
        return { ok: true, needsRestart: false, log: 'installed', method: 'conda' as const }
      })
    })

    await expect(owner.mutate({ target, mirror: {} })).rejects.toBe(updateFailure)

    expect(options.blockUnconfirmedChild).toHaveBeenCalledWith(target)
    expect(release).toHaveBeenCalledWith({
      archivePublications: [
        { workingRoot: '/working-cache', authorizations: [archiveAuthorization] }
      ],
      completedOperationId: expect.any(String),
      retainForRecovery: true
    })
    const retained = await pending(runtimeRoot)
    expect(retained).toEqual([expect.objectContaining({ archivePublicationPending: true })])
    expect(retained[0].archivePublications).toBeUndefined()
  })

  it('still publishes a settled transaction when the mutation lock wrapper fails while unwinding', async () => {
    const wrapperFailure = new Error('lock release failed')
    const release = vi.fn().mockResolvedValue(true)
    const archiveAuthorization = {
      file: 'numpy-1.conda',
      algorithm: 'sha256' as const,
      digest: 'a'.repeat(64)
    }
    const { owner, target, runtimeRoot } = ownerHarness({
      environmentOperations: {
        runMutation: async <T>(_environment: string, operation: () => Promise<T>): Promise<T> => {
          await operation()
          throw wrapperFailure
        },
        logPackageFailure: vi.fn(),
        logPackageResult: vi.fn()
      },
      retainWorkingCache: vi.fn(() => release),
      installPackages: vi.fn(async (_request, deps) => {
        deps?.onCondaArchiveAuthorizations?.([archiveAuthorization], '/working-cache')
        return { ok: true, needsRestart: false, log: 'installed', method: 'conda' as const }
      })
    })

    await expect(owner.mutate({ target, mirror: {} })).rejects.toBe(wrapperFailure)

    expect(release).toHaveBeenCalledWith({
      archivePublications: [
        { workingRoot: '/working-cache', authorizations: [archiveAuthorization] }
      ],
      completedOperationId: expect.any(String),
      retainForRecovery: false
    })
    expect(await pending(runtimeRoot)).toEqual([])
  })

  it('clears settled cache-maintenance child evidence before the installer transaction', async () => {
    let operationId = ''
    const { owner, target, runtimeRoot } = ownerHarness({
      environmentStateTracker: {
        inspectPackages: vi.fn().mockResolvedValue({
          inventory: { source: 'unavailable', validation: 'unavailable' },
          packages: []
        }),
        markPackageMutationDirty: vi.fn(async (_target, mutation) => {
          operationId = mutation.operationId
        }),
        refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
      },
      installPackages: vi.fn(async (_request, deps) => {
        deps?.onBeforeSpawn?.()
        deps?.onChild?.(process.pid)
        await vi.waitFor(async () => {
          expect((await pending(runtimeRoot))[0]).toMatchObject({ childPid: process.pid })
        })

        await (
          deps as (typeof deps & { onCacheMaintenanceSettled?: () => Promise<void> }) | undefined
        )?.onCacheMaintenanceSettled?.()

        expect(readOperationChild(runtimeRoot, operationId)).toBeUndefined()
        const [record] = await pending(runtimeRoot)
        expect(record).not.toHaveProperty('childPid')
        expect(record).not.toHaveProperty('childStartedAt')
        expect(record).not.toHaveProperty('childStartToken')
        return { ok: true, needsRestart: false, log: 'installed', method: 'conda' as const }
      })
    })

    await expect(owner.mutate({ target, mirror: {} })).resolves.toMatchObject({ ok: true })
  })

  it('fails closed without dirtying or spawning when the journal cannot begin', async () => {
    const { owner, options, target, runtimeRoot } = ownerHarness()
    writeFileSync(operationJournalPath(runtimeRoot), '{not-json', 'utf8')

    const result = await owner.mutate({ target, mirror: {} })

    expect(result).toMatchObject({
      ok: false,
      needsRestart: false,
      error: expect.stringContaining('RUNTIME_JOURNAL_UNWRITABLE')
    })
    expect(options.environmentStateTracker.markPackageMutationDirty).not.toHaveBeenCalled()
    expect(options.installPackages).not.toHaveBeenCalled()
    expect(options.runtimeRepair.completeInterruptedInstall).not.toHaveBeenCalled()
  })

  it('clears journal evidence after a pre-spawn dirty-marker failure', async () => {
    const dirtyFailure = new Error('dirty marker denied')
    const { owner, options, target, runtimeRoot } = ownerHarness({
      environmentStateTracker: {
        inspectPackages: vi.fn().mockResolvedValue({
          inventory: { source: 'unavailable', validation: 'unavailable' },
          packages: []
        }),
        markPackageMutationDirty: vi.fn().mockRejectedValue(dirtyFailure),
        refreshAfterPackageMutation: vi.fn()
      }
    })

    await expect(owner.mutate({ target, mirror: {} })).rejects.toBe(dirtyFailure)

    expect(options.installPackages).not.toHaveBeenCalled()
    expect(options.environmentStateTracker.refreshAfterPackageMutation).not.toHaveBeenCalled()
    expect(await pending(runtimeRoot)).toEqual([])
  })

  it('logs installer failure, refreshes failed inventory and clears completed evidence', async () => {
    const installFailure = new Error('installer failed')
    const { owner, options, target, runtimeRoot } = ownerHarness({
      installPackages: vi.fn().mockRejectedValue(installFailure)
    })

    await expect(owner.mutate({ target, mirror: {} })).rejects.toBe(installFailure)

    expect(options.environmentOperations.logPackageFailure).toHaveBeenCalledWith(
      expect.objectContaining({ error: installFailure, environmentName: 'analysis' })
    )
    expect(options.environmentStateTracker.refreshAfterPackageMutation).toHaveBeenCalledWith(
      target.environmentCaptureTarget,
      expect.objectContaining({ result: 'failure', attempts: [], fallbackUsed: false })
    )
    expect(options.environmentOperations.logPackageResult).not.toHaveBeenCalled()
    expect(await pending(runtimeRoot)).toEqual([])
  })

  it('turns an unverifiable successful installer result into the existing structured failure', async () => {
    const { owner, options, target } = ownerHarness({
      environmentStateTracker: {
        inspectPackages: vi.fn().mockResolvedValue({
          inventory: { source: 'unavailable', validation: 'unavailable' },
          packages: []
        }),
        markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
        refreshAfterPackageMutation: vi.fn().mockRejectedValue(new Error('scan failed'))
      }
    })

    const result = await owner.mutate({ target, mirror: {} })

    expect(result).toMatchObject({
      ok: false,
      needsRestart: false,
      error: expect.stringContaining('inventory refresh failed')
    })
    expect(options.environmentOperations.logPackageResult).toHaveBeenCalledWith(
      expect.objectContaining({ result })
    )
    expect(options.runtimeRepair.completeInterruptedInstall).not.toHaveBeenCalled()
  })

  it('upgrades evidence before quarantining a protected identity', async () => {
    const { owner, options, target, runtimeRoot } = ownerHarness({
      installPackages: vi.fn().mockResolvedValue({
        ok: false,
        needsRestart: false,
        repairRequired: true,
        log: 'protected interpreter changed'
      }),
      runtimeRepair: {
        completeInterruptedInstall: vi.fn().mockResolvedValue(undefined),
        quarantineProtectedIdentity: vi.fn(async () => {
          expect(await pending(runtimeRoot)).toEqual([
            expect.objectContaining({
              runtimeId: 'analysis',
              repairReason: 'protected-identity-change'
            })
          ])
        })
      }
    })

    const result = await owner.mutate({ target, mirror: {} })

    expect(result).toMatchObject({ ok: false, repairRequired: true })
    expect(options.runtimeRepair.quarantineProtectedIdentity).toHaveBeenCalledWith(target)
    expect(await pending(runtimeRoot)).toEqual([])
  })

  it('retains evidence when protected-identity quarantine is not durable', async () => {
    const quarantineFailure = new Error('REPAIR_QUARANTINE_FAILED: registry denied')
    const { owner, target, runtimeRoot } = ownerHarness({
      installPackages: vi.fn().mockResolvedValue({
        ok: false,
        needsRestart: false,
        repairRequired: true,
        log: 'protected interpreter changed'
      }),
      runtimeRepair: {
        completeInterruptedInstall: vi.fn().mockResolvedValue(undefined),
        quarantineProtectedIdentity: vi.fn().mockRejectedValue(quarantineFailure)
      }
    })

    await expect(owner.mutate({ target, mirror: {} })).rejects.toBe(quarantineFailure)
    expect(await pending(runtimeRoot)).toEqual([
      expect.objectContaining({ repairReason: 'protected-identity-change' })
    ])
  })

  it('quarantines but retains the original evidence when its stronger journal update fails', async () => {
    const updateFailure = new Error('journal update denied')
    vi.spyOn(RuntimeOperationJournal.prototype, 'update').mockRejectedValueOnce(updateFailure)
    const { owner, options, target, runtimeRoot } = ownerHarness({
      installPackages: vi.fn().mockResolvedValue({
        ok: false,
        needsRestart: false,
        repairRequired: true,
        log: 'protected interpreter changed'
      })
    })

    await expect(owner.mutate({ target, mirror: {} })).rejects.toThrow(
      /could not be upgraded.*journal update denied/
    )

    expect(options.runtimeRepair.quarantineProtectedIdentity).toHaveBeenCalledWith(target)
    expect(await pending(runtimeRoot)).toEqual([
      expect.objectContaining({ repairReason: 'interrupted-install' })
    ])
  })

  it('retains sidecar and journal and blocks the target for an unconfirmed child', async () => {
    let operationId = ''
    const childFailure = new Error(`install failed: ${CHILD_UNCONFIRMED}`)
    const release = vi.fn().mockResolvedValue(false)
    const { owner, options, target, runtimeRoot } = ownerHarness({
      retainWorkingCache: vi.fn(() => release),
      environmentStateTracker: {
        inspectPackages: vi.fn().mockResolvedValue({
          inventory: { source: 'unavailable', validation: 'unavailable' },
          packages: []
        }),
        markPackageMutationDirty: vi.fn(async (_target, mutation) => {
          operationId = mutation.operationId
        }),
        refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'failure' })
      },
      installPackages: vi.fn(async (_request, deps) => {
        deps?.onBeforeSpawn?.()
        deps?.onChild?.(process.pid)
        throw childFailure
      })
    })

    await expect(owner.mutate({ target, mirror: {} })).rejects.toBe(childFailure)

    expect(options.blockUnconfirmedChild).toHaveBeenCalledWith(target)
    expect(options.environmentStateTracker.refreshAfterPackageMutation).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith({
      archivePublications: [],
      completedOperationId: operationId,
      retainForRecovery: true
    })
    expect(await pending(runtimeRoot)).toEqual([expect.objectContaining({ operationId })])
    expect(readOperationChild(runtimeRoot, operationId)).toMatchObject({ spawning: true })
  })
})
