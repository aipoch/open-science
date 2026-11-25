import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NotebookRuntimeService } from './runtime-service'
import { healthyNotebookMemoryPolicy } from './memory-policy.test-support'
import { withNotebookExecutionIntent } from './execution-intent'
import { NotebookKernelExecutor } from './kernel-executor'
import { terminateProcessTree } from '../process-tree'
import { MemoryPolicyService, type MemoryPolicySample } from './memory-policy'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'
import { SessionReproducibilityBatches } from '../artifacts/session-reproducibility'

it.skipIf(process.platform === 'win32')(
  'requires a fresh confirmation when another original resource appears and preserves both trees',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-confirmation-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      shellRuntimeBinding: { kind: 'native-posix', shell: '/bin/bash' }
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      const displayed = await service.getProjectResources({ projectId: 'project' })
      expect(displayed.groups).toHaveLength(1)
      expect(displayed.groups[0].resources).toEqual([
        expect.objectContaining({ kind: 'repl', group: 'kernel' })
      ])
      expect(displayed.groups[0].resources[0].memory.rssBytes).toBeGreaterThan(0)
      expect((await service.getProjectResources(scope)).groups[0].revision).toBe(
        displayed.groups[0].revision
      )
      await service.executeShell({
        ...scope,
        command: 'kept_shell_value=73; printf ready'
      })
      await expect(
        service.releaseSessionResources(
          { ...scope, revision: displayed.groups[0].revision },
          () => undefined
        )
      ).rejects.toThrow(/changed.*refresh|refresh.*changed/i)
      await expect(
        service.executeControl({ ...scope, code: 'console.log(kept)' })
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('41') })
      await expect(
        service.executeShell({ ...scope, command: 'printf "$kept_shell_value"' })
      ).resolves.toMatchObject({ exitCode: 0, stdout: '73' })
    } finally {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'drops a disappeared group confirmation after original shutdown and keeps other projects readable',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-empty-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy()
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    const other = { ...scope, projectId: 'other-project', sessionId: 'other-session' }
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      await service.executeControl({ ...other, code: 'globalThis.kept = 73' })
      const group = (await service.getProjectResources(scope)).groups[0]
      const otherGroup = (await service.getProjectResources(other)).groups[0]
      await service.shutdown(scope)
      expect((await service.getProjectResources(scope)).groups).toEqual([])
      await expect(
        service.releaseSessionResources({ ...scope, revision: group.revision }, () => undefined)
      ).rejects.toThrow(/changed.*refresh|refresh.*changed/i)
      expect((await service.getProjectResources(other)).groups[0].revision).toBe(
        otherGroup.revision
      )
      await expect(
        service.executeControl({ ...other, code: 'console.log(kept)' })
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('73') })
    } finally {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'refuses an in-flight binding conflict immediately without queueing a later stop',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-binding-'))
    const entered = Promise.withResolvers<void>()
    const discovery = Promise.withResolvers<[]>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      discoverRuntimes: async () => {
        entered.resolve()
        return discovery.promise
      }
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    const intent = service.createExecutionIntent(scope)
    let binding: Promise<unknown> | undefined
    try {
      await service.executeControl(
        withNotebookExecutionIntent({ ...scope, code: 'globalThis.kept = 41' }, intent)
      )
      binding = service.bindRuntime({ ...scope, language: 'python', runtimeId: 'unavailable' })
      await entered.promise
      const group = (await service.getProjectResources(scope)).groups[0]
      expect(group.releaseBlockedReason).toBe('runtime-binding-changing')
      await expect(
        service.releaseSessionResources({ ...scope, revision: group.revision }, () => undefined)
      ).rejects.toThrow(/binding.*changing/i)
      expect(intent.refusalId).toBeUndefined()
      discovery.resolve([])
      await binding
      await expect(
        service.executeControl(
          withNotebookExecutionIntent({ ...scope, code: 'console.log(kept)' }, intent)
        )
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('41') })
    } finally {
      discovery.resolve([])
      await binding
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'cancels only the confirmed admission while an unrelated caller shares the late healthy sample',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-sample-'))
    const sampled = Promise.withResolvers<MemoryPolicySample>()
    const entered = Promise.withResolvers<void>()
    const policy = new MemoryPolicyService({
      adapter: {
        platform: 'linux',
        sample: async () => {
          entered.resolve()
          return sampled.promise
        }
      }
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: policy
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    const active = service.executeControl({ ...scope, code: 'console.log("must not run")' })
    void active.catch(() => undefined)
    const other = service.executeControl({ ...scope, sessionId: 'other', code: 'console.log(73)' })
    void other.catch(() => undefined)
    try {
      await entered.promise
      const group = (await service.getProjectResources(scope)).groups.find(
        ({ sessionId }) => sessionId === scope.sessionId
      )!
      expect(group.resources).toEqual([expect.objectContaining({ group: 'operation' })])
      const released = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await service.waitForSessionTeardown(scope)
      await expect(active).rejects.toThrow(/released|abort/i)
      sampled.resolve({
        platform: 'linux',
        source: 'test',
        executionScope: 'linux:host',
        facts: {
          availableBytes: 800,
          totalBytes: 1000,
          overcommitMode: 0
        }
      })
      await expect(other).resolves.toMatchObject({
        status: 'completed',
        stdout: expect.stringContaining('73')
      })
      expect(
        service.getResourceRelease({ ...scope, operationId: released.operationId }).status
      ).toBe('released')
      expect(service.ownedResources(scope)).toEqual([])
      expect((await service.state(scope)).runs).toEqual([])
    } finally {
      sampled.resolve({
        platform: 'linux',
        source: 'test',
        executionScope: 'linux:host',
        facts: {
          availableBytes: 800,
          totalBytes: 1000,
          overcommitMode: 0
        }
      })
      await service.dispose()
      await Promise.allSettled([active, other])
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'drains the confirmed active work, keeps history and an unrelated namespace, and leaves the old intent blocked',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-active-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy()
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    const other = { ...scope, sessionId: 'other' }
    const intent = service.createExecutionIntent(scope)
    let active: Promise<unknown> | undefined
    try {
      await service.executeControl({ ...other, code: 'globalThis.kept = 73' })
      active = service.executeControl(
        withNotebookExecutionIntent(
          {
            ...scope,
            code: 'console.log("started"); await new Promise(() => {})'
          },
          intent
        )
      )
      await vi.waitFor(() =>
        expect(
          service
            .ownedResources(scope)
            .some((resource) => resource.group === 'kernel' && resource.phase === 'running')
        ).toBe(true)
      )
      const displayed = await service.getProjectResources(scope)
      const group = displayed.groups.find(({ sessionId }) => sessionId === scope.sessionId)!
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await service.waitForSessionTeardown(scope)
      await expect(active).resolves.toMatchObject({ status: 'cancelled' })
      expect(
        service.getResourceRelease({ ...scope, operationId: operation.operationId })
      ).toMatchObject({
        status: 'released',
        resources: expect.arrayContaining([
          expect.objectContaining({ group: 'operation', status: 'released' }),
          expect.objectContaining({ group: 'kernel', status: 'released', projection: 'complete' })
        ])
      })
      expect(service.ownedResources(scope)).toEqual([])
      const history = await service.state(scope)
      expect(history.runs).toEqual([expect.objectContaining({ status: 'cancelled' })])
      await expect(
        service.executeControl(
          withNotebookExecutionIntent(
            {
              ...scope,
              code: 'globalThis.shouldNotExist = true'
            },
            intent
          )
        )
      ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
      await expect(
        service.executeControl({ ...other, code: 'console.log(kept)' })
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('73') })
      expect((await service.getProjectResources(scope)).pendingDecisions).toEqual([
        { projectId: scope.projectId, sessionId: scope.sessionId, refusalId: intent.refusalId }
      ])
    } finally {
      await service.dispose()
      await active
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'retains failed original cleanup and retries the same operation without including a successor',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-partial-'))
    let proofAvailable = false
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      executorFactory: () =>
        new NotebookKernelExecutor({
          replLoopPath: join(__dirname, '../../../resources/notebook/repl_loop.js'),
          terminateTree: async (child) => {
            await terminateProcessTree(child)
            return { reaped: proofAvailable }
          }
        }),
      shellRuntimeBinding: { kind: 'native-posix', shell: '/bin/bash' }
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      await service.executeShell({ ...scope, command: 'original_shell_value=13' })
      const group = (await service.getProjectResources(scope)).groups[0]
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
      const request = { ...scope, operationId: operation.operationId }
      expect(service.getResourceRelease(request)).toMatchObject({
        status: 'partial',
        resources: [
          expect.objectContaining({
            id: group.resources[0].id,
            group: 'kernel',
            laneKey: expect.any(String),
            status: 'incomplete'
          }),
          expect.objectContaining({
            id: group.resources[1].id,
            group: 'shell',
            laneKey: expect.any(String),
            status: 'released'
          })
        ]
      })
      expect((await service.getProjectResources(scope)).groups[0].resources).toEqual([
        expect.objectContaining({ id: group.resources[0].id, phase: 'cleanup-pending' })
      ])
      await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
      const freshIntent = service.createExecutionIntent(scope)
      await service.executeShell(
        withNotebookExecutionIntent({ ...scope, command: 'kept_shell_value=73' }, freshIntent)
      )
      proofAvailable = true
      await service.retryResourceRelease(request, () => undefined)
      await service.waitForSessionTeardown(scope)
      expect(service.getResourceRelease(request).status).toBe('released')
      await expect(
        service.executeShell(
          withNotebookExecutionIntent(
            { ...scope, command: 'printf "$kept_shell_value"' },
            freshIntent
          )
        )
      ).resolves.toMatchObject({ exitCode: 0, stdout: '73' })
      await service.executeControl({ ...scope, code: 'globalThis.kept = 73' })
      expect((await service.retryResourceRelease(request, () => undefined)).status).toBe('released')
      await expect(
        service.executeControl({ ...scope, code: 'console.log(kept)' })
      ).resolves.toMatchObject({ stdout: expect.stringContaining('73') })
    } finally {
      proofAvailable = true
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'keeps the original cleanup fence when termination cannot be persisted and permits export only after retry',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-projection-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy()
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    let restore: (() => Promise<void>) | undefined
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      const reference = (await service.getSessionReference(scope))!
      const group = (await service.getProjectResources(scope)).groups[0]
      await rename(reference.runJsonPath, `${reference.runJsonPath}.backup`)
      await mkdir(reference.runJsonPath)
      restore = async () => {
        await rm(reference.runJsonPath, { recursive: true })
        await rename(`${reference.runJsonPath}.backup`, reference.runJsonPath)
      }
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
      const request = { ...scope, operationId: operation.operationId }
      expect(service.getResourceRelease(request)).toMatchObject({
        status: 'partial',
        resources: [
          expect.objectContaining({
            id: group.resources[0].id,
            status: 'incomplete',
            projection: 'failed'
          })
        ]
      })
      expect((await service.getProjectResources(scope)).groups[0].resources).toEqual([
        expect.objectContaining({ id: group.resources[0].id, phase: 'cleanup-pending' })
      ])
      await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(/cleanup.*incomplete/i)
      await restore()
      restore = undefined
      await expect(
        service.executeControl({ ...scope, code: 'globalThis.unconfirmed = true' })
      ).rejects.toThrow(/cleanup.*incomplete/i)
      await service.retryResourceRelease(request, () => undefined)
      await service.waitForSessionTeardown(scope)
      expect(service.getResourceRelease(request).status).toBe('released')
      const history = await service.state(scope)
      expect(history.runs[0]).toMatchObject({ status: 'completed' })
      expect(history.environments).toContainEqual(
        expect.objectContaining({ processKey: 'repl', status: 'terminated' })
      )
    } finally {
      await restore?.()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'retries the original cleanup without marking a replacement kernel terminated',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-replaced-kernel-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy()
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      const { runJsonPath } = (await service.getSessionReference(scope))!
      const { revision } = (await service.getProjectResources(scope)).groups[0]
      const backup = `${runJsonPath}.backup`
      await rename(runJsonPath, backup)
      const request = await (async () => {
        try {
          await mkdir(runJsonPath)
          const { operationId } = await service.releaseSessionResources(
            { ...scope, revision },
            () => undefined
          )
          await expect(service.waitForSessionTeardown(scope)).rejects.toThrow(
            /cleanup.*incomplete/i
          )
          return { ...scope, operationId }
        } finally {
          await rm(runJsonPath, { recursive: true, force: true })
          await rename(backup, runJsonPath)
        }
      })()
      expect(service.getResourceRelease(request).status).toBe('partial')

      await service.shutdown(scope)
      await expect(
        service.executeControl({ ...scope, code: 'globalThis.kept = 73' })
      ).resolves.toMatchObject({ status: 'completed' })
      const kernel = JSON.parse(await readFile(runJsonPath, 'utf8')).kernel
      expect(kernel.lastKnownStatus).toBe('idle')

      await service.retryResourceRelease(request, () => undefined)
      await service.waitForSessionTeardown(scope)
      expect(service.getResourceRelease(request).status).toBe('released')
      expect(JSON.parse(await readFile(runJsonPath, 'utf8')).kernel).toEqual(kernel)
      await expect(
        service.executeControl({ ...scope, code: 'console.log(kept)' })
      ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('73') })
    } finally {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'retains the data-root writer through cleanup and termination persistence before a migration can copy',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-writer-'))
    const entered = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      executorFactory: () =>
        new NotebookKernelExecutor({
          replLoopPath: join(__dirname, '../../../resources/notebook/repl_loop.js'),
          terminateTree: async (child) => {
            const result = await terminateProcessTree(child)
            entered.resolve()
            await cleanup.promise
            return result
          }
        })
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    try {
      await service.executeControl({ ...scope, code: 'globalThis.kept = 41' })
      const group = (await service.getProjectResources(scope)).groups[0]
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await entered.promise
      beginMigration()
      let canCopy = false
      const writers = waitForDataRootWriters().then(() => {
        canCopy = true
      })
      await Promise.resolve()
      expect(canCopy).toBe(false)
      cleanup.resolve()
      await service.waitForSessionTeardown(scope)
      await writers
      expect(
        service.getResourceRelease({ ...scope, operationId: operation.operationId }).status
      ).toBe('released')
      expect((await service.state(scope)).environments).toContainEqual(
        expect.objectContaining({ processKey: 'repl', status: 'terminated' })
      )
    } finally {
      cleanup.resolve()
      clearMigrationPending()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'projects only the current originating continuation across projects and never creates an intent while reading',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-origin-'))
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy()
    })
    const target = { projectId: 'target-project', sessionId: 'target', workspaceCwd: root }
    const origin = { projectId: 'origin-project', sessionId: 'origin' }
    const unseen = { projectId: 'origin-project', sessionId: 'unseen' }
    const intent = service.createExecutionIntent(origin)
    try {
      await service.executeControl(
        withNotebookExecutionIntent({ ...target, code: 'console.log(41)' }, intent)
      )
      const group = (await service.getProjectResources(target)).groups[0]
      const release = await service.releaseSessionResources(
        { ...target, revision: group.revision },
        () => undefined
      )
      await service.waitForSessionTeardown(target)
      const request = { ...target, operationId: release.operationId }
      expect(service.getResourceRelease(request).continuations).toEqual([
        { ...origin, refusalId: intent.refusalId }
      ])
      expect((await service.getProjectResources(target)).releases[0].continuations).toEqual([
        { ...origin, refusalId: intent.refusalId }
      ])
      expect(service.currentExecutionIntent(unseen)).toBeUndefined()
      expect(
        (await service.getProjectResources({ projectId: unseen.projectId })).pendingDecisions
      ).toEqual([{ ...origin, refusalId: intent.refusalId }])
      expect(service.currentExecutionIntent(unseen)).toBeUndefined()
      service.createExecutionIntent(origin)
      expect(service.getResourceRelease(request).continuations).toEqual([])
      expect((await service.getProjectResources(target)).releases[0].continuations).toEqual([])
      expect((await service.getProjectResources(origin)).pendingDecisions).toEqual([])
    } finally {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32').each(['healthy', 'pressured', 'unavailable'] as const)(
  'permits confirmed cleanup when execution memory is %s and retains the completed history',
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-memory-'))
    let current = 'healthy'
    const policy = new MemoryPolicyService({
      adapter: {
        platform: 'win32',
        sample: async () => {
          if (current === 'unavailable') throw new Error('Memory sampler unavailable')
          return {
            platform: 'win32',
            source: 'test',
            executionScope: 'windows:host',
            facts: {
              availableBytes: current === 'pressured' ? 2 : 80,
              totalBytes: 100,
              committedBytes: 50,
              commitLimitBytes: 100
            }
          }
        }
      }
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: policy
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    try {
      await service.executeControl({ ...scope, code: 'console.log(41)' })
      current = status
      expect((await policy.getState({ force: true })).status).toBe(status)
      const group = (await service.getProjectResources(scope)).groups[0]
      const release = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await service.waitForSessionTeardown(scope)
      expect(
        service.getResourceRelease({ ...scope, operationId: release.operationId }).status
      ).toBe('released')
      expect(service.ownedResources(scope)).toEqual([])
      expect((await service.state(scope)).runs).toEqual([
        expect.objectContaining({
          status: 'completed',
          text: expect.objectContaining({ stdout: expect.stringContaining('41') })
        })
      ])
    } finally {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)

it('observes and releases an unstarted original batch without opening Compute or starting any target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-release-ready-batch-'))
  const setActive = vi.fn()
  const run = vi.fn()
  const batches = new SessionReproducibilityBatches({
    preflight: async () => ({
      recipeId: 'a'.repeat(64),
      steps: 1,
      inputBytes: 0,
      environmentCount: 1
    }),
    run,
    cancel: vi.fn(),
    onResourcesChanged: () => service.refreshResourceActivity()
  })
  const service: NotebookRuntimeService = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: { ...healthyNotebookMemoryPolicy(), setActive },
    externalNotebookResources: (scope) => batches.resources(scope)
  })
  const scope = { projectId: 'project', sessionId: 'session' }
  try {
    const ready = (await batches.command(
      {
        projectId: scope.projectId,
        appSessionId: scope.sessionId,
        action: 'prepare',
        targets: [{ artifactId: 'artifact', versionId: 'version', name: 'result.csv' }]
      },
      1
    ))!
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledWith(true))
    const group = (await service.getProjectResources(scope)).groups[0]
    expect(group.resources).toEqual([expect.objectContaining({ group: 'batch', phase: 'ready' })])
    const operation = await service.releaseSessionResources(
      { ...scope, revision: group.revision },
      () => undefined
    )
    await service.waitForSessionTeardown(scope)
    expect(
      service.getResourceRelease({ ...scope, operationId: operation.operationId }).status
    ).toBe('released')
    await vi.waitFor(() => expect(setActive).toHaveBeenLastCalledWith(false))
    await expect(
      batches.command(
        {
          projectId: scope.projectId,
          appSessionId: scope.sessionId,
          action: 'start',
          batchId: ready.batchId
        },
        1
      )
    ).rejects.toThrow(/no longer current/i)
    expect(run).not.toHaveBeenCalled()
    expect(service.ownedResources()).toEqual([])
  } finally {
    await batches.stopWhere(() => true)
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps a current refused decision visible after memory recovers even when no resource was ever created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'notebook-release-empty-refusal-'))
  let availableBytes = 2
  const policy = new MemoryPolicyService({
    adapter: {
      platform: 'win32',
      sample: async () => ({
        platform: 'win32',
        source: 'test',
        executionScope: 'windows:host',
        facts: {
          availableBytes,
          totalBytes: 100,
          committedBytes: 50,
          commitLimitBytes: 100
        }
      })
    }
  })
  const service = new NotebookRuntimeService({
    configRoot: root,
    dataRoot: root,
    projectId: 'project',
    memoryPolicy: policy
  })
  const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
  const intent = service.createExecutionIntent(scope)
  try {
    await expect(
      service.executeControl(
        withNotebookExecutionIntent({ ...scope, code: 'console.log("not started")' }, intent)
      )
    ).rejects.toMatchObject({ code: 'NOTEBOOK_MEMORY_PRESSURE' })
    availableBytes = 80
    expect((await policy.getState({ force: true })).status).toBe('healthy')
    expect(await service.getProjectResources(scope)).toEqual({
      groups: [],
      releases: [],
      pendingDecisions: [
        {
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          refusalId: intent.refusalId,
          kind: 'memory'
        }
      ]
    })
    expect(service.currentExecutionIntent(scope)).toBe(intent)
    await expect(
      service.executeControl(
        withNotebookExecutionIntent({ ...scope, code: 'console.log("still blocked")' }, intent)
      )
    ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
    expect(service.ownedResources()).toEqual([])
  } finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32').each(['session', 'global', 'dispose'] as const)(
  'lets the original %s teardown join a committed manual release without waiting for itself',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'notebook-release-lifecycle-'))
    const entered = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'project',
      memoryPolicy: healthyNotebookMemoryPolicy(),
      executorFactory: () =>
        new NotebookKernelExecutor({
          replLoopPath: join(__dirname, '../../../resources/notebook/repl_loop.js'),
          terminateTree: async (child) => {
            const result = await terminateProcessTree(child)
            entered.resolve()
            await cleanup.promise
            return result
          }
        })
    })
    const scope = { projectId: 'project', sessionId: 'session', workspaceCwd: root }
    try {
      await service.executeControl({ ...scope, code: 'console.log(41)' })
      const group = (await service.getProjectResources(scope)).groups[0]
      const release = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await entered.promise
      let stopped = false
      const teardown = (
        kind === 'session'
          ? service.shutdownSession(scope.sessionId)
          : kind === 'global'
            ? service.shutdownAll()
            : service.dispose()
      ).then(() => {
        stopped = true
      })
      await Promise.resolve()
      expect(stopped).toBe(false)
      cleanup.resolve()
      await teardown
      expect(
        service.getResourceRelease({ ...scope, operationId: release.operationId }).status
      ).toBe('released')
      expect(service.ownedResources(scope)).toEqual([])
    } finally {
      cleanup.resolve()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
)
