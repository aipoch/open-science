import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import { createRootNotebookLane } from './lane-identity'
import { NotebookPackageOperations } from './package-operations'
import { CHILD_UNCONFIRMED } from './provisioner-runtime'
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
    projectId: 'project',
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
  it.each([
    {
      label: 'partially verified batch',
      ok: true,
      needsRestart: true,
      changes: true,
      risk: 'confirmed'
    },
    {
      label: 'verified changes without installer restart flag',
      ok: true,
      needsRestart: false,
      changes: true,
      risk: 'none'
    },
    {
      label: 'installer failure after partial changes',
      ok: false,
      needsRestart: false,
      changes: true,
      risk: 'possible'
    },
    {
      label: 'installer failure with mutation risk and no readable delta',
      ok: false,
      needsRestart: false,
      changes: false,
      risk: 'possible'
    }
  ] as const)(
    'E06 recommends R restart after $label',
    async ({ ok, needsRestart, changes, risk }) => {
      const activeSession = session('session-1')
      const { owner, options } = harness(activeSession)
      const packageChanges = changes
        ? [
            {
              name: 'dplyr',
              ecosystem: 'r' as const,
              relationship: 'requested' as const,
              change: 'updated' as const,
              beforeVersion: '1.0',
              afterVersion: '1.1'
            }
          ]
        : []
      vi.mocked(options.installPackages).mockResolvedValue({
        ok,
        needsRestart,
        log: 'dplyr changed; missing unavailable',
        method: 'cran',
        attempts: [
          {
            groupOrdinal: 0,
            installer: 'r-install-packages',
            packages: ['dplyr', 'missing'],
            status: ok ? 'succeeded' : 'failed',
            mutationRisk: risk
          }
        ]
      })
      vi.mocked(options.environmentStateTracker.refreshAfterPackageMutation).mockResolvedValue({
        result: 'failure',
        unsatisfiedPackages: ['missing'],
        packageChanges
      })

      const result = await owner.manage({ language: 'r', packages: ['dplyr', 'missing'] })

      expect(result.ok).toBe(false)
      expect(result.packageChanges).toEqual(packageChanges)
      expect.soft(result.needsRestart).toBe(true)
      expect
        .soft(options.environmentOperations.recommendRestart)
        .toHaveBeenCalledWith('r', 'default-r')
      expect.soft(options.notifyChanged).toHaveBeenCalledWith(activeSession)
    }
  )

  it('E06 does not recommend restart when admission prevents the installer from starting', async () => {
    const { owner, options } = harness(session('session-1'), {
      isDefaultEnvironmentDisabled: vi.fn().mockResolvedValue(true)
    })
    const result = await owner.manage({ language: 'r', packages: ['dplyr'] })
    expect(result).toMatchObject({ ok: false, needsRestart: false })
    expect(options.installPackages).not.toHaveBeenCalled()
    expect(options.environmentOperations.recommendRestart).not.toHaveBeenCalled()
  })

  it.each(['failed', 'skipped'] as const)(
    'E06 does not infer mutation from observations or an attempt that is %s without mutation',
    async (status) => {
      const { owner, options } = harness(session('session-1'))
      vi.mocked(options.installPackages).mockResolvedValue({
        ok: false,
        needsRestart: false,
        log: '',
        attempts: [
          {
            groupOrdinal: 0,
            installer: 'r-install-packages',
            packages: ['missing'],
            status,
            mutationRisk: 'none'
          }
        ]
      })
      vi.mocked(options.environmentStateTracker.refreshAfterPackageMutation).mockResolvedValue({
        result: 'failure',
        packageChanges: [
          { name: 'dplyr', ecosystem: 'r', relationship: 'dependency', change: 'observed' },
          { name: 'tibble', ecosystem: 'r', relationship: 'dependency', change: 'unchanged' }
        ]
      })
      await expect(owner.manage({ language: 'r', packages: ['missing'] })).resolves.toMatchObject({
        ok: false,
        needsRestart: false
      })
      expect(options.environmentOperations.recommendRestart).not.toHaveBeenCalled()
    }
  )

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

    expect(result).toMatchObject({
      ok: true,
      needsRestart: true,
      environmentName: 'default-r'
    })
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

  it('returns an explicit target receipt when the admitted installer throws', async () => {
    const managed = binding('python', '/runtime/analysis/python', 'managed', 'analysis')
    const { owner, options } = harness(session('session-1', managed), {
      installPackages: vi
        .fn()
        .mockRejectedValue(new Error(`installer exploded: ${'x'.repeat(3_000)}`))
    })

    const result = await owner.manage({
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      language: 'python',
      packages: ['numpy']
    })

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining('installer exploded'),
      target: {
        language: 'python',
        selection: 'explicit-binding',
        runtimeId: managed.runtimeId
      }
    })
    expect(result.error).toHaveLength(2_000)
    expect(options.environmentOperations.logPackageFailure).toHaveBeenCalled()
  })

  it('returns the known target receipt while retaining recovery protection for an unconfirmed child', async () => {
    const { owner, options } = harness(session('session-1'), {
      installPackages: vi
        .fn()
        .mockRejectedValue(new Error(`installer failed: ${CHILD_UNCONFIRMED}`))
    })

    await expect(owner.manage({ language: 'python', packages: ['numpy'] })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(CHILD_UNCONFIRMED),
      target: {
        language: 'python',
        selection: 'implicit-default',
        environmentName: 'default-python'
      }
    })
    expect(options.recovery.markRuntimeLiveUnconfirmed).toHaveBeenCalled()
    expect(options.recovery.markLiveUnconfirmed).toHaveBeenCalled()
  })

  it('returns the known target receipt when the mutation transaction throws before install', async () => {
    const { owner, options } = harness(session('session-1'), {
      environmentStateTracker: {
        inspectPackages: vi.fn(),
        markPackageMutationDirty: vi.fn().mockRejectedValue(new Error('dirty marker unavailable')),
        refreshAfterPackageMutation: vi.fn()
      }
    })

    await expect(owner.manage({ language: 'r', packages: ['dplyr'] })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('dirty marker unavailable'),
      target: {
        language: 'r',
        selection: 'implicit-default',
        environmentName: 'default-r'
      }
    })
    expect(options.installPackages).not.toHaveBeenCalled()
  })

  it('returns the loaded explicit target when recovery fails before package admission', async () => {
    const managed = binding('python', '/runtime/analysis/python', 'managed', 'analysis')
    const { owner, options } = harness(session('session-1', managed), {
      ensureRecovered: vi.fn().mockRejectedValue(new Error('runtime recovery failed'))
    })

    await expect(
      owner.manage({
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        language: 'python',
        packages: ['numpy']
      })
    ).resolves.toMatchObject({
      ok: false,
      error: 'runtime recovery failed',
      target: {
        language: 'python',
        selection: 'explicit-binding',
        runtimeSource: 'managed',
        environmentName: 'analysis',
        runtimeId: managed.runtimeId
      }
    })
    expect(options.installPackages).not.toHaveBeenCalled()
  })

  it('reuses one loaded Session for target receipt and package admission', async () => {
    const managed = binding('python', '/runtime/analysis/python', 'managed', 'analysis')
    const loaded = session('session-1', managed)
    const { owner, options } = harness(loaded, {
      findSession: vi.fn(() => undefined),
      loadSession: vi.fn().mockResolvedValue(loaded)
    })

    await expect(
      owner.manage({
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        language: 'python',
        packages: ['numpy']
      })
    ).resolves.toMatchObject({
      ok: true,
      target: {
        language: 'python',
        selection: 'explicit-binding',
        runtimeId: managed.runtimeId
      }
    })
    expect(options.loadSession).toHaveBeenCalledTimes(1)
  })

  it('does not invent a default target when a disposed Session cannot be resolved', async () => {
    const activeSession = session('other-session')
    const { owner, options } = harness(activeSession, {
      ensureRecovered: vi.fn().mockRejectedValue(new Error('runtime service disposed')),
      findSession: vi.fn(() => undefined),
      loadSession: vi.fn().mockRejectedValue(new Error('Session is disposed'))
    })

    await expect(
      owner.manage({
        sessionId: 'disposed-session',
        workspaceCwd: '/workspace',
        language: 'python',
        packages: ['numpy']
      })
    ).resolves.toMatchObject({
      ok: false,
      error: 'runtime service disposed',
      target: { language: 'python', selection: 'unresolved' }
    })
    expect(options.installPackages).not.toHaveBeenCalled()
  })

  it.each([
    [
      'Error rejection',
      new Error('persisted Session could not be loaded'),
      'persisted Session could not be loaded'
    ],
    ['non-Error rejection', 'storage offline', 'storage offline']
  ])(
    'returns an unresolved target when Session loading rejects with %s',
    async (_kind, cause, message) => {
      const activeSession = session('other-session')
      const { owner, options } = harness(activeSession, {
        findSession: vi.fn(() => undefined),
        loadSession: vi.fn().mockRejectedValue(cause)
      })

      const result = await owner.manage({
        sessionId: 'persisted-session',
        workspaceCwd: '/workspace',
        language: 'python',
        packages: ['numpy']
      })

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining(message),
        target: { language: 'python', selection: 'unresolved' }
      })
      expect(result.error?.length).toBeLessThanOrEqual(2_000)
      expect(options.installPackages).not.toHaveBeenCalled()
    }
  )

  it('returns the same unresolved failure contract when the Session registry lookup throws', async () => {
    const activeSession = session('other-session')
    const { owner, options } = harness(activeSession, {
      findSession: vi.fn(() => {
        throw new Error('Session registry unavailable')
      })
    })

    await expect(
      owner.manage({
        sessionId: 'persisted-session',
        language: 'python',
        packages: ['numpy']
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('Session registry unavailable'),
      target: { language: 'python', selection: 'unresolved' }
    })
    expect(options.installPackages).not.toHaveBeenCalled()
  })

  it('bounds Session target-resolution diagnostics without dropping the receipt', async () => {
    const activeSession = session('other-session')
    const { owner } = harness(activeSession, {
      loadSession: vi.fn().mockRejectedValue(new Error('x'.repeat(3_000)))
    })

    const result = await owner.manage({
      sessionId: 'persisted-session',
      workspaceCwd: '/workspace',
      language: 'python',
      packages: ['numpy']
    })

    expect(result).toMatchObject({
      ok: false,
      target: { language: 'python', selection: 'unresolved' }
    })
    expect(result.error).toHaveLength(2_000)
  })

  it('does not invent a default target when only an unloaded Session id is available', async () => {
    const activeSession = session('other-session')
    const { owner, options } = harness(activeSession, {
      findSession: vi.fn(() => undefined)
    })

    await expect(
      owner.manage({
        sessionId: 'persisted-session',
        language: 'python',
        packages: ['numpy']
      })
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('RUNTIME_SESSION_UNAVAILABLE'),
      target: { language: 'python', selection: 'unresolved' }
    })
    expect(options.loadSession).not.toHaveBeenCalled()
    expect(options.installPackages).not.toHaveBeenCalled()
  })

  it('uses the runtime label as the environment name for an external binding', async () => {
    const external = {
      ...binding('python', '/opt/research/bin/python', 'external'),
      label: 'Research Python'
    }
    const { owner } = harness(session('session-1', external), {
      resolveRuntimeEnablement: vi.fn().mockResolvedValue({
        enabled: { [external.runtimeId]: true },
        installAuthorized: { [external.runtimeId]: true }
      })
    })

    const result = await owner.manage({
      sessionId: 'session-1',
      language: 'python',
      packages: ['numpy']
    })

    expect(result.environmentName).toBe('Research Python')
    expect(result.target).toMatchObject({ label: 'Research Python' })
  })
})
