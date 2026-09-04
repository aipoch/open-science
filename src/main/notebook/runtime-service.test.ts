import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type {
  NotebookExecutionRequest,
  NotebookExecutionResult,
  NotebookExecutorLifecycleCallbacks
} from './runtime-service'
import type { NotebookSessionExecutor } from './session-aggregate'
import {
  NotebookRuntimeService,
  resolveDefaultExecutorOptions,
  resolveLoopScriptPaths
} from './runtime-service'
import { effectiveMirrorAsync, resetAutoMirrorCache } from './mirror-probe'
import { getNotebookInputRoot } from './input-staging'
import { getNotebookDataRoot, NotebookRunRepository, getRuntimeRoot } from './repository'
import { createRootNotebookLane } from './lane-identity'
import {
  RuntimeOperationJournal,
  operationJournalPath,
  recordSpawnIntentSync
} from './operation-journal'
import { DefaultRuntimeProvisioner } from './provisioner'
import {
  EnvironmentManifestPublicationError,
  type EnvironmentStateTracker
} from './environment-state-tracker'
import { CHILD_UNCONFIRMED } from './provisioner-runtime'
import type {
  InstallDeps as InstallDepsForTest,
  InstallRequest as InstallRequestForTest,
  InstallResult as InstallResultForTest
} from './package-manager'
import type { EnvironmentInfo } from '../../shared/notebook-env'
import {
  NOTEBOOK_STATE_HISTORY_FRAME_ID_LIMIT_BYTES,
  NOTEBOOK_STATE_HISTORY_PAGE_LIMIT,
  NOTEBOOK_STATE_TARGET_RUN_LIMIT,
  type NotebookEnvironmentPackageChange,
  type NotebookEnvironmentManifest,
  type NotebookEnvironmentStatus,
  type NotebookLanguage
} from '../../shared/notebook'
import type {
  DiscoveredInterpreter,
  RuntimeEnablement,
  RuntimeTargetReceipt
} from '../../shared/notebook-runtime'
import {
  CompletionGateCoordinator,
  createCompletionGatedControlToolInterceptor
} from '../agents/completion-gate'
import {
  addRepairRequired,
  DEFAULT_ENV_VERSION,
  DEFAULT_PY_ENV,
  DEFAULT_R_ENV,
  envPrefix,
  isProtectedIdentityRepairRequired,
  isRepairRequired,
  managedRepairRegistryKey,
  pythonBin,
  rBin,
  repairRegistryPath,
  writeReadyMarker,
  writeRReadyMarker
} from './runtime-paths'
import type { NotebookShellProcess } from './shell-process'
import { NOTEBOOK_CODE_LIMIT_BYTES } from './content-limits'
import type { RuntimeDiagnosticLogger } from './runtime-diagnostics'
import { projectNotebookDependencies, type AnalyzedNotebookRun } from './dependency-analysis'
import { NotebookRuntimeBindingOwner } from './runtime-binding'
import type { NotebookEnvironmentManager } from './environment-management'

let storageRoot: string | undefined

const helperDigest = (source: string): string => createHash('sha256').update(source).digest('hex')

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-notebook-runtime-'))
  return storageRoot
}

const createDeferred = <Value>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    storageRoot = undefined
  }
})

// Prime the process-wide fastest-mirror memo with a no-network probe so managePackages tests never
// race real HTTP — the live probe adds nondeterministic latency (which flakes the timing-sensitive
// concurrency tests) and geography-dependent results. Tests that assert a specific mirror reset +
// inject their own probe on top of this.
beforeAll(async () => {
  resetAutoMirrorCache()
  await effectiveMirrorAsync(undefined, 'en-US', {
    probe: async () => {
      throw new Error('no network in tests')
    }
  })
})

const verifiedPackageMutationTracker = (): Pick<
  EnvironmentStateTracker,
  | 'prepareRun'
  | 'captureCompletedRun'
  | 'inspectPackages'
  | 'markPackageMutationDirty'
  | 'refreshAfterPackageMutation'
> => ({
  prepareRun: vi.fn(),
  captureCompletedRun: vi.fn(),
  inspectPackages: vi.fn(),
  markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
  refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
})

const expectedManagedTarget = (
  runtimeRoot: string,
  language: NotebookLanguage,
  environmentName: string,
  selection: 'implicit-default' | 'explicit-binding' = 'implicit-default'
): RuntimeTargetReceipt => {
  const prefix = envPrefix(runtimeRoot, environmentName)
  return {
    language,
    selection,
    runtimeSource: 'managed',
    environmentName,
    runtimeId: language === 'r' ? rBin(prefix) : pythonBin(prefix),
    label: environmentName,
    prefix
  }
}

const expectBoundedPackageFailure = (
  result: InstallResultForTest,
  target: RuntimeTargetReceipt,
  error: RegExp
): void => {
  expect(result).toMatchObject({
    ok: false,
    needsRestart: false,
    error: expect.stringMatching(error),
    target
  })
  expect(result.error?.length).toBeLessThanOrEqual(2_000)
}

const lifecycleCallbackHarness = (
  root: string,
  options: {
    inPlaceRestart?: boolean
    repository?: NotebookRunRepository
    shutdown?: () => Promise<{ reaped: boolean }>
    logger?: RuntimeDiagnosticLogger
  } = {}
): {
  service: NotebookRuntimeService
  lifecycles: NotebookExecutorLifecycleCallbacks[]
  changedSessions: string[]
} => {
  const lifecycles: NotebookExecutorLifecycleCallbacks[] = []
  const changedSessions: string[] = []
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'default-project',
    repository: options.repository ?? new NotebookRunRepository(root),
    logger: options.logger,
    callbacks: {
      onNotebookChanged: (event) => changedSessions.push(event.sessionId)
    },
    executorFactory: (_sessionId, lifecycle) => {
      lifecycles.push(lifecycle)
      return {
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: options.shutdown ?? (async () => ({ reaped: true })),
        restart: options.inPlaceRestart ? async () => undefined : undefined
      }
    }
  })
  return { service, lifecycles, changedSessions }
}

describe('notebook runtime service', () => {
  it('deletes generated prompt input copies with their Session and Project input caches', async () => {
    const root = await createStorageRoot()
    const { service } = lifecycleCallbackHarness(root)
    const sessionAData = getNotebookDataRoot(root, 'project-a', 'session-a')
    const sessionBData = getNotebookDataRoot(root, 'project-a', 'session-b')
    const otherProjectData = getNotebookDataRoot(root, 'project-b', 'session-a')
    const sessionAPromptInput = join(sessionAData, 'inputs', 'groups-a.csv')
    const sessionBPromptInput = join(sessionBData, 'inputs', 'groups-b.csv')
    const otherProjectPromptInput = join(otherProjectData, 'inputs', 'groups-other.csv')
    const sessionAWorkingFile = join(sessionAData, 'analysis.csv')
    const sessionBWorkingFile = join(sessionBData, 'analysis.csv')
    const sessionAStagedInput = join(getNotebookInputRoot(root, 'project-a', 'session-a'), 'staged')
    const sessionBStagedInput = join(getNotebookInputRoot(root, 'project-a', 'session-b'), 'staged')

    await Promise.all(
      [
        sessionAPromptInput,
        sessionBPromptInput,
        otherProjectPromptInput,
        sessionAWorkingFile,
        sessionBWorkingFile,
        sessionAStagedInput,
        sessionBStagedInput
      ].map(async (path) => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, path)
      })
    )

    await service.deleteSessionInputs('project-a', 'session-a')
    await expect(readFile(sessionAPromptInput)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sessionAStagedInput)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sessionAWorkingFile, 'utf8')).resolves.toBe(sessionAWorkingFile)
    await expect(readFile(sessionBPromptInput, 'utf8')).resolves.toBe(sessionBPromptInput)
    await expect(readFile(otherProjectPromptInput, 'utf8')).resolves.toBe(otherProjectPromptInput)

    await service.deleteProjectInputs('project-a')
    await expect(readFile(sessionBPromptInput)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sessionBStagedInput)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(sessionBWorkingFile, 'utf8')).resolves.toBe(sessionBWorkingFile)
    await expect(readFile(otherProjectPromptInput, 'utf8')).resolves.toBe(otherProjectPromptInput)
  })

  it('returns only live-epoch namespace snapshots and does not create a session to inspect', async () => {
    const root = await createStorageRoot()
    const inspectNamespace = vi.fn(async () => ({
      status: 'available' as const,
      variableCount: 1,
      variablesTruncated: false,
      variables: [{ name: 'x', type: 'int', preview: '42' }]
    }))
    let executorCreations = 0
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => {
        executorCreations += 1
        return {
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            kernelDispatched: true,
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          inspectNamespace,
          restart: async () => undefined,
          shutdown: async () => ({ reaped: true })
        }
      }
    })
    const request = {
      projectId: 'default-project',
      sessionId: 'session-namespace',
      workspaceCwd: '/workspace'
    }

    await expect(
      service.inspectNamespace({
        ...request,
        language: 'python',
        environment: 'default-python'
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'kernel-not-live' })
    expect(executorCreations).toBe(0)

    await service.execute({ ...request, code: 'x = 42' })
    const snapshot = await service.inspectNamespace({
      ...request,
      language: 'python',
      environment: 'default-python'
    })
    expect(snapshot).toMatchObject({
      status: 'available',
      language: 'python',
      environment: 'default-python',
      variableCount: 1,
      variables: [{ name: 'x', type: 'int', preview: '42' }]
    })
    expect(snapshot.status === 'available' && snapshot.kernelEpochId).toEqual(expect.any(String))

    await service.restart(request)
    await expect(
      service.inspectNamespace({
        ...request,
        language: 'python',
        environment: 'default-python'
      })
    ).resolves.toEqual({ status: 'unavailable', reason: 'kernel-not-live' })
    expect(inspectNamespace).toHaveBeenCalledOnce()
  })

  it('resolves registered helper IDs before dispatching the producer request', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    let generation = 1
    let terminateKernel!: () => Promise<void>
    const repository = new NotebookRunRepository(root)
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      environmentStateTracker: verifiedPackageMutationTracker(),
      helperModuleCatalog: {
        resolve: async (id: string) => {
          const source =
            `PRIVATE_CONSTANT = ${generation === 1 ? 40 : 50}\n` +
            'def public_add(value):\n    return PRIVATE_CONSTANT + value'
          return id === 'registered-test-helper'
            ? {
                id,
                language: 'python' as const,
                source,
                sourceDigest: helperDigest(source),
                exports: ['public_add'],
                skillIdentity: 'skill:registered-test-helper',
                packageOrigin: 'personal',
                interfaceRevision: '2026-08-01',
                registeredGeneration: `generation-${generation}`,
                generationRoot: join(root, 'registered', `generation-${generation}`)
              }
            : undefined
        }
      },
      executorFactory: (_sessionId, lifecycle) => {
        terminateKernel = () => lifecycle.onTerminated('python', 'default-python')
        return {
          execute: async (request) => {
            executions.push(request)
            return {
              status: 'completed' as const,
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: [],
              helperModulesInitialized: request.helperModules?.map(({ id }) => id)
            }
          },
          shutdown: async () => ({ reaped: true }),
          restart: async () => undefined
        }
      }
    } as ConstructorParameters<typeof NotebookRuntimeService>[0])

    await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root,
      language: 'python',
      code: 'print(public_add(2))',
      helperModules: ['registered-test-helper']
    } as Parameters<NotebookRuntimeService['execute']>[0])
    generation = 2
    await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root,
      language: 'python',
      code: 'print(public_add(3))'
    } as Parameters<NotebookRuntimeService['execute']>[0])
    await terminateKernel()
    await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root,
      language: 'python',
      code: 'print(public_add(4))',
      helperModules: ['registered-test-helper']
    } as Parameters<NotebookRuntimeService['execute']>[0])
    generation = 3
    await service.restart({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root
    })
    await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root,
      language: 'python',
      code: 'print(public_add(5))',
      helperModules: ['registered-test-helper']
    } as Parameters<NotebookRuntimeService['execute']>[0])

    expect(executions).toHaveLength(4)
    expect(executions[0]).toMatchObject({
      code: 'print(public_add(2))',
      helperModules: [
        {
          id: 'registered-test-helper',
          language: 'python',
          exports: ['public_add']
        }
      ]
    })
    expect(executions[0]?.helperModules?.[0]?.code).not.toContain('print(public_add(2))')
    expect(executions[0]?.helperModules?.[0]).toMatchObject({
      registeredGeneration: 'generation-1'
    })
    expect(executions[0]?.protectedDirs).toContain(join(root, 'registered', 'generation-1'))
    expect(executions[1]?.helperModules).toBeUndefined()
    const persistedRuns = await repository.readSessionRuns('default-project', 'session-1')
    expect(persistedRuns[0]?.helperModules).toEqual(persistedRuns[1]?.helperModules)
    expect(persistedRuns[1]?.helperModules).toEqual([
      {
        helperId: 'registered-test-helper',
        skillIdentity: 'skill:registered-test-helper',
        packageOrigin: 'personal',
        interfaceRevision: '2026-08-01',
        registeredGeneration: 'generation-1',
        exports: ['public_add'],
        source:
          'PRIVATE_CONSTANT = 40\ndef public_add(value):\n    return PRIVATE_CONSTANT + value',
        sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    ])
    expect(executions[1]?.protectedDirs).toContain(join(root, 'registered', 'generation-1'))
    expect(executions[2]?.helperModules?.[0]).toMatchObject({
      registeredGeneration: 'generation-2'
    })
    expect(executions[2]?.protectedDirs).toContain(join(root, 'registered', 'generation-2'))
    expect(executions[3]?.helperModules?.[0]).toMatchObject({
      registeredGeneration: 'generation-3'
    })
    expect(executions[3]?.protectedDirs).toContain(join(root, 'registered', 'generation-3'))
  })

  it('forwards only authenticated bridge Skill scope to helper resolution', async () => {
    const root = await createStorageRoot()
    const scopes: unknown[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      helperModuleCatalog: {
        resolve: async (id, scope) => {
          scopes.push(scope)
          return {
            id,
            language: 'python',
            source: 'def public_value():\n    return 1',
            sourceDigest: helperDigest('def public_value():\n    return 1'),
            exports: ['public_value'],
            skillIdentity: 'skill:scope-helper',
            packageOrigin: 'personal',
            interfaceRevision: '1',
            registeredGeneration: 'generation-1'
          }
        }
      },
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed' as const,
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: [],
          helperModulesInitialized: request.helperModules?.map(({ id }) => id)
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const base = {
      projectId: 'default-project',
      workspaceCwd: root,
      code: 'public_value()',
      helperModules: ['scope-helper'],
      registeredHelperSkillIds: ['forged-skill']
    }

    await service.execute({ ...base, sessionId: 'untrusted-session' })
    await service.execute({
      ...base,
      sessionId: 'trusted-session',
      executionInvocationId: 'trusted-invocation'
    })

    expect(scopes).toEqual([
      {
        projectId: 'default-project',
        sessionId: 'untrusted-session'
      },
      {
        projectId: 'default-project',
        sessionId: 'trusted-session',
        allowedSkillIds: ['forged-skill']
      }
    ])
  })

  it('rejects unknown, illegal, structured, and R helper requests before kernel dispatch', async () => {
    const root = await createStorageRoot()
    const execute = vi.fn()
    const executorFactory = vi.fn(() => ({
      execute,
      shutdown: async () => ({ reaped: true })
    }))
    const catalogResolve = vi.fn(async () => undefined)
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      helperModuleCatalog: { resolve: catalogResolve },
      executorFactory
    })
    const base = {
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'producer_sentinel = True'
    }

    await expect(service.execute({ ...base, helperModules: ['unknown-helper'] })).rejects.toThrow(
      /UNKNOWN_HELPER_MODULE/
    )
    for (const id of [
      '',
      ' ',
      '.',
      '..',
      './helper',
      'helper/name',
      'helper\\name',
      'helper\0name',
      'Helper',
      'héĺper',
      'a'.repeat(129)
    ]) {
      await expect(service.execute({ ...base, helperModules: [id] })).rejects.toThrow(
        /INVALID_HELPER_ID/
      )
    }
    await expect(
      service.execute({
        ...base,
        helperModules: [{ id: 'unknown-helper', path: '/tmp/kernel.py', source: 'x', digest: 'x' }]
      } as unknown as Parameters<NotebookRuntimeService['execute']>[0])
    ).rejects.toThrow(/INVALID_HELPER_ID/)
    await expect(
      service.execute({ ...base, language: 'r', helperModules: ['unknown-helper'] })
    ).rejects.toThrow(/UNSUPPORTED_HELPER_LANGUAGE/)

    expect(catalogResolve).toHaveBeenCalledTimes(1)
    expect(executorFactory).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  it('routes root and child Frames through isolated owners while aggregating attributed history', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      executorFactory: () => ({
        execute: async (request) => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    const rootContext = {
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'root-frame-session-1',
      messageBranchId: 'branch-root',
      runtimeSegmentId: 'runtime-root',
      promptMessageId: 'message-root'
    }
    const childContext = {
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'child-frame-1',
      messageBranchId: 'branch-child',
      runtimeSegmentId: 'runtime-child',
      promptMessageId: 'message-child'
    }

    await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'root_value = 1',
      provenanceContext: rootContext
    })
    await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'child_value = 2',
      provenanceContext: childContext
    })

    expect(executions.map((request) => request.dataRoot)).toEqual([
      join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      join(root, 'notebooks', 'default-project', 'session-1', 'frames', 'child-frame-1', 'data')
    ])
    const state = await service.state({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      provenanceContext: rootContext
    })
    expect(
      state.runs.map(({ agentFrameId, runtimeSegmentId }) => ({
        agentFrameId,
        runtimeSegmentId
      }))
    ).toEqual([
      { agentFrameId: 'root-frame-session-1', runtimeSegmentId: 'runtime-root' },
      { agentFrameId: 'child-frame-1', runtimeSegmentId: 'runtime-child' }
    ])

    await service.shutdown({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      provenanceContext: childContext
    })
    await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'root_value += 1',
      provenanceContext: rootContext
    })
    expect(executions.at(-1)?.dataRoot).toBe(
      join(root, 'notebooks', 'default-project', 'session-1', 'data')
    )
  })

  it('shuts down every idle root and Frame lane owned by one Project', async () => {
    const root = await createStorageRoot()
    const shutdowns = [vi.fn(), vi.fn(), vi.fn()]
    let executorIndex = 0
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      executorFactory: () => {
        const shutdown = shutdowns[executorIndex++]
        return {
          execute: async (request) => ({
            status: 'completed' as const,
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => {
            shutdown()
            return { reaped: true }
          }
        }
      }
    })
    const rootContext = {
      rootFrameId: 'root-frame-session-1',
      agentFrameId: 'root-frame-session-1',
      messageBranchId: 'branch-root',
      runtimeSegmentId: 'runtime-root',
      promptMessageId: 'message-root'
    }
    const childContext = {
      ...rootContext,
      agentFrameId: 'child-frame-1',
      messageBranchId: 'branch-child',
      runtimeSegmentId: 'runtime-child',
      promptMessageId: 'message-child'
    }
    await service.execute({
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'root_value = 1',
      provenanceContext: rootContext
    })
    await service.execute({
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'child_value = 2',
      provenanceContext: childContext
    })
    await service.execute({
      projectId: 'project-2',
      sessionId: 'session-2',
      workspaceCwd: '/workspace',
      code: 'other_value = 3'
    })

    await service.shutdownProject('project-1')

    expect(shutdowns[0]).toHaveBeenCalledOnce()
    expect(shutdowns[1]).toHaveBeenCalledOnce()
    expect(shutdowns[2]).not.toHaveBeenCalled()
  })

  it('blocks new Project lanes and drains a pending lane creation before deletion snapshots', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const load = repository.loadOrCreate.bind(repository)
    const loading = createDeferred<void>()
    vi.spyOn(repository, 'loadOrCreate').mockImplementation(async (request) => {
      await loading.promise
      return load(request)
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      environmentStateTracker: verifiedPackageMutationTracker()
    })
    const request = {
      projectId: 'project-1',
      sessionId: 'session-pending',
      workspaceCwd: '/workspace'
    }

    const pending = service.state(request)
    await vi.waitFor(() => expect(repository.loadOrCreate).toHaveBeenCalledOnce())
    const deleting = service.shutdownProject('project-1')
    loading.resolve(undefined)

    await expect(pending).rejects.toThrow('Project is being deleted.')
    await expect(deleting).resolves.toBeUndefined()
    await expect(service.state(request)).rejects.toThrow('Project is being deleted.')

    service.releaseProjectDeletion('project-1')
    await expect(service.state(request)).resolves.toMatchObject({ sessionId: 'session-pending' })
    await service.shutdown(request)
  })

  it('drains an admitted restart before shutting down the Project lane', async () => {
    const root = await createStorageRoot()
    const restartGate = createDeferred<void>()
    const events: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => {
          events.push('shutdown')
          return { reaped: true }
        },
        restart: async () => {
          events.push('restart-started')
          await restartGate.promise
          events.push('restart-finished')
        }
      })
    })
    const request = {
      projectId: 'project-1',
      sessionId: 'session-restarting',
      workspaceCwd: root
    }
    await service.execute({ ...request, code: '1' })

    const restarting = service.restart(request)
    await vi.waitFor(() => expect(events).toContain('restart-started'))
    const deleting = service.shutdownProject('project-1')
    await Promise.resolve()

    expect(events).not.toContain('shutdown')
    await expect(service.state(request)).rejects.toThrow('Project is being deleted.')

    restartGate.resolve(undefined)
    await restarting
    await deleting

    expect(events).toEqual(['restart-started', 'restart-finished', 'shutdown'])
  })

  it('cancels an admitted execution before shutting down the Project lane', async () => {
    const root = await createStorageRoot()
    let executionSignal: AbortSignal | undefined
    const execute = vi.fn(
      (request: NotebookExecutionRequest) =>
        new Promise<NotebookExecutionResult>((resolve) => {
          executionSignal = request.signal
          request.signal?.addEventListener(
            'abort',
            () =>
              resolve({
                status: 'cancelled',
                stdout: '',
                stderr: 'cancelled',
                traceback: '',
                cwdAfter: request.cwd,
                outputs: []
              }),
            { once: true }
          )
        })
    )
    const shutdown = vi.fn(async () => ({ reaped: true }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      executorFactory: () => ({ execute, shutdown })
    })
    const request = {
      projectId: 'project-1',
      sessionId: 'session-executing',
      workspaceCwd: root
    }
    const begin = await service.beginCodeCell(request)
    await service.appendCodeCell({
      ...request,
      cellId: begin.cellId,
      writeId: begin.writeId,
      delta: '1'
    })
    await service.finishCodeCell({
      ...request,
      cellId: begin.cellId,
      writeId: begin.writeId
    })

    const running = service.runCell({ ...request, cellId: begin.cellId })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    const deleting = service.shutdownProject('project-1')
    await vi.waitFor(() => expect(executionSignal?.aborted).toBe(true))

    await expect(running).resolves.toMatchObject({ status: 'cancelled' })
    await deleting

    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('cancels admitted control and shell executions before Project shutdown completes', async () => {
    const root = await createStorageRoot()
    let controlSignal: AbortSignal | undefined
    let shellSignal: AbortSignal | undefined
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      executorFactory: () => ({
        execute: (request) =>
          new Promise<NotebookExecutionResult>((resolve) => {
            controlSignal = request.signal
            request.signal?.addEventListener(
              'abort',
              () =>
                resolve({
                  status: 'cancelled',
                  stdout: '',
                  stderr: 'cancelled',
                  traceback: '',
                  cwdAfter: request.cwd,
                  outputs: []
                }),
              { once: true }
            )
          }),
        shutdown: async () => ({ reaped: true })
      }),
      shellProcess: {
        execute: (request) =>
          new Promise((resolve) => {
            shellSignal = request.signal
            request.signal?.addEventListener(
              'abort',
              () =>
                resolve({
                  stdout: '',
                  stderr: 'Shell command was cancelled.',
                  exitCode: null,
                  cancelled: true
                }),
              { once: true }
            )
          })
      }
    })
    const scope = { projectId: 'project-1', workspaceCwd: root }

    const control = service.executeControl({ ...scope, sessionId: 'control-session', code: '1' })
    const shell = service.executeShell({
      ...scope,
      sessionId: 'shell-session',
      command: 'long-running-command'
    })
    await vi.waitFor(
      () => {
        expect(controlSignal).toBeInstanceOf(AbortSignal)
        expect(shellSignal).toBeInstanceOf(AbortSignal)
      },
      { timeout: 5_000 }
    )

    const deleting = service.shutdownProject('project-1')
    await vi.waitFor(
      () => {
        expect(controlSignal?.aborted).toBe(true)
        expect(shellSignal?.aborted).toBe(true)
      },
      { timeout: 5_000 }
    )

    await expect(control).resolves.toMatchObject({ status: 'cancelled' })
    await expect(shell).resolves.toEqual({
      stdout: '',
      stderr: 'Shell command was cancelled.',
      exitCode: null
    })
    await expect(deleting).resolves.toBeUndefined()
  })

  it('drains an admitted Project-scoped package install before shutdown completes', async () => {
    const root = await createStorageRoot()
    const installGate = createDeferred<InstallResultForTest>()
    const installPackagesImpl = vi.fn(() => installGate.promise)
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      installPackagesImpl
    })

    const installing = service.managePackages({
      projectId: 'project-1',
      language: 'python',
      packages: ['numpy']
    })
    await vi.waitFor(() => expect(installPackagesImpl).toHaveBeenCalledOnce())

    let shutdownCompleted = false
    const deleting = service.shutdownProject('project-1').then(() => {
      shutdownCompleted = true
    })
    await Promise.resolve()

    expect(shutdownCompleted).toBe(false)

    installGate.resolve({
      ok: true,
      needsRestart: false,
      log: 'installed',
      method: 'pip'
    })
    await installing
    await deleting

    expect(shutdownCompleted).toBe(true)
  })

  it('rejects new Project-scoped installs during deletion without blocking global installs', async () => {
    const root = await createStorageRoot()
    const installPackagesImpl = vi.fn().mockResolvedValue({
      ok: true,
      needsRestart: false,
      log: 'installed',
      method: 'pip'
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      installPackagesImpl
    })

    service.beginProjectDeletion('project-1')
    await expect(
      service.managePackages({
        projectId: 'project-1',
        language: 'python',
        packages: ['numpy']
      })
    ).rejects.toThrow('Project is being deleted.')
    expect(installPackagesImpl).not.toHaveBeenCalled()

    await expect(
      service.managePackages({ language: 'python', packages: ['numpy'] })
    ).resolves.toMatchObject({ ok: true })
    expect(installPackagesImpl).toHaveBeenCalledOnce()

    service.releaseProjectDeletion('project-1')
  })

  it('rejects session-scoped installs during deletion when projectId is omitted', async () => {
    const root = await createStorageRoot()
    const installPackagesImpl = vi.fn().mockResolvedValue({
      ok: true,
      needsRestart: false,
      log: 'installed',
      method: 'pip'
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      installPackagesImpl
    })

    service.beginProjectDeletion('default-project')

    await expect(
      service.managePackages({
        sessionId: 'session-1',
        language: 'python',
        packages: ['numpy']
      })
    ).rejects.toThrow('Project is being deleted.')
    expect(installPackagesImpl).not.toHaveBeenCalled()

    service.releaseProjectDeletion('default-project')
  })

  it('peeks only actionable in-memory handoff state without creating or reloading a Session', async () => {
    const root = await createStorageRoot()
    const { service } = lifecycleCallbackHarness(root)
    const sessionRoot = join(root, 'notebooks', 'default-project', 'session-1')

    expect(service.peekHandoffContext('session-1')).toBeUndefined()
    expect(existsSync(sessionRoot)).toBe(false)

    const begin = await service.beginCodeCell({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
    const handoff = service.peekHandoffContext('session-1')

    expect(handoff).toMatchObject({
      executionCount: 0,
      activeWriteCellId: begin.cellId,
      cells: [{ id: begin.cellId, language: 'python', status: 'receiving-code' }]
    })
    expect(JSON.stringify(handoff)).not.toContain('notebookSessionRoot')
    expect(JSON.stringify(handoff)).not.toContain('runtimeRoot')

    await service.shutdownSession('session-1')
    expect(service.peekHandoffContext('session-1')).toBeUndefined()
  })

  it('rejects oversized streamed code and releases the write lock', async () => {
    const root = await createStorageRoot()
    const { service } = lifecycleCallbackHarness(root)
    const begin = await service.beginCodeCell({
      sessionId: 'session-1',
      workspaceCwd: root
    })

    await expect(
      service.appendCodeCell({
        sessionId: 'session-1',
        workspaceCwd: root,
        cellId: begin.cellId,
        writeId: begin.writeId,
        delta: 'x'.repeat(NOTEBOOK_CODE_LIMIT_BYTES + 1)
      })
    ).rejects.toThrow(/exceeds/u)

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.activeWrite).toBeUndefined()
    expect(state.cells[0]).toMatchObject({ id: begin.cellId, code: '', status: 'idle' })
  })

  it('rejects an oversized targeted history request before creating a session', async () => {
    const root = await createStorageRoot()
    const { service } = lifecycleCallbackHarness(root)
    const runIds = Array.from(
      { length: NOTEBOOK_STATE_TARGET_RUN_LIMIT + 1 },
      (_, index) => `run-${index}`
    )

    await expect(
      service.state({ sessionId: 'session-1', workspaceCwd: root, runIds })
    ).rejects.toThrow(/at most 20 targeted run IDs/u)
    expect(service.peekHandoffContext('session-1')).toBeUndefined()
  })

  it('rejects an oversized history summary Frame ID before creating a session', async () => {
    const root = await createStorageRoot()
    const { service } = lifecycleCallbackHarness(root)

    await expect(
      service.state({
        sessionId: 'session-1',
        workspaceCwd: root,
        historySummaryFrameId: 'x'.repeat(NOTEBOOK_STATE_HISTORY_FRAME_ID_LIMIT_BYTES + 1)
      })
    ).rejects.toThrow(/history summary Frame ID must not exceed 1024 UTF-8 bytes/u)
    expect(service.peekHandoffContext('session-1')).toBeUndefined()
  })

  it('rejects invalid history page limits and cursors before creating a session', async () => {
    const root = await createStorageRoot()
    const { service } = lifecycleCallbackHarness(root)

    await expect(
      service.state({
        sessionId: 'session-1',
        workspaceCwd: root,
        historyLimit: NOTEBOOK_STATE_HISTORY_PAGE_LIMIT + 1
      })
    ).rejects.toThrow(/history limit must be 1-100/u)
    await expect(
      service.state({
        sessionId: 'session-1',
        workspaceCwd: root,
        historyBefore: { startedAt: Number.NaN, runId: '' }
      })
    ).rejects.toThrow(/history cursor is invalid/u)
    await expect(
      service.state({
        sessionId: 'session-1',
        workspaceCwd: root,
        historyBefore: { startedAt: 1, runId: 42 } as never
      })
    ).rejects.toThrow(/history cursor is invalid/u)
    await expect(
      service.state({
        sessionId: 'session-1',
        workspaceCwd: root,
        historyBefore: { startedAt: 1, runId: 'x'.repeat(1_025) }
      })
    ).rejects.toThrow(/history cursor is invalid/u)
    expect(service.peekHandoffContext('session-1')).toBeUndefined()
  })

  it('reports stale downstream runs when a new cell redefines their input', async () => {
    const root = await createStorageRoot()
    const analyzedRuns: AnalyzedNotebookRun[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      dependencyAnalyzer: {
        project: async ({ completedRun }) => {
          if (completedRun && !analyzedRuns.some(({ run }) => run.runId === completedRun.runId)) {
            analyzedRuns.push({
              run: completedRun,
              facts: completedRun.script.startsWith('y')
                ? {
                    state: 'available',
                    definedNames: ['y'],
                    usedNames: ['x'],
                    mutatedNames: []
                  }
                : {
                    state: 'available',
                    definedNames: ['x'],
                    usedNames: [],
                    mutatedNames: []
                  }
            })
          }
          return projectNotebookDependencies(analyzedRuns)
        }
      },
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: 'x = 1' })
    const downstream = await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'y = x + 1'
    })
    const replacement = await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'x = 2'
    })

    expect(replacement.invalidatedRuns).toEqual([
      { runId: downstream.runId, cellId: downstream.cellId, names: ['x'], state: 'stale' }
    ])
  })

  it('streams agent code into a locked cell and runs it through the shared executor', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const environmentManifest: NotebookEnvironmentManifest = {
      schemaVersion: 1,
      captureKind: 'completed-run',
      capturedAt: '2026-07-27T12:00:00.000Z',
      installedInventory: {
        capturedAt: '2026-07-27T12:00:00.000Z',
        source: 'full-scan',
        validation: 'full-scan'
      },
      kernelKind: 'python',
      environmentName: 'default-python',
      runtimeSource: 'managed',
      runtimeVersion: '3.13.2',
      platform: 'darwin',
      architecture: 'arm64',
      inventorySources: ['kernel-native', 'interpreter-native'],
      packages: [],
      complete: true,
      captureStatus: 'complete'
    }
    const captureCompletedRun = vi.fn().mockResolvedValue({
      manifest: environmentManifest,
      checksum: 'a'.repeat(64),
      storagePath: join(root, 'environment-manifest.json')
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: {
        prepareRun: vi.fn().mockResolvedValue({
          fingerprint: 'stable',
          inventoryRefreshed: false,
          warnings: []
        }),
        captureCompletedRun,
        inspectPackages: vi.fn(),
        markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
        refreshAfterPackageMutation: vi.fn().mockResolvedValue(undefined)
      },
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          const rawRunJson = await readFile(
            join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
            'utf8'
          )
          const document = JSON.parse(rawRunJson) as Awaited<
            ReturnType<NotebookRunRepository['loadOrCreate']>
          >

          expect(document.runs).toHaveLength(1)
          expect(document.runs[0]).toMatchObject({
            script: "print('hello')",
            status: 'running'
          })

          return {
            status: 'completed',
            stdout: 'hello\n',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [
              {
                type: 'stream',
                name: 'stdout',
                text: 'hello\n'
              }
            ],
            environmentOverlay: {
              runtimeVersion: '3.13.2',
              packages: []
            },
            workingFiles: [
              {
                path: join(root, 'notebooks', 'default-project', 'session-1', 'data', 'result.csv'),
                relativePath: 'data/result.csv',
                kind: 'processed-data',
                size: 12,
                mtimeMs: 200
              }
            ]
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const begin = await service.beginCodeCell({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })
    await service.appendCodeCell({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      writeId: begin.writeId,
      cellId: begin.cellId,
      delta: "print('hello')"
    })

    await expect(
      service.beginCodeCell({
        projectId: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: '/workspace'
      })
    ).rejects.toThrow(/already receiving code/)

    await service.finishCodeCell({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      writeId: begin.writeId,
      cellId: begin.cellId
    })

    const now = vi.spyOn(Date, 'now').mockReturnValue(42)
    const summary = await service.runCell({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      cellId: begin.cellId
    })
    now.mockRestore()

    expect(summary).toMatchObject({
      runId: 'notebook-run-42-1',
      kernelEpochId: expect.any(String),
      cellId: begin.cellId,
      source: 'agent',
      script: "print('hello')",
      status: 'completed',
      text: {
        stdout: 'hello\n'
      },
      notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
      dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      runtimeRoot: join(root, 'runtime'),
      workingFiles: [
        {
          relativePath: 'data/result.csv',
          kind: 'processed-data'
        }
      ],
      environmentCapture: {
        state: 'available',
        manifestChecksum: 'a'.repeat(64)
      },
      environmentManifest,
      environmentManifestChecksum: 'a'.repeat(64)
    })
    expect(executions[0]).toMatchObject({
      code: "print('hello')",
      // The interpreter runs in the session's writable data dir (Jupyter-style), not the workspace,
      // so relative writes land inside the artifact import roots.
      cwd: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
      dataRoot: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
      fileEvidenceStorageRoot: root,
      fileEvidenceRoot: join(root, 'execution-file-evidence', 'default-project', 'session-1'),
      fileEvidenceStoragePrefix: 'execution-file-evidence/default-project/session-1',
      runtimeRoot: join(root, 'runtime')
    })
    expect(captureCompletedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'python',
        environmentName: 'default-python',
        runtimeSource: 'managed'
      }),
      { runtimeVersion: '3.13.2', packages: [] },
      { fingerprint: 'stable', inventoryRefreshed: false, warnings: [] }
    )

    const rawRunJson = await readFile(
      join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
      'utf8'
    )

    expect(rawRunJson).toContain(`"script": "print('hello')"`)
    expect(JSON.parse(rawRunJson).runs).toHaveLength(1)
    expect(JSON.parse(rawRunJson).runs[0]).toMatchObject({
      status: 'completed',
      kernelEpochId: expect.any(String),
      environmentCapture: {
        state: 'available',
        manifestChecksum: 'a'.repeat(64)
      },
      environmentManifest,
      environmentManifestChecksum: 'a'.repeat(64)
    })
    expect(rawRunJson).toContain('"relativePath": "data/result.csv"')
  })

  it('captures executor failures as failed run summaries instead of throwing', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'failed',
          stdout: '',
          stderr: 'ModuleNotFoundError: No module named pandas\n',
          traceback: 'Traceback...\nModuleNotFoundError: No module named pandas',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    const summary = await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'import pandas'
    })

    expect(summary).toMatchObject({
      status: 'failed',
      environmentCapture: {
        state: 'unavailable',
        reason: 'environment-capture-failed'
      },
      text: {
        stderr: 'ModuleNotFoundError: No module named pandas\n',
        traceback: 'Traceback...\nModuleNotFoundError: No module named pandas'
      },
      runtimeRoot: join(root, 'runtime')
    })
  })

  it('persists an Agent-cancelled data execution as a cancelled run', async () => {
    const root = await createStorageRoot()
    const executionStarted = createDeferred<NotebookExecutionRequest>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: verifiedPackageMutationTracker(),
      executorFactory: () => ({
        execute: async (request) => {
          executionStarted.resolve(request)
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
          return {
            status: 'cancelled',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    const cancellation = new AbortController()
    const run = service.execute(
      {
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'long_running_analysis()'
      },
      cancellation.signal
    )
    const execution = await executionStarted.promise

    expect(execution.signal).toBeInstanceOf(AbortSignal)
    expect(execution.signal?.aborted).toBe(false)
    cancellation.abort()
    expect(execution.signal?.aborted).toBe(true)

    await expect(run).resolves.toMatchObject({ status: 'cancelled' })
    await expect(
      service.state({ sessionId: 'session-1', workspaceCwd: root })
    ).resolves.toMatchObject({
      cells: [
        expect.objectContaining({
          status: 'cancelled'
        })
      ],
      runs: [
        expect.objectContaining({
          status: 'cancelled',
          script: 'long_running_analysis()'
        })
      ]
    })
    const runJson = JSON.parse(
      await readFile(join(root, 'notebooks', 'default-project', 'session-1', 'run.json'), 'utf8')
    ) as { runs: Array<{ status: string }> }
    expect(runJson.runs).toEqual([expect.objectContaining({ status: 'cancelled' })])
  })

  it('repairs a transient terminal write failure on the next same-process state read', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    vi.spyOn(repository, 'updateRun').mockRejectedValueOnce(
      new Error('transient terminal write failure')
    )
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: 'done\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    await expect(
      service.execute({
        projectId: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'print("done")'
      })
    ).rejects.toThrow('transient terminal write failure')

    const state = await service.state({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root
    })

    expect(state.runs).toEqual([
      expect.objectContaining({
        status: 'completed',
        text: expect.objectContaining({ stdout: 'done\n' })
      })
    ])
  })

  it('does not invoke the executor when the initial running record cannot be persisted', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const appendError = new Error('could not append running run')
    vi.spyOn(repository, 'appendRun').mockRejectedValue(appendError)
    const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
      status: 'completed' as const,
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: request.cwd,
      outputs: []
    }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      executorFactory: () => ({
        execute,
        shutdown: async () => ({ reaped: true })
      })
    })
    const begin = await service.beginCodeCell({ sessionId: 'session-1', workspaceCwd: root })
    await service.appendCodeCell({
      sessionId: 'session-1',
      workspaceCwd: root,
      cellId: begin.cellId,
      writeId: begin.writeId,
      delta: '1 + 1'
    })
    await service.finishCodeCell({
      sessionId: 'session-1',
      workspaceCwd: root,
      cellId: begin.cellId,
      writeId: begin.writeId
    })

    await expect(
      service.runCell({ sessionId: 'session-1', workspaceCwd: root, cellId: begin.cellId })
    ).rejects.toBe(appendError)

    expect(execute).not.toHaveBeenCalled()
    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs).toEqual([])
    expect(state.activeRunId).toBeUndefined()
  })

  it('releases live ownership while leaving the running record recoverable when its terminal update cannot be persisted', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const updateError = new Error('could not persist terminal run')
    vi.spyOn(repository, 'updateRun').mockRejectedValue(updateError)
    const execute = vi.fn(async (request: NotebookExecutionRequest) => ({
      status: 'completed' as const,
      stdout: 'done\n',
      stderr: '',
      traceback: '',
      cwdAfter: request.cwd,
      outputs: [{ type: 'stream' as const, name: 'stdout' as const, text: 'done\n' }]
    }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      environmentStateTracker: {
        ...verifiedPackageMutationTracker(),
        prepareRun: vi.fn().mockResolvedValue(undefined),
        captureCompletedRun: vi.fn().mockRejectedValue(new Error('capture unavailable'))
      },
      executorFactory: () => ({
        execute,
        shutdown: async () => ({ reaped: true })
      })
    })
    const begin = await service.beginCodeCell({ sessionId: 'session-1', workspaceCwd: root })
    await service.appendCodeCell({
      sessionId: 'session-1',
      workspaceCwd: root,
      cellId: begin.cellId,
      writeId: begin.writeId,
      delta: 'print("done")'
    })
    await service.finishCodeCell({
      sessionId: 'session-1',
      workspaceCwd: root,
      cellId: begin.cellId,
      writeId: begin.writeId
    })

    await expect(
      service.runCell({ sessionId: 'session-1', workspaceCwd: root, cellId: begin.cellId })
    ).rejects.toBe(updateError)

    expect(execute).toHaveBeenCalledOnce()
    const document = await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      workspaceCwd: root
    })
    expect(document.runs).toHaveLength(1)
    expect(document.runs[0]).toMatchObject({
      runId: expect.stringMatching(/^notebook-run-/),
      status: 'running',
      script: 'print("done")'
    })
    await expect(service.state({ sessionId: 'session-1', workspaceCwd: root })).rejects.toBe(
      updateError
    )
  })

  it('persists a fail-closed default-runtime admission without dispatching or capturing evidence', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const defaultInterpreter = pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV))
    const execute = vi.fn(
      async (request: NotebookExecutionRequest): Promise<NotebookExecutionResult> => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: request.cwd,
        outputs: []
      })
    )
    const environmentStateTracker = verifiedPackageMutationTracker()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: {
            enabled: { [defaultInterpreter]: false },
            installAuthorized: {}
          },
          manualInterpreters: [],
          packageMirror: {}
        })
      },
      environmentStateTracker,
      executorFactory: () => ({ execute, shutdown: async () => ({ reaped: true }) })
    })

    const summary = await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      language: 'python',
      code: 'print(1)'
    })
    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })

    expect(summary).toMatchObject({
      status: 'failed',
      environment: DEFAULT_PY_ENV,
      text: { traceback: expect.stringMatching(/No enabled python runtime/i) }
    })
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]).toMatchObject({
      runId: summary.runId,
      status: 'failed',
      environment: DEFAULT_PY_ENV
    })
    expect(execute).not.toHaveBeenCalled()
    expect(environmentStateTracker.prepareRun).not.toHaveBeenCalled()
    expect(environmentStateTracker.captureCompletedRun).not.toHaveBeenCalled()
    await expect(repository.findExisting('default-project', 'session-1')).resolves.toMatchObject({
      runs: [expect.objectContaining({ kernelDispatched: false })]
    })
  })

  it('rejects install.packages in an R cell before the managed kernel executes it', async () => {
    const root = await createStorageRoot()
    const execute = vi.fn(async () => ({
      status: 'completed' as const,
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: root,
      outputs: []
    }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute,
        shutdown: async () => ({ reaped: true })
      })
    })

    const summary = await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      language: 'r',
      code: 'install.packages("dplyr")'
    })

    expect(execute).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ status: 'failed' })
    expect(summary.text.traceback).toMatch(/manage_packages/)
  })

  it('rejects Python venv creation in a data cell before the managed kernel executes it', async () => {
    const root = await createStorageRoot()
    const execute = vi.fn(async () => ({
      status: 'completed' as const,
      stdout: '',
      stderr: '',
      traceback: '',
      cwdAfter: root,
      outputs: []
    }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute,
        shutdown: async () => ({ reaped: true })
      })
    })

    const summary = await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      language: 'python',
      code: 'import venv\nvenv.create("analysis-env")'
    })

    expect(execute).not.toHaveBeenCalled()
    expect(summary).toMatchObject({ status: 'failed' })
    expect(summary.text.traceback).toMatch(/manage_packages/)
  })

  it('retains the exact Environment manifest publication failure reason', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentStateTracker: {
        prepareRun: vi.fn().mockResolvedValue({
          fingerprint: 'stable',
          inventoryRefreshed: false,
          warnings: []
        }),
        captureCompletedRun: vi
          .fn()
          .mockRejectedValue(new EnvironmentManifestPublicationError(new Error('disk full'))),
        inspectPackages: vi.fn(),
        markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
        refreshAfterPackageMutation: vi.fn().mockResolvedValue(undefined)
      },
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: 'ok\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    await expect(
      service.execute({
        projectId: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        code: 'print("ok")'
      })
    ).resolves.toMatchObject({
      status: 'completed',
      environmentCapture: {
        state: 'unavailable',
        reason: 'environment-manifest-publication-failed'
      }
    })
  })

  it('records terminal submissions in the shared run history', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: `${request.code}\n`,
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    const summary = await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: 'print(os.getcwd())',
      source: 'user',
      inputKind: 'terminal'
    })
    const state = await service.state({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace'
    })

    expect(summary).toMatchObject({
      source: 'user',
      inputKind: 'terminal',
      script: 'print(os.getcwd())'
    })
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]).toMatchObject({
      source: 'user',
      inputKind: 'terminal',
      script: 'print(os.getcwd())'
    })
    expect(state.runs[0]).not.toHaveProperty('artifacts')
  })

  it('announces agent notebook availability once while publishing notebook changes', async () => {
    const root = await createStorageRoot()
    const notifications: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      callbacks: {
        onNotebookAvailable: (event) => notifications.push(`available:${event.sessionId}`),
        onNotebookChanged: (event) => notifications.push(`changed:${event.sessionId}`)
      },
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: 'ok\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    await service.beginCodeCell({
      projectId: 'default-project',
      sessionId: 'user-session',
      workspaceCwd: '/workspace',
      source: 'user'
    })

    expect(notifications).toEqual(['changed:user-session'])

    const begin = await service.beginCodeCell({
      projectId: 'default-project',
      sessionId: 'agent-session',
      workspaceCwd: '/workspace'
    })
    await service.appendCodeCell({
      projectId: 'default-project',
      sessionId: 'agent-session',
      workspaceCwd: '/workspace',
      writeId: begin.writeId,
      cellId: begin.cellId,
      delta: "print('ok')"
    })
    await service.finishCodeCell({
      projectId: 'default-project',
      sessionId: 'agent-session',
      workspaceCwd: '/workspace',
      writeId: begin.writeId,
      cellId: begin.cellId
    })
    await service.runCell({
      projectId: 'default-project',
      sessionId: 'agent-session',
      workspaceCwd: '/workspace',
      cellId: begin.cellId
    })

    expect(notifications).toEqual([
      'changed:user-session',
      'available:agent-session',
      'changed:agent-session',
      'changed:agent-session',
      'changed:agent-session',
      'changed:agent-session',
      'changed:agent-session'
    ])
  })

  it('keeps agent notebook availability process-scoped across session shutdown', async () => {
    const root = await createStorageRoot()
    const availableSessions: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      callbacks: {
        onNotebookAvailable: (event) => availableSessions.push(event.sessionId)
      },
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: request.code,
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    for (const code of ['before-shutdown', 'after-shutdown']) {
      if (availableSessions.length > 0) {
        await service.shutdown({ sessionId: 'session-1', workspaceCwd: root })
      }
      await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code,
        language: 'python'
      })
    }

    expect(availableSessions).toEqual(['session-1'])
  })

  it('keeps a runtime session usable when executor shutdown fails', async () => {
    const root = await createStorageRoot()
    const shutdownError = new Error('kernel teardown failed')
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request) => ({
          status: 'completed',
          stdout: request.code,
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => Promise.reject(shutdownError)
      })
    })

    await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'before-failed-shutdown',
      language: 'python'
    })

    await expect(service.shutdown({ sessionId: 'session-1', workspaceCwd: root })).rejects.toBe(
      shutdownError
    )
    await expect(
      service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'after-failed-shutdown',
        language: 'python'
      })
    ).resolves.toMatchObject({ status: 'completed', script: 'after-failed-shutdown' })
  })

  it('does not thread the mcp RPC connection into the data-cell execute request', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    service.setMcpRpcConnectionResolver(async () => ({
      endpoint: 'http://127.0.0.1:1/x',
      socketPath: '\\\\.\\pipe\\open-science-notebook',
      token: 'tok'
    }))

    await service.execute({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: '/workspace',
      code: "print('hi')"
    })

    // Data kernels (python/r) have no host.mcp; the RPC connection stays with the control-plane repl.
    expect(executions[0].mcpRpcEndpoint).toBeUndefined()
    expect(executions[0].mcpRpcSocketPath).toBeUndefined()
    expect(executions[0].mcpRpcToken).toBeUndefined()
  })

  it('routes executeControl to the repl kernel kind, threads the RPC connection, and records a repl run', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: 'from-repl\n',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [{ type: 'stream', name: 'stdout', text: 'from-repl\n' }],
            truncated: true
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    service.setMcpRpcConnectionResolver(async () => ({
      endpoint: 'http://127.0.0.1:1/x',
      socketPath: '\\\\.\\pipe\\open-science-notebook',
      token: 'tok'
    }))

    const state0 = await service.state({ sessionId: 'session-1', workspaceCwd: root })

    const result = await service.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'return 1'
    })

    // The control path targets the repl kernel, not a language-derived data kernel.
    expect(executions).toHaveLength(1)
    expect(executions[0].kind).toBe('repl')
    expect(executions[0].language).toBeUndefined()
    expect(executions[0]).toMatchObject({
      code: 'return 1',
      mcpRpcEndpoint: 'http://127.0.0.1:1/x',
      mcpRpcSocketPath: '\\\\.\\pipe\\open-science-notebook',
      mcpRpcToken: 'tok'
    })

    // Mapped outputs are still returned inline for the agent (recording is a side effect; the
    // repl_execute contract to the agent is unchanged).
    expect(result).toMatchObject({
      status: 'completed',
      stdout: 'from-repl\n',
      truncated: true,
      outputs: [{ type: 'stream', name: 'stdout', text: 'from-repl\n' }]
    })

    // A control-plane run now creates a run-history record tagged with kernelKind 'repl'.
    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs).toHaveLength(state0.runs.length + 1)
    expect(state.runs[state.runs.length - 1]).toMatchObject({
      kernelKind: 'repl',
      script: 'return 1',
      status: 'completed',
      source: 'agent'
    })
    expect(state.runs[state.runs.length - 1]).not.toHaveProperty('artifacts')
  })

  it('serializes only the raw control executions for one session', async () => {
    const root = await createStorageRoot()
    const entered: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let announceFirst: (() => void) | undefined
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          entered.push(request.code)
          if (request.code === 'first') {
            announceFirst?.()
            await firstBlocked
          }
          return {
            status: 'completed',
            stdout: request.code,
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const first = service.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'first'
    })
    await firstEntered
    const second = service.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'second'
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(entered).toEqual(['first'])

    releaseFirst?.()
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { stdout: 'first' },
      { stdout: 'second' }
    ])
    expect(entered).toEqual(['first', 'second'])
  })

  it('intercepts an approved control completion before repl_execute can return it to the old prompt', async () => {
    const root = await createStorageRoot()
    const calls: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: 'after switch\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const continuationContexts: unknown[] = []
    const coordinator = new CompletionGateCoordinator({
      stopOldPrompt: async () => {
        calls.push('stop-old-prompt')
      },
      waitForOwnershipRelease: async () => {
        calls.push('ownership-released')
      },
      reconfigure: async () => {
        calls.push('reconfigure')
      },
      continueAsApproved: async (_handoff, _context, continuationContext) => {
        calls.push('continue-approved')
        continuationContexts.push(continuationContext)
      },
      reportHandoffFailure: async () => undefined
    })
    const deliverToOldPrompt = vi.fn(async () => undefined)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1)
    coordinator.arm(
      {
        sessionId: 'session-1',
        turnId: 'notebook-run-1-1',
        controlInvocationGeneration: 1,
        toolInvocationId: 'notebook-run-1-1'
      },
      'Approved Specialist'
    )

    service.setControlCompletionInterceptor(
      createCompletionGatedControlToolInterceptor(coordinator, deliverToOldPrompt)
    )

    await expect(
      service.executeControl({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'await host.agents.switch({ specialist: "Approved Specialist" })',
        provenanceContext: {
          rootFrameId: 'root-1',
          agentFrameId: 'agent-1',
          messageBranchId: 'branch-1',
          runtimeSegmentId: 'runtime-1',
          promptMessageId: 'prompt-1'
        },
        registeredInputFiles: [
          {
            inputFileVersionId: 'upload-version-1',
            sourceKind: 'upload-version',
            sourceFileId: 'upload-1',
            sourceProjectId: 'project-1',
            sourceSessionId: 'session-1',
            filename: 'sample.csv',
            sizeBytes: 10,
            checksum: 'sha256:upload',
            storageKey: 'upload-key',
            association: 'turn-attached'
          },
          {
            inputFileVersionId: 'artifact-version-1',
            sourceKind: 'artifact-version',
            sourceFileId: 'artifact-1',
            sourceProjectId: 'project-1',
            sourceSessionId: 'session-1',
            filename: 'prior.csv',
            sizeBytes: 20,
            checksum: 'sha256:artifact',
            storageKey: 'artifact-key',
            association: 'turn-attached'
          }
        ]
      })
    ).rejects.toThrow('captured for specialist handoff')

    expect(deliverToOldPrompt).not.toHaveBeenCalled()
    expect(calls).toEqual([
      'stop-old-prompt',
      'ownership-released',
      'reconfigure',
      'continue-approved'
    ])
    expect(continuationContexts).toEqual([
      expect.objectContaining({
        originatingTurnId: 'prompt-1',
        originatingUserMessageId: 'prompt-1',
        attachmentIds: ['upload-1'],
        artifactIds: ['artifact-1']
      })
    ])
    now.mockRestore()
  })

  it('releases the control queue before an approved continuation re-enters executeControl', async () => {
    const root = await createStorageRoot()
    const executedCodes: string[] = []
    const calls: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executedCodes.push(request.code)
          return {
            status: 'completed',
            stdout: request.code,
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    const coordinator = new CompletionGateCoordinator({
      stopOldPrompt: async () => undefined,
      waitForOwnershipRelease: async () => undefined,
      reconfigure: async () => undefined,
      continueAsApproved: async () => {
        const continuation = await service.executeControl({
          sessionId: 'session-1',
          workspaceCwd: root,
          code: 'approved continuation'
        })
        calls.push(continuation.stdout)
      },
      reportHandoffFailure: async () => undefined
    })
    const now = vi.spyOn(Date, 'now').mockReturnValue(2)
    coordinator.arm(
      {
        sessionId: 'session-1',
        turnId: 'notebook-run-2-1',
        controlInvocationGeneration: 1,
        toolInvocationId: 'notebook-run-2-1'
      },
      'Approved Specialist'
    )
    service.setControlCompletionInterceptor(
      createCompletionGatedControlToolInterceptor(coordinator, async () => undefined)
    )

    await expect(
      service.executeControl({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'outer control tool'
      })
    ).rejects.toThrow('captured for specialist handoff')

    expect(executedCodes).toEqual(['outer control tool', 'approved continuation'])
    expect(calls).toEqual(['approved continuation'])
    now.mockRestore()
  })

  it('binds each executeControl generation to the cached session capability and releases both lifetimes', async () => {
    const root = await createStorageRoot()
    const projectWorkspace = join(root, 'project-workspace')
    await mkdir(projectWorkspace, { recursive: true })
    const executions: NotebookExecutionRequest[] = []
    const release = vi.fn()
    const releaseInvocation = vi.fn()
    const completeControlInvocation = vi.fn(async () => [
      { data: Buffer.from('image').toString('base64'), mimeType: 'image/png' as const }
    ])
    const discardControlInvocation = vi.fn()
    const beginControlInvocation = vi.fn(() => releaseInvocation)
    const resolveConnection = vi.fn(async (binding: { sessionId: string; projectId: string }) => ({
      endpoint: 'http://127.0.0.1:1/x',
      token: 'session-token',
      beginControlInvocation,
      completeControlInvocation,
      discardControlInvocation,
      release,
      binding
    }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    service.setMcpRpcConnectionResolver(resolveConnection)

    const now = vi.spyOn(Date, 'now').mockReturnValue(42)
    try {
      for (const code of ['return 1', 'return 2']) {
        await expect(
          service.executeControl({
            projectId: 'default-project',
            sessionId: 'session-1',
            workspaceCwd: projectWorkspace,
            code
          })
        ).resolves.toMatchObject({
          viewImages: [{ data: Buffer.from('image').toString('base64'), mimeType: 'image/png' }]
        })
      }
    } finally {
      now.mockRestore()
    }

    expect(resolveConnection).toHaveBeenCalledOnce()
    expect(resolveConnection).toHaveBeenCalledWith({
      sessionId: 'session-1',
      projectId: 'default-project',
      agentFrameId: 'root-frame-session-1',
      executionCwd: join(root, 'notebooks', 'default-project', 'session-1', 'data')
    })
    expect(executions.map((request) => request.mcpRpcToken)).toEqual([
      'session-token',
      'session-token'
    ])
    expect(beginControlInvocation).toHaveBeenNthCalledWith(1, {
      turnId: 'notebook-run-42-1',
      controlInvocationGeneration: 1,
      toolInvocationId: 'notebook-run-42-1',
      attachmentIds: [],
      artifactIds: []
    })
    expect(beginControlInvocation).toHaveBeenNthCalledWith(2, {
      turnId: 'notebook-run-42-2',
      controlInvocationGeneration: 2,
      toolInvocationId: 'notebook-run-42-2',
      attachmentIds: [],
      artifactIds: []
    })
    expect(releaseInvocation).toHaveBeenCalledTimes(2)
    expect(completeControlInvocation).toHaveBeenCalledTimes(2)
    expect(discardControlInvocation).not.toHaveBeenCalled()
    const persistedRun = await readFile(
      join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
      'utf8'
    )
    expect(persistedRun).not.toContain(Buffer.from('image').toString('base64'))
    expect(persistedRun).not.toContain('viewImages')

    await service.shutdown({ sessionId: 'session-1', workspaceCwd: projectWorkspace })
    expect(release).toHaveBeenCalledOnce()
  })

  it('discards transient images on failed execution and captured completion', async () => {
    const root = await createStorageRoot()
    const completeControlInvocation = vi.fn(async () => [
      { data: Buffer.from('image').toString('base64'), mimeType: 'image/png' as const }
    ])
    const discardControlInvocation = vi.fn()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: request.code === 'fail' ? 'failed' : 'completed',
          stdout: '',
          stderr: request.code === 'fail' ? 'failed' : '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    service.setMcpRpcConnectionResolver(async () => ({
      endpoint: 'http://127.0.0.1:1/x',
      token: 'session-token',
      beginControlInvocation: () => vi.fn(),
      completeControlInvocation,
      discardControlInvocation
    }))

    await expect(
      service.executeControl({ sessionId: 'session-1', workspaceCwd: root, code: 'fail' })
    ).resolves.not.toHaveProperty('viewImages')
    expect(completeControlInvocation).not.toHaveBeenCalled()
    expect(discardControlInvocation).toHaveBeenCalledTimes(1)

    service.setControlCompletionInterceptor({
      intercept: async ({ execute }) => {
        await execute()
        return { kind: 'captured' as const }
      }
    })
    await expect(
      service.executeControl({ sessionId: 'session-1', workspaceCwd: root, code: 'complete' })
    ).rejects.toThrow(/captured for specialist handoff/u)
    expect(completeControlInvocation).not.toHaveBeenCalled()
    expect(discardControlInvocation).toHaveBeenCalledTimes(2)
  })

  it('binds a suppressed continuation to its durable authorization origin', async () => {
    const root = await createStorageRoot()
    const beginControlInvocation = vi.fn(() => vi.fn())
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    service.setMcpRpcConnectionResolver(async () => ({
      endpoint: 'http://127.0.0.1:1/x',
      token: 'session-token',
      beginControlInvocation
    }))

    await service.executeControl({
      projectId: 'default-project',
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'return 1',
      provenanceContext: {
        rootFrameId: 'root-frame-session-1',
        agentFrameId: 'root-frame-session-1',
        messageBranchId: 'root-branch',
        runtimeSegmentId: 'delegated-message-1',
        promptMessageId: 'synthetic-message-prompt',
        originMessageId: 'durable-root-message'
      }
    })

    expect(beginControlInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        originatingTurnId: 'synthetic-message-prompt',
        originatingUserMessageId: 'durable-root-message'
      })
    )
  })

  it('binds a delegated control connection to the current Attempt and rotates it on restart', async () => {
    const root = await createStorageRoot()
    const releaseFirst = vi.fn()
    const releaseSecond = vi.fn()
    const resolveConnection = vi.fn(
      async (binding: {
        sessionId: string
        projectId: string
        agentFrameId: string
        attemptId?: string
      }) => ({
        endpoint: 'http://127.0.0.1:1/x',
        token: `${binding.attemptId}-token`,
        release: binding.attemptId === 'attempt-1' ? releaseFirst : releaseSecond
      })
    )
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: request.mcpRpcToken ?? '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    service.setMcpRpcConnectionResolver(resolveConnection)
    const request = (attemptId: string): Parameters<typeof service.executeControl>[0] =>
      ({
        projectId: 'project-1',
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'return 1',
        delegatedWorkAttemptId: attemptId,
        provenanceContext: {
          rootFrameId: 'root-frame-session-1',
          agentFrameId: 'child-frame',
          messageBranchId: 'child-branch',
          runtimeSegmentId: `runtime-${attemptId}`,
          promptMessageId: `prompt-${attemptId}`
        }
      }) as Parameters<typeof service.executeControl>[0]

    await expect(service.executeControl(request('attempt-1'))).resolves.toMatchObject({
      stdout: 'attempt-1-token'
    })
    await service.shutdown(request('attempt-1'))
    await expect(service.executeControl(request('attempt-2'))).resolves.toMatchObject({
      stdout: 'attempt-2-token'
    })

    expect(resolveConnection).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      projectId: 'project-1',
      agentFrameId: 'child-frame',
      attemptId: 'attempt-1',
      executionCwd: join(
        root,
        'notebooks',
        'project-1',
        'session-1',
        'frames',
        'child-frame',
        'data'
      )
    })
    expect(resolveConnection).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      projectId: 'project-1',
      agentFrameId: 'child-frame',
      attemptId: 'attempt-2',
      executionCwd: join(
        root,
        'notebooks',
        'project-1',
        'session-1',
        'frames',
        'child-frame',
        'data'
      )
    })
    expect(releaseFirst).toHaveBeenCalledOnce()
    expect(releaseSecond).not.toHaveBeenCalled()
  })

  it('keeps control connections and cleanup isolated between runtime sessions', async () => {
    const root = await createStorageRoot()
    const releases = new Map([
      ['session-1', vi.fn()],
      ['session-2', vi.fn()]
    ])
    const resolveConnection = vi.fn(
      async ({ sessionId }: { sessionId: string; projectId: string }) => ({
        endpoint: 'http://127.0.0.1:1/x',
        token: `${sessionId}-token`,
        release: releases.get(sessionId)
      })
    )
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: (sessionId) => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: `${sessionId}:${request.mcpRpcToken}`,
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    service.setMcpRpcConnectionResolver(resolveConnection)

    const [first, second] = await Promise.all(
      ['session-1', 'session-2'].map((sessionId) =>
        service.executeControl({ sessionId, workspaceCwd: root, code: 'return 1' })
      )
    )

    expect([first.stdout, second.stdout]).toEqual([
      'session-1:session-1-token',
      'session-2:session-2-token'
    ])

    await service.shutdown({ sessionId: 'session-1', workspaceCwd: root })
    expect(releases.get('session-1')).toHaveBeenCalledOnce()
    expect(releases.get('session-2')).not.toHaveBeenCalled()

    await expect(
      service.executeControl({ sessionId: 'session-2', workspaceCwd: root, code: 'return 2' })
    ).resolves.toMatchObject({ stdout: 'session-2:session-2-token' })
    expect(
      resolveConnection.mock.calls.filter(([binding]) => binding.sessionId === 'session-2')
    ).toHaveLength(1)

    await service.shutdownAll()
    expect(releases.get('session-2')).toHaveBeenCalledOnce()
  })

  it('rejects a dynamically executed package installer in the control REPL before dispatch', async () => {
    const root = await createStorageRoot()
    const execute = vi.fn()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute,
        shutdown: async () => ({ reaped: true })
      })
    })

    const result = await service.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: `require('node:child_process').exec('pip install pandas')`
    })

    expect(result.status).toBe('failed')
    expect(result.traceback).toMatch(/manage_packages/)
    expect(execute).not.toHaveBeenCalled()
    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs.at(-1)).toMatchObject({ kernelKind: 'repl', status: 'failed' })
    expect(state.kernelStatus).toBe('idle')
  })

  it('threads the session id and project name into the repl execute request for host.compute grants', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'my-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    await service.executeControl({
      projectId: 'my-project',
      sessionId: 'session-9',
      workspaceCwd: root,
      code: 'return 1'
    })

    // The control path threads session/project identity so the repl kernel can carry it into
    // host.compute call_command payloads (grant-scope approval memory: This conversation / This project).
    expect(executions).toHaveLength(1)
    expect(executions[0].kind).toBe('repl')
    expect(executions[0].sessionId).toBe('session-9')
    expect(executions[0].projectId).toBe('my-project')
  })

  it('records a failed repl run when the executor throws', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (): Promise<NotebookExecutionResult> => {
          throw new Error('repl kernel exploded')
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const result = await service.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'throw new Error("boom")'
    })

    expect(result.status).toBe('failed')

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs).toHaveLength(1)
    expect(state.runs[0]).toMatchObject({
      kernelKind: 'repl',
      status: 'failed'
    })
  })

  it('forwards repl working files and file evidence into the recorded run', async () => {
    const root = await createStorageRoot()
    const writtenFile = {
      path: join(root, 'notebooks', 'default-project', 'session-1', 'handoff', 'data.json'),
      relativePath: 'handoff/data.json',
      kind: 'raw-data' as const
    }
    const fileEvidence = {
      schemaVersion: 1 as const,
      activityKind: 'notebook-run' as const,
      state: 'partial' as const,
      evidenceId: 'execution-file-evidence-runtime-service',
      checksum: 'a'.repeat(64),
      storageKey: 'execution-file-evidence/runtime-service/evidence.json',
      scientificOutputCount: 1,
      initialViewState: 'complete' as const,
      managedRootsFinalState: 'partial' as const,
      scientificOutputAnalysis: 'partial' as const,
      fileReads: 'unavailable' as const,
      externalPaths: 'unavailable' as const,
      writerAttribution: 'unavailable' as const,
      reasonCodes: ['file-reads-not-observed' as const]
    }
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [],
            workingFiles: [writtenFile],
            fileEvidence: { ...fileEvidence, activityId: request.runId }
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const result = await service.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'writeHandoffFile()'
    })

    expect(result.workingFiles).toMatchObject([{ relativePath: 'handoff/data.json' }])
    expect(result.fileEvidence).toMatchObject(fileEvidence)
    expect(result.fileEvidence?.activityId).toEqual(expect.any(String))

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs[0].workingFiles).toMatchObject([{ relativePath: 'handoff/data.json' }])
    expect(state.runs[0].fileEvidence).toEqual(result.fileEvidence)
  })

  describe('executeShell', () => {
    const createShellService = (root: string): NotebookRuntimeService =>
      new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        // Unit tests already run inside the host's process sandbox on macOS. Select the portable
        // semantic-policy path here; managed-runtime-guard.test.ts verifies the Seatbelt wrapper.
        platform: process.platform === 'darwin' ? 'linux' : process.platform
      })

    it('runs a command in a fresh sh process and captures stdout/exitCode', async () => {
      const root = await createStorageRoot()
      const service = createShellService(root)

      const now = vi.spyOn(Date, 'now').mockReturnValue(42)
      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'echo hi'
      })
      now.mockRestore()

      expect(result.stdout).toContain('hi')
      expect(result.exitCode).toBe(0)

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs).toHaveLength(1)
      expect(state.runs[0]).toMatchObject({
        runId: 'notebook-run-42-1',
        kernelKind: 'bash',
        script: 'echo hi',
        status: 'completed',
        source: 'agent'
      })
      expect(state.runs[0]).not.toHaveProperty('artifacts')
      expect(state.runs[0].text.stdout).toContain('hi')
    })

    it('routes one admitted call through the shell process port and preserves its public result', async () => {
      const root = await createStorageRoot()
      const execute = vi.fn<NotebookShellProcess['execute']>().mockResolvedValue({
        stdout: 'partial output',
        stderr: 'command failed',
        exitCode: 9,
        truncated: true
      })
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        shellProcess: { execute }
      })

      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'opaque command',
        timeoutMs: 321
      })

      expect(execute).toHaveBeenCalledWith({
        command: 'opaque command',
        cwd: join(root, 'notebooks', 'default-project', 'session-1', 'data'),
        handoffDir: join(root, 'notebooks', 'default-project', 'session-1', 'handoff'),
        notebookSessionRoot: join(root, 'notebooks', 'default-project', 'session-1'),
        inputRoot: getNotebookInputRoot(root, 'default-project', 'session-1'),
        projectId: 'default-project',
        protectedDirs: [join(root, 'claude')],
        runtimeRoot: getRuntimeRoot(root),
        sessionId: 'session-1',
        timeoutMs: 321,
        signal: expect.any(AbortSignal)
      })
      expect(result).toEqual({
        stdout: 'partial output',
        stderr: 'command failed',
        exitCode: 9,
        truncated: true
      })
      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs[0]).toMatchObject({
        status: 'failed',
        text: { stdout: 'partial output', stderr: 'command failed' }
      })
    })

    it('queues overlapping shell calls in the same Session until the active command finishes', async () => {
      const root = await createStorageRoot()
      const entered: string[] = []
      const releases = new Map<string, () => void>()
      const execute = vi.fn<NotebookShellProcess['execute']>(
        ({ command }) =>
          new Promise((resolve) => {
            entered.push(command)
            releases.set(command, () => resolve({ stdout: command, stderr: '', exitCode: 0 }))
          })
      )
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        shellProcess: { execute }
      })
      const rootContext = {
        rootFrameId: 'root-frame-session-1',
        agentFrameId: 'root-frame-session-1',
        messageBranchId: 'branch-root',
        runtimeSegmentId: 'runtime-root',
        promptMessageId: 'message-root'
      }
      const childContext = {
        ...rootContext,
        agentFrameId: 'child-frame-1',
        messageBranchId: 'branch-child',
        runtimeSegmentId: 'runtime-child',
        promptMessageId: 'message-child'
      }

      const first = service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'first',
        provenanceContext: rootContext
      })
      const second = service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'second',
        provenanceContext: childContext
      })

      await vi.waitFor(async () => {
        const state = await service.state({
          sessionId: 'session-1',
          workspaceCwd: root
        })
        expect(state.runs).toHaveLength(2)
      })
      const queuedState = await service.state({
        sessionId: 'session-1',
        workspaceCwd: root
      })
      const queuedRun = queuedState.runs.at(-1)
      if (queuedRun?.status !== 'queued') {
        await vi.waitFor(() => expect(entered).toHaveLength(2))
        for (const release of releases.values()) release()
        await Promise.allSettled([first, second])
      }
      await vi.waitFor(() => expect(entered).toEqual(['first']))
      expect(entered).toEqual(['first'])
      expect(queuedRun).toMatchObject({ script: 'second', status: 'queued' })

      try {
        releases.get('first')?.()
        await vi.waitFor(() => expect(entered).toEqual(['first', 'second']))
        releases.get('second')?.()

        await expect(Promise.all([first, second])).resolves.toEqual([
          { stdout: 'first', stderr: '', exitCode: 0 },
          { stdout: 'second', stderr: '', exitCode: 0 }
        ])
      } finally {
        for (const release of releases.values()) release()
        await Promise.allSettled([first, second])
      }
      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs).toHaveLength(2)
      expect(state.runs.every((run) => run.status === 'completed')).toBe(true)
    })

    it('admits at most six shell processes across Sessions', async () => {
      const root = await createStorageRoot()
      const entered: string[] = []
      const releases = new Map<string, () => void>()
      const execute = vi.fn<NotebookShellProcess['execute']>(
        ({ command }) =>
          new Promise((resolve) => {
            entered.push(command)
            releases.set(command, () => resolve({ stdout: command, stderr: '', exitCode: 0 }))
          })
      )
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        shellProcess: { execute }
      })
      for (let index = 0; index < 7; index += 1) {
        await service.state({
          sessionId: `session-${index + 1}`,
          workspaceCwd: root
        })
      }
      const executions = Array.from({ length: 7 }, (_, index) =>
        service.executeShell({
          sessionId: `session-${index + 1}`,
          workspaceCwd: root,
          command: `command-${index + 1}`
        })
      )

      await vi.waitFor(async () => {
        const queuedState = await service.state({
          sessionId: 'session-7',
          workspaceCwd: root
        })
        expect(queuedState.runs).toHaveLength(1)
      })
      const queuedState = await service.state({
        sessionId: 'session-7',
        workspaceCwd: root
      })
      const queuedRun = queuedState.runs.at(-1)
      if (queuedRun?.status !== 'queued') {
        await vi.waitFor(() => expect(entered).toHaveLength(7))
        for (const release of releases.values()) release()
        await Promise.allSettled(executions)
      }
      expect(queuedRun).toMatchObject({ script: 'command-7', status: 'queued' })

      try {
        await vi.waitFor(() => expect(entered).toHaveLength(6))
        expect(entered).toHaveLength(6)
        expect(entered).not.toContain('command-7')

        releases.get('command-1')?.()
        await vi.waitFor(() => expect(entered).toContain('command-7'))
        for (const release of releases.values()) release()

        await expect(Promise.all(executions)).resolves.toHaveLength(7)
      } finally {
        for (const release of releases.values()) release()
        await Promise.allSettled(executions)
      }
    })

    it('cancels a queued shell call without starting its process', async () => {
      const root = await createStorageRoot()
      const entered: string[] = []
      const releases = new Map<string, () => void>()
      const execute = vi.fn<NotebookShellProcess['execute']>(
        ({ command }) =>
          new Promise((resolve) => {
            entered.push(command)
            releases.set(command, () => resolve({ stdout: command, stderr: '', exitCode: 0 }))
          })
      )
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        shellProcess: { execute }
      })
      const first = service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'first'
      })
      const cancellation = new AbortController()
      const queued = service.executeShell(
        {
          sessionId: 'session-1',
          workspaceCwd: root,
          command: 'cancelled-before-start'
        },
        cancellation.signal
      )

      await vi.waitFor(async () => {
        const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
        expect(state.runs).toHaveLength(2)
      })
      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      const queuedRun = state.runs.at(-1)
      if (queuedRun?.status !== 'queued') {
        await vi.waitFor(() => expect(entered).toHaveLength(2))
        for (const release of releases.values()) release()
        await Promise.allSettled([first, queued])
      }
      expect(queuedRun).toMatchObject({ script: 'cancelled-before-start', status: 'queued' })

      await vi.waitFor(() => expect(entered).toEqual(['first']))
      cancellation.abort()
      await expect(queued).resolves.toEqual({
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null
      })
      expect(entered).toEqual(['first'])

      releases.get('first')?.()
      await expect(first).resolves.toEqual({ stdout: 'first', stderr: '', exitCode: 0 })
      const finalState = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(finalState.runs.at(-1)).toMatchObject({ status: 'cancelled' })
    })

    it('cancels and drains queued shell work before Session shutdown completes', async () => {
      const root = await createStorageRoot()
      const entered: string[] = []
      const signals = new Map<string, AbortSignal | undefined>()
      const releases = new Map<string, () => void>()
      const execute = vi.fn<NotebookShellProcess['execute']>(
        ({ command, signal }) =>
          new Promise((resolve) => {
            let settled = false
            const finish = (cancelled: boolean): void => {
              if (settled) return
              settled = true
              resolve({
                stdout: cancelled ? '' : command,
                stderr: '',
                exitCode: cancelled ? null : 0,
                ...(cancelled ? { cancelled: true } : {})
              })
            }
            entered.push(command)
            signals.set(command, signal)
            releases.set(command, () => finish(false))
            signal?.addEventListener('abort', () => finish(true), { once: true })
          })
      )
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        shellProcess: { execute }
      })
      const rootContext = {
        rootFrameId: 'root-frame-session-1',
        agentFrameId: 'root-frame-session-1',
        messageBranchId: 'branch-root',
        runtimeSegmentId: 'runtime-root',
        promptMessageId: 'message-root'
      }
      const childContext = {
        ...rootContext,
        agentFrameId: 'child-frame-1',
        messageBranchId: 'branch-child',
        runtimeSegmentId: 'runtime-child',
        promptMessageId: 'message-child'
      }
      const first = service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'first',
        provenanceContext: rootContext
      })
      const queued = service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'must-not-start',
        provenanceContext: childContext
      })

      await vi.waitFor(() => expect(entered).toEqual(['first']))
      const shutdown = service.shutdownSession('session-1')
      await shutdown

      const activeWasCancelled = signals.get('first')?.aborted === true
      if (!activeWasCancelled) {
        releases.get('first')?.()
        await vi.waitFor(() => expect(entered).toHaveLength(2))
        releases.get('must-not-start')?.()
      }
      await Promise.allSettled([first, queued])

      expect(activeWasCancelled).toBe(true)
      expect(entered).toEqual(['first'])
    })

    it('waits for shell termination before removing the Session executor', async () => {
      const root = await createStorageRoot()
      let markShellStarted!: () => void
      const shellStarted = new Promise<void>((resolve) => {
        markShellStarted = resolve
      })
      let markCancellationStarted!: () => void
      const cancellationStarted = new Promise<void>((resolve) => {
        markCancellationStarted = resolve
      })
      let finishShell!: () => void
      const execute = vi.fn<NotebookShellProcess['execute']>(
        ({ signal }) =>
          new Promise((resolve) => {
            markShellStarted()
            finishShell = () => resolve({ stdout: '', stderr: '', exitCode: null, cancelled: true })
            signal?.addEventListener('abort', markCancellationStarted, { once: true })
          })
      )
      const shutdownExecutor = vi.fn(async () => ({ reaped: true }))
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: shutdownExecutor
        }),
        shellProcess: { execute }
      })
      const running = service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'long-running'
      })
      await shellStarted

      const shutdown = service.shutdownSession('session-1')
      await cancellationStarted
      await new Promise<void>((resolve) => setImmediate(resolve))
      const removedBeforeShellFinished = shutdownExecutor.mock.calls.length > 0
      finishShell()

      await Promise.all([running, shutdown])
      expect(removedBeforeShellFinished).toBe(false)
      expect(shutdownExecutor).toHaveBeenCalledOnce()
    })

    it('rejects shell admission while Session shutdown owns the registry gate', async () => {
      const root = await createStorageRoot()
      let markShutdownStarted!: () => void
      const shutdownStarted = new Promise<void>((resolve) => {
        markShutdownStarted = resolve
      })
      let releaseShutdown!: () => void
      const shutdownGate = new Promise<void>((resolve) => {
        releaseShutdown = resolve
      })
      const execute = vi.fn<NotebookShellProcess['execute']>().mockResolvedValue({
        stdout: 'must not run',
        stderr: '',
        exitCode: 0
      })
      const executorFactory = vi.fn(() => ({
        execute: async (request: NotebookExecutionRequest): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => {
          markShutdownStarted()
          await shutdownGate
          return { reaped: true }
        }
      }))
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory,
        shellProcess: { execute }
      })
      const request = { sessionId: 'session-1', workspaceCwd: root }
      await service.state(request)

      const shutdown = service.shutdownSession(request.sessionId)
      await shutdownStarted
      const lateShell = service.executeShell({ ...request, command: 'must-not-run' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      releaseShutdown()

      await expect(shutdown).resolves.toEqual({ sessionId: 'session-1', status: 'shutdown' })
      await expect(lateShell).resolves.toEqual({
        stdout: '',
        stderr: 'Shell command was cancelled.',
        exitCode: null
      })
      expect(execute).not.toHaveBeenCalled()
      expect(executorFactory).toHaveBeenCalledOnce()
    })

    it('rejects a direct micromamba install before spawning the shell command', async () => {
      const root = await createStorageRoot()
      const service = createShellService(root)

      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'micromamba install --help'
      })

      expect(result).toMatchObject({ stdout: '', exitCode: 1 })
      expect(result.stderr).toMatch(/manage_packages/)
      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs[0]).toMatchObject({ status: 'failed', script: 'micromamba install --help' })
    })

    it.each(
      [
        ['R install.packages', `Rscript -e 'install.packages()'`],
        ['Python pip', 'python -m pip install --help'],
        ['Python venv', 'python -m venv --help'],
        [
          'dynamic Python venv',
          'tool=python3; mode=-m; action=venv; "$tool" "$mode" "$action" analysis-env'
        ],
        ['uv', 'uv venv --help'],
        ['Poetry', 'poetry add --help']
      ].filter(([label]) => process.platform !== 'win32' || label !== 'dynamic Python venv')
    )('rejects %s package/environment mutation through bash_execute', async (_label, command) => {
      const root = await createStorageRoot()
      const service = createShellService(root)

      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command
      })

      expect(result).toMatchObject({ stdout: '', exitCode: 1 })
      expect(result.stderr).toMatch(/manage_packages/)
    })

    it('rejects direct file mutation under the managed runtime', async () => {
      const root = await createStorageRoot()
      const service = createShellService(root)
      const target = join(root, 'runtime', 'envs', 'default-r', 'conda-meta', 'missing.json')

      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: `rm -f ${JSON.stringify(target)}`
      })

      expect(result).toMatchObject({ stdout: '', exitCode: 1 })
      expect(result.stderr).toMatch(/managed runtime is read-only/i)
    })

    it.each([
      'Set-Location $env:OPEN_SCIENCE_RUNTIME_DIR; New-Item conda-meta\\pwn.json',
      'Remove-Item "$env:OPEN_SCIENCE_RUNTIME_DIR\\conda-meta\\history"'
    ])('uses the PowerShell runtime-write policy on Windows: %s', async (command) => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        platform: 'win32'
      })

      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command
      })

      expect(result).toMatchObject({ stdout: '', exitCode: 1 })
      expect(result.stderr).toMatch(/managed runtime is read-only/i)
    })

    it.skipIf(process.platform === 'win32')(
      'records a shell-created file as a working file for provenance',
      async () => {
        const root = await createStorageRoot()
        const service = createShellService(root)

        await service.executeShell({
          sessionId: 'session-1',
          workspaceCwd: root,
          command: "printf 'x,y\\n1,2\\n' > shell-output.csv"
        })

        const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
        expect(state.runs[0].workingFiles).toEqual([
          expect.objectContaining({
            relativePath: 'data/shell-output.csv',
            kind: 'other',
            size: 8,
            createdByRunId: state.runs[0].runId
          })
        ])
      }
    )

    // POSIX-only: reads env via the shell. bash must NOT inherit arbitrary host env (secrets), only an
    // allowlist + the handoff channel — so a leaked connector token / API key can't reach the shell.
    it.skipIf(process.platform === 'win32')(
      'scrubs host secrets from the bash environment, keeping only the allowlist + handoff dir',
      async () => {
        const root = await createStorageRoot()
        process.env.OPEN_SCIENCE_TEST_SECRET = 'super-secret-token'
        try {
          const service = new NotebookRuntimeService({
            configRoot: root,
            dataRoot: root,
            projectId: 'default-project',
            repository: new NotebookRunRepository(root),
            platform: 'linux'
          })

          const result = await service.executeShell({
            sessionId: 'session-1',
            workspaceCwd: root,
            command:
              'echo "secret=[${OPEN_SCIENCE_TEST_SECRET}]"; echo "handoff=[${OPEN_SCIENCE_HANDOFF_DIR:+set}]"'
          })

          // The host secret is dropped; the workspace channel var is preserved.
          expect(result.stdout).toContain('secret=[]')
          expect(result.stdout).toContain('handoff=[set]')
        } finally {
          delete process.env.OPEN_SCIENCE_TEST_SECRET
        }
      }
    )

    it('returns the process non-zero exit code instead of throwing', async () => {
      const root = await createStorageRoot()
      const service = createShellService(root)

      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'exit 3'
      })

      expect(result.exitCode).toBe(3)

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs[0]).toMatchObject({
        kernelKind: 'bash',
        script: 'exit 3',
        status: 'failed'
      })
    })

    it('kills a command that outlasts the timeout and returns a non-normal result', async () => {
      const root = await createStorageRoot()
      const service = createShellService(root)

      const startedAt = Date.now()
      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: 'sleep 30',
        timeoutMs: 100
      })
      const elapsedMs = Date.now() - startedAt

      // Settlement waits for the process-tree terminator. Hosted Windows taskkill of PowerShell
      // Start-Sleep can take a few seconds, so keep the bound well under the full sleep.
      expect(elapsedMs).toBeLessThan(10_000)
      expect(result.exitCode).not.toBe(0)

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs[0]).toMatchObject({
        kernelKind: 'bash',
        script: 'sleep 30',
        status: 'timeout'
      })
    })

    it('spawns a fresh process per call instead of reusing a persistent shell', async () => {
      const root = await createStorageRoot()
      const service = createShellService(root)

      await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: process.platform === 'win32' ? "$env:FOO='bar'" : 'FOO=bar'
      })
      // A persistent shell would remember FOO from the previous call; a fresh process never does.
      const result = await service.executeShell({
        sessionId: 'session-1',
        workspaceCwd: root,
        command: process.platform === 'win32' ? 'Write-Output "[$env:FOO]"' : 'echo "[$FOO]"'
      })

      expect(result.stdout).toContain('[]')

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      // Each executeShell call produces its own record: two calls, two distinct runIds.
      expect(state.runs).toHaveLength(2)
      expect(state.runs.every((run) => run.kernelKind === 'bash')).toBe(true)
      expect(new Set(state.runs.map((run) => run.runId)).size).toBe(2)
    })

    // POSIX-only: relies on `trap '' TERM` and signal-0 process probes. Windows signal semantics
    // differ entirely and use taskkill-backed tree termination instead.
    it.skipIf(process.platform === 'win32')(
      'SIGKILLs a timed-out command that ignores SIGTERM instead of leaving it running',
      async () => {
        const root = await createStorageRoot()
        const service = createShellService(root)
        // A marker unique to this test run. It appears on both the shell and its real Node descendant,
        // so the observable contract requires the whole timed-out command tree to disappear.
        const marker = `os-notebook-shell-test-${randomUUID()}`
        const descendantPidPath = join(root, `${marker}.pid`)
        const quoteForShell = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

        const execution = service.executeShell({
          sessionId: 'session-1',
          workspaceCwd: root,
          // The shell records its real descendant's PID before waiting. Both ignore SIGTERM, so the
          // timeout cleanup must escalate and reap the whole tree rather than only the direct shell.
          command: `trap '' TERM; ${quoteForShell(process.execPath)} -e ${quoteForShell(
            "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000)"
          )} ${quoteForShell(marker)} & descendant_pid=$!; printf '%s' "$descendant_pid" > ${quoteForShell(
            descendantPidPath
          )}; wait "$descendant_pid" # ${marker}`,
          timeoutMs: 2_000
        })

        // Start the execution first, then require the descendant to be observable well before the
        // timeout. This prevents a loaded runner from taking the process-tree snapshot before the
        // fixture has spawned the process that the cleanup contract is meant to cover.
        const readinessDeadline = Date.now() + 1_500
        let descendantPid: number | undefined
        while (descendantPid === undefined && Date.now() < readinessDeadline) {
          try {
            const candidate = Number((await readFile(descendantPidPath, 'utf8')).trim())
            if (Number.isInteger(candidate) && candidate > 0) descendantPid = candidate
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          if (descendantPid === undefined) await new Promise((r) => setTimeout(r, 20))
        }
        if (descendantPid === undefined) {
          throw new Error(
            'timed-out shell descendant did not become ready before the fixture deadline'
          )
        }

        const result = await execution

        // The RPC promise must not settle until the whole command tree has finished teardown.
        expect(result.exitCode).toBeNull()

        // Probe the exact descendant instead of searching the process table. The former pgrep fixture
        // wrapped the query in `sh -c`, whose own argv contained the marker and self-matched on Linux.
        const descendantIsRunning = (): boolean => {
          try {
            process.kill(descendantPid, 0)
            return true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
            throw error
          }
        }

        const stillRunning = descendantIsRunning()

        try {
          expect(stillRunning).toBe(false)
        } finally {
          // A RED run must not leak the process whose survival it proves.
          if (stillRunning) {
            try {
              process.kill(descendantPid, 'SIGKILL')
            } catch {
              // It exited between the final probe and cleanup.
            }
          }
        }
      },
      15_000
    )

    it('records distinct evidence for back-to-back same-Session calls', async () => {
      const root = await createStorageRoot()
      const service = createShellService(root)

      // Submit without awaiting between calls. Session admission serializes their shared writable root,
      // while durable run writes retain both identities and terminal results.
      const [okResult, failResult] = await Promise.all([
        service.executeShell({ sessionId: 'session-1', workspaceCwd: root, command: 'echo one' }),
        service.executeShell({ sessionId: 'session-1', workspaceCwd: root, command: 'exit 5' })
      ])

      expect(okResult.exitCode).toBe(0)
      expect(failResult.exitCode).toBe(5)

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.runs).toHaveLength(2)
      expect(new Set(state.runs.map((run) => run.runId)).size).toBe(2)
      expect(new Set(state.runs.map((run) => run.cellId)).size).toBe(2)

      const statuses = state.runs.map((run) => run.status).sort()
      expect(statuses).toEqual(['completed', 'failed'])
      expect(state.runs.every((run) => run.kernelKind === 'bash')).toBe(true)
      expect(
        state.runs.every((run) => !run.fileEvidence?.reasonCodes.includes('observer-conflict'))
      ).toBe(true)
    })
  })

  it('returns null when a session has no persisted notebook run history', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })

    const reference = await service.getSessionReference({
      projectId: 'default-project',
      sessionId: 'never-used',
      workspaceCwd: '/workspace'
    })

    expect(reference).toBeNull()
  })

  it('rebuilds a session reference from persisted run.json without a live runtime session', async () => {
    const root = await createStorageRoot()

    // Execute against one service instance, then throw it away to simulate an app restart.
    const firstService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: 'done\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    await firstService.execute({
      projectId: 'default-project',
      sessionId: 'restored-session',
      workspaceCwd: '/workspace',
      code: "print('done')"
    })

    // A fresh service has no in-memory session, mirroring the state after relaunch.
    const restartedService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })

    const reference = await restartedService.getSessionReference({
      sessionId: 'restored-session',
      workspaceCwd: '/workspace'
    })

    expect(reference).toMatchObject({
      sessionId: 'restored-session',
      projectId: 'default-project',
      workspaceCwd: '/workspace',
      notebookSessionRoot: join(root, 'notebooks', 'default-project', 'restored-session'),
      dataRoot: join(root, 'notebooks', 'default-project', 'restored-session', 'data'),
      runtimeRoot: join(root, 'runtime'),
      runJsonPath: join(root, 'notebooks', 'default-project', 'restored-session', 'run.json')
    })
  })

  it('recovers an interrupted download by cleaning orphan staging + clearing the journal (WS13)', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = join(root, 'runtime')
    // Simulate a process killed mid-download: an orphan .incoming-* staging dir + its journal entry.
    const staging = join(runtimeRoot, 'packs', '.incoming-crashed')
    await mkdir(staging, { recursive: true })
    const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'd',
      kind: 'download',
      runtimeId: 'python-3.12',
      phase: 'fetch',
      startedAt: 100,
      targetPath: staging
    })

    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    await service.recoverInterruptedOperations()

    // The orphan staging dir is removed and the journal entry is cleared (not reprocessed next boot).
    expect(existsSync(staging)).toBe(false)
    expect(await journal.pending()).toEqual([])
  })

  it('shares one startup recovery attempt across concurrent callers', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const originalReadState = RuntimeOperationJournal.prototype.readState
    let releaseRead!: () => void
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const readState = vi
      .spyOn(RuntimeOperationJournal.prototype, 'readState')
      .mockImplementation(async function (this: RuntimeOperationJournal) {
        await readGate
        return originalReadState.call(this)
      })

    const first = service.recoverInterruptedOperations()
    await vi.waitFor(() => expect(readState).toHaveBeenCalledOnce())
    const second = service.recoverInterruptedOperations()

    await Promise.resolve()
    expect(readState).toHaveBeenCalledOnce()

    releaseRead()
    await Promise.all([first, second])

    // One healthy recovery reads once for the fail-closed preflight, once for reconciliation, and
    // once more before cache cleanup so a journal mutation during publication remains fail-closed.
    expect(readState).toHaveBeenCalledTimes(3)
    readState.mockRestore()
  })

  it('treats a missing startup journal as ready without blocking runtimes', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })

    await service.recoverInterruptedOperations()

    expect(service.isPrefixRecoveryBlocked(envPrefix(runtimeRoot, DEFAULT_PY_ENV))).toBe(false)
    expect(service.isPrefixRecoveryBlocked(envPrefix(runtimeRoot, DEFAULT_R_ENV))).toBe(false)
    expect(existsSync(operationJournalPath(runtimeRoot))).toBe(false)
  })

  it('wipes the pack download cache on startup so a restart does not resume a partial (WS13)', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = join(root, 'runtime')
    // A leftover partial download from a prior session: a .part (and a stale complete archive) in the
    // version/subdir-keyed .cache. The design requires "app closes → start from scratch", so startup
    // recovery must remove these rather than let a restart Range-resume them.
    const cache = join(runtimeRoot, 'packs', '.cache', '1', 'osx-arm64')
    await mkdir(cache, { recursive: true })
    await writeFile(join(cache, 'python-3.12.tar.zst.part'), Buffer.from('half'))
    await writeFile(join(cache, 'r-4.4.tar.zst'), Buffer.from('whole-but-orphaned'))

    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    await service.recoverInterruptedOperations()

    // The entire .cache is gone — neither the partial nor the orphaned archive survives the restart.
    expect(existsSync(join(runtimeRoot, 'packs', '.cache'))).toBe(false)
  })

  it('wipes the pack download cache even when the operation journal is corrupt (WS13)', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = join(root, 'runtime')
    // A corrupt journal makes recovery early-return (blocking all runtime writes). The .cache wipe must
    // still run — it is ordered BEFORE that early return — so a corrupt journal can't strand a prior
    // session's .part for a later fetch. (Correctness also holds via the per-session cache key; this
    // covers the housekeeping path the reviewer flagged as untested.)
    const cache = join(runtimeRoot, 'packs', '.cache', '1', 'osx-arm64')
    await mkdir(cache, { recursive: true })
    await writeFile(join(cache, 'python-3.12.tar.zst.part'), Buffer.from('half'))
    await writeFile(operationJournalPath(runtimeRoot), 'not-json{{{')

    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    await service.recoverInterruptedOperations()

    expect(existsSync(join(runtimeRoot, 'packs', '.cache'))).toBe(false)
  })

  it('reconciles a stale running run to interrupted on first load after a crash (WS12)', async () => {
    const root = await createStorageRoot()

    // Simulate a prior process that died mid-run: persist a run left in 'running'.
    const priorRepo = new NotebookRunRepository(root)
    await priorRepo.loadOrCreate({
      projectId: 'default-project',
      sessionId: 'crashed',
      lane: createRootNotebookLane('default-project', 'crashed', 'root-frame-crashed'),
      workspaceCwd: '/workspace'
    })
    await priorRepo.appendRun({
      projectId: 'default-project',
      sessionId: 'crashed',
      lane: createRootNotebookLane('default-project', 'crashed', 'root-frame-crashed'),
      run: {
        runId: 'run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        script: 'long()',
        status: 'running',
        startedAt: 100,
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: []
      }
    })

    // A fresh service loading the session reconciles the stale run (no live kernel exists for it).
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const state = await service.state({ sessionId: 'crashed', workspaceCwd: '/workspace' })
    expect(state.runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'interrupted',
      interruptionReason: 'app-terminated'
    })
  })

  it('keeps a live root-Frame control run running when the renderer reads Session state', async () => {
    const root = await createStorageRoot()
    const executionStarted = createDeferred<void>()
    const releaseExecution = createDeferred<void>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executionStarted.resolve()
          await releaseExecution.promise
          return {
            status: 'completed',
            stdout: 'done\n',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    const sessionId = 'codex-session'
    const rootFrameId = 'root-frame-pending-session-1'
    const executing = service.executeControl({
      projectId: 'default-project',
      sessionId,
      workspaceCwd: '/workspace',
      code: 'await host.mcp("pubmed", "search_articles", {})',
      executionInvocationId: 'invocation-1',
      provenanceContext: {
        rootFrameId,
        agentFrameId: rootFrameId,
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1'
      }
    })

    await executionStarted.promise
    try {
      const state = await service.state({
        projectId: 'default-project',
        sessionId,
        workspaceCwd: '/workspace'
      })

      expect(state.runs).toContainEqual(
        expect.objectContaining({
          executionInvocationId: 'invocation-1',
          status: 'running'
        })
      )
    } finally {
      releaseExecution.resolve()
      await executing
    }
  })

  it('keeps root-Frame provenance when renderer state creates the Session owner first', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: 'done\n',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const sessionId = 'codex-session'
    const rootFrameId = 'root-frame-pending-session-1'

    await service.state({
      projectId: 'default-project',
      sessionId,
      workspaceCwd: '/workspace'
    })
    await service.executeControl({
      projectId: 'default-project',
      sessionId,
      workspaceCwd: '/workspace',
      code: 'await host.mcp("pubmed", "search_articles", {})',
      executionInvocationId: 'invocation-1',
      provenanceContext: {
        rootFrameId,
        agentFrameId: rootFrameId,
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-1',
        promptMessageId: 'prompt-1'
      }
    })

    const state = await service.state({
      projectId: 'default-project',
      sessionId,
      workspaceCwd: '/workspace'
    })
    expect(state.runs).toContainEqual(
      expect.objectContaining({
        executionInvocationId: 'invocation-1',
        agentFrameId: rootFrameId,
        rootFrameId
      })
    )

    const frameSummary = await service.state({
      projectId: 'default-project',
      sessionId,
      workspaceCwd: '/workspace',
      historySummaryFrameId: rootFrameId
    })
    expect(frameSummary.historySummary).toMatchObject({
      agentFrameId: rootFrameId,
      runCount: 1
    })
  })

  it('serializes overlapping runs on the shared interpreter instead of failing the second', async () => {
    const root = await createStorageRoot()
    let active = 0
    let maxConcurrent = 0
    const releases: Array<() => void> = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          active += 1
          maxConcurrent = Math.max(maxConcurrent, active)

          // Mirror the real single-slot executor: a second concurrent execution is rejected.
          if (active > 1) {
            active -= 1
            throw new Error('Notebook execution is already running.')
          }

          // Hold this execution open so a second run can attempt to overlap with it.
          await new Promise<void>((resolve) => releases.push(resolve))
          active -= 1

          return {
            status: 'completed',
            stdout: `${request.code}\n`,
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [],
            workingFiles: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const submit = (code: string): Promise<unknown> =>
      service.execute({
        projectId: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: '/workspace',
        code,
        source: 'user',
        inputKind: 'terminal'
      })

    const first = submit("print('a')")
    // Wait until the first run has actually entered the executor and is holding the single slot.
    await vi.waitFor(() => expect(releases).toHaveLength(1))

    const second = submit("print('b')")
    // Give the second run a chance to (wrongly) reach the executor while the first is in flight.
    await new Promise((resolve) => setTimeout(resolve, 20))

    // With serialization the second run is still queued, so only the first has entered the executor.
    expect(releases).toHaveLength(1)

    // Drain the first run; the second should then take the freed slot and run on its own.
    releases[0]()
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]()

    const [firstSummary, secondSummary] = (await Promise.all([first, second])) as Array<{
      status: string
    }>

    expect(maxConcurrent).toBe(1)
    expect(firstSummary.status).toBe('completed')
    expect(secondSummary.status).toBe('completed')

    const rawRunJson = await readFile(
      join(root, 'notebooks', 'default-project', 'session-1', 'run.json'),
      'utf8'
    )
    const document = JSON.parse(rawRunJson) as Awaited<
      ReturnType<NotebookRunRepository['loadOrCreate']>
    >
    expect(document.runs).toHaveLength(2)
    expect(document.runs.every((run) => run.status === 'completed')).toBe(true)
  })

  it('settles a cancelled queued run before the active interpreter execution finishes', async () => {
    const root = await createStorageRoot()
    const executionStarted = createDeferred<void>()
    const releaseExecution = createDeferred<void>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executionStarted.resolve()
          await releaseExecution.promise
          return {
            status: 'completed',
            stdout: `${request.code}\n`,
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [],
            workingFiles: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })
    const first = service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: 'long_running_analysis()'
    })
    await executionStarted.promise

    const cancellation = new AbortController()
    const queued = service.execute(
      {
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'should_not_run()'
      },
      cancellation.signal
    )
    await vi.waitFor(async () => {
      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.cells).toHaveLength(2)
    })
    cancellation.abort()

    await expect(queued).rejects.toBe(cancellation.signal.reason)
    const queuedState = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(queuedState.runs).toHaveLength(1)
    expect(queuedState.cells[1]).toMatchObject({
      code: 'should_not_run()',
      status: 'idle'
    })

    releaseExecution.resolve()
    await expect(first).resolves.toMatchObject({ status: 'completed' })
  })

  it('runs different sessions in parallel instead of serializing across sessions', async () => {
    const root = await createStorageRoot()
    let active = 0
    let maxConcurrent = 0
    const releases = new Map<string, () => void>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      // Each session gets its own executor; the shared counter proves both can be in flight at once.
      executorFactory: (sessionId) => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          active += 1
          maxConcurrent = Math.max(maxConcurrent, active)

          // Hold each session's execution open until released so both can overlap.
          await new Promise<void>((resolve) => releases.set(sessionId, resolve))
          active -= 1

          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: [],
            workingFiles: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    const submit = (sessionId: string): Promise<unknown> =>
      service.execute({
        projectId: 'default-project',
        sessionId,
        workspaceCwd: '/workspace',
        code: 'print(1)',
        source: 'user',
        inputKind: 'terminal'
      })

    const runA = submit('session-a')
    const runB = submit('session-b')

    // Both sessions should be inside their own executors at the same time — the per-session queue
    // must not serialize one session behind another.
    await vi.waitFor(() => expect(releases.size).toBe(2))
    expect(maxConcurrent).toBe(2)

    releases.get('session-a')?.()
    releases.get('session-b')?.()
    await Promise.all([runA, runB])
  })

  it('threads the cell language to the executor (default python)', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '1 + 1'
    })

    expect(executions).toHaveLength(1)
    expect(executions[0].language).toBe('python')

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs[0].kernelKind).toBe('python')
  })

  it('threads an explicit r language from the execute request to the executor', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true })
      })
    })

    await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '1 + 1',
      language: 'r'
    })

    expect(executions).toHaveLength(1)
    expect(executions[0].language).toBe('r')

    // Guards the I1 mislabel: an R cell run must record kernelKind 'r', not the python default.
    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.runs[0].kernelKind).toBe('r')
  })

  it('restart calls executor.restart when the executor supports it', async () => {
    const root = await createStorageRoot()
    let restarts = 0
    let shutdowns = 0
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => {
          shutdowns += 1
          return { reaped: true }
        },
        restart: async () => {
          restarts += 1
        }
      })
    })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    await service.restart({ sessionId: 'session-1', workspaceCwd: root })

    expect(restarts).toBe(1)
    // In-place restart keeps the same executor instance, so no shutdown+recreate is needed.
    expect(shutdowns).toBe(0)
  })

  it('restarts only the requested R environment without restarting the session executor', async () => {
    const root = await createStorageRoot()
    let restarts = 0
    const terminated: Array<['python' | 'r' | 'repl', string]> = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        restart: async () => {
          restarts += 1
        },
        terminate: async (kind, environment) => {
          terminated.push([kind, environment])
        }
      })
    })
    const request = { sessionId: 'session-1', workspaceCwd: root }
    await service.execute({ ...request, language: 'python', code: 'python_state = 1' })
    await service.execute({ ...request, language: 'r', code: 'r_state <- 1' })

    const restarted = await service.restart({
      ...request,
      language: 'r',
      environment: DEFAULT_R_ENV
    })

    expect(restarts).toBe(0)
    expect(terminated).toEqual([['r', DEFAULT_R_ENV]])
    expect(restarted.environments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ processKey: `python:${DEFAULT_PY_ENV}`, status: 'idle' }),
        expect.objectContaining({ processKey: `r:${DEFAULT_R_ENV}`, status: 'idle' })
      ])
    )
    for (const malformedTarget of [{ language: 'r' as const }, { environment: DEFAULT_R_ENV }]) {
      await expect(
        service.restart({
          ...request,
          ...malformedTarget
        } as never)
      ).rejects.toThrow('language and environment must be provided together')
    }
    expect(restarts).toBe(0)
    expect(terminated).toEqual([['r', DEFAULT_R_ENV]])
  })

  it('persists default Python idle after reload when a targeted restart recovers a coarse error', async () => {
    const root = await createStorageRoot()
    const request = { sessionId: 'session-1', workspaceCwd: root }
    const executorFactory = (): NotebookSessionExecutor => ({
      execute: async (execution): Promise<NotebookExecutionResult> => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: execution.cwd,
        outputs: []
      }),
      shutdown: async () => ({ reaped: true }),
      restart: async () => {
        throw new Error('restart failed')
      },
      terminate: async () => undefined
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    await service.execute({ ...request, code: '1' })
    await expect(service.restart(request)).rejects.toThrow('restart failed')

    const reloadedService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    const restarted = await reloadedService.restart({
      ...request,
      language: 'python',
      environment: DEFAULT_PY_ENV
    })
    expect(restarted.kernelStatus).toBe('idle')

    const verifiedService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    expect((await verifiedService.state(request)).kernelStatus).toBe('idle')
  })

  it('preserves durable termination when targeted restart cleanup fails', async () => {
    const root = await createStorageRoot()
    const request = { sessionId: 'session-1', workspaceCwd: root }
    let lifecycle!: NotebookExecutorLifecycleCallbacks
    const firstService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: (_sessionId, callbacks) => {
        lifecycle = callbacks
        return {
          execute: async (execution): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: execution.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }
      }
    })
    await firstService.execute({ ...request, code: '1' })
    await lifecycle.onTerminated('python', DEFAULT_PY_ENV)

    const repository = new NotebookRunRepository(root)
    vi.spyOn(repository, 'clearKernelTermination').mockRejectedValueOnce(
      new Error('could not clear durable termination')
    )
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      executorFactory: () => ({
        execute: async (execution): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        terminate: async () => undefined
      })
    })

    await expect(
      service.restart({ ...request, language: 'python', environment: DEFAULT_PY_ENV })
    ).rejects.toThrow('could not clear durable termination')
    expect((await service.state(request)).kernelStatus).toBe('terminated')
  })

  it('persists a targeted default Python restart failure across reload', async () => {
    const root = await createStorageRoot()
    const request = { sessionId: 'session-1', workspaceCwd: root }
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (execution): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        terminate: async () => {
          throw new Error('targeted restart failed')
        }
      })
    })
    await service.execute({ ...request, code: '1' })

    await expect(
      service.restart({ ...request, language: 'python', environment: DEFAULT_PY_ENV })
    ).rejects.toThrow('targeted restart failed')
    expect((await service.state(request)).kernelStatus).toBe('error')

    const reloadedService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (execution): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    expect((await reloadedService.state(request)).kernelStatus).toBe('error')
  })

  it('holds later executions until targeted restart persistence completes', async () => {
    const root = await createStorageRoot()
    const request = { sessionId: 'session-1', workspaceCwd: root }
    const repository = new NotebookRunRepository(root)
    const secondExecutionStarted = createDeferred<void>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      executorFactory: () => ({
        execute: async (execution): Promise<NotebookExecutionResult> => {
          if (execution.code === '2') secondExecutionStarted.resolve()
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: execution.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true }),
        terminate: async () => undefined
      })
    })
    await service.execute({ ...request, code: '1' })

    const persistenceGate = createDeferred<void>()
    const updateKernelStatus = repository.updateKernelStatus.bind(repository)
    let holdNextIdle = true
    const persistenceStarted = createDeferred<void>()
    vi.spyOn(repository, 'updateKernelStatus').mockImplementation(async (update) => {
      if (holdNextIdle && update.status === 'idle') {
        holdNextIdle = false
        persistenceStarted.resolve()
        await persistenceGate.promise
      }
      return updateKernelStatus(update)
    })

    const restarting = service.restart({
      ...request,
      language: 'python',
      environment: DEFAULT_PY_ENV
    })
    await persistenceStarted.promise
    const nextExecution = service.execute({ ...request, code: '2' })

    try {
      const startedBeforePersistence = await Promise.race([
        secondExecutionStarted.promise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 20))
      ])
      expect(startedBeforePersistence).toBe(false)
    } finally {
      persistenceGate.resolve()
      await Promise.allSettled([restarting, nextExecution])
    }
  })

  it('does not create a live environment entry for a dormant targeted restart', async () => {
    const root = await createStorageRoot()
    const request = { sessionId: 'session-1', workspaceCwd: root }
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (execution): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: execution.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        terminate: async () => undefined
      })
    })

    const settled = await service.restart({
      ...request,
      language: 'python',
      environment: DEFAULT_PY_ENV
    })

    expect(settled.kernelStatus).toBe('idle')
    expect(settled.environments).toEqual([])
  })

  it('reports a restarting kernel status while restart() is in flight, then settles to idle', async () => {
    const root = await createStorageRoot()
    let releaseRestart: (() => void) | undefined
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        restart: () =>
          new Promise<void>((resolve) => {
            releaseRestart = resolve
          })
      })
    })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })

    const restarting = service.restart({ sessionId: 'session-1', workspaceCwd: root })
    // Wait for restart() to reach and await executor.restart() (the in-flight window).
    await vi.waitFor(() => expect(releaseRestart).toBeDefined())

    const midFlight = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(midFlight.kernelStatus).toBe('restarting')

    releaseRestart?.()
    const settled = await restarting

    expect(settled.kernelStatus).toBe('idle')
  })

  it('reports and persists error when an in-place restart fails', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        restart: async () => {
          throw new Error('restart failed')
        }
      })
    })
    const request = { sessionId: 'session-1', workspaceCwd: root }
    await service.execute({ ...request, code: '1' })

    await expect(service.restart(request)).rejects.toThrow('restart failed')

    expect((await service.state(request)).kernelStatus).toBe('error')
    expect(
      (await new NotebookRunRepository(root).findExisting('default-project', 'session-1'))?.kernel
    ).toMatchObject({ lastKnownStatus: 'error' })
  })

  it('preserves terminated kernel evidence when restart fails', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    let lifecycle!: NotebookExecutorLifecycleCallbacks
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      executorFactory: (_sessionId, callbacks) => {
        lifecycle = callbacks
        return {
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true }),
          restart: async () => {
            throw new Error('restart failed')
          }
        }
      }
    })
    const request = { sessionId: 'session-1', workspaceCwd: root }
    await service.execute({ ...request, code: '1' })
    await lifecycle.onTerminated('python', DEFAULT_PY_ENV)

    await expect(service.restart(request)).rejects.toThrow('restart failed')

    expect((await service.state(request)).kernelStatus).toBe('terminated')
    expect(
      (await new NotebookRunRepository(root).findExisting('default-project', 'session-1'))?.kernel
    ).toMatchObject({
      lastKnownStatus: 'terminated',
      terminatedKernelInstances: [{ kind: 'python', environment: DEFAULT_PY_ENV }]
    })
  })

  it('does not create a live environment entry when restarting before any kernel spawned', async () => {
    const root = await createStorageRoot()
    let releaseRestart: (() => void) | undefined
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true }),
        restart: () =>
          new Promise<void>((resolve) => {
            releaseRestart = resolve
          })
      })
    })

    const restarting = service.restart({ sessionId: 'session-1', workspaceCwd: root })
    await vi.waitFor(() => expect(releaseRestart).toBeDefined())

    const midFlight = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(midFlight.kernelStatus).toBe('restarting')
    expect(midFlight.environments).toEqual([])

    releaseRestart?.()
    const settled = await restarting
    expect(settled.kernelStatus).toBe('idle')
    expect(settled.environments).toEqual([])
  })

  it('keeps the executor callback current across an in-place restart', async () => {
    const root = await createStorageRoot()
    const { service, lifecycles, changedSessions } = lifecycleCallbackHarness(root, {
      inPlaceRestart: true
    })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    await service.restart({ sessionId: 'session-1', workspaceCwd: root })
    const changedCountBefore = changedSessions.length

    expect(lifecycles).toHaveLength(1)
    await lifecycles[0].onIdleShutdown('python', DEFAULT_PY_ENV)

    expect((await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus).toBe(
      'terminated'
    )
    expect(changedSessions).toHaveLength(changedCountBefore + 1)
  })

  it('idle-shutdown reports a terminated kernel status and notifies listeners', async () => {
    const root = await createStorageRoot()
    const changedSessions: string[] = []
    let lifecycle!: NotebookExecutorLifecycleCallbacks
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      callbacks: {
        onNotebookChanged: (event) => changedSessions.push(event.sessionId)
      },
      executorFactory: (_sessionId, callbacks) => {
        lifecycle = callbacks
        return {
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }
      }
    })

    // Establishes the runtime session (and its persisted run.json) the idle-shutdown hook targets.
    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })

    // Simulates NotebookKernelExecutor's onIdleShutdown firing after its idle window elapses.
    await lifecycle.onIdleShutdown('python', DEFAULT_PY_ENV)

    const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(state.kernelStatus).toBe('terminated')
    expect(changedSessions).toContain('session-1')
  })

  it.each(['idle-shutdown', 'termination'] as const)(
    'keeps live and durable kernel state unchanged when %s persistence fails',
    async (callback) => {
      const root = await createStorageRoot()
      const repository = new NotebookRunRepository(root)
      const { service, lifecycles, changedSessions } = lifecycleCallbackHarness(root, {
        repository
      })

      const firstRun = await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '1'
      })
      const before = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      const runJsonBefore = await readFile(before.runJsonPath, 'utf8')
      const changedCountBefore = changedSessions.length
      const persistenceError = new Error('kernel status persistence failed')
      vi.spyOn(repository, 'markKernelTerminated').mockRejectedValueOnce(persistenceError)

      const lifecycle = lifecycles[0]
      const statusUpdate =
        callback === 'idle-shutdown'
          ? lifecycle.onIdleShutdown('python', DEFAULT_PY_ENV)
          : lifecycle.onTerminated('python', DEFAULT_PY_ENV)
      const failure = await statusUpdate.catch((error: unknown) => error)

      expect(failure).toBe(persistenceError)
      expect(
        (await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus
      ).toBe('idle')
      expect(await readFile(before.runJsonPath, 'utf8')).toBe(runJsonBefore)
      expect(changedSessions).toHaveLength(changedCountBefore)

      const nextRun = await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '2'
      })
      expect(nextRun.kernelEpochId).not.toBe(firstRun.kernelEpochId)
    }
  )

  it('orders a new execution after delayed idle-shutdown persistence', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const { service, lifecycles } = lifecycleCallbackHarness(root, { repository })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    const persistenceGate = createDeferred<void>()
    const markKernelTerminated = repository.markKernelTerminated.bind(repository)
    const persistenceSpy = vi
      .spyOn(repository, 'markKernelTerminated')
      .mockImplementation(async (request) => {
        await persistenceGate.promise
        return markKernelTerminated(request)
      })

    const idleShutdown = lifecycles[0].onIdleShutdown('python', DEFAULT_PY_ENV)
    await vi.waitFor(() => expect(persistenceSpy).toHaveBeenCalledTimes(1))
    let nextExecutionSettled = false
    const nextExecution = service
      .execute({ sessionId: 'session-1', workspaceCwd: root, code: '2' })
      .finally(() => {
        nextExecutionSettled = true
      })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(nextExecutionSettled).toBe(false)

    persistenceGate.resolve()
    await idleShutdown
    await nextExecution

    expect((await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus).toBe(
      'idle'
    )
    expect(
      (await new NotebookRunRepository(root).findExisting('default-project', 'session-1'))?.kernel
    ).toMatchObject({ lastKnownStatus: 'idle' })
  })

  it('ignores an idle-shutdown callback from a session replaced under the same id', async () => {
    const root = await createStorageRoot()
    const { service, lifecycles, changedSessions } = lifecycleCallbackHarness(root)

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    await service.shutdown({ sessionId: 'session-1', workspaceCwd: root })
    const replacement = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    const runJsonBefore = await readFile(replacement.runJsonPath, 'utf8')
    const changedCountBefore = changedSessions.length

    expect(lifecycles).toHaveLength(2)
    await lifecycles[0].onIdleShutdown('python', DEFAULT_PY_ENV)

    expect(await readFile(replacement.runJsonPath, 'utf8')).toBe(runJsonBefore)
    expect((await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus).toBe(
      'idle'
    )
    expect(changedSessions).toHaveLength(changedCountBefore)
  })

  it.each(['idle', 'terminated'] as const)(
    'ignores an old %s callback after shutdown and before same-id recreation',
    async (callback) => {
      const root = await createStorageRoot()
      const { service, lifecycles, changedSessions } = lifecycleCallbackHarness(root)

      const current = await service.state({
        sessionId: 'session-1',
        workspaceCwd: root
      })
      await service.shutdown({ sessionId: 'session-1', workspaceCwd: root })
      const runJsonBefore = await readFile(current.runJsonPath, 'utf8')
      const changedCountBefore = changedSessions.length

      expect(lifecycles).toHaveLength(1)
      if (callback === 'idle') {
        await lifecycles[0].onIdleShutdown('python', DEFAULT_PY_ENV)
      } else {
        await lifecycles[0].onTerminated('python', DEFAULT_PY_ENV)
      }

      expect(await readFile(current.runJsonPath, 'utf8')).toBe(runJsonBefore)
      expect(changedSessions).toHaveLength(changedCountBefore)

      const replacement = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(replacement.kernelStatus).toBe('idle')
      expect(lifecycles).toHaveLength(2)
    }
  )

  it('applies only the current terminated callback after executor replacement', async () => {
    const root = await createStorageRoot()
    const { service, lifecycles, changedSessions } = lifecycleCallbackHarness(root)

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    await service.restart({ sessionId: 'session-1', workspaceCwd: root })
    const restarted = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    const runJsonBefore = await readFile(restarted.runJsonPath, 'utf8')
    const environmentsBefore = restarted.environments
    const changedCountBefore = changedSessions.length

    expect(lifecycles).toHaveLength(2)
    await lifecycles[0].onTerminated('python', 'analysis')
    expect(
      (await service.state({ sessionId: 'session-1', workspaceCwd: root })).environments
    ).toEqual(environmentsBefore)
    expect(await readFile(restarted.runJsonPath, 'utf8')).toBe(runJsonBefore)
    expect(changedSessions).toHaveLength(changedCountBefore)

    await lifecycles[1].onTerminated('python', 'analysis')
    expect(
      (await service.state({ sessionId: 'session-1', workspaceCwd: root })).environments
    ).toEqual([
      ...environmentsBefore,
      {
        processKey: 'python:analysis',
        kind: 'python',
        environment: 'analysis',
        status: 'terminated',
        restartRecommended: false
      }
    ])
    expect(JSON.parse(await readFile(restarted.runJsonPath, 'utf8')).kernel).toMatchObject({
      lastKnownStatus: 'terminated',
      terminatedKernelInstances: [{ kind: 'python', environment: 'analysis' }]
    })
    expect(changedSessions).toHaveLength(changedCountBefore + 1)
  })

  it.each([
    { operation: 'session shutdown', callback: 'idle' },
    { operation: 'executor replacement', callback: 'terminated' }
  ] as const)(
    'drops the old $callback callback once $operation teardown begins',
    async ({ operation, callback }) => {
      const root = await createStorageRoot()
      let releaseShutdown!: () => void
      const shutdownGate = new Promise<void>((resolve) => {
        releaseShutdown = resolve
      })
      const shutdownExecutor = vi.fn(async () => {
        await shutdownGate
        return { reaped: true }
      })
      const { service, lifecycles, changedSessions } = lifecycleCallbackHarness(root, {
        shutdown: shutdownExecutor
      })

      await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
      const beforeTeardown = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      const teardown =
        operation === 'session shutdown'
          ? service.shutdown({ sessionId: 'session-1', workspaceCwd: root })
          : service.restart({ sessionId: 'session-1', workspaceCwd: root })
      await vi.waitFor(() => expect(shutdownExecutor).toHaveBeenCalledTimes(1))

      const duringTeardown =
        operation === 'executor replacement'
          ? await service.state({ sessionId: 'session-1', workspaceCwd: root })
          : beforeTeardown
      const runJsonBefore = await readFile(duringTeardown.runJsonPath, 'utf8')
      const environmentsBefore = duringTeardown.environments
      const changedCountBefore = changedSessions.length

      if (callback === 'idle') {
        await lifecycles[0].onIdleShutdown('python', DEFAULT_PY_ENV)
      } else {
        await lifecycles[0].onTerminated('python', 'analysis')
      }

      try {
        expect(await readFile(duringTeardown.runJsonPath, 'utf8')).toBe(runJsonBefore)
        if (operation === 'executor replacement') {
          expect(
            (await service.state({ sessionId: 'session-1', workspaceCwd: root })).environments
          ).toEqual(environmentsBefore)
        }
        expect(changedSessions).toHaveLength(changedCountBefore)
      } finally {
        releaseShutdown()
        await teardown
      }
      if (operation === 'session shutdown') {
        await service.state({ sessionId: 'session-1', workspaceCwd: root })
      }
      expect(lifecycles).toHaveLength(2)
    }
  )

  it('drains a callback that already owns persistence before session teardown', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const shutdownExecutor = vi.fn(async () => ({ reaped: true }))
    const { service, lifecycles, changedSessions } = lifecycleCallbackHarness(root, {
      repository,
      shutdown: shutdownExecutor
    })
    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })

    let releasePersistence!: () => void
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve
    })
    const markKernelTerminated = repository.markKernelTerminated.bind(repository)
    const updateSpy = vi
      .spyOn(repository, 'markKernelTerminated')
      .mockImplementation(async (request) => {
        await persistenceGate
        return markKernelTerminated(request)
      })
    const changedCountBefore = changedSessions.length

    const callback = lifecycles[0].onIdleShutdown('python', DEFAULT_PY_ENV)
    await vi.waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1))
    const teardown = service.shutdown({ sessionId: 'session-1', workspaceCwd: root })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(shutdownExecutor).not.toHaveBeenCalled()

    releasePersistence()
    await callback
    await teardown

    expect(shutdownExecutor).toHaveBeenCalledTimes(1)
    expect(changedSessions).toHaveLength(changedCountBefore + 1)
  })

  it('clears a stale terminated status once a run completes on the transparently respawned kernel', async () => {
    const root = await createStorageRoot()
    let lifecycle!: NotebookExecutorLifecycleCallbacks
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: (_sessionId, callbacks) => {
        lifecycle = callbacks
        return {
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }
      }
    })

    // Establishes the runtime session and persisted run.json the idle-shutdown hook targets.
    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })

    // Simulates the executor's own idle timer dropping the proc between runs (see the
    // 'idle-shutdown reports a terminated kernel status' test above for the same mechanism).
    await lifecycle.onIdleShutdown('python', DEFAULT_PY_ENV)

    const afterShutdown = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(afterShutdown.kernelStatus).toBe('terminated')

    // The next execute() transparently respawns a fresh kernel (executorFactory above never actually
    // dies), so the run completes normally — the persisted status must no longer read 'terminated'.
    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '2' })

    const afterRespawn = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(afterRespawn.kernelStatus).toBe('idle')
  })

  it('keeps a recovered execution successful when clearing durable termination fails', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const { service, lifecycles } = lifecycleCallbackHarness(root, { repository, logger })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    await lifecycles[0].onIdleShutdown('python', DEFAULT_PY_ENV)
    const persistenceError = new Error('could not clear durable termination')
    vi.spyOn(repository, 'clearKernelTermination').mockRejectedValueOnce(persistenceError)

    const recovered = await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '2'
    })

    expect(recovered.status).toBe('completed')
    expect((await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus).toBe(
      'idle'
    )
    expect(
      (await new NotebookRunRepository(root).findExisting('default-project', 'session-1'))?.kernel
    ).toMatchObject({
      lastKnownStatus: 'terminated',
      terminatedKernelInstances: [{ kind: 'python', environment: DEFAULT_PY_ENV }]
    })
    expect(logger.error).toHaveBeenCalledWith(
      'notebook kernel lifecycle persistence failed',
      expect.objectContaining({
        error: persistenceError.message,
        operation: 'recovered-idle',
        kind: 'python',
        environment: DEFAULT_PY_ENV
      })
    )
  })

  it('persists idle after recovering a terminated kernel in a recreated runtime service', async () => {
    const root = await createStorageRoot()
    let lifecycle!: NotebookExecutorLifecycleCallbacks
    const executorFactory = (
      _sessionId: string,
      callbacks: NotebookExecutorLifecycleCallbacks
    ): NotebookSessionExecutor => {
      lifecycle = callbacks
      return {
        execute: async (request: NotebookExecutionRequest): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      }
    }

    const firstService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    await firstService.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    await lifecycle.onIdleShutdown('python', DEFAULT_PY_ENV)

    const recoveredService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    await recoveredService.execute({ sessionId: 'session-1', workspaceCwd: root, code: '2' })

    const reloadedService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    const reloadedState = await reloadedService.state({
      sessionId: 'session-1',
      workspaceCwd: root
    })
    expect(reloadedState.kernelStatus).toBe('idle')
  })

  it('does not clear a terminated data-kernel status after an unrelated control run', async () => {
    const root = await createStorageRoot()
    let lifecycle!: NotebookExecutorLifecycleCallbacks
    const repository = new NotebookRunRepository(root)
    const statusWrite = vi.spyOn(repository, 'updateKernelStatus')
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      executorFactory: (_sessionId, callbacks) => {
        lifecycle = callbacks
        return {
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }
      }
    })

    // Establishes the runtime session and persisted run.json the idle-shutdown hook targets.
    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })

    await lifecycle.onIdleShutdown('python', DEFAULT_PY_ENV)

    const afterShutdown = await service.state({ sessionId: 'session-1', workspaceCwd: root })
    expect(afterShutdown.kernelStatus).toBe('terminated')
    statusWrite.mockClear()

    await service.executeControl({ sessionId: 'session-1', workspaceCwd: root, code: '2' })

    expect(statusWrite).not.toHaveBeenCalled()
  })

  it('does not durably recover a terminated data kernel through an unrelated control run after relaunch', async () => {
    const root = await createStorageRoot()
    let lifecycle!: NotebookExecutorLifecycleCallbacks
    const executorFactory = (
      _sessionId: string,
      callbacks: NotebookExecutorLifecycleCallbacks
    ): NotebookSessionExecutor => {
      lifecycle = callbacks
      return {
        execute: async (request: NotebookExecutionRequest): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      }
    }

    const firstService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    await firstService.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '1'
    })
    const runJsonPath = (await firstService.state({ sessionId: 'session-1', workspaceCwd: root }))
      .runJsonPath
    await lifecycle.onIdleShutdown('python', DEFAULT_PY_ENV)

    const recoveredService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    await recoveredService.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '2'
    })

    const persisted = JSON.parse(await readFile(runJsonPath, 'utf8'))
    expect(persisted.kernel).toMatchObject({
      lastKnownStatus: 'terminated',
      terminatedKernelInstances: [{ kind: 'python', environment: DEFAULT_PY_ENV }]
    })
    const reloadedService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    expect(
      (await reloadedService.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus
    ).toBe('terminated')
  })

  it('persists idle after recovering a terminated repl in a recreated runtime service', async () => {
    const root = await createStorageRoot()
    let lifecycle!: NotebookExecutorLifecycleCallbacks
    const executorFactory = (
      _sessionId: string,
      callbacks: NotebookExecutorLifecycleCallbacks
    ): NotebookSessionExecutor => {
      lifecycle = callbacks
      return {
        execute: async (request: NotebookExecutionRequest): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      }
    }

    const firstService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    await firstService.executeControl({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    await lifecycle.onIdleShutdown('repl', undefined)

    const recoveredService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    await recoveredService.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '2'
    })

    const reloadedService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    const reloadedState = await reloadedService.state({
      sessionId: 'session-1',
      workspaceCwd: root
    })
    expect(reloadedState.kernelStatus).toBe('idle')
  })

  it('keeps a legacy coarse terminated status until an explicit restart', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const executorFactory = (): NotebookSessionExecutor => ({
      execute: async (request: NotebookExecutionRequest): Promise<NotebookExecutionResult> => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: request.cwd,
        outputs: []
      }),
      shutdown: async () => ({ reaped: true })
    })
    const firstService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      executorFactory
    })
    await firstService.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '1'
    })
    const runJsonPath = (await firstService.state({ sessionId: 'session-1', workspaceCwd: root }))
      .runJsonPath
    await repository.updateKernelStatus({
      projectId: 'default-project',
      sessionId: 'session-1',
      lane: createRootNotebookLane('default-project', 'session-1', 'root-frame-session-1'),
      status: 'terminated'
    })

    const recoveredService = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory
    })
    await recoveredService.executeControl({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '2'
    })
    expect(JSON.parse(await readFile(runJsonPath, 'utf8')).kernel).toMatchObject({
      lastKnownStatus: 'terminated'
    })
    expect(
      JSON.parse(await readFile(runJsonPath, 'utf8')).kernel.terminatedKernelInstances
    ).toBeUndefined()

    await recoveredService.restart({ sessionId: 'session-1', workspaceCwd: root })
    expect(JSON.parse(await readFile(runJsonPath, 'utf8')).kernel).toMatchObject({
      lastKnownStatus: 'idle'
    })
  })

  describe('lifecycle & concurrency (G2/G3/G4/G5)', () => {
    // Executor double that holds each run open until released, recording every start so a test can
    // observe how many runs are concurrently in flight and in what order.
    const holdingService = (
      root: string,
      onStart: (request: NotebookExecutionRequest, release: () => void) => void,
      repository = new NotebookRunRepository(root)
    ): NotebookRuntimeService =>
      new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository,
        environmentStateTracker: {
          prepareRun: vi.fn().mockResolvedValue({
            fingerprint: 'stable',
            inventoryRefreshed: false,
            warnings: []
          }),
          captureCompletedRun: vi.fn().mockRejectedValue(new Error('not under test')),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue(undefined)
        },
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            await new Promise<void>((resolve) => onStart(request, resolve))
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })

    it('writes a running kernel status during a live run, then settles to idle (G4)', async () => {
      const root = await createStorageRoot()
      let release: (() => void) | undefined
      const service = holdingService(root, (_request, resolve) => {
        release = resolve
      })

      const run = service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
      await vi.waitFor(() => expect(release).toBeDefined())

      // The kernel reads 'running' while the run is in flight (G4: the union member is now written).
      const midFlight = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(midFlight.kernelStatus).toBe('running')

      release?.()
      await run
      const settled = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(settled.kernelStatus).toBe('idle')
    })

    it('keeps ordinary running/idle status in memory without rewriting run.json', async () => {
      const root = await createStorageRoot()
      const repository = new NotebookRunRepository(root)
      const statusWrite = vi.spyOn(repository, 'updateKernelStatus')
      let release: (() => void) | undefined
      const service = holdingService(
        root,
        (_request, resolve) => {
          release = resolve
        },
        repository
      )

      const run = service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
      await vi.waitFor(() => expect(release).toBeDefined())
      expect(
        (await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus
      ).toBe('running')
      release?.()
      await run

      expect(statusWrite).not.toHaveBeenCalled()
    })

    it('keeps the kernel idle when the runtime mutation policy rejects before execution', async () => {
      const root = await createStorageRoot()
      let executorStarted = false
      const service = holdingService(root, () => {
        executorStarted = true
      })

      const run = await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: `open(os.path.join(os.environ["OPEN_SCIENCE_RUNTIME_DIR"], "blocked"), "w")`
      })

      expect(run.status).toBe('failed')
      expect(run.text.traceback).toMatch(/MANAGED_RUNTIME_MUTATION_BLOCKED/)
      expect(executorStarted).toBe(false)
      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.kernelStatus).toBe('idle')
    })

    it('runs python and r concurrently while serializing same-language runs (G5)', async () => {
      const root = await createStorageRoot()
      let active = 0
      let maxConcurrent = 0
      const releases: Array<{ language?: string; release: () => void }> = []
      const service = holdingService(root, (request, resolve) => {
        active += 1
        maxConcurrent = Math.max(maxConcurrent, active)
        releases.push({ language: request.language, release: resolve })
      })
      // Undo the shared active counter as each held run is released.
      const drain = (entry: { release: () => void }): void => {
        active -= 1
        entry.release()
      }

      // Pre-create the cells sequentially (the write-lock dance can't run concurrently), then fire the
      // runs at once so the per-kind execution queues — not the write lock — govern concurrency.
      const makeCell = async (cellId: string, language: 'python' | 'r'): Promise<void> => {
        const begin = await service.beginCodeCell({
          sessionId: 's',
          workspaceCwd: root,
          cellId,
          language
        })
        await service.appendCodeCell({
          sessionId: 's',
          workspaceCwd: root,
          writeId: begin.writeId,
          cellId,
          delta: '1'
        })
        await service.finishCodeCell({
          sessionId: 's',
          workspaceCwd: root,
          writeId: begin.writeId,
          cellId
        })
      }
      await makeCell('py1', 'python')
      await makeCell('r1', 'r')
      await makeCell('py2', 'python')

      const py1 = service.runCell({ sessionId: 's', workspaceCwd: root, cellId: 'py1' })
      const r1 = service.runCell({ sessionId: 's', workspaceCwd: root, cellId: 'r1' })
      const py2 = service.runCell({ sessionId: 's', workspaceCwd: root, cellId: 'py2' })

      // python and r are independent processes → both enter the executor at once; the second python
      // queues behind the first, so exactly two runs (one python, one r) are in flight.
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(releases).toHaveLength(2)
      expect(maxConcurrent).toBe(2)
      expect(releases.map((entry) => entry.language).sort()).toEqual(['python', 'r'])

      // Drain the first python; the queued second python now takes the freed python slot (still only
      // two concurrent, never three).
      drain(releases.find((entry) => entry.language === 'python')!)
      await vi.waitFor(() => expect(releases).toHaveLength(3))
      expect(maxConcurrent).toBe(2)

      releases.forEach((entry) => entry.release())
      await Promise.all([py1, r1, py2])
    })

    it('blocks a package install on the same language until an in-flight run finishes (G2)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseRun: (() => void) | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn().mockResolvedValue({
            fingerprint: 'stable',
            inventoryRefreshed: false,
            warnings: []
          }),
          captureCompletedRun: vi.fn().mockRejectedValue(new Error('not under test')),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue(undefined)
        },
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push('run:start')
            await new Promise<void>((resolve) => {
              releaseRun = resolve
            })
            events.push('run:end')
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:run')
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      const run = service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      await vi.waitFor(() => expect(releaseRun).toBeDefined())

      const install = service.managePackages({ language: 'python', packages: ['numpy'] })
      // The install (exclusive writer) must not start while the run holds the python env read lock.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(events).toEqual(['run:start'])

      releaseRun?.()
      await Promise.all([run, install])
      expect(events).toEqual(['run:start', 'run:end', 'install:run'])
    })

    it('blocks a run on the same language until an in-flight install finishes (G2)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseInstall: (() => void) | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn().mockResolvedValue({
            fingerprint: 'stable',
            inventoryRefreshed: false,
            warnings: []
          }),
          captureCompletedRun: vi.fn().mockRejectedValue(new Error('not under test')),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue(undefined)
        },
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push('run:run')
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:start')
          await new Promise<void>((resolve) => {
            releaseInstall = resolve
          })
          events.push('install:end')
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      const install = service.managePackages({ language: 'python', packages: ['numpy'] })
      await vi.waitFor(() => expect(releaseInstall).toBeDefined())

      const run = service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      // The run (reader) must wait out the install (exclusive writer) on the same env.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(events).toEqual(['install:start'])

      releaseInstall?.()
      await Promise.all([install, run])
      expect(events).toEqual(['install:start', 'install:end', 'run:run'])
    })

    it('rechecks a stale repair rejection after a queued run acquires the repaired environment', async () => {
      const root = await createStorageRoot()
      const repairedPython: DiscoveredInterpreter = {
        language: 'python',
        provenance: 'app-managed',
        envId: pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV)),
        interpreterPath: pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV)),
        label: DEFAULT_PY_ENV,
        version: '3.12.0',
        runnable: true,
        condaEnv: DEFAULT_PY_ENV
      }
      const firstStarted = createDeferred<void>()
      const releaseFirst = createDeferred<void>()
      const executions: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        discoverRuntimes: async (language) => (language === 'python' ? [repairedPython] : []),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            executions.push(request.code)
            if (request.code === 'hold_environment()') {
              firstStarted.resolve()
              await releaseFirst.promise
            }
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })

      const first = service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'hold_environment()'
      })
      await firstStarted.promise

      addRepairRequired(getRuntimeRoot(root), DEFAULT_PY_ENV, 'protected-identity-change')
      const repair = service.withEnvLock(DEFAULT_PY_ENV, async () => {
        await service.completeRuntimeRepair('python')
      })
      const queued = service.execute({
        sessionId: 'session-2',
        workspaceCwd: root,
        code: 'run_after_repair()'
      })
      await vi.waitFor(async () => {
        const state = await service.state({ sessionId: 'session-2', workspaceCwd: root })
        expect(state.cells[0]?.status).toBe('running')
      })
      expect(executions).toEqual(['hold_environment()'])

      releaseFirst.resolve()
      await repair
      expect(isRepairRequired(getRuntimeRoot(root), DEFAULT_PY_ENV)).toBe(false)
      const queuedResult = await queued
      expect(queuedResult.text.traceback).not.toContain('RUNTIME_REPAIR_REQUIRED')
      expect(queuedResult).toMatchObject({ status: 'completed' })
      expect(executions).toEqual(['hold_environment()', 'run_after_repair()'])
      await first
    })

    it('does not clear a stale repair rejection after the queued Session changes runtime binding', async () => {
      const root = await createStorageRoot()
      const firstStarted = createDeferred<void>()
      const releaseFirst = createDeferred<void>()
      const executions: NotebookExecutionRequest[] = []
      const externalRuntime: DiscoveredInterpreter = {
        language: 'python',
        provenance: 'user-own',
        envId: '/opt/external-python/bin/python',
        interpreterPath: '/opt/external-python/bin/python',
        label: 'External Python',
        version: '3.13.2',
        runnable: true
      }
      const repairedPython: DiscoveredInterpreter = {
        language: 'python',
        provenance: 'app-managed',
        envId: pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV)),
        interpreterPath: pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV)),
        label: DEFAULT_PY_ENV,
        version: '3.12.0',
        runnable: true,
        condaEnv: DEFAULT_PY_ENV
      }
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        discoverRuntimes: async (language) =>
          language === 'python' ? [repairedPython, externalRuntime] : [],
        notebookRuntimeSettings: {
          getSnapshot: async (language) => ({
            language,
            runtimeEnablement: {
              enabled: { [externalRuntime.envId]: true },
              installAuthorized: {}
            },
            manualInterpreters: [],
            packageMirror: {}
          })
        },
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            executions.push(request)
            if (request.code === 'hold_environment()') {
              firstStarted.resolve()
              await releaseFirst.promise
            }
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })

      const first = service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'hold_environment()'
      })
      await firstStarted.promise

      addRepairRequired(getRuntimeRoot(root), DEFAULT_PY_ENV, 'protected-identity-change')
      const repair = service.withEnvLock(DEFAULT_PY_ENV, async () => {
        await service.completeRuntimeRepair('python')
      })
      const queued = service.execute({
        sessionId: 'session-2',
        workspaceCwd: root,
        code: 'must_not_run_with_stale_binding()'
      })
      await vi.waitFor(async () => {
        const state = await service.state({ sessionId: 'session-2', workspaceCwd: root })
        expect(state.cells[0]?.status).toBe('running')
      })

      await service.bindRuntime({
        sessionId: 'session-2',
        workspaceCwd: root,
        language: 'python',
        runtimeId: externalRuntime.envId
      })
      releaseFirst.resolve()
      await repair

      const queuedResult = await queued
      expect(queuedResult).toMatchObject({
        status: 'failed',
        text: { traceback: expect.stringContaining('RUNTIME_BINDING_CHANGED') }
      })
      expect(executions.map((request) => request.code)).toEqual(['hold_environment()'])
      await first
    })

    it('does not block a different-language run behind an install (G2)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseInstall: (() => void) | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: verifiedPackageMutationTracker(),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push(`run:${request.language}`)
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:python:start')
          await new Promise<void>((resolve) => {
            releaseInstall = resolve
          })
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      const install = service.managePackages({ language: 'python', packages: ['numpy'] })
      await vi.waitFor(() => expect(releaseInstall).toBeDefined())

      // An r run proceeds to completion even while a python install holds the python env lock — the
      // lock is keyed per language, so it only blocks the target env's queue.
      const rRun = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'r'
      })
      expect(rRun.status).toBe('completed')
      expect(events).toContain('run:r')

      releaseInstall?.()
      await install
    })

    it('serializes environment mutations that target the same environment', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root)
      })
      const events: string[] = []
      let releaseFirst: (() => void) | undefined

      const first = service.withEnvLock('analysis', async () => {
        events.push('first:start')
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        events.push('first:end')
      })
      await vi.waitFor(() => expect(releaseFirst).toBeDefined())

      const second = service.withEnvLock('analysis', async () => {
        events.push('second:start')
      })
      await Promise.resolve()
      expect(events).toEqual(['first:start'])

      releaseFirst?.()
      await Promise.all([first, second])
      expect(events).toEqual(['first:start', 'first:end', 'second:start'])
    })

    it('releases environment mutation admission after a failed operation', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root)
      })

      await expect(
        service.withEnvLock('analysis', async () => {
          throw new Error('mutation failed')
        })
      ).rejects.toThrow('mutation failed')

      await expect(
        service.withEnvLock('analysis', async () => 'next mutation admitted')
      ).resolves.toBe('next mutation admitted')
    })

    it('allows environment mutations for different environments to proceed concurrently', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root)
      })
      const events: string[] = []
      let releaseFirst: (() => void) | undefined

      const first = service.withEnvLock('analysis-a', async () => {
        events.push('first:start')
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        events.push('first:end')
      })
      await vi.waitFor(() => expect(releaseFirst).toBeDefined())

      await service.withEnvLock('analysis-b', async () => {
        events.push('second:start')
      })
      expect(events).toEqual(['first:start', 'second:start'])

      releaseFirst?.()
      await first
      expect(events).toEqual(['first:start', 'second:start', 'first:end'])
    })

    it('leaves a terminated kernel status after a run whose kernel rejected (G3)', async () => {
      const root = await createStorageRoot()
      let lifecycle!: NotebookExecutorLifecycleCallbacks
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: (_sessionId, callbacks) => ({
          execute: async (): Promise<NotebookExecutionResult> => {
            lifecycle = callbacks
            // Simulate the executor's onTerminated firing mid-run (crash), then the run rejecting so
            // the runtime service's executor-rejection path sets executedOnLiveKernel false.
            await lifecycle.onTerminated('python', DEFAULT_PY_ENV)
            throw new Error('Notebook kernel process exited.')
          },
          shutdown: async () => ({ reaped: true })
        })
      })

      const summary = await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(summary.status).toBe('failed')

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.kernelStatus).toBe('terminated')
    })

    it('does not overwrite a mid-run termination with idle when the executor resolves (G3)', async () => {
      const root = await createStorageRoot()
      let lifecycle!: NotebookExecutorLifecycleCallbacks
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: (_sessionId, callbacks) => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            lifecycle = callbacks
            // The real executor catches a crash internally and RESOLVES a failed result while its
            // onTerminated callback fires — the terminatedKernels guard must still keep 'terminated'.
            await lifecycle.onTerminated('python', DEFAULT_PY_ENV)
            return {
              status: 'failed',
              stdout: '',
              stderr: 'boom',
              traceback: 'boom',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })

      await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })

      const state = await service.state({ sessionId: 'session-1', workspaceCwd: root })
      expect(state.kernelStatus).toBe('terminated')
    })

    it('clears a crash terminated status once a clean run of that kind completes (G3)', async () => {
      const root = await createStorageRoot()
      let mode: 'crash' | 'ok' = 'crash'
      let lifecycle!: NotebookExecutorLifecycleCallbacks
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: (_sessionId, callbacks) => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            lifecycle = callbacks
            if (mode === 'crash') {
              await lifecycle.onTerminated('python', DEFAULT_PY_ENV)
              return {
                status: 'failed',
                stdout: '',
                stderr: 'boom',
                traceback: 'boom',
                cwdAfter: request.cwd,
                outputs: []
              }
            }
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })

      await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(
        (await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus
      ).toBe('terminated')

      // The next clean run of the same kind clears the flag at run start and settles back to 'idle'.
      mode = 'ok'
      await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: '2',
        language: 'python'
      })
      expect(
        (await service.state({ sessionId: 'session-1', workspaceCwd: root })).kernelStatus
      ).toBe('idle')
    })
  })

  it('restart falls back to shutdown+recreate when the executor has no restart()', async () => {
    const root = await createStorageRoot()
    let shutdowns = 0
    let factoryCalls = 0
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => {
        factoryCalls += 1
        return {
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => {
            shutdowns += 1
            return { reaped: true }
          }
        }
      }
    })

    await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    expect(factoryCalls).toBe(1)

    await service.restart({ sessionId: 'session-1', workspaceCwd: root })

    expect(shutdowns).toBe(1)
    expect(factoryCalls).toBe(2)
  })

  it('surfaces (without throwing) when the session cwd has disappeared before a run', async () => {
    const root = await createStorageRoot()
    // A cell can os.chdir() to a directory outside the repository-managed session tree (whose
    // sub-directories are recreated on every write); simulate that, then delete it.
    const changedCwd = await mkdtemp(join(tmpdir(), 'open-science-notebook-chdir-'))
    const error = vi.fn()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      logger: { info: vi.fn(), warn: vi.fn(), error },
      executorFactory: () => ({
        execute: async (): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: changedCwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })

    // First run establishes the session and leaves it chdir'd into a real (temp) directory.
    const first = await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '1' })
    expect(first.status).toBe('completed')

    // The directory the interpreter last chdir'd into is now gone.
    await rm(changedCwd, { recursive: true, force: true })

    const second = await service.execute({ sessionId: 'session-1', workspaceCwd: root, code: '2' })

    expect(second.status).toBe('completed')
    expect(error).toHaveBeenCalledWith('session working directory is missing before execution', {
      sessionId: 'session-1'
    })
  })

  describe('inspectPackages', () => {
    it('reads package metadata from the session-bound runtime without invoking the installer', async () => {
      const root = await createStorageRoot()
      const runtimeRoot = getRuntimeRoot(root)
      const interpreter = pythonBin(envPrefix(runtimeRoot, DEFAULT_PY_ENV))
      await mkdir(dirname(interpreter), { recursive: true })
      await writeFile(interpreter, '', 'utf8')
      writeReadyMarker(runtimeRoot, DEFAULT_ENV_VERSION, 'ready')
      const inspectPackages = vi.fn().mockResolvedValue({
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
      const installPackagesImpl = vi.fn()
      const provisionPython = vi.fn(async () => undefined)
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages,
          markPackageMutationDirty: vi.fn(),
          refreshAfterPackageMutation: vi.fn()
        },
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl
      })
      service.setDefaultEnvProvisioner({
        provisionPython,
        provisionR: vi.fn(async () => undefined)
      })

      const result = await service.inspectPackages({
        language: 'python',
        packages: ['numpy'],
        projectId: 'default-project',
        sessionId: 'session-1',
        workspaceCwd: root
      })

      expect(result).toMatchObject({
        language: 'python',
        environmentName: 'default-python',
        runtimeSource: 'managed',
        packages: [{ name: 'numpy', status: 'installed', version: '2.2.0' }]
      })
      expect(inspectPackages).toHaveBeenCalledWith(
        expect.objectContaining({
          language: 'python',
          environmentName: 'default-python',
          runtimeSource: 'managed'
        }),
        ['numpy']
      )
      expect(provisionPython).not.toHaveBeenCalled()
      expect(installPackagesImpl).not.toHaveBeenCalled()
    })

    it('refuses to provision a missing default runtime under read-only inspection permission', async () => {
      const root = await createStorageRoot()
      const inspectPackages = vi.fn()
      const provisionPython = vi.fn(async () => undefined)
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages,
          markPackageMutationDirty: vi.fn(),
          refreshAfterPackageMutation: vi.fn()
        },
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        })
      })
      service.setDefaultEnvProvisioner({
        provisionPython,
        provisionR: vi.fn(async () => undefined)
      })

      await expect(
        service.inspectPackages({
          language: 'python',
          packages: ['numpy'],
          projectId: 'default-project',
          sessionId: 'session-1',
          workspaceCwd: root
        })
      ).rejects.toThrow(/DEFAULT_RUNTIME_NOT_READY.*notebook_execute/)
      expect(provisionPython).not.toHaveBeenCalled()
      expect(inspectPackages).not.toHaveBeenCalled()
    })

    it('refuses package inspection for an external runtime so interpreter execution uses notebook approval', async () => {
      const root = await createStorageRoot()
      const runtimeId = '/opt/external-python/bin/python'
      const inspectPackages = vi.fn().mockResolvedValue({
        inventory: { source: 'full-scan', validation: 'full-scan' },
        packages: []
      })
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        discoverRuntimes: async (language) =>
          language === 'python'
            ? [
                {
                  language: 'python',
                  provenance: 'user-own',
                  envId: runtimeId,
                  interpreterPath: runtimeId,
                  label: 'External Python',
                  version: '3.13.2',
                  runnable: true
                }
              ]
            : [],
        notebookRuntimeSettings: {
          getSnapshot: async (language) => ({
            language,
            runtimeEnablement: {
              enabled: { [runtimeId]: true },
              installAuthorized: {}
            },
            manualInterpreters: [],
            packageMirror: {}
          })
        },
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages,
          markPackageMutationDirty: vi.fn(),
          refreshAfterPackageMutation: vi.fn()
        },
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        })
      })
      await service.bindRuntime({
        sessionId: 'session-1',
        workspaceCwd: root,
        language: 'python',
        runtimeId
      })

      await expect(
        service.inspectPackages({
          language: 'python',
          packages: ['numpy'],
          projectId: 'default-project',
          sessionId: 'session-1',
          workspaceCwd: root
        })
      ).rejects.toThrow(/EXTERNAL_RUNTIME_INSPECTION_REQUIRES_EXECUTION.*notebook_execute/)
      expect(inspectPackages).not.toHaveBeenCalled()
    })
  })

  describe('managePackages', () => {
    it('returns verified requested package changes alongside related inventory changes', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue({
            result: 'success',
            packageChanges: [
              {
                name: 'numpy',
                ecosystem: 'python',
                relationship: 'requested',
                change: 'updated',
                beforeVersion: '2.1.0',
                afterVersion: '2.2.0'
              },
              {
                name: 'packaging',
                ecosystem: 'python',
                relationship: 'unattributed',
                change: 'updated',
                beforeVersion: '24.0',
                afterVersion: '25.0'
              }
            ]
          })
        },
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: vi.fn().mockResolvedValue({
          ok: true,
          needsRestart: false,
          log: 'installer succeeded',
          method: 'conda'
        })
      })

      const result = await service.managePackages({ language: 'python', packages: ['numpy'] })

      expect(result.packageChanges).toEqual([
        expect.objectContaining({
          name: 'numpy',
          relationship: 'requested',
          change: 'updated',
          beforeVersion: '2.1.0',
          afterVersion: '2.2.0'
        }),
        expect.objectContaining({
          name: 'packaging',
          relationship: 'unattributed',
          change: 'updated',
          beforeVersion: '24.0',
          afterVersion: '25.0'
        })
      ])
      expect(result.target).toMatchObject({
        language: 'python',
        selection: 'implicit-default',
        runtimeSource: 'managed',
        environmentName: DEFAULT_PY_ENV,
        runtimeId: expect.any(String),
        label: DEFAULT_PY_ENV
      })
      expect(result.environmentName).toBe('default-python')
    })

    it('quarantines and stops an R runtime after a protected r-base identity violation', async () => {
      const root = await createStorageRoot()
      const execute = vi.fn(async (): Promise<NotebookExecutionResult> => {
        throw new Error('a quarantined kernel must not execute')
      })
      const terminate = vi.fn(async () => undefined)
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'failure' })
        },
        executorFactory: () => ({
          execute,
          terminate,
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: vi.fn().mockResolvedValue({
          ok: false,
          needsRestart: false,
          log: 'r-base build changed',
          method: 'conda',
          repairRequired: true,
          error: 'Protected r-base changed unexpectedly. Run Repair.'
        })
      })

      await service.state({ sessionId: 'session-1', workspaceCwd: root })
      const result = await service.managePackages({
        sessionId: 'session-1',
        workspaceCwd: root,
        language: 'r',
        packages: ['dplyr']
      })

      // Quarantine runs while manage_packages still holds the environment install lock.
      expect(isRepairRequired(getRuntimeRoot(root), DEFAULT_R_ENV)).toBe(true)
      expect(terminate).toHaveBeenCalledWith('r', DEFAULT_R_ENV)

      const run = await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        code: 'R.version.string',
        language: 'r'
      })
      expect(run.status).toBe('failed')
      expect(run.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)
      expect(execute).not.toHaveBeenCalled()
      expect(result.repairRequired).toBe(true)
    })

    it('keeps the in-process repair gate when the protected-identity journal update fails', async () => {
      const root = await createStorageRoot()
      const execute = vi.fn(async (): Promise<NotebookExecutionResult> => {
        throw new Error('a repair-blocked kernel must not execute')
      })
      const terminate = vi.fn(async () => undefined)
      const update = vi
        .spyOn(RuntimeOperationJournal.prototype, 'update')
        .mockRejectedValueOnce(new Error('journal update denied'))
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: verifiedPackageMutationTracker(),
        executorFactory: () => ({
          execute,
          terminate,
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: vi.fn().mockResolvedValue({
          ok: false,
          needsRestart: false,
          log: 'r-base changed',
          repairRequired: true,
          error: 'Protected r-base changed unexpectedly. Run Repair.'
        })
      })

      try {
        await service.state({ sessionId: 'session-1', workspaceCwd: root })
        const failure = await service.managePackages({
          sessionId: 'session-1',
          workspaceCwd: root,
          language: 'r',
          packages: ['dplyr']
        })
        expectBoundedPackageFailure(
          failure,
          expectedManagedTarget(getRuntimeRoot(root), 'r', DEFAULT_R_ENV),
          /journal update denied/
        )

        const run = await service.execute({
          sessionId: 'session-1',
          workspaceCwd: root,
          code: 'R.version.string',
          language: 'r'
        })
        expect(run.status).toBe('failed')
        expect(run.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)
        expect(terminate).toHaveBeenCalledWith('r', DEFAULT_R_ENV)
        expect(execute).not.toHaveBeenCalled()
      } finally {
        update.mockRestore()
      }
    })

    it('retains recovery evidence and blocks execution when the repair registry is unwritable', async () => {
      const root = await createStorageRoot()
      const runtimeRoot = getRuntimeRoot(root)
      const execute = vi.fn(async (): Promise<NotebookExecutionResult> => {
        throw new Error('a repair-blocked kernel must not execute')
      })
      const terminate = vi.fn(async () => undefined)
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'failure' })
        },
        executorFactory: () => ({
          execute,
          terminate,
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: vi.fn().mockImplementation(async () => {
          // The pre-install gate must see a healthy, missing registry. Make the target unwritable only
          // after the simulated installer reports an identity change, so this test reaches quarantine.
          await mkdir(repairRegistryPath(runtimeRoot), { recursive: true })
          return {
            ok: false,
            needsRestart: false,
            log: 'r-base changed',
            repairRequired: true,
            error: 'Protected r-base changed unexpectedly. Run Repair.'
          }
        })
      })

      await service.state({ sessionId: 'session-1', workspaceCwd: root })
      const failure = await service.managePackages({
        sessionId: 'session-1',
        workspaceCwd: root,
        language: 'r',
        packages: ['dplyr']
      })
      expectBoundedPackageFailure(
        failure,
        expectedManagedTarget(runtimeRoot, 'r', DEFAULT_R_ENV),
        /REPAIR_QUARANTINE_FAILED/
      )

      expect(terminate).toHaveBeenCalledWith('r', DEFAULT_R_ENV)
      expect(
        await RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot)).pending()
      ).toHaveLength(1)
      const run = await service.execute({
        sessionId: 'session-1',
        workspaceCwd: root,
        language: 'r',
        code: 'R.version.string'
      })
      expect(run.status).toBe('failed')
      expect(run.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)
      expect(execute).not.toHaveBeenCalled()

      // The registry failure is transient, but the retained journal is the only durable evidence that
      // this was a protected identity change. Recovery must replay the stronger reason rather than
      // downgrading it to an interrupted install that an ordinary package install could clear.
      await rm(repairRegistryPath(runtimeRoot), { recursive: true, force: true })
      const restartedInstall = vi
        .fn()
        .mockResolvedValue({ ok: true, needsRestart: false, log: 'ordinary install' })
      const restarted = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: verifiedPackageMutationTracker(),
        executorFactory: () => ({
          execute,
          terminate,
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: restartedInstall
      })

      await restarted.recoverInterruptedOperations()
      expect(isProtectedIdentityRepairRequired(runtimeRoot, DEFAULT_R_ENV)).toBe(true)
      const retry = await restarted.managePackages({ language: 'r', packages: ['ggplot2'] })
      expect(retry.ok).toBe(false)
      expect(retry.repairRequired).toBe(true)
      expect(restartedInstall).not.toHaveBeenCalled()
    })

    it('blocks both language bindings that share a managed prefix when quarantine persistence fails', async () => {
      const root = await createStorageRoot()
      const runtimeRoot = getRuntimeRoot(root)
      const envName = 'shared-analysis'
      const prefix = envPrefix(runtimeRoot, envName)
      const namedPython = pythonBin(prefix)
      const namedR = rBin(prefix)
      const terminate = vi.fn(async () => undefined)
      const execute = vi.fn(async (): Promise<NotebookExecutionResult> => {
        throw new Error('a repair-blocked shared prefix must not execute')
      })
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: verifiedPackageMutationTracker(),
        discoverRuntimes: async (language) => [
          {
            language,
            provenance: 'agent-created',
            envId: language === 'python' ? namedPython : namedR,
            interpreterPath: language === 'python' ? namedPython : namedR,
            label: envName,
            condaEnv: envName,
            version: language === 'python' ? '3.12' : '4.4.3',
            runnable: true
          }
        ],
        executorFactory: () => ({
          execute,
          terminate,
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: vi.fn().mockImplementation(async () => {
          await mkdir(repairRegistryPath(runtimeRoot), { recursive: true })
          return {
            ok: false,
            needsRestart: false,
            log: 'r-base changed',
            repairRequired: true,
            error: 'Protected r-base changed unexpectedly. Run Repair.'
          }
        })
      })

      await service.bindRuntime({
        sessionId: 'shared',
        workspaceCwd: root,
        language: 'python',
        runtimeId: namedPython
      })
      await service.bindRuntime({
        sessionId: 'shared',
        workspaceCwd: root,
        language: 'r',
        runtimeId: namedR
      })
      const failure = await service.managePackages({
        sessionId: 'shared',
        workspaceCwd: root,
        language: 'r',
        packages: ['dplyr']
      })
      expectBoundedPackageFailure(
        failure,
        expectedManagedTarget(runtimeRoot, 'r', envName, 'explicit-binding'),
        /REPAIR_QUARANTINE_FAILED/
      )

      expect(terminate).toHaveBeenCalledWith('r', envName)
      expect(terminate).toHaveBeenCalledWith('python', envName)
      const run = await service.execute({
        sessionId: 'shared',
        workspaceCwd: root,
        language: 'python',
        code: '1'
      })
      expect(run.status).toBe('failed')
      expect(run.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)
      expect(execute).not.toHaveBeenCalled()
    })

    it('does not start an installer when the durable Environment dirty marker cannot be written', async () => {
      const root = await createStorageRoot()
      const installPackagesImpl = vi.fn().mockResolvedValue({
        ok: true,
        needsRestart: false,
        log: 'unexpected install'
      })
      const dirtyFailure = new Error('environment binding is unwritable')
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockRejectedValue(dirtyFailure),
          refreshAfterPackageMutation: vi.fn()
        },
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl
      })

      const failure = await service.managePackages({
        language: 'python',
        packages: ['numpy'],
        usePip: true
      })
      expectBoundedPackageFailure(
        failure,
        expectedManagedTarget(getRuntimeRoot(root), 'python', DEFAULT_PY_ENV),
        /environment binding is unwritable/
      )
      expect(installPackagesImpl).not.toHaveBeenCalled()
    })

    it('reports failure when the refreshed inventory cannot verify an installed package', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue({
            result: 'failure',
            unsatisfiedPackages: ['dplyr']
          })
        },
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: vi.fn().mockResolvedValue({
          ok: true,
          needsRestart: true,
          log: 'micromamba transaction output',
          method: 'conda'
        })
      })

      const result = await service.managePackages({ language: 'r', packages: ['dplyr'] })

      expect(result).toMatchObject({
        ok: false,
        needsRestart: false,
        method: 'conda'
      })
      expect(result.error).toContain('dplyr')
      expect(result.error).toMatch(/could not be verified/i)
    })

    it('reports failure when the post-install inventory refresh throws', async () => {
      const root = await createStorageRoot()
      const info = vi.fn()
      const warn = vi.fn()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        logger: { info, warn, error: vi.fn() },
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockRejectedValue(new Error('scan failed'))
        },
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: vi.fn().mockResolvedValue({
          ok: true,
          needsRestart: true,
          log: 'installer succeeded',
          method: 'conda'
        })
      })

      const result = await service.managePackages({ language: 'python', packages: ['numpy'] })

      expect(result).toMatchObject({ ok: false, needsRestart: false, method: 'conda' })
      expect(result.error).toMatch(/inventory refresh failed/i)
      expect(info).not.toHaveBeenCalledWith('package installer completed', expect.anything())
      expect(warn).toHaveBeenCalledWith(
        'package installer completed',
        expect.objectContaining({
          ok: false,
          error: expect.stringMatching(/inventory refresh failed/i)
        })
      )
    })

    it('writes bounded redacted installer diagnostics to the main-process logger', async () => {
      const root = await createStorageRoot()
      const info = vi.fn()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        logger: { info, warn: vi.fn(), error: vi.fn() },
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
        },
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: vi.fn().mockResolvedValue({
          ok: true,
          needsRestart: true,
          method: 'conda',
          log:
            'FETCH https://user:password@example.test/channel?token=secret\n' +
            `${'x'.repeat(20_000)}\ntransaction-tail-marker`
        })
      })

      await service.managePackages({ language: 'r', packages: ['ggplot2'] })

      expect(info).toHaveBeenCalledWith(
        'package installer completed',
        expect.objectContaining({
          language: 'r',
          environmentName: 'default-r',
          packages: ['ggplot2'],
          method: 'conda',
          installerLog: expect.objectContaining({ truncated: true })
        })
      )
      const serialized = JSON.stringify(info.mock.calls)
      expect(serialized).not.toContain('password')
      expect(serialized).not.toContain('token=secret')
      expect(serialized).toContain('transaction-tail-marker')
    })

    it('resolves the effective mirror from the injected getPackageMirror + locale and forwards it as installPackages deps', async () => {
      const root = await createStorageRoot()
      const calls: Array<[InstallRequestForTest, Partial<InstallDepsForTest> | undefined]> = []
      const processSandbox = { wrap: vi.fn() }
      const scriptedResult: InstallResultForTest = { ok: true, needsRestart: false, log: 'done' }
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
        },
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        getPackageMirror: () => ({ pypiIndex: 'https://corp.example/simple' }),
        locale: 'zh-CN',
        processSandbox,
        installPackagesImpl: async (request, deps) => {
          calls.push([request, deps])
          return scriptedResult
        }
      })

      const request: InstallRequestForTest = {
        language: 'python',
        packages: ['numpy'],
        usePip: true
      }
      const result = await service.managePackages(request)

      expect(result).toMatchObject(scriptedResult)
      expect(result.target).toMatchObject({
        language: 'python',
        selection: 'implicit-default',
        runtimeSource: 'managed',
        environmentName: DEFAULT_PY_ENV
      })
      expect(result.environmentName).toBe('default-python')
      expect(calls).toHaveLength(1)
      // The service forwards the request with the install target PINNED to the binding-resolved env
      // (default-python here), so it is a copy of the original fields plus `environment`, not the same
      // object reference (the service pins the install target to the binding-resolved env).
      expect(calls[0][0]).toEqual({ ...request, environment: DEFAULT_PY_ENV })
      // The configured pypiIndex overrides the CN region default entirely (effectiveMirror semantics):
      // a configured field wins outright, so condaChannel/cranMirror stay unset rather than CN defaults.
      expect(calls[0][1]).toMatchObject({
        storageRoot: root,
        pypiIndex: 'https://corp.example/simple'
      })
      expect(calls[0][1]?.condaChannel).toBeUndefined()
      expect(calls[0][1]?.cranMirror).toBeUndefined()
      expect(calls[0][1]?.spawn).toBeTypeOf('function')
    })

    it('resolves the mirror before returning a package admission refusal', async () => {
      const root = await createStorageRoot()
      const probe = vi.fn(async () => {
        throw new Error('probe unreachable (test)')
      })
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        getPackageMirror: () => undefined,
        mirrorProbe: { probe }
      })

      resetAutoMirrorCache()
      const result = await service.managePackages({
        language: 'python',
        packages: ['numpy'],
        sessionId: 'unloaded-session'
      })

      expect(probe).toHaveBeenCalled()
      expect(result.error).toContain('RUNTIME_SESSION_UNAVAILABLE')
      expect(result.target).toEqual({ language: 'python', selection: 'unresolved' })
    })

    it('falls back to the region default mirror when nothing is configured', async () => {
      const root = await createStorageRoot()
      const calls: Array<Partial<InstallDepsForTest> | undefined> = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: verifiedPackageMutationTracker(),
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        getPackageMirror: () => undefined,
        locale: 'zh-CN',
        // Force the latency probe to find nothing reachable so the resolver takes the deterministic
        // locale fallback (zh-CN -> CN mirror) instead of racing real network from the CI runner,
        // where the public mirror wins and leaves condaChannel unset.
        mirrorProbe: {
          probe: async () => {
            throw new Error('probe unreachable (test)')
          }
        },
        installPackagesImpl: async (_request, deps) => {
          calls.push(deps)
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      // Clear any mirror cached by an earlier test so the injected probe actually runs.
      resetAutoMirrorCache()
      await service.managePackages({ language: 'r', packages: ['ggplot2'] })

      expect(calls[0]?.condaChannel).toMatch(/tuna|ustc|aliyun/i)
      expect(calls[0]?.cranMirror).toMatch(/tuna|ustc/i)
    })

    it('never spawns real installs when installPackagesImpl is injected (no getPackageMirror wired)', async () => {
      const root = await createStorageRoot()
      let called = false
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: verifiedPackageMutationTracker(),
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          called = true
          return { ok: false, needsRestart: false, log: '', error: 'boom' }
        }
      })

      const result = await service.managePackages({ language: 'python', packages: ['seaborn'] })

      expect(called).toBe(true)
      expect(result.error).toBe('boom')
    })
  })

  describe('default executor factory (D-B4)', () => {
    afterEach(() => {
      delete process.env.OPEN_SCIENCE_PYTHON_LOOP
      delete process.env.OPEN_SCIENCE_R_LOOP
      delete process.env.OPEN_SCIENCE_REPL_LOOP
    })

    it('returns only the three exec-loop script paths (de-pinned: no single pythonBin/rEnvPrefix)', async () => {
      await createStorageRoot()
      const options = resolveDefaultExecutorOptions()

      // The executor now derives each interpreter prefix per request (from request.runtimeRoot + the
      // resolved env name), so the default options no longer pin a single env's bin/prefix.
      expect(options.pythonBin).toBeUndefined()
      expect(options.rEnvPrefix).toBeUndefined()
      // Resolved against the real repo tree (not the temp storage root), so these should exist.
      expect(options.pythonLoopPath).toMatch(/python_loop\.py$/)
      expect(options.rLoopPath).toMatch(/r_loop\.R$/)
      expect(options.replLoopPath).toMatch(/repl_loop\.js$/)
      expect(existsSync(options.pythonLoopPath as string)).toBe(true)
      expect(existsSync(options.rLoopPath as string)).toBe(true)
      expect(existsSync(options.replLoopPath as string)).toBe(true)
    })

    it('honors OPEN_SCIENCE_PYTHON_LOOP / OPEN_SCIENCE_R_LOOP / OPEN_SCIENCE_REPL_LOOP overrides', () => {
      process.env.OPEN_SCIENCE_PYTHON_LOOP = '/tmp/custom-python-loop.py'
      process.env.OPEN_SCIENCE_R_LOOP = '/tmp/custom-r-loop.R'
      process.env.OPEN_SCIENCE_REPL_LOOP = '/tmp/custom-repl-loop.js'

      expect(resolveLoopScriptPaths()).toEqual({
        pythonLoopPath: '/tmp/custom-python-loop.py',
        rLoopPath: '/tmp/custom-r-loop.R',
        replLoopPath: '/tmp/custom-repl-loop.js'
      })
    })

    it('creates and shuts down a session through the default executor', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root)
      })

      const cell = await service.beginCodeCell({ sessionId: 'session-1', workspaceCwd: root })

      expect(cell).toMatchObject({ sessionId: 'session-1', status: 'receiving-code' })
      await expect(
        service.shutdown({ sessionId: 'session-1', workspaceCwd: root })
      ).resolves.toEqual({ sessionId: 'session-1', status: 'shutdown' })
    })
  })

  describe('named environments (D1/D4/D5/D2)', () => {
    const recordingService = (
      root: string,
      executions: NotebookExecutionRequest[]
    ): NotebookRuntimeService =>
      new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            executions.push(request)
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        })
      })

    it('auto-provisions a missing default env on demand, but not a named env or an existing default', async () => {
      const root = await createStorageRoot()
      const service = recordingService(root, [])
      const provisionR = vi.fn(async () => undefined)
      const provisionPython = vi.fn(async () => undefined)
      service.setDefaultEnvProvisioner({ provisionPython, provisionR })

      // default-r missing → an R run (unbound → managed default) triggers provisionR (build on demand).
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'r' })
      expect(provisionR).toHaveBeenCalledTimes(1)
      expect(provisionPython).not.toHaveBeenCalled()

      // An already-materialized default env is not re-provisioned.
      const rBinPath = rBin(envPrefix(join(root, 'runtime'), DEFAULT_R_ENV))
      await mkdir(join(rBinPath, '..'), { recursive: true })
      await writeFile(rBinPath, '')
      writeRReadyMarker(join(root, 'runtime'), DEFAULT_ENV_VERSION, 'now')
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '2', language: 'r' })
      expect(provisionR).toHaveBeenCalledTimes(1)
    })

    it('broadcasts lazy provisioning progress and records its root cause as a failed run', async () => {
      const root = await createStorageRoot()
      const executions: NotebookExecutionRequest[] = []
      const service = recordingService(root, executions)
      const progress: Array<{ phase: string; message: string; progress: number }> = []
      service.setDefaultEnvProvisioner(
        {
          provisionPython: async () => undefined,
          provisionR: async (onProgress) => {
            onProgress({ phase: 'fetch-r', message: 'Downloading R runtime', progress: 0.4 })
            throw new Error('checksum mismatch')
          }
        },
        (event) => progress.push(event)
      )

      const run = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'r'
      })

      expect(executions).toHaveLength(0)
      expect(run.status).toBe('failed')
      expect(run.text.traceback).toContain('Could not prepare default-r: checksum mismatch')
      expect(progress).toEqual([
        {
          phase: 'fetch-r',
          message: 'Downloading R runtime',
          progress: 0.4,
          scope: 'r',
          sessionId: 's'
        },
        {
          phase: 'error',
          message: 'Could not prepare default-r: checksum mismatch',
          progress: 0,
          scope: 'r',
          sessionId: 's',
          // Tagged so the Settings R card settles out of "preparing" on a first-use provision failure.
          language: 'r'
        }
      ])
    })

    it('threads the binding-resolved env to the executor and records it on the run', async () => {
      const root = await createStorageRoot()
      const executions: NotebookExecutionRequest[] = []
      const service = recordingService(root, executions)

      // Unbound python → the app-managed default env; v4 always threads the resolved env name to the
      // executor (not a per-call argument) and records it on the run for history/replay.
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

      expect(executions[0].environment).toBe('default-python')
      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(state.runs[0].environment).toBe('default-python')
    })

    it('blocks a run on the same bound env until an in-flight install into that env finishes (D5)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseInstall: (() => void) | undefined
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn().mockResolvedValue({
            fingerprint: 'stable',
            inventoryRefreshed: false,
            warnings: []
          }),
          captureCompletedRun: vi.fn().mockRejectedValue(new Error('not under test')),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue(undefined)
        },
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push('run:run')
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:start')
          await new Promise<void>((resolve) => {
            releaseInstall = resolve
          })
          events.push('install:end')
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      const install = service.managePackages({ language: 'python', packages: ['numpy'] })
      await vi.waitFor(() => expect(releaseInstall).toBeDefined())

      const run = service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      // The run (reader) waits out the install (writer) on the SAME (default) env.
      expect(events).toEqual(['install:start'])

      releaseInstall?.()
      await Promise.all([install, run])
      expect(events).toEqual(['install:start', 'install:end', 'run:run'])
    })

    it('rechecks the repair gate after a queued run acquires the environment lock', async () => {
      const root = await createStorageRoot()
      let releaseInstall: (() => void) | undefined
      const execute = vi.fn(async (request): Promise<NotebookExecutionResult> => ({
        status: 'completed',
        stdout: '',
        stderr: '',
        traceback: '',
        cwdAfter: request.cwd,
        outputs: []
      }))
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: verifiedPackageMutationTracker(),
        executorFactory: () => ({
          execute,
          terminate: async () => undefined,
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          await new Promise<void>((resolve) => {
            releaseInstall = resolve
          })
          return {
            ok: false,
            needsRestart: false,
            log: 'protected interpreter changed',
            repairRequired: true,
            error: 'Run Repair.'
          }
        }
      })

      const install = service.managePackages({ language: 'python', packages: ['numpy'] })
      await vi.waitFor(() => expect(releaseInstall).toBeDefined())
      const run = service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      await new Promise((resolve) => setTimeout(resolve, 20))

      releaseInstall?.()
      const [, completedRun] = await Promise.all([install, run])
      expect(completedRun.status).toBe('failed')
      expect(completedRun.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)
      expect(execute).not.toHaveBeenCalled()
    })

    it('does not block a run in a different env behind an install (D5)', async () => {
      const root = await createStorageRoot()
      const events: string[] = []
      let releaseInstall: (() => void) | undefined
      // v4: a session runs ONE env per language, so "different envs" now means different SESSIONS —
      // an installer session bound to a named env vs a runner session on the app-managed default.
      const namedPy = pythonBin(envPrefix(getRuntimeRoot(root), 'my-analysis'))
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: verifiedPackageMutationTracker(),
        // Surface the named agent-created env so the installer session can bind it.
        discoverRuntimes: async (language) =>
          language === 'python'
            ? [
                {
                  language: 'python',
                  provenance: 'agent-created',
                  envId: namedPy,
                  interpreterPath: namedPy,
                  label: 'my-analysis',
                  condaEnv: 'my-analysis',
                  version: '3.12',
                  runnable: true
                }
              ]
            : [],
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => {
            events.push(`run:${request.environment ?? 'default'}`)
            return {
              status: 'completed',
              stdout: '',
              stderr: '',
              traceback: '',
              cwdAfter: request.cwd,
              outputs: []
            }
          },
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => {
          events.push('install:my-analysis:start')
          await new Promise<void>((resolve) => {
            releaseInstall = resolve
          })
          return { ok: true, needsRestart: false, log: '' }
        }
      })

      // Installer session bound to the named env -> its install holds the 'my-analysis' env lock.
      await service.bindRuntime({
        sessionId: 'installer',
        workspaceCwd: root,
        language: 'python',
        runtimeId: namedPy
      })
      const install = service.managePackages({
        sessionId: 'installer',
        language: 'python',
        packages: ['numpy']
      })
      await vi.waitFor(() => expect(releaseInstall).toBeDefined())

      // A run in a DIFFERENT session on the DEFAULT python env proceeds while the my-analysis install
      // holds only its own env lock — the lock is keyed by resolved env name, not language.
      const run = await service.execute({
        sessionId: 'runner',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(run.status).toBe('completed')
      expect(events).toContain('run:default-python')

      releaseInstall?.()
      await install
    })

    it('manageEnvironments create/list/remove delegates to the injected environment manager', async () => {
      const root = await createStorageRoot()
      const envs: EnvironmentInfo[] = [
        { name: 'default-python', language: 'python', ready: true, isDefault: true }
      ]
      const created: Array<{ name: string; language: string; packages?: string[] }> = []
      const removed: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentManager: {
          createNamedEnvironment: async (name, language, packages) => {
            created.push({ name, language, packages })
            const info: EnvironmentInfo = { name, language, ready: true, isDefault: false }
            envs.push(info)
            return info
          },
          listEnvironments: () => [...envs],
          removeEnvironment: (name) => {
            removed.push(name)
            return envs.filter((env) => env.name !== name)
          }
        }
      })

      const createResult = await service.manageEnvironments({
        action: 'create',
        language: 'python',
        name: 'my-analysis',
        packages: ['numpy']
      })
      expect(created).toEqual([{ name: 'my-analysis', language: 'python', packages: ['numpy'] }])
      expect(createResult).not.toHaveProperty('environments')

      const listResult = await service.manageEnvironments({ action: 'list' })
      expect(listResult).toEqual({
        environments: [
          { name: 'default-python', language: 'python', ready: true, isDefault: true },
          { name: 'my-analysis', language: 'python', ready: true, isDefault: false }
        ]
      })

      const removeResult = await service.manageEnvironments({
        action: 'remove',
        name: 'my-analysis'
      })
      expect(removed).toEqual(['my-analysis'])
      expect(removeResult).toEqual({ removed: { name: 'my-analysis' } })
      expect(removeResult).not.toHaveProperty('environments')
    })

    it('named-env create awaits crash recovery before writing a prefix (barrier)', async () => {
      // create writes into <root>/envs, so it must wait for startup recovery to finish reconciling —
      // otherwise recovery's cleanup/verify could race the fresh create. Seed an interrupted op so
      // recovery has real async work, kick it off, then create WITHOUT awaiting recovery and assert the
      // create only runs after recovery settled.
      const root = await createStorageRoot()
      const runtimeRoot = join(root, 'runtime')
      const staging = join(runtimeRoot, 'packs', '.incoming-crashed')
      await mkdir(staging, { recursive: true })
      const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
      await journal.begin({
        operationId: 'd',
        kind: 'download',
        runtimeId: 'python-3.12',
        phase: 'fetch',
        startedAt: 100,
        targetPath: staging
      })

      let recoveryDone = false
      const order: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentManager: {
          createNamedEnvironment: async (name, language) => {
            // The observable check: recovery MUST have settled before create touches the prefix.
            order.push(recoveryDone ? 'create-after-recovery' : 'create-before-recovery')
            return { name, language, ready: true, isDefault: false }
          },
          listEnvironments: () => [],
          removeEnvironment: () => []
        }
      })

      // Kick off recovery (do NOT await) and mark when it settles, then immediately create.
      const recovery = service.recoverInterruptedOperations().then(() => {
        recoveryDone = true
        order.push('recovery-done')
      })
      await service.manageEnvironments({
        action: 'create',
        language: 'python',
        name: 'my-analysis'
      })
      await recovery

      expect(order).toEqual(['recovery-done', 'create-after-recovery'])
    })

    it('named-env remove awaits crash recovery before rm -rf a prefix (barrier)', async () => {
      // remove rm -rf's a prefix, so — like create — it must wait for recovery to finish reconciling, or
      // recovery's verify/rebuild could race the delete. Seed an interrupted op for real async recovery
      // work, kick recovery off, remove WITHOUT awaiting it, and assert the delete ran only after
      // recovery settled.
      const root = await createStorageRoot()
      const runtimeRoot = join(root, 'runtime')
      const staging = join(runtimeRoot, 'packs', '.incoming-crashed')
      await mkdir(staging, { recursive: true })
      const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
      await journal.begin({
        operationId: 'd',
        kind: 'download',
        runtimeId: 'python-3.12',
        phase: 'fetch',
        startedAt: 100,
        targetPath: staging
      })

      let recoveryDone = false
      const order: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentManager: {
          createNamedEnvironment: async (name, language) => ({
            name,
            language,
            ready: true,
            isDefault: false
          }),
          listEnvironments: () => [],
          removeEnvironment: () => {
            order.push(recoveryDone ? 'remove-after-recovery' : 'remove-before-recovery')
            return []
          }
        }
      })

      const recovery = service.recoverInterruptedOperations().then(() => {
        recoveryDone = true
        order.push('recovery-done')
      })
      // 'my-analysis' is agent-created provenance, so it passes the remove guard.
      await service.manageEnvironments({ action: 'remove', name: 'my-analysis' })
      await recovery

      expect(order).toEqual(['recovery-done', 'remove-after-recovery'])
    })

    it('refuses to remove an environment that is in use by a live kernel', async () => {
      const root = await createStorageRoot()
      const removed: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        discoverRuntimes: async (language) =>
          language === 'python'
            ? [
                {
                  language: 'python',
                  provenance: 'agent-created',
                  envId: pythonBin(envPrefix(getRuntimeRoot(root), 'my-analysis')),
                  interpreterPath: pythonBin(envPrefix(getRuntimeRoot(root), 'my-analysis')),
                  label: 'my-analysis',
                  condaEnv: 'my-analysis',
                  version: '3.12',
                  runnable: true
                }
              ]
            : [],
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }),
        environmentManager: {
          createNamedEnvironment: async (name, language) => ({
            name,
            language,
            ready: true,
            isDefault: false
          }),
          listEnvironments: () => [],
          removeEnvironment: (name) => {
            removed.push(name)
            return []
          }
        }
      })

      // Bind the named env, then a completed run leaves the my-analysis python proc live (idle, not
      // terminated) — a run now targets the bound env, not a per-call environment argument.
      await service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: pythonBin(envPrefix(getRuntimeRoot(root), 'my-analysis'))
      })
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

      await expect(
        service.manageEnvironments({ action: 'remove', name: 'my-analysis' })
      ).rejects.toThrow(/in use by a running kernel/)
      expect(removed).toEqual([])

      // A different env with no live proc is removable.
      await service.manageEnvironments({ action: 'remove', name: 'other-env' })
      expect(removed).toEqual(['other-env'])
    })

    it('rejects hostile / reserved environment names before touching the manager (security)', async () => {
      const root = await createStorageRoot()
      const created: string[] = []
      const removed: string[] = []
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        executorFactory: () => ({
          execute: async () => {
            throw new Error('not used')
          },
          shutdown: async () => ({ reaped: true })
        }),
        environmentManager: {
          createNamedEnvironment: async (name, language) => {
            created.push(name)
            return { name, language, ready: true, isDefault: false }
          },
          listEnvironments: () => [],
          removeEnvironment: (name) => {
            removed.push(name)
            return []
          }
        }
      })

      // Path traversal must never reach removeEnvironment's rm -rf (the ship-blocking finding).
      await expect(
        service.manageEnvironments({ action: 'remove', name: '../../../../tmp/victim' })
      ).rejects.toThrow(/Invalid environment name/)
      // Reserved/default/alias names are refused on create so a created env is always reachable.
      for (const reserved of ['python', 'r', 'default-python', 'default-r']) {
        await expect(
          service.manageEnvironments({ action: 'create', language: 'python', name: reserved })
        ).rejects.toThrow(/reserved environment name/)
      }
      // create without a language is a clean domain error, not a raw crash.
      await expect(
        service.manageEnvironments({
          action: 'create',
          name: 'x'
        } as unknown as Parameters<typeof service.manageEnvironments>[0])
      ).rejects.toThrow(/requires a language/)

      expect(created).toEqual([])
      expect(removed).toEqual([])
    })

    it('surfaces the resolved per-env kernel status in state().environments', async () => {
      const root = await createStorageRoot()
      const executions: NotebookExecutionRequest[] = []
      const service = recordingService(root, executions)

      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(state.environments).toContainEqual({
        processKey: 'python:default-python',
        kind: 'python',
        environment: 'default-python',
        status: 'idle',
        restartRecommended: false
      })
    })

    it('flags restartRecommended on the R env after an R install and clears it on restart', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: {
          prepareRun: vi.fn(),
          captureCompletedRun: vi.fn(),
          inspectPackages: vi.fn(),
          markPackageMutationDirty: vi.fn().mockResolvedValue(undefined),
          refreshAfterPackageMutation: vi.fn().mockResolvedValue({ result: 'success' })
        },
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }),
        // An R install reports needsRestart; a Python install would not (asserted below).
        installPackagesImpl: async (request) => ({
          ok: true,
          needsRestart: request.language === 'r',
          log: 'done'
        })
      })

      // Spawn the R kernel status entry so the env view has something to flag.
      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'r' })

      const rEntry = (
        s: Awaited<ReturnType<typeof service.state>>
      ): NotebookEnvironmentStatus | undefined =>
        s.environments.find((entry) => entry.processKey === 'r:default-r')

      await service.managePackages({ language: 'r', packages: ['ggplot2'] })
      const afterInstall = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(rEntry(afterInstall)?.restartRecommended).toBe(true)

      await service.restart({ sessionId: 's', workspaceCwd: root })
      const afterRestart = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(rEntry(afterRestart)?.restartRecommended).toBe(false)
    })

    it('does not flag restartRecommended for a Python install', async () => {
      const root = await createStorageRoot()
      const service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'default-project',
        repository: new NotebookRunRepository(root),
        environmentStateTracker: verifiedPackageMutationTracker(),
        executorFactory: () => ({
          execute: async (request): Promise<NotebookExecutionResult> => ({
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }),
          shutdown: async () => ({ reaped: true })
        }),
        installPackagesImpl: async () => ({ ok: true, needsRestart: false, log: 'done' })
      })

      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })
      await service.managePackages({ language: 'python', packages: ['numpy'], usePip: true })
      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(
        state.environments.find((entry) => entry.processKey === 'python:default-python')
          ?.restartRecommended
      ).toBe(false)
    })
  })
})

describe('v4 runtime bindings & agent tools', () => {
  const managedPy: DiscoveredInterpreter = {
    language: 'python',
    provenance: 'app-managed',
    envId: '/root/runtime/envs/default-python/bin/python',
    interpreterPath: '/root/runtime/envs/default-python/bin/python',
    label: 'default-python',
    version: '3.12.0',
    runnable: true,
    condaEnv: DEFAULT_PY_ENV
  }
  const userPyA: DiscoveredInterpreter = {
    language: 'python',
    provenance: 'user-own',
    envId: '/usr/bin/python3',
    interpreterPath: '/usr/bin/python3',
    label: '/usr/bin/python3',
    version: '3.11.0',
    runnable: true
  }
  const userPyB: DiscoveredInterpreter = {
    language: 'python',
    provenance: 'user-own',
    envId: '/opt/py/bin/python3',
    interpreterPath: '/opt/py/bin/python3',
    label: '/opt/py/bin/python3',
    version: '3.10.0',
    runnable: true
  }
  const managedR: DiscoveredInterpreter = {
    language: 'r',
    provenance: 'app-managed',
    envId: '/root/runtime/envs/default-r/bin/R',
    interpreterPath: '/root/runtime/envs/default-r/bin/R',
    label: 'default-r',
    version: '4.3.1',
    runnable: true,
    condaEnv: DEFAULT_R_ENV
  }
  const userR: DiscoveredInterpreter = {
    language: 'r',
    provenance: 'user-own',
    envId: '/usr/local/bin/R',
    interpreterPath: '/usr/local/bin/R',
    label: '/usr/local/bin/R',
    version: '4.4.0',
    runnable: true
  }

  // Service with injected discovery + enablement + a recording executor, so the tools run without any
  // real interpreter and executions can be inspected for the resolved interpreter.
  const bindingService = (
    root: string,
    options: {
      discovered?: DiscoveredInterpreter[]
      enablement?: RuntimeEnablement
      executions?: NotebookExecutionRequest[]
      terminations?: string[]
      terminate?: (kind: 'python' | 'r' | 'repl', env: string) => Promise<void>
      platform?: NodeJS.Platform
      repository?: NotebookRunRepository
      discoverRuntimes?: (language: 'python' | 'r') => Promise<DiscoveredInterpreter[]>
      installPackagesImpl?: (
        request: InstallRequestForTest,
        deps?: Partial<InstallDepsForTest>
      ) => Promise<InstallResultForTest>
      packageChanges?: NotebookEnvironmentPackageChange[]
      environmentManager?: NotebookEnvironmentManager
    } = {}
  ): NotebookRuntimeService => {
    const enablement = options.enablement ?? { enabled: {}, installAuthorized: {} }
    return new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: options.repository ?? new NotebookRunRepository(root),
      discoverRuntimes:
        options.discoverRuntimes ??
        (async (language) =>
          (options.discovered ?? [managedPy, userPyA, userPyB]).filter(
            (env) => env.language === language
          )),
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: enablement,
          manualInterpreters: [],
          packageMirror: {}
        }),
        setEnvironmentEnabled: async (_language, envId, enabled) => {
          enablement.enabled[envId] = enabled
          return enablement
        }
      },
      platform: options.platform,
      environmentManager: options.environmentManager,
      installPackagesImpl: options.installPackagesImpl,
      // A fake installer must have a fake inventory refresh too. Mixing the fake installer with a
      // scan of the host's real /usr/bin/python3 makes these tests depend on runner packages.
      environmentStateTracker: options.installPackagesImpl
        ? {
            ...verifiedPackageMutationTracker(),
            refreshAfterPackageMutation: vi.fn().mockResolvedValue({
              result: 'success',
              ...(options.packageChanges ? { packageChanges: options.packageChanges } : {})
            })
          }
        : undefined,
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          options.executions?.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true }),
        terminate:
          options.terminate ??
          (async (kind, env) => {
            options.terminations?.push(`${kind}:${env}`)
          })
      })
    })
  }

  it('prepares a healthy managed Python reinstall by closing explicit and implicit kernels', async () => {
    const root = await createStorageRoot()
    const terminations: string[] = []
    const service = bindingService(root, { discovered: [managedPy], terminations })

    await service.execute({ sessionId: 'implicit', workspaceCwd: root, code: '1' })
    await service.bindRuntime({
      sessionId: 'explicit',
      workspaceCwd: root,
      language: 'python',
      runtimeId: managedPy.envId
    })
    await service.execute({ sessionId: 'explicit', workspaceCwd: root, code: '2' })

    await service.prepareRuntimeRepair('python', { kind: 'runtime', runtimeId: managedPy.envId })

    expect(terminations).toEqual(['python:default-python', 'python:default-python'])
    expect(isRepairRequired(getRuntimeRoot(root), DEFAULT_PY_ENV)).toBe(true)
    const quarantined = await service.state({
      sessionId: 'explicit',
      workspaceCwd: root
    })
    expect(quarantined.runtimeBindings.python).toMatchObject({
      status: 'unavailable',
      reason: 'repair-required'
    })

    await service.completeRuntimeRepair('python')

    expect(isRepairRequired(getRuntimeRoot(root), DEFAULT_PY_ENV)).toBe(false)
    const repaired = await service.state({ sessionId: 'explicit', workspaceCwd: root })
    expect(repaired.runtimeBindings.python).toMatchObject({
      runtimeId: managedPy.envId,
      status: 'active'
    })
  })

  it('accepts a healthy managed R default and rejects external or legacy managed identities', async () => {
    const root = await createStorageRoot()
    const service = bindingService(root, { discovered: [managedR, userPyA] })

    await service.prepareRuntimeRepair('r', { kind: 'runtime', runtimeId: managedR.envId })
    expect(isRepairRequired(getRuntimeRoot(root), DEFAULT_R_ENV)).toBe(true)
    await service.completeRuntimeRepair('r')
    expect(isRepairRequired(getRuntimeRoot(root), DEFAULT_R_ENV)).toBe(false)

    await expect(
      service.prepareRuntimeRepair('python', { kind: 'runtime', runtimeId: userPyA.envId })
    ).rejects.toThrow(/no longer the app-managed python default/i)

    const legacy: DiscoveredInterpreter = {
      ...managedPy,
      envId: '/root/runtime/envs/default-python-legacy/bin/python',
      interpreterPath: '/root/runtime/envs/default-python-legacy/bin/python',
      condaEnv: 'default-python-legacy'
    }
    const legacyService = bindingService(root, { discovered: [legacy] })
    await expect(
      legacyService.prepareRuntimeRepair('python', { kind: 'runtime', runtimeId: legacy.envId })
    ).rejects.toThrow(/no longer the app-managed python default/i)

    addRepairRequired(getRuntimeRoot(root), DEFAULT_PY_ENV, 'protected-identity-change')
    const recoveryService = bindingService(root, { discovered: [] })
    await expect(
      recoveryService.prepareRuntimeRepair('python', {
        kind: 'default-environment',
        environmentName: DEFAULT_PY_ENV
      })
    ).resolves.toBeUndefined()
  })

  it('accepts the exact discovered managed default when its interpreter is broken', async () => {
    const root = await createStorageRoot()
    const brokenManagedPython: DiscoveredInterpreter = {
      ...managedPy,
      runnable: false
    }
    const service = bindingService(root, { discovered: [brokenManagedPython] })

    await expect(
      service.prepareRuntimeRepair('python', {
        kind: 'runtime',
        runtimeId: brokenManagedPython.envId
      })
    ).resolves.toBeUndefined()
    expect(isRepairRequired(getRuntimeRoot(root), DEFAULT_PY_ENV)).toBe(true)
  })

  it('list_notebook_runtimes returns only enabled runtimes (never disabled), flagging the binding', async () => {
    const root = await createStorageRoot()
    // No enablement override: user-own defaults OFF, app-managed defaults ON.
    const service = bindingService(root)

    const listedDefault = await service.listRuntimes({ sessionId: 's', workspaceCwd: root })
    expect(listedDefault.runtimes.map((r) => r.runtimeId)).toEqual([managedPy.envId])

    // Enabling one external env surfaces it too, still excluding the other (disabled) one.
    const enabledService = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    })
    const listed = await enabledService.listRuntimes({ sessionId: 's2', workspaceCwd: root })
    expect(listed.runtimes.map((r) => r.runtimeId).sort()).toEqual(
      [managedPy.envId, userPyA.envId].sort()
    )
    expect(listed.runtimes.every((r) => r.runtimeId !== userPyB.envId)).toBe(true)
  })

  it('creates canonical runtime receipts for explicit first-bind and later switch', async () => {
    const root = await createStorageRoot()
    const environments: EnvironmentInfo[] = []
    const discovered: DiscoveredInterpreter[] = []
    const environmentManager: NotebookEnvironmentManager = {
      createNamedEnvironment: async (name, language) => {
        const info = { name, language, ready: true, isDefault: false }
        environments.push(info)
        const prefix = envPrefix(getRuntimeRoot(root), name)
        const runtimeId = language === 'r' ? rBin(prefix) : pythonBin(prefix)
        discovered.push({
          language,
          provenance: 'agent-created',
          envId: runtimeId,
          interpreterPath: runtimeId,
          label: `conda: ${name}`,
          condaEnv: name,
          runnable: true
        })
        return info
      },
      listEnvironments: () => [...environments],
      removeEnvironment: () => [...environments]
    }
    const service = bindingService(root, {
      environmentManager,
      discoverRuntimes: async (language) =>
        discovered.filter((runtime) => runtime.language === language)
    })
    const request = { sessionId: 's', workspaceCwd: root } as const

    const createdA = await service.manageEnvironments({
      action: 'create',
      language: 'python',
      name: 'analysis-a'
    })
    expect(createdA.created).toMatchObject({
      name: 'analysis-a',
      language: 'python',
      runnable: true
    })
    expect((await service.state(request)).runtimeBindings.python).toBeUndefined()
    await expect(
      service.bindRuntime({ ...request, language: 'python', runtimeId: 'analysis-a' })
    ).resolves.toMatchObject({
      ok: false,
      bindingChanged: false,
      error: expect.stringMatching(/not an enabled python runtime/),
      target: { language: 'python', selection: 'unresolved' }
    })
    expect((await service.state(request)).runtimeBindings.python).toBeUndefined()

    await service.bindRuntime({
      ...request,
      language: 'python',
      runtimeId: createdA.created!.runtimeId
    })
    expect((await service.state(request)).runtimeBindings.python?.runtimeId).toBe(
      createdA.created!.runtimeId
    )

    const createdB = await service.manageEnvironments({
      action: 'create',
      language: 'python',
      name: 'analysis-b'
    })
    expect((await service.state(request)).runtimeBindings.python?.runtimeId).toBe(
      createdA.created!.runtimeId
    )
    await expect(
      service.switchRuntime({ ...request, language: 'python', runtimeId: 'analysis-b' })
    ).resolves.toMatchObject({
      ok: false,
      bindingChanged: false,
      error: expect.stringMatching(/not an enabled python runtime/),
      target: {
        language: 'python',
        selection: 'explicit-binding',
        runtimeId: createdA.created!.runtimeId
      }
    })
    expect((await service.state(request)).runtimeBindings.python?.runtimeId).toBe(
      createdA.created!.runtimeId
    )
    await service.switchRuntime({
      ...request,
      language: 'python',
      runtimeId: createdB.created!.runtimeId
    })
    expect((await service.state(request)).runtimeBindings.python?.runtimeId).toBe(
      createdB.created!.runtimeId
    )
  })

  it('refuses binding a disabled or unknown runtime IN THE MAIN process', async () => {
    const root = await createStorageRoot()
    const service = bindingService(root)

    // userPyA is discovered but disabled (user-own default OFF) -> refused even with a valid id.
    await expect(
      service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
    ).resolves.toMatchObject({
      ok: false,
      bindingChanged: false,
      error: expect.stringMatching(/not an enabled python runtime/),
      target: {
        language: 'python',
        selection: 'implicit-default',
        runtimeSource: 'managed',
        runtimeId: managedPy.envId,
        label: managedPy.label
      }
    })

    // A completely unknown id is likewise refused (a guessed path cannot bypass the gate).
    await expect(
      service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: '/tmp/hacker/python'
      })
    ).resolves.toMatchObject({
      ok: false,
      bindingChanged: false,
      error: expect.stringMatching(/not an enabled python runtime/),
      target: { language: 'python', selection: 'implicit-default', runtimeId: managedPy.envId }
    })
  })

  it('refuses a no-binding execute when the app-managed default is disabled (no silent fallback)', async () => {
    const root = await createStorageRoot()
    // Explicitly disable the app-managed default python (as toggling it off in Settings would), keyed
    // by the same interpreter path isDefaultEnvDisabled computes for this data root.
    const defaultPyId = pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV))
    const service = bindingService(root, {
      enablement: { enabled: { [defaultPyId]: false }, installAuthorized: {} }
    })

    // No bind: the run must FAIL with an actionable message rather than silently running the disabled
    // default (Settings would show no available runtime while execute still ran it).
    const summary = await service.execute({ sessionId: 's', workspaceCwd: root, code: '1' })
    expect(summary.status).toBe('failed')
    expect(summary.text.traceback).toMatch(/No enabled python runtime/i)
  })

  it('runs a bound enabled NAMED env even when the app-managed default is disabled', async () => {
    // Regression: disabling default-python must not block a session already bound to an enabled
    // agent-created env. The run resolves to the named env (not the default), so the disabled-default
    // gate must not fire.
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const namedPyId = pythonBin(envPrefix(getRuntimeRoot(root), 'my-analysis'))
    const defaultPyId = pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV))
    const namedEnv: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: namedPyId,
      interpreterPath: namedPyId,
      label: 'my-analysis',
      condaEnv: 'my-analysis',
      version: '3.12',
      runnable: true
    }
    const provisionPython = vi.fn(async () => undefined)
    const service = bindingService(root, {
      discovered: [managedPy, namedEnv],
      // Default OFF, named env ON.
      enablement: { enabled: { [defaultPyId]: false, [namedPyId]: true }, installAuthorized: {} },
      executions
    })
    service.setDefaultEnvProvisioner({ provisionPython, provisionR: async () => undefined })

    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: namedPyId
    })

    const summary = await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: '1',
      language: 'python'
    })
    // The run succeeds against the named env; the disabled default never gates it.
    expect(summary.status).toBe('completed')
    expect(executions).toHaveLength(1)
    expect(executions[0].environment).toBe('my-analysis')
    // A managed named env is not the default, so the on-demand default provision never runs.
    expect(provisionPython).not.toHaveBeenCalled()
  })

  it('binds an enabled external runtime and runs the user interpreter without touching the managed default', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const executions: NotebookExecutionRequest[] = []
    const provisionPython = vi.fn(async () => undefined)
    const service = bindingService(root, {
      repository,
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      executions
    })
    service.setDefaultEnvProvisioner({ provisionPython, provisionR: async () => undefined })

    const bound = await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    expect(bound.bindings.python?.runtimeId).toBe(userPyA.envId)
    expect(bound.bindings.python?.source).toBe('external')

    const summary = await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: '1',
      language: 'python'
    })
    // The bound external interpreter is threaded to the executor, and the managed default is NOT built.
    expect(executions[0].resolvedInterpreter?.command).toBe(userPyA.interpreterPath)
    expect(provisionPython).not.toHaveBeenCalled()
    expect(summary).not.toHaveProperty('kernelDispatched')
    expect(summary).not.toHaveProperty('runtimeId')
    await expect(repository.findExisting('default-project', 's')).resolves.toMatchObject({
      runs: [expect.objectContaining({ kernelDispatched: true, runtimeId: userPyA.envId })]
    })

    // notebook_state surfaces the current binding.
    const state = await service.state({ sessionId: 's', workspaceCwd: root })
    expect(state.runtimeBindings.python?.runtimeId).toBe(userPyA.envId)
  })

  it('rotates the kernel epoch when first binding an external runtime after managed execution', async () => {
    const root = await createStorageRoot()
    const terminations: string[] = []
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      terminations
    })

    const managedRun = await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: 'managed_value = 1',
      language: 'python'
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    const externalRun = await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: 'external_value = 1',
      language: 'python'
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    expect(terminations).toEqual(['python:default-python'])
    expect(externalRun.kernelEpochId).not.toBe(managedRun.kernelEpochId)
  })

  it('switch tears down the language kernel, clears its state, and rebinds to the new runtime', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const terminations: string[] = []
    const service = bindingService(root, {
      enablement: {
        enabled: { [userPyA.envId]: true, [userPyB.envId]: true },
        installAuthorized: {}
      },
      executions,
      terminations
    })

    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

    // The run left the python default-env kernel live.
    const before = await service.state({ sessionId: 's', workspaceCwd: root })
    expect(before.environments.some((e) => e.processKey === 'python:default-python')).toBe(true)

    const switched = await service.switchRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyB.envId
    })
    expect(switched.bindings.python?.runtimeId).toBe(userPyB.envId)

    // The old kernel was PHYSICALLY torn down via the executor (external bindings share the default
    // env key), not just left to the interpreter-identity respawn seam.
    expect(terminations).toContain('python:default-python')

    // The old kernel's state was torn down (dropped from the live env view).
    const after = await service.state({ sessionId: 's', workspaceCwd: root })
    expect(after.environments.some((e) => e.processKey === 'python:default-python')).toBe(false)
    expect(after.runtimeBindings.python?.runtimeId).toBe(userPyB.envId)

    // Subsequent runs use the newly-bound interpreter.
    await service.execute({ sessionId: 's', workspaceCwd: root, code: '2', language: 'python' })
    expect(executions.at(-1)?.resolvedInterpreter?.command).toBe(userPyB.interpreterPath)
  })

  it('clears exact persisted terminations when intentionally switching or revoking a runtime', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const seedTerminatedDefault = async (sessionId: string): Promise<void> => {
      const lane = createRootNotebookLane('default-project', sessionId, `root-frame-${sessionId}`)
      await repository.loadOrCreate({
        projectId: 'default-project',
        sessionId,
        workspaceCwd: root,
        lane
      })
      await repository.markKernelTerminated({
        projectId: 'default-project',
        sessionId,
        lane,
        kernelInstance: { kind: 'python', environment: DEFAULT_PY_ENV }
      })
    }
    await seedTerminatedDefault('switch-session')
    await seedTerminatedDefault('revoke-session')

    const service = bindingService(root, {
      repository,
      enablement: {
        enabled: { [userPyA.envId]: true, [userPyB.envId]: true },
        installAuthorized: {}
      }
    })

    await service.bindRuntime({
      sessionId: 'switch-session',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await service.switchRuntime({
      sessionId: 'switch-session',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyB.envId
    })

    await service.bindRuntime({
      sessionId: 'revoke-session',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await service.revokeRuntime('python', userPyA.envId, { force: true })

    for (const sessionId of ['switch-session', 'revoke-session']) {
      const persisted = await repository.findExisting('default-project', sessionId)
      expect(persisted?.kernel).toMatchObject({ lastKnownStatus: 'idle' })
      expect(persisted?.kernel.terminatedKernelInstances).toBeUndefined()
    }
  })

  it('preserves a switched and revoked binding across a replacement session generation', async () => {
    const root = await createStorageRoot()
    const discovered = [managedPy, userPyA, userPyB]
    const enablement: RuntimeEnablement = {
      enabled: { [userPyA.envId]: true, [userPyB.envId]: true },
      installAuthorized: {}
    }
    const service = bindingService(root, { discovered, enablement })

    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await service.switchRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyB.envId
    })

    const persistedAfterSwitch = await new NotebookRunRepository(root).findExisting(
      'default-project',
      's'
    )
    expect(persistedAfterSwitch?.runtimeBindings).toEqual({
      python: {
        language: 'python',
        runtimeId: userPyB.envId,
        source: 'external',
        provenance: 'user-own',
        interpreterPath: userPyB.interpreterPath,
        label: userPyB.label,
        version: userPyB.version,
        status: 'active'
      }
    })

    enablement.enabled[userPyB.envId] = false
    await service.revokeRuntime('python', userPyB.envId)
    await service.shutdownAll()

    const reloaded = await service.state({ sessionId: 's', workspaceCwd: root })
    expect(reloaded.runtimeBindings).toEqual({
      python: {
        language: 'python',
        runtimeId: userPyB.envId,
        source: 'external',
        provenance: 'user-own',
        interpreterPath: userPyB.interpreterPath,
        label: userPyB.label,
        version: userPyB.version,
        status: 'unavailable',
        reason: 'disabled'
      },
      r: undefined
    })
  })

  it('finishes a binding persistence commit before replacing the session generation', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const persistRuntimeBindings = repository.setRuntimeBindings.bind(repository)
    let releasePersistence!: () => void
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve
    })
    let markPersistenceStarted!: () => void
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve
    })
    vi.spyOn(repository, 'setRuntimeBindings').mockImplementation(async (...args) => {
      markPersistenceStarted()
      await persistenceGate
      return persistRuntimeBindings(...args)
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      discoverRuntimes: async (language) => (language === 'python' ? [userPyA] : []),
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: {
            enabled: { [userPyA.envId]: true },
            installAuthorized: {}
          },
          manualInterpreters: [],
          packageMirror: {}
        })
      },
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: '',
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: async () => ({ reaped: true })
      })
    })
    const request = { sessionId: 's', workspaceCwd: root }
    await service.state(request)

    const bind = service.bindRuntime({
      ...request,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await persistenceStarted

    let shutdownSettled = false
    let replacementSettled = false
    const shutdown = service.shutdownAll().then((result) => {
      shutdownSettled = true
      return result
    })
    const replacement = service.state(request).then((state) => {
      replacementSettled = true
      return state
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    const shutdownSettledBeforeCommit = shutdownSettled
    const replacementSettledBeforeCommit = replacementSettled
    releasePersistence()

    await expect(bind).resolves.toEqual(
      expect.objectContaining({ bound: expect.objectContaining({ runtimeId: userPyA.envId }) })
    )
    await expect(shutdown).resolves.toEqual({ reaped: true })
    await expect(replacement).resolves.toEqual(
      expect.objectContaining({
        runtimeBindings: expect.objectContaining({
          python: expect.objectContaining({ runtimeId: userPyA.envId })
        })
      })
    )
    expect(shutdownSettledBeforeCommit).toBe(false)
    expect(replacementSettledBeforeCommit).toBe(false)
  })

  it.each(['shutdown', 'dispose'] as const)(
    'starts fresh-session binding creation before an immediate %s teardown',
    async (teardown) => {
      const root = await createStorageRoot()
      const service = bindingService(root, {
        discovered: [userPyA],
        enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
      })

      const bind = service.bindRuntime({
        sessionId: 'fresh',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
      const close = teardown === 'shutdown' ? service.shutdownAll() : service.dispose()
      await Promise.all([bind, close])
    }
  )

  it('does not let another session runtime listing delay a session shutdown', async () => {
    const root = await createStorageRoot()
    let releaseDiscovery!: () => void
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve
    })
    let markDiscoveryStarted!: () => void
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve
    })
    const service = bindingService(root, {
      discoverRuntimes: async (language) => {
        if (language !== 'python') return []
        markDiscoveryStarted()
        await discoveryGate
        return [managedPy]
      }
    })
    await service.state({ sessionId: 'a', workspaceCwd: root })

    const listing = service.listRuntimes({ sessionId: 'b', workspaceCwd: root })
    await discoveryStarted
    let shutdownSettled = false
    const shutdown = service.shutdownSession('a').then((result) => {
      shutdownSettled = true
      return result
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    const shutdownSettledBeforeDiscovery = shutdownSettled
    releaseDiscovery()

    await expect(shutdown).resolves.toEqual({ sessionId: 'a', status: 'shutdown' })
    await expect(listing).resolves.toEqual(expect.objectContaining({ runtimes: expect.any(Array) }))
    expect(shutdownSettledBeforeDiscovery).toBe(true)
  })

  it('does not let another session binding write delay a session shutdown', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const persistRuntimeBindings = repository.setRuntimeBindings.bind(repository)
    let releasePersistence!: () => void
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve
    })
    let markPersistenceStarted!: () => void
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve
    })
    vi.spyOn(repository, 'setRuntimeBindings').mockImplementation(async (...args) => {
      if (args[1] === 'b') {
        markPersistenceStarted()
        await persistenceGate
      }
      return persistRuntimeBindings(...args)
    })
    const service = bindingService(root, {
      repository,
      discovered: [userPyA],
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    })
    await Promise.all([
      service.state({ sessionId: 'a', workspaceCwd: root }),
      service.state({ sessionId: 'b', workspaceCwd: root })
    ])

    const bind = service.bindRuntime({
      sessionId: 'b',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await persistenceStarted
    let shutdownSettled = false
    const shutdown = service.shutdownSession('a').then((result) => {
      shutdownSettled = true
      return result
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    const shutdownSettledBeforeCommit = shutdownSettled
    releasePersistence()

    await expect(shutdown).resolves.toEqual({ sessionId: 'a', status: 'shutdown' })
    await expect(bind).resolves.toEqual(
      expect.objectContaining({ bound: expect.objectContaining({ runtimeId: userPyA.envId }) })
    )
    expect(shutdownSettledBeforeCommit).toBe(true)
  })

  it('does not let read-only runtime discovery delay terminal disposal', async () => {
    const root = await createStorageRoot()
    let releaseDiscovery!: () => void
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve
    })
    let markDiscoveryStarted!: () => void
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve
    })
    const service = bindingService(root, {
      discoverRuntimes: async (language) => {
        if (language !== 'python') return []
        markDiscoveryStarted()
        await discoveryGate
        return [managedPy]
      }
    })

    const listing = service.listRuntimes({ sessionId: 'b', workspaceCwd: root })
    await discoveryStarted
    let disposalSettled = false
    const disposal = service.dispose().then((result) => {
      disposalSettled = true
      return result
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    const disposalSettledBeforeDiscovery = disposalSettled
    releaseDiscovery()

    await expect(disposal).resolves.toEqual({ reaped: true })
    await expect(listing).resolves.toEqual(expect.objectContaining({ runtimes: expect.any(Array) }))
    expect(disposalSettledBeforeDiscovery).toBe(true)
  })

  it('refuses switching to a disabled runtime', async () => {
    const root = await createStorageRoot()
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await expect(
      service.switchRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyB.envId
      })
    ).resolves.toMatchObject({
      ok: false,
      bindingChanged: false,
      error: expect.stringMatching(/not an enabled python runtime/),
      target: {
        language: 'python',
        selection: 'explicit-binding',
        runtimeSource: 'external',
        runtimeId: userPyA.envId,
        label: userPyA.label
      }
    })
  })

  it('binds an enabled external R runtime and runs the user Rscript without provisioning managed R', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const provisionR = vi.fn(async () => undefined)
    const service = bindingService(root, {
      discovered: [managedR, userR],
      enablement: { enabled: { [userR.envId]: true }, installAuthorized: {} },
      executions
    })
    service.setDefaultEnvProvisioner({ provisionPython: async () => undefined, provisionR })

    const bound = await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'r',
      runtimeId: userR.envId
    })
    expect(bound.bindings.r?.runtimeId).toBe(userR.envId)
    expect(bound.bindings.r?.source).toBe('external')

    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'r' })
    // External R launches via Rscript (…/bin/R -> …/bin/Rscript), not the R binary, matching the
    // managed rScriptBin path; the managed R env is NOT built.
    expect(executions[0].resolvedInterpreter?.command).toBe('/usr/local/bin/Rscript')
    expect(provisionR).not.toHaveBeenCalled()
  })

  it('carries an external Windows conda R own activation prefix into execution', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const prefix = 'C:\\Users\\HM\\miniforge3\\envs\\analysis'
    const windowsCondaR: DiscoveredInterpreter = {
      language: 'r',
      provenance: 'user-own',
      envId: `${prefix}\\Lib\\R\\bin\\R.exe`,
      interpreterPath: `${prefix}\\Lib\\R\\bin\\R.exe`,
      label: 'analysis',
      version: '4.4.3',
      runnable: true
    }
    const service = bindingService(root, {
      discovered: [windowsCondaR],
      enablement: { enabled: { [windowsCondaR.envId]: true }, installAuthorized: {} },
      executions,
      platform: 'win32'
    })

    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'r',
      runtimeId: windowsCondaR.envId
    })
    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'r' })

    expect(executions[0].resolvedInterpreter).toMatchObject({
      command: `${prefix}\\Lib\\R\\bin\\Rscript.exe`,
      condaPrefix: prefix
    })
    const dependencyInterpreter = await (
      service as unknown as { runtimeBindingOwner: NotebookRuntimeBindingOwner }
    ).runtimeBindingOwner.dependencyInterpreter('r', windowsCondaR.envId)
    expect(dependencyInterpreter).toMatchObject({ condaPrefix: prefix })
  })

  it('does not infer Windows conda activation from a Windows-shaped R path on another platform', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const prefix = 'C:\\Users\\HM\\miniforge3\\envs\\analysis'
    const windowsShapedR: DiscoveredInterpreter = {
      language: 'r',
      provenance: 'user-own',
      envId: `${prefix}\\Lib\\R\\bin\\R.exe`,
      interpreterPath: `${prefix}\\Lib\\R\\bin\\R.exe`,
      label: 'analysis',
      version: '4.4.3',
      runnable: true
    }
    const service = bindingService(root, {
      discovered: [windowsShapedR],
      enablement: { enabled: { [windowsShapedR.envId]: true }, installAuthorized: {} },
      executions,
      platform: 'darwin'
    })

    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'r',
      runtimeId: windowsShapedR.envId
    })
    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'r' })

    expect(executions[0].resolvedInterpreter?.condaPrefix).toBeUndefined()
  })

  it('binds an agent-created named env and runs cells in it via the managed conda path', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const namedAgent: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: '/root/runtime/envs/my-analysis/bin/python',
      interpreterPath: '/root/runtime/envs/my-analysis/bin/python',
      label: 'my-analysis',
      condaEnv: 'my-analysis',
      version: '3.12',
      runnable: true
    }
    // No enablement override: agent-created defaults ENABLED, so it is bindable without a manual enable.
    const service = bindingService(root, { discovered: [managedPy, namedAgent], executions })

    const bound = await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: namedAgent.envId
    })
    if (!('bound' in bound)) throw new Error(bound.error)
    // A conda env WE own is 'managed' (executor resolves it by NAME), not 'external'.
    expect(bound.bound.source).toBe('managed')

    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })
    // The run targets the bound named env by name via the managed path — no raw external interpreter.
    expect(executions[0].environment).toBe('my-analysis')
    expect(executions[0].resolvedInterpreter).toBeUndefined()
  })

  it('protects a dormant bound environment until the Session switches to another runtime', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const executions: NotebookExecutionRequest[] = []
    const removed: string[] = []
    const namedRuntime = (name: string): DiscoveredInterpreter => ({
      language: 'python',
      provenance: 'agent-created',
      envId: pythonBin(envPrefix(runtimeRoot, name)),
      interpreterPath: pythonBin(envPrefix(runtimeRoot, name)),
      label: name,
      condaEnv: name,
      version: '3.12',
      runnable: true
    })
    const analysis = namedRuntime('analysis')
    const replacement = namedRuntime('replacement')
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      discoverRuntimes: async (language) => (language === 'python' ? [analysis, replacement] : []),
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: { enabled: {}, installAuthorized: {} },
          manualInterpreters: [],
          packageMirror: {}
        })
      },
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => ({ reaped: true }),
        terminate: async () => undefined
      }),
      environmentManager: {
        createNamedEnvironment: async (name, language) => ({
          name,
          language,
          ready: true,
          isDefault: false
        }),
        listEnvironments: () => [],
        removeEnvironment: (name) => {
          removed.push(name)
          return []
        }
      }
    })

    await service.bindRuntime({
      sessionId: 'session-1',
      workspaceCwd: root,
      language: 'python',
      runtimeId: analysis.envId
    })

    await expect(
      service.manageEnvironments({ action: 'remove', name: 'analysis' })
    ).rejects.toThrow(
      'Session "session-1" has an active Runtime Binding to it. Switch that Session to another Runtime Environment first.'
    )
    expect(removed).toEqual([])

    await service.switchRuntime({
      sessionId: 'session-1',
      workspaceCwd: root,
      language: 'python',
      runtimeId: replacement.envId
    })
    await expect(
      service.manageEnvironments({ action: 'remove', name: 'analysis' })
    ).resolves.toEqual({ removed: { name: 'analysis' } })
    expect(removed).toEqual(['analysis'])

    await service.execute({
      sessionId: 'session-1',
      workspaceCwd: root,
      code: '1',
      language: 'python'
    })
    expect(executions.at(-1)?.environment).toBe('replacement')
  })

  it('installs into the bound external interpreter when the user authorized package install', async () => {
    const root = await createStorageRoot()
    const captured: Array<{ command: string; args?: string[] } | undefined> = []
    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      },
      installPackagesImpl: async (_request, deps) => {
        captured.push(deps?.interpreter)
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    const result = await service.managePackages({
      sessionId: 's',
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(true)
    expect(result.target).toEqual({
      language: 'python',
      selection: 'explicit-binding',
      runtimeSource: 'external',
      runtimeId: userPyA.envId,
      label: userPyA.label
    })
    // pip runs against the user's OWN interpreter (no app-owned overlay).
    expect(captured[0]?.command).toBe(userPyA.interpreterPath)
  })

  it('returns an unchanged package outcome with the explicit managed target that was mutated', async () => {
    const root = await createStorageRoot()
    const namedRuntime: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: pythonBin(envPrefix(getRuntimeRoot(root), 'analysis')),
      interpreterPath: pythonBin(envPrefix(getRuntimeRoot(root), 'analysis')),
      label: 'conda: analysis',
      condaEnv: 'analysis',
      version: '3.12',
      runnable: true
    }
    const service = bindingService(root, {
      discovered: [managedPy, namedRuntime],
      installPackagesImpl: async () => ({ ok: true, needsRestart: false, log: '' }),
      packageChanges: [
        {
          name: 'numpy',
          ecosystem: 'python',
          relationship: 'requested',
          change: 'unchanged',
          beforeVersion: '2.2.0',
          afterVersion: '2.2.0'
        }
      ]
    })
    const bound = await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: namedRuntime.envId
    })
    expect(bound).toHaveProperty('bound')

    const result = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })

    expect(result).toMatchObject({
      ok: true,
      packageChanges: [{ name: 'numpy', change: 'unchanged' }],
      target: {
        language: 'python',
        selection: 'explicit-binding',
        runtimeSource: 'managed',
        environmentName: 'analysis',
        runtimeId: namedRuntime.envId,
        label: namedRuntime.label,
        prefix: envPrefix(getRuntimeRoot(root), 'analysis')
      }
    })
  })

  it('refuses installing into a bound external runtime that is not install-authorized', async () => {
    const root = await createStorageRoot()
    let installRan = false
    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      // Enabled (so it can be bound), but NOT install-authorized.
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      installPackagesImpl: async () => {
        installRan = true
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    const result = await service.managePackages({
      sessionId: 's',
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not authorized/)
    expect(result.target).toEqual({
      language: 'python',
      selection: 'explicit-binding',
      runtimeSource: 'external',
      runtimeId: userPyA.envId,
      label: userPyA.label
    })
    expect(installRan).toBe(false)
  })

  it('refuses installing into a MANAGED (agent-created) binding that has been revoked/disabled (unified gate)', async () => {
    // Regression: the manage_packages gate was external-only, so a disabled MANAGED runtime still
    // installed. This binds a genuinely MANAGED runtime (an agent-created named env — source 'managed',
    // NOT the user-own/external branch), revokes it, and asserts the install is refused by the managed
    // gate (an earlier version bound userPyA, which is provenance user-own and only exercised the
    // external branch, so it never covered the managed gate).
    const root = await createStorageRoot()
    let installRan = false
    const namedPyId = pythonBin(envPrefix(getRuntimeRoot(root), 'my-analysis'))
    const namedEnv: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: namedPyId,
      interpreterPath: namedPyId,
      label: 'my-analysis',
      condaEnv: 'my-analysis',
      version: '3.12',
      runnable: true
    }
    const service = bindingService(root, {
      discovered: [managedPy, namedEnv],
      enablement: { enabled: { [namedPyId]: true }, installAuthorized: {} },
      installPackagesImpl: async () => {
        installRan = true
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    // Bind the MANAGED named env, then disable+revoke it -> the binding is kept but unavailable.
    const bound = await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: namedPyId
    })
    if (!('bound' in bound)) throw new Error(bound.error)
    // Guard the regression: this MUST be the managed branch, not external, or the test is vacuous.
    expect(bound.bound.source).toBe('managed')
    await service.revokeRuntime('python', namedPyId)

    const result = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/RUNTIME_BINDING_UNAVAILABLE/)
    expect(installRan).toBe(false)
  })

  it('pins the install target to the binding env, ignoring a stale request.environment', async () => {
    // Regression: package-manager re-derived the env from request.environment and the local RPC forwards
    // the raw request, so a stale/mismatched environment could install into a DIFFERENT env than the one
    // whose lock/journal/repair the service resolved. The service now overrides it with the binding env.
    const root = await createStorageRoot()
    const captured: Array<string | undefined> = []
    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      installPackagesImpl: async (request) => {
        captured.push(request.environment)
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    // No session/binding -> managed default. A caller passing a bogus environment must not redirect the
    // install. (No sessionId: a caller with no session context legitimately targets the default; a
    // sessionId with no workspaceCwd would instead be refused, covered by its own test.)
    const result = await service.managePackages({
      language: 'python',
      packages: ['numpy'],
      environment: 'some-other-env'
    } as InstallRequestForTest)
    expect(result.ok).toBe(true)
    // The forwarded request carries the binding-resolved default env, not the caller's stale value.
    expect(captured[0]).toBe(DEFAULT_PY_ENV)
    expect(result.target).toEqual({
      language: 'python',
      selection: 'implicit-default',
      runtimeSource: 'managed',
      environmentName: DEFAULT_PY_ENV,
      runtimeId: pythonBin(envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV)),
      label: DEFAULT_PY_ENV,
      prefix: envPrefix(getRuntimeRoot(root), DEFAULT_PY_ENV)
    })
  })

  it('honors a PERSISTED binding on the first manage_packages after a restart (fresh service)', async () => {
    // Regression: managePackages resolved the session with a bare sessions.get, so the FIRST install
    // after an app restart (session not yet in memory) saw no binding and silently installed into the
    // default env — bypassing the bound runtime + its install authorization. It now ensureSession()s
    // first, rehydrating the persisted binding.
    const root = await createStorageRoot()
    // Service A: bind an external, install-authorized runtime and persist it to run.json.
    const serviceA = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      }
    })
    await serviceA.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    // Service B: a fresh process (no in-memory session). Its FIRST call is manage_packages — it must
    // load the session, rehydrate the persisted external binding, and pip into the user's OWN
    // interpreter, NOT micromamba into the default managed prefix.
    const captured: Array<{ interpreter?: string; environment?: string }> = []
    const serviceB = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      },
      installPackagesImpl: async (request, deps) => {
        captured.push({ interpreter: deps?.interpreter?.command, environment: request.environment })
        return { ok: true, needsRestart: false, log: '' }
      }
    })

    const result = await serviceB.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(true)
    // Installed into the user's own interpreter (external pip), proving the persisted binding was
    // honored — not the managed default prefix.
    expect(captured[0]?.interpreter).toBe(userPyA.interpreterPath)
  })

  it('refuses manage_packages with a sessionId but no workspaceCwd on a memory miss (no silent default)', async () => {
    // A sessionId names a session whose persisted binding we must honor, but with no workspaceCwd we
    // can't load it and it isn't in memory. Installing would silently target the default env, bypassing
    // the binding — so refuse instead.
    const root = await createStorageRoot()
    let installRan = false
    const service = bindingService(root, {
      installPackagesImpl: async () => {
        installRan = true
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    const result = await service.managePackages({
      sessionId: 'ghost',
      language: 'python',
      packages: ['numpy']
    } as InstallRequestForTest)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/RUNTIME_SESSION_UNAVAILABLE/)
    expect(result.target).toEqual({ language: 'python', selection: 'unresolved' })
    expect(installRan).toBe(false)
  })

  it('awaits startup recovery before executing bound external or named runtimes', async () => {
    const root = await createStorageRoot()
    const namedId = pythonBin(envPrefix(getRuntimeRoot(root), 'my-analysis'))
    const namedRuntime: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: namedId,
      interpreterPath: namedId,
      label: 'my-analysis',
      condaEnv: 'my-analysis',
      version: '3.12',
      runnable: true
    }
    const scenarios = [
      {
        label: 'external',
        runtimeId: userPyA.envId,
        discovered: [managedPy, userPyA],
        enablement: {
          enabled: { [userPyA.envId]: true },
          installAuthorized: {}
        }
      },
      {
        label: 'named',
        runtimeId: namedId,
        discovered: [managedPy, namedRuntime],
        enablement: { enabled: { [namedId]: true }, installAuthorized: {} }
      }
    ] satisfies Array<{
      label: string
      runtimeId: string
      discovered: DiscoveredInterpreter[]
      enablement: RuntimeEnablement
    }>

    for (const [index, scenario] of scenarios.entries()) {
      const executions: NotebookExecutionRequest[] = []
      const service = bindingService(root, {
        discovered: scenario.discovered,
        enablement: scenario.enablement,
        executions
      })
      const sessionId = `recovery-${index}`
      await service.bindRuntime({
        sessionId,
        workspaceCwd: root,
        language: 'python',
        runtimeId: scenario.runtimeId
      })

      let releaseRecovery!: () => void
      const recoveryGate = new Promise<void>((resolve) => {
        releaseRecovery = resolve
      })
      const ensureRecovered = vi
        .spyOn(service, 'ensureRecovered')
        .mockImplementation(() => recoveryGate)

      const run = service.execute({ sessionId, workspaceCwd: root, code: '1' })
      await vi.waitFor(() => expect(ensureRecovered).toHaveBeenCalledOnce())
      expect(executions, scenario.label).toEqual([])

      releaseRecovery()
      const result = await run
      ensureRecovered.mockRestore()
      expect(result.status, scenario.label).toBe('completed')
      expect(executions, scenario.label).toHaveLength(1)
    }
  })

  it('blocks a no-binding execute + install on a DEFAULT prefix an unknown-liveness orphan may hold', async () => {
    // After recovery, an interrupted materialize whose child could NOT be confirmed dead ('unknown' —
    // here a live pid with no recorded start time) must leave its prefix BLOCKED for this process, so a
    // fresh materialize/install refuses rather than racing the possible survivor. Verifies the barrier
    // resolving is not mistaken for "safe to write this prefix". The provision/repair/restore side of
    // this guarantee is exercised in provisioner.test.ts (the provisioner self-guards via the same
    // isPrefixRecoveryBlocked predicate ipc.ts injects), and the named/external runtimeId side below.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const defaultPrefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    // childPid alive (this process) + no token => defaultOperationChildLiveness = 'unknown'
    // deterministically, on every platform. childStartedAt is written atomically with childPid.
    await journal.begin({
      operationId: 'm',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create',
      startedAt: 100,
      childPid: process.pid,
      childStartedAt: 100,
      targetPath: defaultPrefix
    })

    const provisionPython = vi.fn(async () => undefined)
    let installRan = false
    const service = bindingService(root, {
      installPackagesImpl: async () => {
        installRan = true
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    service.setDefaultEnvProvisioner({ provisionPython, provisionR: async () => undefined })

    await service.recoverInterruptedOperations()

    // The default prefix is now recovery-blocked — both via the language helper AND the raw-prefix
    // predicate ipc.ts hands to the provisioner (so the startup gate self-guards through the same seam).
    expect(service.isDefaultEnvRecoveryBlocked('python')).toBe(true)
    expect(service.isPrefixRecoveryBlocked(defaultPrefix)).toBe(true)

    // A no-binding execute (default env) fails rather than materializing over the blocked prefix.
    const run = await service.execute({ sessionId: 's', workspaceCwd: root, code: '1' })
    expect(run.status).toBe('failed')
    expect(run.text.traceback).toMatch(/RUNTIME_RECOVERY_BLOCKED/)
    expect(provisionPython).not.toHaveBeenCalled()

    // A manage_packages install into that env refuses too.
    const install = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(install.ok).toBe(false)
    expect(install.error).toMatch(/RUNTIME_RECOVERY_BLOCKED/)
    expect(installRan).toBe(false)
  })

  it('re-derives the recovery block from the retained journal across sessions (persistent quarantine)', async () => {
    // An unprobeable record is RETAINED (never auto-cleared on a guess), so the block is re-derived
    // from the journal on every startup — a fresh service (a new session) blocks the same prefix. This
    // is the service-side blockedPrefixes lifecycle: it lives only in memory and is rebuilt from the
    // durable journal each session, so recovery only truly clears once the child is confirmed gone.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const defaultPrefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    // Alive pid + NO childStartedAt => 'unknown' deterministically -> block + retain.
    await journal.begin({
      operationId: 'm',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create',
      startedAt: 100,
      childPid: process.pid,
      childStartedAt: 100, // written atomically with childPid; alive + no token => 'unknown'
      targetPath: defaultPrefix
    })

    // Session A blocks and RETAINS the record (does not clear it under a possible writer).
    const serviceA = bindingService(root)
    await serviceA.recoverInterruptedOperations()
    expect(serviceA.isPrefixRecoveryBlocked(defaultPrefix)).toBe(true)
    expect((await journal.pending()).map((r) => r.operationId)).toEqual(['m'])

    // Session B (a fresh service on the same journal) re-derives the same block from the retained record.
    const serviceB = bindingService(root)
    await serviceB.recoverInterruptedOperations()
    expect(serviceB.isPrefixRecoveryBlocked(defaultPrefix)).toBe(true)
  })

  it('refreshes a startup recovery block after the operation owner durably completes it', async () => {
    // During a data-root relaunch the new app can observe the old app's still-finishing runtime child
    // and conservatively block its prefix. The old owner then commits and removes the journal record,
    // but the new app must not retain that now-stale block for its entire process lifetime.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const defaultPrefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'migration-owner',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create',
      startedAt: 100,
      childPid: process.pid,
      childStartedAt: 100,
      targetPath: defaultPrefix
    })

    const service = bindingService(root)
    await service.recoverInterruptedOperations()
    expect(service.isPrefixRecoveryBlocked(defaultPrefix)).toBe(true)

    // Rechecking while the owner's record is still present must remain fail-closed.
    await service.ensureRecovered()
    expect(service.isPrefixRecoveryBlocked(defaultPrefix)).toBe(true)

    // The process that owned the operation is the authority that removes this record after commit.
    await journal.complete('migration-owner')
    await service.ensureRecovered()

    expect(service.isPrefixRecoveryBlocked(defaultPrefix)).toBe(false)
  })

  it('integration: a real provisioner writes the spawn-intent sidecar; service recovery hydrates it and blocks', async () => {
    // The production chain end-to-end (not mocks): a real DefaultRuntimeProvisioner rooted at the same
    // runtime root the service recovers from journals the op + writes a synchronous spawn-intent sidecar
    // before its create runs. We hang the create (simulating a crash mid-op that never records a PID),
    // then a fresh service recovers from the SAME root: it hydrates the intent sidecar and BLOCKS the
    // prefix (a child may be live), without probing/killing.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const prefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    const cachePath = join(runtimeRoot, 'pkgs')
    const provisioner = new DefaultRuntimeProvisioner({
      root: runtimeRoot,
      mm: '/mm',
      channel: 'conda-forge',
      // Cache selection and Windows ACL hardening are covered separately. Keep this integration test
      // focused on the provisioner-to-recovery journal boundary and independent of host ACL latency.
      cache: { path: cachePath, lockKey: cachePath },
      fetchBundle: async (spec) => ({
        lockPath: join(runtimeRoot, `${spec.name}.lock`),
        // This fake lock has no package paths. Avoid applying the production bundle's worst-case
        // Windows path budget to the deliberately long temporary test root.
        pathBudget: { maxCacheRelativePath: 1, maxEnvRelativePath: 1 }
      }),
      // Real runMicromamba calls onBeforeSpawn right before spawning; mimic that (write the intent) then
      // hang, modelling a crash after spawn but before the PID is recorded.
      runArgv: (_argv, _signal, _onChild, onBeforeSpawn) => {
        onBeforeSpawn?.()
        return new Promise<void>(() => {})
      },
      verify: async () => undefined
    })
    void provisioner.provisionPython(() => {}) // leaves an interrupted materialize (do not await)

    // Wait until the provisioner has journaled the op (its spawn-intent sidecar is written just before).
    const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    await vi.waitFor(async () => {
      expect((await journal.pending()).some((r) => r.kind === 'materialize')).toBe(true)
    })

    const service = bindingService(root)
    await service.recoverInterruptedOperations()
    expect(service.isPrefixRecoveryBlocked(prefix)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses an install when the journal cannot record it (begin fails closed, no spawn)',
    async () => {
      // If the install can't be journaled for crash recovery, spawning the installer could strand a
      // worker. managePackages must refuse with a structured error instead of installing.
      const root = await createStorageRoot()
      const runtimeRoot = getRuntimeRoot(root)
      await mkdir(runtimeRoot, { recursive: true })

      let installRan = false
      const service = bindingService(root, {
        installPackagesImpl: async () => {
          installRan = true
          return { ok: true, needsRestart: false, log: '' }
        }
      })
      await service.ensureRecovered()
      // Keep the runtime readable so the repair-registry gate remains healthy, but deny the journal's
      // atomic temp-file write. chmod semantics are not portable to Windows, hence the explicit skip.
      await chmod(runtimeRoot, 0o555)
      try {
        const result = await service.managePackages({
          sessionId: 's',
          workspaceCwd: root,
          language: 'python',
          packages: ['numpy']
        })
        expect(result.ok).toBe(false)
        expect(result.error).toMatch(/RUNTIME_JOURNAL_UNWRITABLE/)
        expect(installRan).toBe(false)
      } finally {
        await chmod(runtimeRoot, 0o755)
      }
    }
  )

  it('blocks a named-env REMOVE on a prefix an unknown-liveness orphan may still hold', async () => {
    // After a restart there is no in-memory kernel state, so isEnvironmentLive() can't see a surviving
    // installer — the prefix-block from recovery is the only thing standing between rm -rf and a live
    // orphan still writing the named prefix. Assert the guard fires BEFORE the manager deletes anything.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const namedPrefix = envPrefix(runtimeRoot, 'my-analysis')
    const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'i',
      kind: 'install',
      runtimeId: 'my-analysis',
      phase: 'install-python',
      startedAt: 100,
      childPid: process.pid, // alive + no token => 'unknown'
      childStartedAt: 100, // written atomically with childPid
      targetPath: namedPrefix
    })

    const removed: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentManager: {
        createNamedEnvironment: async (name, language) => ({
          name,
          language,
          ready: true,
          isDefault: false
        }),
        listEnvironments: () => [],
        removeEnvironment: (name) => {
          removed.push(name)
          return []
        }
      }
    })

    await service.recoverInterruptedOperations()
    expect(service.isPrefixRecoveryBlocked(namedPrefix)).toBe(true)

    await expect(
      service.manageEnvironments({ action: 'remove', name: 'my-analysis' })
    ).rejects.toThrow(/RUNTIME_RECOVERY_BLOCKED/)
    // The rm -rf never reached the manager — nothing was deleted out from under a possible survivor.
    expect(removed).toEqual([])
  })

  it('blocks a bound external execute + install by runtimeId after an interrupted external install', async () => {
    // An external install writes the user's OWN env, not a path under runtimeRoot, so it is blocked by
    // runtimeId (blockUnknownChildTarget), NOT a prefix. execute() and managePackages() must consume
    // that runtimeId block for the bound runtime — the default-prefix guard alone would never fire here.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'x',
      kind: 'install',
      runtimeId: userPyA.envId, // the external runtime's identity
      phase: 'install-python',
      startedAt: 100,
      childPid: process.pid, // alive + no token => 'unknown'
      childStartedAt: 100 // written atomically with childPid
      // NOTE: no targetPath — an external install carries none (that is exactly the journal-target fix).
    })

    let installRan = false
    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      },
      installPackagesImpl: async () => {
        installRan = true
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    await service.recoverInterruptedOperations()
    // The external runtime is blocked by id; the app-managed DEFAULT prefix is NOT (no false-positive).
    expect(service.isPrefixRecoveryBlocked(envPrefix(runtimeRoot, DEFAULT_PY_ENV))).toBe(false)

    const run = await service.execute({ sessionId: 's', workspaceCwd: root, code: '1' })
    expect(run.status).toBe('failed')
    expect(run.text.traceback).toMatch(/RUNTIME_RECOVERY_BLOCKED/)

    const install = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(install.ok).toBe(false)
    expect(install.error).toMatch(/RUNTIME_RECOVERY_BLOCKED/)
    expect(installRan).toBe(false)
  })

  it('journals an external install by runtimeId with NO managed prefix as target', async () => {
    // The bug: an external install recorded envPrefix(default) as its targetPath, so recovery would
    // clean/block the unrelated app-managed default and never identify the real external runtime. Assert
    // the in-flight journal record carries the external runtimeId and an UNDEFINED targetPath.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const inspectJournal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    let recordedDuringInstall: { runtimeId: string; targetPath?: string } | undefined

    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      },
      installPackagesImpl: async () => {
        // Read the journal WHILE the install is in flight (before the finally clears it).
        const pending = await inspectJournal.pending()
        const install = pending.find((r) => r.kind === 'install')
        recordedDuringInstall = install
          ? { runtimeId: install.runtimeId, targetPath: install.targetPath }
          : undefined
        return { ok: true, needsRestart: false, log: '' }
      }
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    const result = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(true)
    expect(recordedDuringInstall?.runtimeId).toBe(userPyA.envId)
    expect(recordedDuringInstall?.targetPath).toBeUndefined()
  })

  it('refuses an install when the operation journal is corrupt (fail closed inside the lock)', async () => {
    // begin() runs inside the env lock and throws on a corrupt journal; managePackages must map that to
    // a structured refusal (no installer spawned) rather than proceeding without a recovery record.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(operationJournalPath(runtimeRoot), '{ not json', 'utf8')
    let installRan = false
    const service = bindingService(root, {
      installPackagesImpl: async () => {
        installRan = true
        return { ok: true, needsRestart: false, log: '' }
      }
    })

    const result = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/RUNTIME_JOURNAL_UNWRITABLE/)
    expect(installRan).toBe(false)
  })

  it('blocks when a later spawn intent supersedes a stale journal PID (multi-spawn recovery)', async () => {
    // Multi-spawn op (e.g. materialize's cache-repair retry): spawn #1's PID landed in the journal, then
    // a second spawn was armed ({ spawning: true } sidecar) but crashed before its PID was recorded. The
    // journal still names the (exited) first child. Trusting it would probe a dead pid, conclude 'dead',
    // and clean the prefix while spawn #2 may still be writing. The sidecar is authoritative: a bare
    // spawn intent must BLOCK regardless of the stale journal PID.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const defaultPrefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    const journal = new RuntimeOperationJournal(operationJournalPath(runtimeRoot))
    await journal.begin({
      operationId: 'm',
      kind: 'materialize',
      runtimeId: DEFAULT_PY_ENV,
      phase: 'create',
      startedAt: 100,
      // A stale PID that is definitely GONE (would probe 'dead' and reconcile if trusted).
      childPid: 2_147_483_646,
      childStartedAt: 100,
      targetPath: defaultPrefix
    })
    // The current spawn re-armed the sidecar to a bare intent (its PID never landed).
    recordSpawnIntentSync(runtimeRoot, 'm')

    const service = bindingService(root)
    service.setDefaultEnvProvisioner({
      provisionPython: async () => undefined,
      provisionR: async () => undefined
    })

    await service.recoverInterruptedOperations()

    // The sidecar intent wins over the stale journal PID -> the prefix is blocked, not reconciled.
    expect(service.isPrefixRecoveryBlocked(defaultPrefix)).toBe(true)
  })

  it('fails safe on a corrupt operation journal by blocking the managed default prefixes', async () => {
    // A corrupt/unreadable journal is NOT proof that nothing was in flight — an install may have been
    // mid-write. Recovery can't know which prefix, so it blocks BOTH managed defaults for this session
    // and leaves the journal untouched (a later boot / explicit Reset recovers), rather than reading it
    // as empty and opening the barrier.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(operationJournalPath(runtimeRoot), '{ not json', 'utf8')

    const service = bindingService(root)
    await service.recoverInterruptedOperations()

    expect(service.isPrefixRecoveryBlocked(envPrefix(runtimeRoot, DEFAULT_PY_ENV))).toBe(true)
    expect(service.isPrefixRecoveryBlocked(envPrefix(runtimeRoot, DEFAULT_R_ENV))).toBe(true)
    // The corrupt journal is left in place for a later boot to recover.
    expect(existsSync(operationJournalPath(runtimeRoot))).toBe(true)
  })

  it('corrupt journal blocks ALL prefixes (not just the two managed defaults)', async () => {
    // A corrupt journal means we can't enumerate what was in flight: a named env's orphan might still
    // be writing, so blocking only the defaults would leave that env exposed. recoveryCorrupt must make
    // isPrefixRecoveryBlocked return true for ANY prefix, including named-env and external targets.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(operationJournalPath(runtimeRoot), '{ not json', 'utf8')

    const service = bindingService(root)
    await service.recoverInterruptedOperations()

    const namedPrefix = envPrefix(runtimeRoot, 'my-analysis')
    const pyPrefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    expect(service.isPrefixRecoveryBlocked(namedPrefix)).toBe(true)
    expect(service.isPrefixRecoveryBlocked(pyPrefix)).toBe(true)
    // A force Reset releases only the prefix it reset from the global corrupt barrier — resetting the
    // Python default must NOT unblock the named env (we can't know which env the corrupt journal's
    // in-flight work targeted). The others stay blocked until their own Reset or a restart.
    service.clearCorruptRecoveryBlock(pyPrefix)
    expect(service.isPrefixRecoveryBlocked(pyPrefix)).toBe(false)
    expect(service.isPrefixRecoveryBlocked(namedPrefix)).toBe(true)
  })

  it('lets an allowlisted default env EXECUTE cells after a corrupt-journal Reset (no restart needed)', async () => {
    // Fix D: the execute path must gate a managed/default run by its per-prefix block (allowlist-aware),
    // NOT the raw recoveryCorrupt flag. Otherwise a force-Reset Python env stays un-runnable until a
    // restart even though its prefix was explicitly released. A DIFFERENT default (R) stays blocked.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(operationJournalPath(runtimeRoot), '{ not json', 'utf8')

    const executions: NotebookExecutionRequest[] = []
    const service = bindingService(root, { executions })
    // A ready marker so the default-env readiness gate doesn't try to provision during execute.
    service.setDefaultEnvProvisioner({
      provisionPython: async () => undefined,
      provisionR: async () => undefined
    })
    await service.recoverInterruptedOperations()

    // Release ONLY the Python default prefix (what a force Reset of Python does via clearQuarantine).
    service.clearCorruptRecoveryBlock(envPrefix(runtimeRoot, DEFAULT_PY_ENV))

    // A no-binding Python execute now runs (reaches the executor) instead of failing recovery-blocked.
    const pyRun = await service.execute({ sessionId: 's', workspaceCwd: root, code: '1' })
    expect(pyRun.status).not.toBe('failed')
    expect(executions.length).toBe(1)

    // R was NOT reset, so its execute is still refused under the corrupt barrier.
    const rRun = await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      language: 'r',
      code: '1'
    })
    expect(rRun.status).toBe('failed')
    expect(rRun.text.traceback).toMatch(/RUNTIME_RECOVERY_BLOCKED/)
  })

  it('blocks the install target in-process after an unconfirmed-child install failure, refusing a retry', async () => {
    // An install whose worker could not be confirmed stopped leaves a possibly-live orphan. Retaining the
    // journal record only guards the NEXT boot — so managePackages must ALSO block the runtimeId + prefix
    // in THIS process, or an in-session retry would begin() a SECOND install racing the orphan. The
    // installer throws the CHILD_UNCONFIRMED marker (recording failed, exit unconfirmed) on the first call
    // only; the second must be refused before it ever runs.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const pyPrefix = envPrefix(runtimeRoot, DEFAULT_PY_ENV)
    let installAttempts = 0
    const service = bindingService(root, {
      installPackagesImpl: async () => {
        installAttempts += 1
        throw new Error(`install failed: ${CHILD_UNCONFIRMED}`)
      }
    })

    const failure = await service.managePackages({ language: 'python', packages: ['numpy'] })
    expectBoundedPackageFailure(
      failure,
      expectedManagedTarget(runtimeRoot, 'python', DEFAULT_PY_ENV),
      new RegExp(CHILD_UNCONFIRMED)
    )
    expect(installAttempts).toBe(1)
    // The managed default's prefix is now blocked in-process (not just via the retained journal entry).
    expect(service.isPrefixRecoveryBlocked(pyPrefix)).toBe(true)
    // It is ALSO marked live-unconfirmed, so a force Reset this session refuses to delete it out from
    // under the possibly-live installer (the provisioner reads this via the injected dep).
    expect(service.isPrefixLiveUnconfirmed(pyPrefix)).toBe(true)

    // An in-session retry is refused by the block — the installer is never spawned a second time.
    const retry = await service.managePackages({ language: 'python', packages: ['numpy'] })
    expect(retry).toMatchObject({
      ok: false,
      needsRestart: false,
      error: expect.stringMatching(/RUNTIME_RECOVERY_BLOCKED/),
      target: failure.target
    })
    expect(installAttempts).toBe(1)
  })

  it('uses one repair key for bound and unbound sessions sharing a managed R prefix', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const terminations: string[] = []
    const executions: NotebookExecutionRequest[] = []
    const service = bindingService(root, {
      discovered: [managedR],
      executions,
      terminations,
      installPackagesImpl: async () => ({
        ok: false,
        needsRestart: false,
        log: 'r-base changed',
        repairRequired: true,
        error: 'Protected r-base changed unexpectedly. Run Repair.'
      })
    })

    await service.bindRuntime({
      sessionId: 'bound',
      workspaceCwd: root,
      language: 'r',
      runtimeId: managedR.envId
    })
    await service.state({ sessionId: 'unbound', workspaceCwd: root })

    const result = await service.managePackages({
      sessionId: 'bound',
      workspaceCwd: root,
      language: 'r',
      packages: ['dplyr']
    })

    expect(result.repairRequired).toBe(true)
    expect(isRepairRequired(runtimeRoot, DEFAULT_R_ENV)).toBe(true)
    expect(isRepairRequired(runtimeRoot, managedR.envId)).toBe(false)
    expect(terminations.filter((entry) => entry === `r:${DEFAULT_R_ENV}`)).toHaveLength(2)

    for (const sessionId of ['bound', 'unbound']) {
      const run = await service.execute({
        sessionId,
        workspaceCwd: root,
        language: 'r',
        code: 'R.version.string'
      })
      expect(run.status).toBe('failed')
      expect(run.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)
    }
    expect(executions).toHaveLength(0)
  })

  it('keeps raw-path-only legacy repair aliases out of the public binding projection', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    addRepairRequired(runtimeRoot, pythonBin(envPrefix(runtimeRoot, DEFAULT_PY_ENV)))
    const executions: NotebookExecutionRequest[] = []
    const service = bindingService(root, { discovered: [managedPy], executions })

    const bound = await service.bindRuntime({
      sessionId: 'raw-alias',
      workspaceCwd: root,
      language: 'python',
      runtimeId: managedPy.envId
    })
    if (!('bound' in bound)) throw new Error(bound.error)
    expect(bound.bound).toMatchObject({ status: 'active', reason: undefined })

    const run = await service.execute({
      sessionId: 'raw-alias',
      workspaceCwd: root,
      language: 'python',
      code: '1'
    })
    expect(run.status).toBe('failed')
    expect(run.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)
    expect(executions).toHaveLength(0)
  })

  it('keeps an interrupted install scoped to its language in a shared managed env', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const envName = 'shared-analysis'
    const prefix = envPrefix(runtimeRoot, envName)
    const namedPython: DiscoveredInterpreter = {
      language: 'python',
      provenance: 'agent-created',
      envId: pythonBin(prefix),
      interpreterPath: pythonBin(prefix),
      label: envName,
      condaEnv: envName,
      version: '3.12',
      runnable: true
    }
    const namedR: DiscoveredInterpreter = {
      language: 'r',
      provenance: 'agent-created',
      envId: rBin(prefix),
      interpreterPath: rBin(prefix),
      label: envName,
      condaEnv: envName,
      version: '4.4.3',
      runnable: true
    }
    const executions: NotebookExecutionRequest[] = []
    const installPackagesImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, needsRestart: false, log: 'installed' })
    const service = bindingService(root, {
      discovered: [namedPython, namedR],
      executions,
      installPackagesImpl
    })

    for (const [language, runtimeId] of [
      ['python', namedPython.envId],
      ['r', namedR.envId]
    ] as const) {
      await service.bindRuntime({
        sessionId: 'shared',
        workspaceCwd: root,
        language,
        runtimeId
      })
    }
    await RuntimeOperationJournal.forPath(operationJournalPath(runtimeRoot)).begin({
      operationId: 'interrupted-r-install',
      kind: 'install',
      runtimeId: envName,
      phase: 'install-r',
      startedAt: 100,
      targetPath: prefix
    })
    await service.recoverInterruptedOperations()

    const pythonBeforeRepair = await service.execute({
      sessionId: 'shared',
      workspaceCwd: root,
      language: 'python',
      code: '1'
    })
    expect(pythonBeforeRepair.status).toBe('completed')
    const rBeforeRepair = await service.execute({
      sessionId: 'shared',
      workspaceCwd: root,
      language: 'r',
      code: '1'
    })
    expect(rBeforeRepair.status).toBe('failed')
    expect(rBeforeRepair.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)

    const pythonInstall = await service.managePackages({
      sessionId: 'shared',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(pythonInstall.ok).toBe(true)
    const rAfterPythonInstall = await service.execute({
      sessionId: 'shared',
      workspaceCwd: root,
      language: 'r',
      code: '1'
    })
    expect(rAfterPythonInstall.status).toBe('failed')
    expect(rAfterPythonInstall.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)

    const rInstall = await service.managePackages({
      sessionId: 'shared',
      workspaceCwd: root,
      language: 'r',
      packages: ['dplyr']
    })
    expect(rInstall.ok).toBe(true)
    const rAfterRepair = await service.execute({
      sessionId: 'shared',
      workspaceCwd: root,
      language: 'r',
      code: '1'
    })
    expect(rAfterRepair.status).toBe('completed')
  })

  it('does not let an ordinary package install clear a protected R identity quarantine', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    let installAttempts = 0
    const serviceOptions = {
      discovered: [managedR],
      installPackagesImpl: async () => {
        installAttempts += 1
        if (installAttempts === 1) {
          return {
            ok: false,
            needsRestart: false,
            log: 'r-base changed',
            repairRequired: true,
            error: 'Protected r-base changed unexpectedly. Run Repair.'
          }
        }
        return { ok: true, needsRestart: false, log: 'ordinary install completed' }
      }
    }
    const service = bindingService(root, serviceOptions)

    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'r',
      runtimeId: managedR.envId
    })
    const quarantined = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'r',
      packages: ['dplyr']
    })
    expect(quarantined.repairRequired).toBe(true)
    expect(isRepairRequired(runtimeRoot, DEFAULT_R_ENV)).toBe(true)
    expect(isProtectedIdentityRepairRequired(runtimeRoot, DEFAULT_R_ENV)).toBe(true)

    // A fresh service proves the durable reason survives an app restart; the process-local gate from
    // the first service cannot be what refuses this retry.
    const restarted = bindingService(root, serviceOptions)

    const retry = await restarted.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'r',
      packages: ['ggplot2']
    })

    expect(retry.ok).toBe(false)
    expect(retry.repairRequired).toBe(true)
    expect(retry.error).toMatch(/RUNTIME_REPAIR_REQUIRED/)
    expect(installAttempts).toBe(1)
    expect(isRepairRequired(runtimeRoot, DEFAULT_R_ENV)).toBe(true)
    const state = await restarted.state({ sessionId: 's', workspaceCwd: root })
    expect(state.runtimeBindings.r?.reason).toBe('repair-required')

    // This callback represents a successful provisioner Reset: only that verified rebuild releases
    // the durable marker, in-memory gate, and persisted binding state.
    await restarted.completeRuntimeRepair('r')
    expect(isRepairRequired(runtimeRoot, DEFAULT_R_ENV)).toBe(false)
    const repairedState = await restarted.state({ sessionId: 's', workspaceCwd: root })
    expect(repairedState.runtimeBindings.r?.status).toBe('active')
    expect(repairedState.runtimeBindings.r?.reason).toBeUndefined()

    const run = await restarted.execute({
      sessionId: 's',
      workspaceCwd: root,
      language: 'r',
      code: 'R.version.string'
    })
    expect(run.status).toBe('completed')

    const reloaded = bindingService(root, serviceOptions)
    const reloadedState = await reloaded.state({ sessionId: 's', workspaceCwd: root })
    expect(reloadedState.runtimeBindings.r?.status).toBe('active')
    expect(reloadedState.runtimeBindings.r?.reason).toBeUndefined()
  })

  it('releases a named managed quarantine only after the environment is removed', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const envName = 'named-r-analysis'
    const prefix = envPrefix(runtimeRoot, envName)
    const namedR: DiscoveredInterpreter = {
      language: 'r',
      provenance: 'agent-created',
      envId: rBin(prefix),
      interpreterPath: rBin(prefix),
      label: envName,
      condaEnv: envName,
      version: '4.4.3',
      runnable: true
    }
    const executions: NotebookExecutionRequest[] = []
    let present = true
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      discoverRuntimes: async (language) => (language === 'r' ? [namedR] : []),
      environmentManager: {
        createNamedEnvironment: async (name, language) => {
          present = true
          return { name, language, ready: true, isDefault: false }
        },
        listEnvironments: () =>
          present ? [{ name: envName, language: 'r', ready: true, isDefault: false }] : [],
        removeEnvironment: () => {
          present = false
          return []
        }
      },
      environmentStateTracker: verifiedPackageMutationTracker(),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request)
          return {
            status: 'completed',
            stdout: '',
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        terminate: async () => undefined,
        shutdown: async () => ({ reaped: true })
      }),
      installPackagesImpl: async () => ({
        ok: false,
        needsRestart: false,
        log: 'r-base changed',
        repairRequired: true,
        error: 'Protected r-base changed unexpectedly. Run Repair.'
      })
    })

    await service.bindRuntime({
      sessionId: 'named',
      workspaceCwd: root,
      language: 'r',
      runtimeId: namedR.envId
    })
    const quarantined = await service.managePackages({
      sessionId: 'named',
      workspaceCwd: root,
      language: 'r',
      packages: ['dplyr']
    })
    expect(quarantined.repairRequired).toBe(true)
    expect(isProtectedIdentityRepairRequired(runtimeRoot, envName)).toBe(true)

    await service.manageEnvironments({ action: 'remove', name: envName })
    expect(isRepairRequired(runtimeRoot, envName)).toBe(false)
    await service.manageEnvironments({ action: 'create', name: envName, language: 'r' })
    const rebound = await service.bindRuntime({
      sessionId: 'named',
      workspaceCwd: root,
      language: 'r',
      runtimeId: namedR.envId
    })
    if (!('bound' in rebound)) throw new Error(rebound.error)
    expect(rebound.bound.status).toBe('active')
    const run = await service.execute({
      sessionId: 'named',
      workspaceCwd: root,
      language: 'r',
      code: '1'
    })
    expect(run.status).toBe('completed')
    expect(executions).toHaveLength(1)
  })

  it('keeps an untyped legacy external install marker repairable by an authorized reinstall', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    await mkdir(runtimeRoot, { recursive: true })
    await writeFile(
      repairRegistryPath(runtimeRoot),
      `${JSON.stringify({ runtimeIds: [userPyA.envId] })}\n`,
      'utf8'
    )
    const installPackagesImpl = vi
      .fn()
      .mockResolvedValue({ ok: true, needsRestart: false, log: 'repaired' })
    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      },
      installPackagesImpl
    })

    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    const result = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })

    expect(result.ok).toBe(true)
    expect(installPackagesImpl).toHaveBeenCalledOnce()
    expect(isRepairRequired(runtimeRoot, userPyA.envId)).toBe(false)
  })

  it('recomputes repair aliases after installation before clearing legacy markers', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const postInstallAlias = 'post-install-canonical-runtime'
    addRepairRequired(runtimeRoot, postInstallAlias)
    const service = bindingService(root, {
      installPackagesImpl: async () => ({ ok: true, needsRestart: false, log: 'repaired' })
    })
    const repairRegistryKeys = vi.spyOn(
      (
        service as unknown as {
          repairPolicy: {
            registryKeys: (
              language: 'python' | 'r',
              environment: string,
              binding: unknown
            ) => readonly string[]
          }
        }
      ).repairPolicy,
      'registryKeys'
    )
    repairRegistryKeys
      .mockReturnValueOnce([DEFAULT_PY_ENV, managedRepairRegistryKey(DEFAULT_PY_ENV, 'python')])
      .mockReturnValueOnce([DEFAULT_PY_ENV, managedRepairRegistryKey(DEFAULT_PY_ENV, 'python')])
      .mockReturnValueOnce([
        DEFAULT_PY_ENV,
        managedRepairRegistryKey(DEFAULT_PY_ENV, 'python'),
        postInstallAlias
      ])

    const result = await service.managePackages({ language: 'python', packages: ['numpy'] })

    expect(result.ok).toBe(true)
    expect(repairRegistryKeys).toHaveBeenCalledTimes(3)
    expect(isRepairRequired(runtimeRoot, postInstallAlias)).toBe(false)
  })

  it('does not quarantine an external binding that shares the managed default env key', async () => {
    const root = await createStorageRoot()
    const terminations: string[] = []
    const executions: NotebookExecutionRequest[] = []
    const service = bindingService(root, {
      discovered: [managedR, userR],
      enablement: { enabled: { [userR.envId]: true }, installAuthorized: {} },
      executions,
      terminations,
      installPackagesImpl: async () => ({
        ok: false,
        needsRestart: false,
        log: 'managed r-base changed',
        repairRequired: true,
        error: 'Protected r-base changed unexpectedly. Run Repair.'
      })
    })

    await service.bindRuntime({
      sessionId: 'external',
      workspaceCwd: root,
      language: 'r',
      runtimeId: userR.envId
    })
    await service.state({ sessionId: 'managed', workspaceCwd: root })

    const result = await service.managePackages({
      sessionId: 'managed',
      workspaceCwd: root,
      language: 'r',
      packages: ['dplyr']
    })

    expect(result.repairRequired).toBe(true)
    expect(terminations.filter((entry) => entry === `r:${DEFAULT_R_ENV}`)).toHaveLength(1)
    const state = await service.state({ sessionId: 'external', workspaceCwd: root })
    expect(state.runtimeBindings.r?.status).toBe('active')
    expect(state.runtimeBindings.r?.reason).toBeUndefined()

    const run = await service.execute({
      sessionId: 'external',
      workspaceCwd: root,
      language: 'r',
      code: 'R.version.string'
    })
    expect(run.status).toBe('completed')
    expect(executions.at(-1)?.resolvedInterpreter?.command).toBe('/usr/local/bin/Rscript')
  })

  it('honors and clears a legacy managed runtimeId marker for an unbound default session', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    const interpreterPath = rBin(envPrefix(runtimeRoot, DEFAULT_R_ENV))
    const discovered: DiscoveredInterpreter = {
      ...managedR,
      envId: interpreterPath,
      interpreterPath
    }
    const executions: NotebookExecutionRequest[] = []
    addRepairRequired(runtimeRoot, interpreterPath)
    const service = bindingService(root, {
      discovered: [discovered],
      executions,
      installPackagesImpl: async () => ({ ok: true, needsRestart: false, log: 'repaired' })
    })

    await service.state({ sessionId: 'unbound', workspaceCwd: root })
    const run = await service.execute({
      sessionId: 'unbound',
      workspaceCwd: root,
      language: 'r',
      code: 'R.version.string'
    })

    expect(run.status).toBe('failed')
    expect(run.text.traceback).toMatch(/RUNTIME_REPAIR_REQUIRED/)
    expect(executions).toHaveLength(0)

    const repaired = await service.managePackages({ language: 'r', packages: ['dplyr'] })
    expect(repaired.ok).toBe(true)
    expect(isRepairRequired(runtimeRoot, interpreterPath)).toBe(false)

    const afterRepair = await service.execute({
      sessionId: 'unbound',
      workspaceCwd: root,
      language: 'r',
      code: 'R.version.string'
    })
    expect(afterRepair.status).toBe('completed')
    expect(executions).toHaveLength(1)
  })

  it('clears a legacy managed runtimeId marker when an unbound session repairs the env', async () => {
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    addRepairRequired(runtimeRoot, managedR.envId)
    const service = bindingService(root, {
      discovered: [managedR],
      installPackagesImpl: async () => ({ ok: true, needsRestart: false, log: 'repaired' })
    })

    const bound = await service.bindRuntime({
      sessionId: 'bound',
      workspaceCwd: root,
      language: 'r',
      runtimeId: managedR.envId
    })
    if (!('bound' in bound)) throw new Error(bound.error)
    expect(bound.bound.reason).toBe('repair-required')

    const result = await service.managePackages({ language: 'r', packages: ['dplyr'] })
    expect(result.ok).toBe(true)
    expect(isRepairRequired(runtimeRoot, managedR.envId)).toBe(false)
    expect(isRepairRequired(runtimeRoot, DEFAULT_R_ENV)).toBe(false)
    const state = await service.state({ sessionId: 'bound', workspaceCwd: root })
    expect(state.runtimeBindings.r?.status).toBe('active')
    expect(state.runtimeBindings.r?.reason).toBeUndefined()
  })

  it('restores a repaired binding to active in EVERY bound session after a successful repair install', async () => {
    // A binding resolved while its runtime was repair-required is held unavailable/repair-required in
    // memory. A completed repair install clears the disk flag AND must restore the in-memory binding to
    // active in EVERY session that bound it — restoreRepairedBindings() walks all live sessions, so this
    // uses TWO distinct sessions (s and t) bound to the SAME runtime and asserts both flip back.
    const root = await createStorageRoot()
    const runtimeRoot = getRuntimeRoot(root)
    // Flag the external runtime repair-required BEFORE binding, so each bind resolves it as unavailable.
    addRepairRequired(runtimeRoot, userPyA.envId)
    const service = bindingService(root, {
      discovered: [managedPy, userPyA],
      enablement: {
        enabled: { [userPyA.envId]: true },
        installAuthorized: { [userPyA.envId]: true }
      },
      installPackagesImpl: async () => ({ ok: true, needsRestart: false, log: '' })
    })

    // Bind the same repair-required runtime in two separate sessions.
    for (const sessionId of ['s', 't']) {
      const bound = await service.bindRuntime({
        sessionId,
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
      if (!('bound' in bound)) throw new Error(bound.error)
      expect(bound.bound.status).toBe('unavailable')
      expect(bound.bound.reason).toBe('repair-required')
    }

    // Repair via a completed install issued from session s only.
    const result = await service.managePackages({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      packages: ['numpy']
    })
    expect(result.ok).toBe(true)

    // BOTH sessions' bindings are active again — including session t, which never issued the install.
    for (const sessionId of ['s', 't']) {
      const state = await service.state({ sessionId, workspaceCwd: root })
      expect(state.runtimeBindings.python?.status).toBe('active')
      expect(state.runtimeBindings.python?.reason).toBeUndefined()
    }
  })

  it('revokes a disabled runtime from a bound session so execution rejects (no silent fallback)', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      executions
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    // Disable the bound runtime -> revoke it from the session.
    await service.revokeRuntime('python', userPyA.envId)

    // notebook_state surfaces the binding as unavailable/disabled (kept, not cleared — no fallback).
    const state = await service.state({ sessionId: 's', workspaceCwd: root })
    expect(state.runtimeBindings.python?.status).toBe('unavailable')
    expect(state.runtimeBindings.python?.reason).toBe('disabled')

    // A subsequent run FAILS with an actionable message instead of silently running the managed default.
    const run = await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: '1',
      language: 'python'
    })
    expect(run.status).toBe('failed')
    expect(run.text.traceback).toContain('RUNTIME_BINDING_UNAVAILABLE')
    // The revoked interpreter was never dispatched to the executor.
    expect(executions).toHaveLength(0)
  })

  it('drains then physically closes a revoked runtime kernel in the background (WS10 remainder)', async () => {
    const root = await createStorageRoot()
    const terminations: string[] = []
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      terminations
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    // A completed run leaves the external kernel live under the default env key.
    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })

    await service.revokeRuntime('python', userPyA.envId)

    // Disable is non-blocking: the drain-and-close runs in the background — the kernel is torn down
    // after the in-flight run drains (here already finished), not left to idle-timeout.
    await vi.waitFor(() => expect(terminations).toContain('python:default-python'))
    await service.shutdownAll()
  })

  it('waits for a deferred runtime-revocation drain before removing the Project lane', async () => {
    const root = await createStorageRoot()
    const terminationStarted = createDeferred<void>()
    const terminationGate = createDeferred<void>()
    const events: string[] = []
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
      terminate: async () => {
        events.push('revocation-started')
        terminationStarted.resolve(undefined)
        await terminationGate.promise
        events.push('revocation-finished')
      }
    })
    const request = {
      projectId: 'project-1',
      sessionId: 's',
      workspaceCwd: root
    }
    await service.bindRuntime({
      ...request,
      language: 'python',
      runtimeId: userPyA.envId
    })
    await service.execute({ ...request, code: '1', language: 'python' })

    await service.revokeRuntime('python', userPyA.envId)
    await terminationStarted.promise

    let deletionCompleted = false
    const deleting = service.shutdownProject('project-1').then(() => {
      deletionCompleted = true
      events.push('project-deleted')
    })
    await Promise.resolve()

    expect(deletionCompleted).toBe(false)
    expect(events).toEqual(['revocation-started'])

    terminationGate.resolve(undefined)
    await deleting

    expect(events).toEqual(['revocation-started', 'revocation-finished', 'project-deleted'])
  })

  it('shares one aggregate initialization across concurrent public session reads', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const loadOrCreate = repository.loadOrCreate.bind(repository)
    let releaseFirstLoad!: () => void
    const firstLoadGate = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve
    })
    let gateFirstLoad = true
    const loadSpy = vi.spyOn(repository, 'loadOrCreate').mockImplementation(async (request) => {
      if (gateFirstLoad) {
        gateFirstLoad = false
        await firstLoadGate
      }
      return loadOrCreate(request)
    })
    const executorFactory = vi.fn(() => ({
      execute: async (request: NotebookExecutionRequest): Promise<NotebookExecutionResult> => ({
        status: 'completed',
        stdout: request.code,
        stderr: '',
        traceback: '',
        cwdAfter: request.cwd,
        outputs: []
      }),
      shutdown: async () => ({ reaped: true })
    }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository,
      executorFactory
    })
    const request = { sessionId: 's', workspaceCwd: root }

    const first = service.state(request)
    const second = service.state(request)

    await vi.waitFor(() => expect(loadSpy).toHaveBeenCalledTimes(1))
    expect(executorFactory).not.toHaveBeenCalled()
    releaseFirstLoad()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(executorFactory).toHaveBeenCalledTimes(1)
  })

  it('remains usable after temporary shutdowns for update and migration gates', async () => {
    const root = await createStorageRoot()
    const executions: string[] = []
    let shutdowns = 0
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => {
          executions.push(request.code)
          return {
            status: 'completed',
            stdout: request.code,
            stderr: '',
            traceback: '',
            cwdAfter: request.cwd,
            outputs: []
          }
        },
        shutdown: async () => {
          shutdowns += 1
          return { reaped: true }
        }
      })
    })

    for (const code of ['before-gate', 'after-update-gate', 'after-migration-gate']) {
      if (executions.length > 0) await service.shutdownAll()

      const result = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code,
        language: 'python'
      })

      expect(result.status).toBe('completed')
    }

    expect(executions).toEqual(['before-gate', 'after-update-gate', 'after-migration-gate'])
    expect(shutdowns).toBe(2)
  })

  it('starts kernel teardown without waiting for startup recovery to settle', async () => {
    const root = await createStorageRoot()
    let releaseRecovery: (() => void) | undefined
    const recoveryDisposal = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    const shutdown = vi.fn(async () => ({ reaped: true }))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: request.code,
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown
      })
    })

    await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: 'before-quit',
      language: 'python'
    })
    Object.defineProperty(service, 'recoveryCoordinator', {
      value: { dispose: vi.fn(() => recoveryDisposal) }
    })

    const disposal = service.dispose()
    expect(service.dispose()).toBe(disposal)
    let disposed = false
    void disposal.then(() => {
      disposed = true
    })

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1))
    expect(disposed).toBe(false)
    releaseRecovery?.()
    await expect(disposal).resolves.toEqual({ reaped: true })
  })

  it('closes environment leases before terminal disposal can release queued operations', async () => {
    const root = await createStorageRoot()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root)
    })
    const operationOwner = (
      service as unknown as {
        environmentOperations: {
          runMutation: <T>(environment: string, operation: () => Promise<T>) => Promise<T>
          snapshot: () => { disposed: boolean }
        }
      }
    ).environmentOperations
    let releaseHeld!: () => void
    const held = operationOwner.runMutation(
      'default',
      () =>
        new Promise<void>((resolve) => {
          releaseHeld = resolve
        })
    )
    await vi.waitFor(() => expect(releaseHeld).toBeTypeOf('function'))
    const queued = operationOwner.runMutation('default', async () => undefined)

    const disposal = service.dispose()

    await expect(queued).rejects.toThrow(/disposed/)
    expect(operationOwner.snapshot().disposed).toBe(true)
    releaseHeld()
    await held
    await expect(disposal).resolves.toEqual({ reaped: true })
  })

  it('waits for recovery disposal before propagating a kernel teardown failure', async () => {
    const root = await createStorageRoot()
    let releaseRecovery: (() => void) | undefined
    const recoveryDisposal = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    const shutdownError = new Error('kernel teardown failed')
    const shutdown = vi.fn(async () => Promise.reject(shutdownError))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: request.code,
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown
      })
    })

    await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: 'before-quit',
      language: 'python'
    })
    Object.defineProperty(service, 'recoveryCoordinator', {
      value: { dispose: vi.fn(() => recoveryDisposal) }
    })

    const disposal = service.dispose()
    let disposed = false
    void disposal.then(
      () => {
        disposed = true
      },
      () => {
        disposed = true
      }
    )

    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1))
    expect(disposed).toBe(false)
    releaseRecovery?.()
    await expect(disposal).rejects.toBe(shutdownError)
  })

  it('reports kernel and recovery disposal failures together in deterministic order', async () => {
    const root = await createStorageRoot()
    const shutdownError = new Error('kernel teardown failed')
    const recoveryError = new Error('recovery disposal failed')
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      executorFactory: () => ({
        execute: async (request): Promise<NotebookExecutionResult> => ({
          status: 'completed',
          stdout: request.code,
          stderr: '',
          traceback: '',
          cwdAfter: request.cwd,
          outputs: []
        }),
        shutdown: vi.fn(async () => Promise.reject(shutdownError))
      })
    })
    await service.state({ sessionId: 's', workspaceCwd: root })
    Object.defineProperty(service, 'recoveryCoordinator', {
      value: { dispose: vi.fn(async () => Promise.reject(recoveryError)) }
    })

    const failure = await service.dispose().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([shutdownError, recoveryError])
  })

  it('describeRuntimeUsage counts bound sessions by kernel state for the disable warning (WS11)', async () => {
    const root = await createStorageRoot()
    const service = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    })
    // s1: bound + ran -> a live-but-idle kernel. s2: bound, never ran -> dormant (no kernel).
    for (const sessionId of ['s1', 's2']) {
      await service.bindRuntime({
        sessionId,
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
    }
    await service.execute({ sessionId: 's1', workspaceCwd: root, code: '1', language: 'python' })

    expect(service.describeRuntimeUsage('python', userPyA.envId)).toEqual({
      running: 0,
      idle: 1,
      dormant: 1
    })
    // A runtime nobody is bound to has no usage.
    expect(service.describeRuntimeUsage('python', userPyB.envId)).toEqual({
      running: 0,
      idle: 0,
      dormant: 0
    })
  })

  it('force-stop disable aborts the running cell and records it cancelled (WS10 force-stop)', async () => {
    const root = await createStorageRoot()
    // A blocking executor: execute() stays pending until terminate() rejects it (a killed kernel).
    let rejectRun: ((error: unknown) => void) | undefined
    let executionCount = 0
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      discoverRuntimes: async (language) => (language === 'python' ? [userPyA, userPyB] : []),
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: {
            enabled: { [userPyA.envId]: true, [userPyB.envId]: true },
            installAuthorized: {}
          },
          manualInterpreters: [],
          packageMirror: {}
        })
      },
      executorFactory: () => ({
        execute: () => {
          executionCount += 1
          if (executionCount > 1) return Promise.reject(new Error('ordinary kernel failure'))
          return new Promise<NotebookExecutionResult>((_resolve, reject) => {
            rejectRun = reject
          })
        },
        shutdown: async () => ({ reaped: true }),
        terminate: async () => {
          rejectRun?.(new Error('kernel killed'))
          rejectRun = undefined
        }
      })
    })
    await service.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })
    const runPromise = service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: 'long()',
      language: 'python'
    })
    // Wait until the cell is genuinely in flight (the executor was invoked).
    await vi.waitFor(() => expect(rejectRun).toBeDefined())

    // Force-stop: abort the running cell now. The killed run is recorded 'cancelled', not 'failed'.
    await service.revokeRuntime('python', userPyA.envId, { force: true })
    const summary = await runPromise
    expect(summary.status).toBe('cancelled')

    // The force-stop marker is one-shot even though external runtimes share the default-python key.
    // A later ordinary executor rejection must not inherit the earlier cancellation classification.
    await service.switchRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyB.envId
    })
    const laterSummary = await service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: 'fail_later()',
      language: 'python'
    })
    expect(laterSummary).toMatchObject({
      status: 'failed',
      text: { traceback: 'ordinary kernel failure' }
    })
  })

  it('managed reinstall aborts an executing default-runtime cell before prefix mutation', async () => {
    const root = await createStorageRoot()
    let resolveRun: ((result: NotebookExecutionResult) => void) | undefined
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      discoverRuntimes: async (language) => (language === 'python' ? [managedPy] : []),
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: { enabled: {}, installAuthorized: {} },
          manualInterpreters: [],
          packageMirror: {}
        })
      },
      executorFactory: () => ({
        execute: () =>
          new Promise<NotebookExecutionResult>((resolve) => {
            resolveRun = resolve
          }),
        shutdown: async () => ({ reaped: true }),
        terminate: async () => {
          // The real NotebookKernelExecutor catches its rejected pending request and resolves execute()
          // with a failed result. Reinstall still owns the terminal classification and records cancelled.
          resolveRun?.({
            status: 'failed',
            kernelDispatched: true,
            stdout: '',
            stderr: 'kernel killed for reinstall',
            traceback: 'kernel killed for reinstall',
            cwdAfter: root,
            outputs: []
          })
          resolveRun = undefined
        }
      })
    })
    const run = service.execute({
      sessionId: 's',
      workspaceCwd: root,
      code: 'long_running()',
      language: 'python'
    })
    await vi.waitFor(() => expect(resolveRun).toBeDefined())

    await service.prepareRuntimeRepair('python', { kind: 'runtime', runtimeId: managedPy.envId })

    await expect(run).resolves.toMatchObject({ status: 'cancelled' })
    expect(isRepairRequired(getRuntimeRoot(root), DEFAULT_PY_ENV)).toBe(true)
  })

  it('persists a binding and restores it active on a fresh service (WS1-rest/WS12 boot revalidation)', async () => {
    const root = await createStorageRoot()
    const enablement = { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    // Service A binds an external runtime -> persisted to run.json.
    const serviceA = bindingService(root, { enablement })
    await serviceA.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    // A FRESH service over the same root (app restart) reloads + revalidates the persisted binding.
    const serviceB = bindingService(root, { enablement })
    const state = await serviceB.state({ sessionId: 's', workspaceCwd: root })
    expect(state.runtimeBindings.python?.runtimeId).toBe(userPyA.envId)
    expect(state.runtimeBindings.python?.status).toBe('active')
  })

  it('reloads a persisted binding as unavailable when its runtime is now disabled (no silent fallback)', async () => {
    const root = await createStorageRoot()
    // Bind while enabled...
    const serviceA = bindingService(root, {
      enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} }
    })
    await serviceA.bindRuntime({
      sessionId: 's',
      workspaceCwd: root,
      language: 'python',
      runtimeId: userPyA.envId
    })

    // ...then a fresh service where the runtime is DISABLED (still detected, gate off) -> unavailable.
    const serviceB = bindingService(root, {
      enablement: { enabled: {}, installAuthorized: {} }
    })
    const state = await serviceB.state({ sessionId: 's', workspaceCwd: root })
    expect(state.runtimeBindings.python?.runtimeId).toBe(userPyA.envId)
    expect(state.runtimeBindings.python?.status).toBe('unavailable')
    expect(state.runtimeBindings.python?.reason).toBe('disabled')
  })

  it('migrates persisted Windows legacy default bindings to the current managed prefixes', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const sessionId = 'legacy-defaults'
    const lane = createRootNotebookLane('default-project', sessionId, `root-frame-${sessionId}`)
    const runtimeRoot = getRuntimeRoot(root)
    const legacyPython = win32.join(runtimeRoot, 'envs', DEFAULT_PY_ENV.toUpperCase(), 'PYTHON.EXE')
    const legacyR = win32.join(
      runtimeRoot,
      'envs',
      DEFAULT_R_ENV.toUpperCase(),
      'lib',
      'r',
      'BIN',
      'r.exe'
    )
    const currentPython = win32.join(runtimeRoot, 'envs', '.p', 'python.exe')
    const currentR = win32.join(runtimeRoot, 'envs', '.r', 'Lib', 'R', 'bin', 'R.exe')

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId,
      workspaceCwd: root,
      lane
    })
    await repository.setRuntimeBindings(
      'default-project',
      sessionId,
      {
        python: {
          language: 'python',
          runtimeId: legacyPython,
          source: 'managed',
          provenance: 'app-managed',
          interpreterPath: legacyPython,
          label: 'Python (managed)',
          status: 'active'
        },
        r: {
          language: 'r',
          runtimeId: legacyR,
          source: 'managed',
          provenance: 'app-managed',
          interpreterPath: legacyR,
          label: 'R (managed)',
          status: 'active'
        }
      },
      lane
    )

    const service = bindingService(root, {
      platform: 'win32',
      repository,
      discovered: [
        {
          language: 'python',
          provenance: 'app-managed',
          envId: currentPython,
          interpreterPath: currentPython,
          label: 'Python (managed)',
          version: '3.12.4',
          runnable: true,
          condaEnv: DEFAULT_PY_ENV
        },
        {
          language: 'r',
          provenance: 'app-managed',
          envId: currentR,
          interpreterPath: currentR,
          label: 'R (managed)',
          version: '4.4.1',
          runnable: true,
          condaEnv: DEFAULT_R_ENV
        }
      ]
    })

    const state = await service.state({ sessionId, workspaceCwd: root })
    expect(state.runtimeBindings.python?.runtimeId).toBe(currentPython)
    expect(state.runtimeBindings.r?.runtimeId).toBe(currentR)

    const persisted = await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId,
      workspaceCwd: root,
      lane
    })
    expect(persisted.runtimeBindings?.python?.runtimeId).toBe(currentPython)
    expect(persisted.runtimeBindings?.r?.runtimeId).toBe(currentR)
  })

  const relocationBindingCases: Array<{
    scenario: string
    platform: NodeJS.Platform
    environment: string
    provenance: 'app-managed' | 'agent-created'
    previous: string
    current: string
    status?: 'active' | 'unavailable'
    reason?: 'disabled' | 'repair-required'
    previousEnabled?: boolean
  }> = [
    {
      scenario: 'linux-default',
      platform: 'linux' as const,
      environment: DEFAULT_PY_ENV,
      provenance: 'app-managed' as const,
      previous: posix.join(
        '/mnt/old/OpenScience',
        'runtime',
        'envs',
        DEFAULT_PY_ENV,
        'bin',
        'python'
      ),
      current: posix.join(
        '/mnt/new/OpenScience',
        'runtime',
        'envs',
        DEFAULT_PY_ENV,
        'bin',
        'python'
      )
    },
    {
      scenario: 'darwin-default',
      platform: 'darwin' as const,
      environment: DEFAULT_PY_ENV,
      provenance: 'app-managed' as const,
      previous: posix.join(
        '/Volumes/Old/OpenScience',
        'runtime',
        'envs',
        DEFAULT_PY_ENV,
        'bin',
        'python'
      ),
      current: posix.join(
        '/Volumes/New/OpenScience',
        'runtime',
        'envs',
        DEFAULT_PY_ENV,
        'bin',
        'python'
      )
    },
    {
      scenario: 'windows-default',
      platform: 'win32' as const,
      environment: DEFAULT_PY_ENV,
      provenance: 'app-managed' as const,
      previous: win32.join('D:\\Old\\OpenScience', 'runtime', 'envs', '.p', 'python.exe'),
      current: win32.join('E:\\New\\OpenScience', 'runtime', 'envs', '.p', 'python.exe')
    },
    {
      scenario: 'windows-legacy-default',
      platform: 'win32' as const,
      environment: DEFAULT_PY_ENV,
      provenance: 'app-managed' as const,
      previous: 'd:\\OLD\\OPENSCIENCE\\runtime\\envs\\DEFAULT-PYTHON\\PYTHON.EXE',
      current: win32.join('E:\\New\\OpenScience', 'runtime', 'envs', '.p', 'python.exe')
    },
    {
      scenario: 'linux-named',
      platform: 'linux' as const,
      environment: 'analysis',
      provenance: 'agent-created' as const,
      previous: posix.join('/mnt/old/OpenScience', 'runtime', 'envs', 'analysis', 'bin', 'python'),
      current: posix.join('/mnt/new/OpenScience', 'runtime', 'envs', 'analysis', 'bin', 'python')
    },
    {
      scenario: 'windows-named',
      platform: 'win32' as const,
      environment: 'analysis',
      provenance: 'agent-created' as const,
      previous: win32.join('D:\\Old\\OpenScience', 'runtime', 'envs', 'analysis', 'python.exe'),
      current: win32.join('E:\\New\\OpenScience', 'runtime', 'envs', 'analysis', 'python.exe')
    },
    {
      scenario: 'linux-disabled-default',
      platform: 'linux',
      environment: DEFAULT_PY_ENV,
      provenance: 'app-managed',
      previous: posix.join(
        '/mnt/old/OpenScience',
        'runtime',
        'envs',
        DEFAULT_PY_ENV,
        'bin',
        'python'
      ),
      current: posix.join(
        '/mnt/new/OpenScience',
        'runtime',
        'envs',
        DEFAULT_PY_ENV,
        'bin',
        'python'
      ),
      status: 'unavailable',
      reason: 'disabled',
      previousEnabled: false
    },
    {
      scenario: 'windows-repair-required-default',
      platform: 'win32',
      environment: DEFAULT_PY_ENV,
      provenance: 'app-managed',
      previous: win32.join('D:\\Old\\OpenScience', 'runtime', 'envs', '.p', 'python.exe'),
      current: win32.join('E:\\New\\OpenScience', 'runtime', 'envs', '.p', 'python.exe'),
      status: 'unavailable',
      reason: 'repair-required'
    }
  ]

  it.each(relocationBindingCases)(
    'migrates a persisted $scenario managed binding after data-root relocation',
    async ({
      platform,
      previous,
      current,
      environment,
      provenance,
      status = 'active',
      reason,
      previousEnabled
    }) => {
      const root = await createStorageRoot()
      const repository = new NotebookRunRepository(root)
      const sessionId = `relocated-${platform}-${environment}`
      const lane = createRootNotebookLane('default-project', sessionId, `root-frame-${sessionId}`)
      const enablement: RuntimeEnablement = {
        enabled: previousEnabled === undefined ? {} : { [previous]: previousEnabled },
        installAuthorized: {}
      }

      await repository.loadOrCreate({
        projectId: 'default-project',
        sessionId,
        workspaceCwd: root,
        lane
      })
      await repository.setRuntimeBindings(
        'default-project',
        sessionId,
        {
          python: {
            language: 'python',
            runtimeId: previous,
            source: 'managed',
            provenance,
            interpreterPath: previous,
            label: 'Python (managed)',
            status,
            ...(reason ? { reason } : {})
          }
        },
        lane
      )
      if (reason === 'repair-required') {
        addRepairRequired(
          getRuntimeRoot(root),
          managedRepairRegistryKey(environment, 'python'),
          'interrupted-install'
        )
      }

      const service = bindingService(root, {
        platform,
        repository,
        enablement,
        discovered: [
          {
            language: 'python',
            provenance,
            envId: current,
            interpreterPath: current,
            label: 'Python (managed)',
            version: '3.12.4',
            runnable: true,
            condaEnv: environment
          }
        ]
      })

      const state = await service.state({ sessionId, workspaceCwd: root })
      expect(state.runtimeBindings.python).toMatchObject({
        runtimeId: current,
        interpreterPath: current,
        status
      })
      expect(state.runtimeBindings.python?.reason).toBe(reason)
      if (previousEnabled === false) expect(enablement.enabled[current]).toBe(false)

      const persisted = await repository.loadOrCreate({
        projectId: 'default-project',
        sessionId,
        workspaceCwd: root,
        lane
      })
      expect(persisted.runtimeBindings?.python?.runtimeId).toBe(current)

      const reloaded = bindingService(root, {
        platform,
        repository,
        enablement,
        discovered: [
          {
            language: 'python',
            provenance,
            envId: current,
            interpreterPath: current,
            label: 'Python (managed)',
            version: '3.12.4',
            runnable: true,
            condaEnv: environment
          }
        ]
      })
      const reloadedState = await reloaded.state({ sessionId, workspaceCwd: root })
      expect(reloadedState.runtimeBindings.python).toMatchObject({ runtimeId: current, status })
      expect(reloadedState.runtimeBindings.python?.reason).toBe(reason)
    }
  )

  it('waits for startup environment restoration before migrating a relocated binding', async () => {
    const root = await createStorageRoot()
    const repository = new NotebookRunRepository(root)
    const sessionId = 'relocated-startup-race'
    const lane = createRootNotebookLane('default-project', sessionId, `root-frame-${sessionId}`)
    const previous = posix.join(
      '/mnt/old/OpenScience',
      'runtime',
      'envs',
      'analysis',
      'bin',
      'python'
    )
    const current = posix.join(
      '/mnt/new/OpenScience',
      'runtime',
      'envs',
      'analysis',
      'bin',
      'python'
    )
    let finishStartup!: () => void
    const startup = new Promise<void>((resolve) => {
      finishStartup = resolve
    })
    let restorationComplete = false
    const discoverRuntimes = vi.fn(async (language: 'python' | 'r') =>
      restorationComplete && language === 'python'
        ? [
            {
              language: 'python' as const,
              provenance: 'agent-created' as const,
              envId: current,
              interpreterPath: current,
              label: 'analysis',
              version: '3.12.4',
              runnable: true,
              condaEnv: 'analysis'
            }
          ]
        : []
    )

    await repository.loadOrCreate({
      projectId: 'default-project',
      sessionId,
      workspaceCwd: root,
      lane
    })
    await repository.setRuntimeBindings(
      'default-project',
      sessionId,
      {
        python: {
          language: 'python',
          runtimeId: previous,
          source: 'managed',
          provenance: 'agent-created',
          interpreterPath: previous,
          label: 'analysis',
          status: 'active'
        }
      },
      lane
    )

    const service = bindingService(root, {
      platform: 'linux',
      repository,
      discoverRuntimes
    })
    service.setEnvironmentStartupBarrier(startup)

    const statePromise = service.state({ sessionId, workspaceCwd: root })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(discoverRuntimes).not.toHaveBeenCalled()

    restorationComplete = true
    finishStartup()

    await expect(statePromise).resolves.toMatchObject({
      runtimeBindings: {
        python: {
          runtimeId: current,
          interpreterPath: current,
          status: 'active'
        }
      }
    })
    await expect(
      repository.loadOrCreate({
        projectId: 'default-project',
        sessionId,
        workspaceCwd: root,
        lane
      })
    ).resolves.toMatchObject({
      runtimeBindings: {
        python: {
          runtimeId: current,
          interpreterPath: current,
          status: 'active'
        }
      }
    })
  })

  // WS9: certify the disable/binding lifecycle across the scenarios from the disable-binding spec.
  describe('disable lifecycle certification (WS9)', () => {
    it('dormant session: revoking a runtime with no live kernel marks it unavailable + rejects', async () => {
      const root = await createStorageRoot()
      const terminations: string[] = []
      const service = bindingService(root, {
        enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
        terminations
      })
      // Bind but NEVER run -> the session is "dormant" (no live kernel).
      await service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })

      // revokeRuntime marks the in-memory binding unavailable synchronously (before the background
      // drain), so no live kernel + no shutdown needed to observe it.
      await service.revokeRuntime('python', userPyA.envId)

      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(state.runtimeBindings.python?.status).toBe('unavailable')
      const run = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(run.status).toBe('failed')
      expect(run.text.traceback).toContain('RUNTIME_BINDING_UNAVAILABLE')
    })

    it('disable-then-resume: after a revoke, switching to an enabled runtime restores execution', async () => {
      const root = await createStorageRoot()
      const executions: NotebookExecutionRequest[] = []
      const service = bindingService(root, {
        enablement: { enabled: { [userPyA.envId]: true }, installAuthorized: {} },
        executions
      })
      await service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
      await service.revokeRuntime('python', userPyA.envId)
      // Rejected while unavailable...
      const rejected = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '1',
        language: 'python'
      })
      expect(rejected.status).toBe('failed')

      // ...the agent recovers by switching to the (enabled) app-managed default.
      await service.switchRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: managedPy.envId
      })
      const resumed = await service.execute({
        sessionId: 's',
        workspaceCwd: root,
        code: '2',
        language: 'python'
      })
      expect(resumed.status).toBe('completed')
      // Managed binding runs via the managed path (no external interpreter override).
      expect(executions.at(-1)?.resolvedInterpreter).toBeUndefined()
    })

    it('A->B->A: switching back to a previously-bound runtime rebinds it', async () => {
      const root = await createStorageRoot()
      const terminations: string[] = []
      const service = bindingService(root, {
        enablement: {
          enabled: { [userPyA.envId]: true, [userPyB.envId]: true },
          installAuthorized: {}
        },
        terminations
      })
      const bind = (runtimeId: string): Promise<unknown> =>
        service.bindRuntime({ sessionId: 's', workspaceCwd: root, language: 'python', runtimeId })
      const to = (runtimeId: string): Promise<unknown> =>
        service.switchRuntime({ sessionId: 's', workspaceCwd: root, language: 'python', runtimeId })

      await bind(userPyA.envId)
      await to(userPyB.envId)
      const back = await service.switchRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: userPyA.envId
      })
      expect(back.bindings.python?.runtimeId).toBe(userPyA.envId)
      // Each switch physically tore down the outgoing kernel.
      expect(terminations.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('leaves the managed-default path unchanged when no runtime is bound', async () => {
    const root = await createStorageRoot()
    const executions: NotebookExecutionRequest[] = []
    const provisionPython = vi.fn(async () => undefined)
    const service = bindingService(root, { executions })
    service.setDefaultEnvProvisioner({ provisionPython, provisionR: async () => undefined })

    await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })
    // No binding -> managed default: no resolved interpreter override, and the default env is built.
    expect(executions[0].resolvedInterpreter).toBeUndefined()
    expect(provisionPython).toHaveBeenCalledTimes(1)
  })

  it('remove-guard: only agent-created envs are removable (app-managed refused)', async () => {
    const root = await createStorageRoot()
    const removed: string[] = []
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'default-project',
      repository: new NotebookRunRepository(root),
      environmentManager: {
        createNamedEnvironment: async (name, language) => ({
          name,
          language,
          ready: true,
          isDefault: false
        }),
        listEnvironments: () => [],
        removeEnvironment: (name) => {
          removed.push(name)
          return []
        }
      }
    })

    // A versioned app-managed env slips past assertSafeEnvName but is refused by the provenance guard.
    await expect(
      service.manageEnvironments({ action: 'remove', name: 'default-python-3.13' })
    ).rejects.toThrow(/app-managed and cannot be removed/)
    expect(removed).toEqual([])

    // An agent-created env is removable.
    await service.manageEnvironments({ action: 'remove', name: 'my-analysis' })
    expect(removed).toEqual(['my-analysis'])
  })

  // End-to-end constructor wiring of NotebookRuntimeSettings: a Settings-added interpreter is folded
  // into the service's REAL default discovery (NOT an injected discoverRuntimes), so it becomes
  // discoverable, enable-able, and bindable — and survives a restart (a fresh service with the same
  // capability still resolves it active, not 'missing'). Uses a real executable interpreter so the
  // version probe + runnability classification run for real. POSIX-only:
  // it relies on a chmod-executable shell shim, which Windows can't run as `<path> --version`.
  it.skipIf(process.platform === 'win32')(
    'discovers, binds, and (across a restart) keeps a constructor-injected manual interpreter',
    async () => {
      // Real discovery is exercised (no injected discoverRuntimes): it enumerates PATH + conda roots and
      // probes every real interpreter's `--version`, and it runs on each list/bind/execute/restart call —
      // so this legitimately needs far more than the default 5s budget on a machine with many envs.
      const root = await createStorageRoot()

      // A real, runnable Python shim OUTSIDE runtime/envs (so discovery classifies it 'user-own'): it
      // answers `--version` with a Python-3 string, which is exactly what the default probe validates.
      const manualDir = await mkdtemp(join(tmpdir(), 'open-science-manual-interp-'))
      const shim = join(manualDir, 'python3')
      await writeFile(shim, '#!/bin/sh\necho "Python 3.12.7"\n')
      await chmod(shim, 0o755)
      // Key everything by the canonical path — discovery's realpath-dedup makes envId the real path.
      const manualPath = await realpath(shim)

      let manualResolverCalls = 0
      const resolver = async (language: 'python' | 'r'): Promise<string[]> => {
        manualResolverCalls += 1
        return language === 'python' ? [manualPath] : []
      }
      // A user-own interpreter defaults OFF, so it must be explicitly enabled (as toggling it on in
      // Settings would) before it is bindable — keyed by the same envId discovery computes.
      const enablement: RuntimeEnablement = {
        enabled: { [manualPath]: true },
        installAuthorized: {}
      }
      const executions: NotebookExecutionRequest[] = []
      const makeService = (): NotebookRuntimeService => {
        // NO discoverRuntimes injected: the REAL default discovery runs and must consult the manual
        // resolver — the wiring under test. Enablement is wired so the user-own env can be enabled.
        const service = new NotebookRuntimeService({
          configRoot: root,
          dataRoot: root,
          projectId: 'default-project',
          repository: new NotebookRunRepository(root),
          notebookRuntimeSettings: {
            getSnapshot: async (language) => ({
              language,
              runtimeEnablement: enablement,
              manualInterpreters: await resolver(language),
              packageMirror: {}
            })
          },
          executorFactory: () => ({
            execute: async (request): Promise<NotebookExecutionResult> => {
              executions.push(request)
              return {
                status: 'completed',
                stdout: '',
                stderr: '',
                traceback: '',
                cwdAfter: request.cwd,
                outputs: []
              }
            },
            shutdown: async () => ({ reaped: true }),
            terminate: async () => undefined
          })
        })
        return service
      }

      const service = makeService()

      // 1) The manual interpreter surfaces through the agent-facing list (real discovery folded it in).
      const listed = await service.listRuntimes({ sessionId: 's', workspaceCwd: root })
      const manualListing = listed.runtimes.find((r) => r.runtimeId === manualPath)
      expect(manualResolverCalls).toBeGreaterThan(0) // proves the resolver was consulted by discovery
      expect(manualListing).toBeDefined()
      expect(manualListing?.provenance).toBe('user-own')
      expect(manualListing?.runnable).toBe(true)
      expect(manualListing?.version).toMatch(/^3\.12\.7/)

      // 2) It is bindable, and a subsequent state/execute reflects the binding + threads the interpreter.
      const bound = await service.bindRuntime({
        sessionId: 's',
        workspaceCwd: root,
        language: 'python',
        runtimeId: manualPath
      })
      if (!('bound' in bound)) throw new Error(bound.error)
      expect(bound.bound.source).toBe('external')
      expect(bound.bound.runtimeId).toBe(manualPath)

      const state = await service.state({ sessionId: 's', workspaceCwd: root })
      expect(state.runtimeBindings.python?.runtimeId).toBe(manualPath)
      expect(state.runtimeBindings.python?.status ?? 'active').toBe('active')

      await service.execute({ sessionId: 's', workspaceCwd: root, code: '1', language: 'python' })
      expect(executions.at(-1)?.resolvedInterpreter?.command).toBe(manualPath)

      // 3) Restart: a FRESH service instance (same manual resolver + same on-disk repository) must still
      // discover the interpreter and rehydrate the persisted binding as ACTIVE — never 'missing'.
      const afterRestart = makeService()
      const restartState = await afterRestart.state({ sessionId: 's', workspaceCwd: root })
      expect(restartState.runtimeBindings.python?.runtimeId).toBe(manualPath)
      expect(restartState.runtimeBindings.python?.status ?? 'active').toBe('active')
      expect(restartState.runtimeBindings.python?.reason).toBeUndefined()

      const relisted = await afterRestart.listRuntimes({ sessionId: 's', workspaceCwd: root })
      expect(relisted.runtimes.some((r) => r.runtimeId === manualPath)).toBe(true)

      await rm(manualDir, { recursive: true, force: true })
    },
    60_000
  )
})
