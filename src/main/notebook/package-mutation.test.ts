import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('clears settled cache-maintenance child evidence before the installer transaction', async () => {
    let operationId = ''
    const { owner, target, runtimeRoot } = ownerHarness({
      environmentStateTracker: {
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
    const { owner, options, target, runtimeRoot } = ownerHarness({
      environmentStateTracker: {
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
    expect(await pending(runtimeRoot)).toEqual([expect.objectContaining({ operationId })])
    expect(readOperationChild(runtimeRoot, operationId)).toMatchObject({ spawning: true })
  })
})
