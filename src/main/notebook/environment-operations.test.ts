import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'
import { NotebookEnvironmentOperations } from './environment-operations'
import { createRootNotebookLane, type NotebookLaneIdentity } from './lane-identity'
import { NotebookRecoveryCoordinator } from './recovery-coordinator'
import { managedRuntimeIdentity } from './runtime-target'

let storageRoot: string | undefined

afterEach(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

const createRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-environment-operations-'))
  return storageRoot
}

type TestSession = {
  projectId: string
  sessionId: string
  runtimeRoot?: string
  lane: NotebookLaneIdentity
  bindings: Partial<Record<NotebookLanguage, NotebookSessionRuntimeBinding>>
  statuses: Map<string, 'idle' | 'running' | 'terminated'>
  runtimeBinding(language: NotebookLanguage): NotebookSessionRuntimeBinding | undefined
  setRuntimeBinding(language: NotebookLanguage, binding: NotebookSessionRuntimeBinding): void
  kernelStatus(processKey: string): 'idle' | 'running' | 'terminated' | undefined
  markForceStopped(processKey: string): void
  drainExecution(processKey: string): Promise<void>
  terminateExecutor(kind: 'python' | 'r', environment: string): Promise<void>
  clearProcessState(processKey: string): void
}

const createOwner = async (
  sessions: TestSession[] = []
): Promise<{
  owner: NotebookEnvironmentOperations
  notifyChanged: ReturnType<typeof vi.fn>
  clearKernelTermination: ReturnType<typeof vi.fn>
}> => {
  const recovery = new NotebookRecoveryCoordinator(join(await createRoot(), 'runtime'))
  const notifyChanged = vi.fn()
  const clearKernelTermination = vi.fn(async () => undefined)
  const bindings = {
    runWrites: async <T>(_sessionIds: Iterable<string>, operation: () => Promise<T>): Promise<T> =>
      operation(),
    revoke: async <Context>(
      session: TestSession,
      language: NotebookLanguage,
      runtimeId: string,
      beforeRevoke: (binding: NotebookSessionRuntimeBinding) => Context
    ): Promise<Context | undefined> => {
      const binding = session.runtimeBinding(language)
      if (!binding || binding.runtimeId !== runtimeId || binding.status === 'unavailable') {
        return undefined
      }
      const context = beforeRevoke(binding)
      session.setRuntimeBinding(language, {
        ...binding,
        status: 'unavailable',
        reason: 'disabled'
      })
      return context
    }
  }
  const owner = new NotebookEnvironmentOperations({
    recovery,
    bindings,
    sessions: () => sessions,
    clearKernelTermination,
    notifyChanged,
    now: () => 123
  })
  return { owner, notifyChanged, clearKernelTermination }
}

describe('NotebookEnvironmentOperations', () => {
  it('owns operation admission and releases a failed mutation before the next waiter', async () => {
    const { owner } = await createOwner()
    let releaseFirst!: () => void
    const first = owner.runMutation(
      'analysis',
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    )
    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))

    const queued = owner.runMutation('analysis', async () => 'second')
    expect(owner.snapshot()).toMatchObject({
      active: [{ kind: 'mutation', environment: 'analysis', startedAt: 123 }],
      leases: {
        disposed: false,
        environments: [
          {
            environment: 'analysis',
            holders: { shared: 0, exclusive: 1 },
            waiters: { shared: 0, exclusive: 1 }
          }
        ]
      }
    })

    releaseFirst()
    await first
    await expect(queued).resolves.toBe('second')
    await expect(
      owner.runMutation('analysis', async () => {
        throw new Error('failed mutation')
      })
    ).rejects.toThrow('failed mutation')
    await expect(owner.runMutation('analysis', async () => 'after failure')).resolves.toBe(
      'after failure'
    )
    expect(owner.snapshot()).toMatchObject({ active: [], leases: { environments: [] } })
  })

  it('retains scoped provisioning progress and the terminal diagnostic after failure', async () => {
    const { owner } = await createOwner()
    const forwarded: unknown[] = []
    owner.setDefaultEnvProvisioner(
      {
        provisionPython: async (report) => {
          report({ phase: 'extract', message: 'extracting', progress: 0.5, language: 'python' })
          throw new Error('bundle corrupt')
        },
        provisionR: async () => undefined
      },
      (progress) => forwarded.push(progress)
    )

    await expect(
      owner.ensureDefaultEnvironmentReady({
        language: 'python',
        environment: 'default-python',
        runtimeRoot: join(storageRoot!, 'runtime'),
        sessionId: 'session-1',
        ensureRecovered: async () => undefined,
        assertRecoverable: () => undefined
      })
    ).rejects.toThrow('Could not prepare default-python: bundle corrupt')

    expect(forwarded).toEqual([
      expect.objectContaining({ phase: 'extract', scope: 'python', sessionId: 'session-1' }),
      expect.objectContaining({
        phase: 'error',
        language: 'python',
        scope: 'python',
        sessionId: 'session-1'
      })
    ])
    expect(owner.snapshot()).toMatchObject({
      active: [],
      progress: {
        phase: 'error',
        language: 'python',
        scope: 'python',
        sessionId: 'session-1'
      }
    })
  })

  it('checks Agent creation policy only when the managed default is missing', async () => {
    const { owner } = await createOwner()
    const provisionPython = vi.fn(async () => undefined)
    const assertCreationAllowed = vi.fn(async () => {
      throw new Error('AGENT_ENVIRONMENT_CREATION_DISABLED')
    })
    owner.setDefaultEnvProvisioner({
      provisionPython,
      provisionR: async () => undefined
    })

    await expect(
      owner.ensureDefaultEnvironmentReady({
        language: 'python',
        environment: 'default-python',
        runtimeRoot: join(storageRoot!, 'runtime'),
        sessionId: 'session-1',
        ensureRecovered: async () => undefined,
        assertRecoverable: () => undefined,
        assertCreationAllowed
      })
    ).rejects.toThrow('AGENT_ENVIRONMENT_CREATION_DISABLED')
    expect(provisionPython).not.toHaveBeenCalled()
  })

  it('drains admitted default provisioning and rejects new provisioning before removal', async () => {
    const { owner } = await createOwner()
    const order: string[] = []
    let releaseProvision!: () => void
    owner.setDefaultEnvProvisioner({
      provisionPython: () =>
        new Promise<void>((resolve) => {
          order.push('provision')
          releaseProvision = resolve
        }),
      provisionR: async () => undefined
    })
    const input = {
      language: 'python' as const,
      environment: 'default-python',
      runtimeRoot: join(storageRoot!, 'runtime'),
      sessionId: 'session-1',
      ensureRecovered: async () => undefined,
      assertRecoverable: () => undefined
    }

    const provision = owner.ensureDefaultEnvironmentReady(input)
    await vi.waitFor(() => expect(releaseProvision).toBeTypeOf('function'))
    const removal = owner.withRemovalBarrier('default-python', () =>
      owner.runRemoval('default-python', async () => {
        order.push('remove')
      })
    )

    await expect(owner.ensureDefaultEnvironmentReady(input)).rejects.toThrow(
      'RUNTIME_ENVIRONMENT_REMOVING'
    )
    expect(order).toEqual(['provision'])

    releaseProvision()
    await Promise.all([provision, removal])
    expect(order).toEqual(['provision', 'remove'])
  })

  it('marks a binding unavailable before tracking its background revocation drain', async () => {
    let releaseDrain!: () => void
    const terminations: string[] = []
    const session: TestSession = {
      projectId: 'project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('project', 'session-1', 'root-frame-session-1'),
      bindings: {
        python: {
          language: 'python',
          runtimeId: '/env/python',
          source: 'external',
          provenance: 'user-own',
          interpreterPath: '/env/python',
          label: 'Python',
          status: 'active'
        }
      },
      statuses: new Map([['python:default-python', 'running']]),
      runtimeBinding(language) {
        return this.bindings[language]
      },
      setRuntimeBinding(language, binding) {
        this.bindings[language] = binding
      },
      kernelStatus(processKey) {
        return this.statuses.get(processKey)
      },
      markForceStopped: vi.fn(),
      drainExecution: async () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve
        }),
      terminateExecutor: async (kind, environment) => {
        terminations.push(`${kind}:${environment}`)
      },
      clearProcessState(processKey) {
        this.statuses.delete(processKey)
      }
    }
    const { owner, notifyChanged, clearKernelTermination } = await createOwner([session])

    await owner.revokeRuntime('python', '/env/python')

    expect(session.bindings.python).toMatchObject({ status: 'unavailable', reason: 'disabled' })
    await vi.waitFor(() => expect(releaseDrain).toBeTypeOf('function'))
    expect(owner.snapshot().revocationDrains).toBe(1)
    expect(terminations).toEqual([])

    releaseDrain()
    await owner.waitForRevocationDrains()
    expect(terminations).toEqual(['python:default-python'])
    expect(clearKernelTermination).toHaveBeenCalledWith(session, 'python:default-python')
    expect(owner.snapshot().revocationDrains).toBe(0)
    expect(notifyChanged).toHaveBeenCalledTimes(2)
  })

  it('holds the environment mutation lease until a background revocation drain closes the executor', async () => {
    let releaseDrain!: () => void
    const order: string[] = []
    const session: TestSession = {
      projectId: 'project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('project', 'session-1', 'root-frame-session-1'),
      bindings: {
        python: {
          language: 'python',
          runtimeId: '/env/python',
          source: 'external',
          provenance: 'user-own',
          interpreterPath: '/env/python',
          label: 'Python',
          status: 'active'
        }
      },
      statuses: new Map([['python:default-python', 'running']]),
      runtimeBinding(language) {
        return this.bindings[language]
      },
      setRuntimeBinding(language, binding) {
        this.bindings[language] = binding
      },
      kernelStatus(processKey) {
        return this.statuses.get(processKey)
      },
      markForceStopped: vi.fn(),
      drainExecution: async () =>
        new Promise<void>((resolve) => {
          order.push('drain')
          releaseDrain = resolve
        }),
      terminateExecutor: async () => {
        order.push('terminate')
      },
      clearProcessState(processKey) {
        this.statuses.delete(processKey)
      }
    }
    const { owner } = await createOwner([session])

    await owner.revokeRuntime('python', '/env/python')
    await vi.waitFor(() => expect(releaseDrain).toBeTypeOf('function'))
    const remove = owner.runMutation('default-python', async () => {
      order.push('remove')
    })
    await Promise.resolve()

    expect(order).toEqual(['drain'])
    releaseDrain()
    await remove
    expect(order).toEqual(['drain', 'terminate', 'remove'])
  })

  it('holds managed removal behind an admitted forced revocation teardown', async () => {
    let releaseExecution!: () => void
    let releaseTermination!: () => void
    const order: string[] = []
    const session: TestSession = {
      projectId: 'project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('project', 'session-1', 'root-frame-session-1'),
      bindings: {
        python: {
          language: 'python',
          runtimeId: '/managed/python',
          source: 'managed',
          provenance: 'app-managed',
          interpreterPath: '/managed/python',
          label: 'Python',
          status: 'active',
          envName: 'default-python'
        }
      },
      statuses: new Map([['python:default-python', 'running']]),
      runtimeBinding(language) {
        return this.bindings[language]
      },
      setRuntimeBinding(language, binding) {
        this.bindings[language] = binding
      },
      kernelStatus(processKey) {
        return this.statuses.get(processKey)
      },
      markForceStopped: vi.fn(),
      drainExecution: async () => undefined,
      terminateExecutor: () => {
        order.push('terminate')
        releaseExecution()
        return new Promise<void>((resolve) => {
          releaseTermination = resolve
        })
      },
      clearProcessState(processKey) {
        order.push('clear')
        this.statuses.delete(processKey)
      }
    }
    const { owner } = await createOwner([session])
    const execution = owner.runShared(
      'execution',
      'default-python',
      () =>
        new Promise<void>((resolve) => {
          releaseExecution = resolve
        })
    )
    await vi.waitFor(() => expect(releaseExecution).toBeTypeOf('function'))

    const revocation = owner.revokeRuntime('python', '/managed/python', { force: true })
    await vi.waitFor(() => expect(releaseTermination).toBeTypeOf('function'))
    const removal = owner.withRemovalBarrier('default-python', () =>
      owner.runRemoval('default-python', async () => {
        order.push('remove')
      })
    )
    await Promise.resolve()

    expect(order).toEqual(['terminate'])
    releaseTermination()
    await Promise.all([execution, revocation, removal])
    expect(order).toEqual(['terminate', 'clear', 'remove'])
  })

  it('reports and revokes an unbound session using the implicit managed default', async () => {
    const runtimeRoot = join(tmpdir(), 'open-science-implicit-default-runtime')
    const runtimeId = managedRuntimeIdentity(runtimeRoot, 'python', 'default-python').runtimeId
    const session: TestSession = {
      projectId: 'project',
      sessionId: 'session-1',
      runtimeRoot,
      lane: createRootNotebookLane('project', 'session-1', 'root-frame-session-1'),
      bindings: {},
      statuses: new Map([['python:default-python', 'running']]),
      runtimeBinding(language) {
        return this.bindings[language]
      },
      setRuntimeBinding(language, binding) {
        this.bindings[language] = binding
      },
      kernelStatus(processKey) {
        return this.statuses.get(processKey)
      },
      markForceStopped: vi.fn(),
      drainExecution: async () => undefined,
      terminateExecutor: vi.fn(async () => undefined),
      clearProcessState(processKey) {
        this.statuses.delete(processKey)
      }
    }
    const { owner, notifyChanged, clearKernelTermination } = await createOwner([session])

    expect(owner.describeRuntimeUsage('python', runtimeId)).toEqual({
      running: 1,
      idle: 0,
      dormant: 0
    })

    await owner.revokeRuntime('python', runtimeId, { force: true })

    expect(session.markForceStopped).toHaveBeenCalledWith('python:default-python')
    expect(session.terminateExecutor).toHaveBeenCalledWith('python', 'default-python')
    expect(clearKernelTermination).toHaveBeenCalledWith(session, 'python:default-python')
    expect(session.statuses.has('python:default-python')).toBe(false)
    expect(session.bindings).toEqual({})
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })

  it('rejects a queued package mutation after managed removal closes admission', async () => {
    const { owner } = await createOwner()
    const order: string[] = []
    let releaseExecution!: () => void
    const execution = owner.runShared(
      'execution',
      'default-python',
      () =>
        new Promise<void>((resolve) => {
          order.push('execution')
          releaseExecution = resolve
        })
    )
    await vi.waitFor(() => expect(releaseExecution).toBeTypeOf('function'))

    const packageMutation = owner.runPackageMutation('default-python', async () => {
      order.push('package')
    })
    const packageOutcome = expect(packageMutation).rejects.toThrow('RUNTIME_ENVIRONMENT_REMOVING')
    const removal = owner.withRemovalBarrier('default-python', () =>
      owner.runRemoval('default-python', async () => {
        order.push('remove')
      })
    )

    releaseExecution()
    await Promise.all([execution, packageOutcome, removal])
    expect(order).toEqual(['execution', 'remove'])
  })

  it('rejects an execution queued before managed removal closes admission', async () => {
    const { owner } = await createOwner()
    const order: string[] = []
    let releaseMutation!: () => void
    const mutation = owner.runMutation(
      'default-python',
      () =>
        new Promise<void>((resolve) => {
          order.push('mutation')
          releaseMutation = resolve
        })
    )
    await vi.waitFor(() => expect(releaseMutation).toBeTypeOf('function'))

    const execution = owner.runShared('execution', 'default-python', async () => {
      order.push('execution')
    })
    const executionOutcome = expect(execution).rejects.toThrow('RUNTIME_ENVIRONMENT_REMOVING')
    const removal = owner.withRemovalBarrier('default-python', () =>
      owner.runRemoval('default-python', async () => {
        order.push('remove')
      })
    )

    releaseMutation()
    await Promise.all([mutation, executionOutcome, removal])
    expect(order).toEqual(['mutation', 'remove'])
  })

  it('rejects new shared work while managed removal is active', async () => {
    const { owner } = await createOwner()
    let releaseRemoval!: () => void
    const removal = owner.withRemovalBarrier('default-python', () =>
      owner.runRemoval(
        'default-python',
        () =>
          new Promise<void>((resolve) => {
            releaseRemoval = resolve
          })
      )
    )
    await vi.waitFor(() => expect(releaseRemoval).toBeTypeOf('function'))

    await expect(
      owner.runShared('execution', 'default-python', async () => undefined)
    ).rejects.toThrow('RUNTIME_ENVIRONMENT_REMOVING')
    await expect(
      owner.runShared('inspection', 'default-python', async () => undefined)
    ).rejects.toThrow('RUNTIME_ENVIRONMENT_REMOVING')

    releaseRemoval()
    await removal
  })

  it('keeps restart, repair, recovery, and redacted diagnostics in one snapshot', async () => {
    const { owner } = await createOwner()

    owner.recommendRestart('r', 'analysis')
    owner.blockRepair('r:analysis')
    owner.logPackageResult({
      operationId: 'operation-1',
      operation: 'install',
      language: 'r',
      environmentName: 'analysis',
      runtimeSource: 'managed',
      packages: ['secret-package'],
      result: { ok: true, needsRestart: true, log: 'installed' },
      durationMs: 15
    })

    expect(owner.snapshot()).toMatchObject({
      restartRecommendedEnvironments: ['r:analysis'],
      repairBlockedEnvironments: ['r:analysis'],
      diagnostic: {
        level: 'info',
        message: 'package installer completed',
        fields: {
          operationId: 'operation-1',
          language: 'r',
          environmentName: 'analysis',
          ok: true,
          needsRestart: true
        }
      },
      recovery: { readiness: 'not-started' }
    })
  })

  it('returns defensive progress and diagnostic snapshots', async () => {
    const { owner } = await createOwner()
    owner.setDefaultEnvProvisioner({
      provisionPython: async (report) => {
        report({
          phase: 'download',
          message: 'downloading',
          progress: 0.5,
          language: 'python',
          download: {
            phase: 'downloading',
            transferred: 50,
            total: 100,
            percent: 50,
            bytesPerSecond: 10,
            attempt: 1
          }
        })
      },
      provisionR: async () => undefined
    })
    await owner.ensureDefaultEnvironmentReady({
      language: 'python',
      environment: 'default-python',
      runtimeRoot: join(storageRoot!, 'runtime'),
      sessionId: 'session-1',
      ensureRecovered: async () => undefined,
      assertRecoverable: () => undefined
    })
    owner.logPackageResult({
      operationId: 'operation-1',
      operation: 'install',
      language: 'python',
      environmentName: 'default-python',
      runtimeSource: 'managed',
      packages: ['numpy'],
      result: { ok: true, needsRestart: false, log: 'installed' },
      durationMs: 10
    })

    const snapshot = owner.snapshot()
    snapshot.progress!.download!.transferred = 999
    const diagnosticLog = snapshot.diagnostic!.fields.installerLog as { text: string }
    diagnosticLog.text = 'changed'

    expect(owner.snapshot().progress?.download?.transferred).toBe(50)
    expect(owner.snapshot().diagnostic?.fields.installerLog).toMatchObject({ text: 'installed' })
  })
})
