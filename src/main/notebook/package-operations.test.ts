import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import { createRootNotebookLane } from './lane-identity'
import { NotebookPackageOperations } from './package-operations'
import { NotebookRuntimeRepairPolicy } from './runtime-repair-policy'
import { NotebookSessionAggregate, type NotebookSessionRuntimeBinding } from './session-aggregate'

type PackageOptions = ConstructorParameters<typeof NotebookPackageOperations>[0]

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const binding = (
  language: NotebookLanguage,
  runtimeId: string,
  source: 'managed' | 'external',
  envName?: string
): NotebookSessionRuntimeBinding => ({
  language,
  runtimeId,
  source,
  provenance: source === 'managed' ? 'agent-created' : 'user-own',
  interpreterPath: runtimeId,
  label: runtimeId,
  ...(envName ? { envName } : {})
})

const session = (
  sessionId: string,
  runtimeBinding?: NotebookSessionRuntimeBinding
): NotebookSessionAggregate => {
  const value = new NotebookSessionAggregate({
    sessionId,
    projectName: 'project',
    lane: createRootNotebookLane('project', sessionId, 'root-frame-' + sessionId),
    cwd: '/workspace',
    notebookSessionRoot: '/workspace',
    dataRoot: '/data',
    runtimeRoot: '/runtime',
    runJsonPath: `/workspace/${sessionId}.json`,
    executionCount: 0,
    executorGeneration: Symbol(sessionId),
    executor: {
      execute: async () => ({
        status: 'completed' as const,
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: '/workspace',
        outputs: []
      }),
      shutdown: async () => ({ reaped: true })
    }
  })
  if (runtimeBinding) value.setRuntimeBinding(runtimeBinding.language, runtimeBinding)
  return value
}

const harness = (
  activeSession: NotebookSessionAggregate,
  overrides: Partial<PackageOptions> = {}
): {
  owner: NotebookPackageOperations
  options: PackageOptions
  runtimeRoot: string
  sharedCalls: Array<readonly ['execution' | 'inspection', string]>
} => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'notebook-package-operations-'))
  roots.push(storageRoot)
  const runtimeRoot = join(storageRoot, 'runtime')
  const sharedCalls: Array<readonly ['execution' | 'inspection', string]> = []
  const options: PackageOptions = {
    storageRoot,
    runtimeRoot,
    locale: 'en-US',
    resolvePackageMirror: vi.fn(() => ({ pypiIndex: 'https://mirror/simple' })),
    ensureRecovered: vi.fn().mockResolvedValue(undefined),
    loadSession: vi.fn().mockResolvedValue(activeSession),
    findSession: vi.fn((sessionId) =>
      sessionId === activeSession.sessionId ? activeSession : undefined
    ),
    sessions: () => [activeSession],
    notifyChanged: vi.fn(),
    resolveRuntimeEnablement: vi.fn().mockResolvedValue(undefined),
    isDefaultEnvironmentDisabled: vi.fn().mockResolvedValue(false),
    repairPolicy: new NotebookRuntimeRepairPolicy(runtimeRoot),
    runtimeRepair: {
      quarantineProtectedIdentity: vi.fn().mockResolvedValue(undefined),
      completeInterruptedInstall: vi.fn().mockResolvedValue(undefined)
    },
    recovery: {
      isGloballyBlocked: vi.fn(() => false),
      isPrefixBlocked: vi.fn(() => false),
      isRuntimeIdBlocked: vi.fn(() => false),
      markLiveUnconfirmed: vi.fn(),
      markRuntimeLiveUnconfirmed: vi.fn()
    },
    environmentOperations: {
      isRepairBlocked: vi.fn(() => false),
      logPackageFailure: vi.fn(),
      logPackageResult: vi.fn(),
      recommendRestart: vi.fn(),
      runMutation: async <Result>(
        _environment: string,
        operation: () => Promise<Result>
      ): Promise<Result> => operation(),
      runShared: async <Result>(
        kind: 'execution' | 'inspection',
        environment: string,
        operation: () => Promise<Result>
      ): Promise<Result> => {
        sharedCalls.push([kind, environment])
        return operation()
      }
    },
    environmentStateTracker: {
      inspectPackages: vi.fn().mockResolvedValue({
        inventory: { source: 'full-scan', validation: 'full-scan' },
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
    createEnvironmentCaptureTarget: (language, environmentName, candidate) => ({
      language,
      environmentName,
      runtimeSource: candidate?.source === 'external' ? 'external' : 'managed',
      command: candidate?.interpreterPath ?? `${runtimeRoot}/${environmentName}/${language}`
    }),
    ...overrides
  }
  return { owner: new NotebookPackageOperations(options), options, runtimeRoot, sharedCalls }
}

describe('NotebookPackageOperations', () => {
  it('inspects the Session-bound managed environment through the shared read slot', async () => {
    const managed = binding('python', '/runtime/analysis/python', 'managed', 'analysis')
    const activeSession = session('session-1', managed)
    const { owner, options, sharedCalls } = harness(activeSession)
    vi.mocked(options.environmentStateTracker.inspectPackages).mockResolvedValue({
      inventory: { source: 'full-scan', validation: 'full-scan' },
      packages: [
        {
          requested: 'numpy',
          name: 'numpy',
          status: 'installed',
          version: '2.2.0',
          versionStatus: 'known'
        }
      ]
    })

    const result = await owner.inspect({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      language: 'python',
      packages: ['numpy']
    })

    expect(result).toMatchObject({
      language: 'python',
      environmentName: 'analysis',
      runtimeSource: 'managed',
      runtimeId: managed.runtimeId,
      packages: [{ name: 'numpy', version: '2.2.0' }]
    })
    expect(sharedCalls).toEqual([['inspection', 'analysis']])
    expect(options.installPackages).not.toHaveBeenCalled()
  })

  it('keeps external inspection behind notebook execution approval', async () => {
    const external = binding('python', '/usr/bin/python3', 'external')
    const { owner, options } = harness(session('session-1', external))

    await expect(
      owner.inspect({
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        language: 'python',
        packages: ['numpy']
      })
    ).rejects.toThrow(/EXTERNAL_RUNTIME_INSPECTION_REQUIRES_EXECUTION/)

    expect(options.environmentStateTracker.inspectPackages).not.toHaveBeenCalled()
  })

  it('composes admission, mutation, repair completion and R restart publication', async () => {
    const activeSession = session('session-1')
    const { owner, options } = harness(activeSession, {
      resolvePackageMirror: vi.fn(() => ({ cranMirror: 'https://mirror/cran' })),
      installPackages: vi.fn().mockResolvedValue({
        ok: true,
        needsRestart: true,
        log: 'installed',
        method: 'conda'
      })
    })

    const result = await owner.manage({ language: 'r', packages: ['dplyr'] })

    expect(result).toMatchObject({ ok: true, needsRestart: true })
    expect(options.installPackages).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'r', environment: 'default-r' }),
      expect.objectContaining({ cranMirror: 'https://mirror/cran' })
    )
    expect(options.runtimeRepair.completeInterruptedInstall).toHaveBeenCalledWith(
      expect.objectContaining({ environmentName: 'default-r' })
    )
    expect(options.environmentOperations.recommendRestart).toHaveBeenCalledWith('r', 'default-r')
    expect(options.notifyChanged).toHaveBeenCalledWith(activeSession)
  })
})
