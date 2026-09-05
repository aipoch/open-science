import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NotebookLanguage } from '../../shared/notebook'
import type { NotebookSessionRuntimeBinding } from './session-aggregate'
import { NotebookEnvironmentOperations } from './environment-operations'
import {
  createFrameNotebookLane,
  createRootNotebookLane,
  notebookLaneKey,
  notebookLaneScope,
  type NotebookLaneIdentity
} from './lane-identity'
import { NotebookSessionRegistry, type NotebookSessionRegistryMember } from './session-registry'
import { NotebookRecoveryCoordinator } from './recovery-coordinator'

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
  sessions: TestSession[] | (() => Iterable<TestSession>) = [],
  beforeWrites: (keys: string[]) => Promise<void> | void = () => undefined
): Promise<{
  owner: NotebookEnvironmentOperations
  notifyChanged: ReturnType<typeof vi.fn>
  clearKernelTermination: ReturnType<typeof vi.fn>
}> => {
  const recovery = new NotebookRecoveryCoordinator(join(await createRoot(), 'runtime'))
  const notifyChanged = vi.fn()
  const clearKernelTermination = vi.fn(async () => undefined)
  const bindings = {
    runWrites: async <T>(keys: Iterable<string>, operation: () => Promise<T>): Promise<T> => {
      await beforeWrites([...keys])
      return operation()
    },
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
    sessions: typeof sessions === 'function' ? sessions : () => sessions,
    clearKernelTermination,
    notifyChanged,
    now: () => 123
  })
  return { owner, notifyChanged, clearKernelTermination }
}

describe('NotebookEnvironmentOperations', () => {
  it.each([false, true])('E04 revokes all current lane owners (force: %s)', async (force) => {
    const makeSession = (
      lane: NotebookLaneIdentity
    ): TestSession & NotebookSessionRegistryMember => ({
      ...notebookLaneScope(lane),
      lane,
      bindings: {
        python: {
          language: 'python' as const,
          runtimeId: '/env/python',
          source: 'external' as const,
          provenance: 'user-own' as const,
          interpreterPath: '/env/python',
          label: 'Python',
          status: 'active' as const
        }
      } as TestSession['bindings'],
      statuses: new Map<string, 'running'>([['python:default-python', 'running']]),
      runtimeBinding(language: NotebookLanguage) {
        return this.bindings[language]
      },
      setRuntimeBinding(language: NotebookLanguage, value: NotebookSessionRuntimeBinding) {
        this.bindings[language] = value
      },
      kernelStatus(key: string) {
        return this.statuses.get(key)
      },
      markForceStopped: vi.fn(),
      drainExecution: vi.fn().mockResolvedValue(undefined),
      terminateExecutor: vi.fn().mockResolvedValue(undefined),
      clearProcessState: vi.fn(),
      shutdownExecutor: vi.fn().mockResolvedValue({ reaped: true }),
      releaseMcpRpcConnection: vi.fn()
    })
    const lanes = [
      createRootNotebookLane('project', 'shared-session', 'root-frame-shared-session'),
      createFrameNotebookLane('project', 'shared-session', 'child-a', 'attempt-1'),
      createFrameNotebookLane('project', 'shared-session', 'child-a', 'attempt-2'),
      createFrameNotebookLane('project', 'shared-session', 'child-b'),
      createRootNotebookLane('other-project', 'shared-session', 'root-frame-shared-session')
    ]
    const registry = new NotebookSessionRegistry<ReturnType<typeof makeSession>>()
    const current = await Promise.all(
      lanes.map((lane) => registry.getOrCreate(lane, async () => makeSession(lane)))
    )
    const staleLane = createFrameNotebookLane('project', 'shared-session', 'replaced-child')
    const stale = await registry.getOrCreate(staleLane, async () => makeSession(staleLane))
    let replacement: ReturnType<typeof makeSession> | undefined
    const writes = vi.fn(async () => {
      await registry.remove(staleLane)
      replacement = await registry.getOrCreate(staleLane, async () => makeSession(staleLane))
    })
    const { owner } = await createOwner(() => registry.values(), writes)

    await owner.revokeRuntime('python', '/env/python', { force })
    await owner.waitForRevocationDrains()

    for (const candidate of current) {
      expect
        .soft(candidate.runtimeBinding('python'))
        .toMatchObject({ status: 'unavailable', reason: 'disabled' })
      expect.soft(candidate.terminateExecutor).toHaveBeenCalledWith('python', 'default-python')
      expect.soft(candidate.markForceStopped).toHaveBeenCalledTimes(force ? 1 : 0)
      expect.soft(candidate.drainExecution).toHaveBeenCalledTimes(force ? 0 : 1)
    }
    expect(stale.runtimeBinding('python')?.status).toBe('active')
    expect(stale.terminateExecutor).not.toHaveBeenCalled()
    expect(replacement?.runtimeBinding('python')?.status).toBe('active')
    expect(writes).toHaveBeenCalledWith([...lanes, staleLane].map(notebookLaneKey))
  })

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
          report({
            phase: 'create-python',
            event: { code: 'environment-create', environment: 'default-python' },
            progress: 0.5,
            language: 'python'
          })
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
      expect.objectContaining({ phase: 'create-python', scope: 'python', sessionId: 'session-1' }),
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
          phase: 'fetch-python',
          event: { code: 'downloading-python-runtime' },
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
