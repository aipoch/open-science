import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import type { NotebookRunDocument } from '../../shared/notebook'
import { DEFAULT_NOTEBOOK_NETWORK_SETTINGS } from '../../shared/notebook-network'
import { withNotebookExecutionIntent } from './execution-intent'
import {
  MemoryPolicyService,
  type MemoryPolicyObservation,
  type MemoryPressureLevel
} from './memory-policy'
import { NotebookNetworkSandboxOwner } from './network-sandbox-owner'
import { NotebookRuntimeService } from './runtime-service'

const resetOwnership = configureTestRuntimeMetadata()
// Use an existing read-only interpreter; this test never provisions a Python environment.
const python = process.env.OPEN_SCIENCE_TEST_PY_ENV

it.skipIf(process.platform !== 'darwin' || !python)(
  'preserves real Python through memory refusals, then releases its session without stopping another Python',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'notebook-macos-python-')))
    const native = await import('@aipoch/process-tree-native')
    let now = 0
    let pressureLevel: MemoryPressureLevel = 'warning'
    let pressureEventSequence = 1
    let sampleFails = false
    let beforeDispatch: (() => void) | undefined
    let afterMemoryCheck: (() => void) | undefined
    let preparations = 0
    let executions = 0
    const rejections: MemoryPolicyObservation[] = []
    // Control only pressure facts and policy time. Python, stdio, sandbox, native identity,
    // original process-tree teardown and persisted runs remain real.
    const policy = new MemoryPolicyService({
      now: () => now,
      wallNow: () => 1_000_000 + now,
      adapter: {
        platform: 'darwin',
        sample: async () => {
          if (sampleFails) throw new Error('Controlled unavailable sample')
          return {
            platform: 'darwin',
            source: 'controlled-macos-python-tracer',
            executionScope: 'darwin:host',
            facts: { pressureLevel, pressureEventSequence }
          }
        }
      }
    })
    const owner = new NotebookNetworkSandboxOwner({
      resourceRoot: join(process.cwd(), 'packages', 'notebook-network-sandbox', 'vendor'),
      temporaryRoot: join(root, 'commands'),
      getSettings: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      persistAlwaysAllow: async () => DEFAULT_NOTEBOOK_NETWORK_SETTINGS,
      requestDecision: async () => 'deny',
      getGrantedLocalRoots: async () => [
        {
          id: 'python-fixture',
          path: await realpath(dirname(dirname(python!))),
          name: 'Python fixture',
          access: 'ro'
        }
      ]
    })
    const service = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'macos-python',
      callbacks: { onMemoryPolicyRejected: (_context, state) => rejections.push(state) },
      memoryPolicy: {
        getState: async (request) => {
          const state = await policy.getState(request)
          afterMemoryCheck?.()
          return state
        },
        currentState: (request) => policy.currentState(request),
        subscribe: (listener) => policy.subscribe(listener),
        setActive: (active) => policy.setActive(active),
        dispose: () => policy.dispose()
      },
      processSandbox: {
        wrap: async (invocation) => {
          preparations++
          const wrapped = await owner.wrap(invocation)
          return {
            ...wrapped,
            beginExecution: (request) => {
              const end = wrapped.beginExecution?.(request)
              executions++
              beforeDispatch?.()
              return () => end?.()
            }
          }
        }
      },
      discoverRuntimes: async (language) =>
        language === 'python'
          ? [
              {
                language: 'python',
                provenance: 'user-own',
                envId: python!,
                interpreterPath: python!,
                label: 'existing test interpreter',
                version: 'fixture',
                runnable: true
              }
            ]
          : [],
      notebookRuntimeSettings: {
        getSnapshot: async (language) => ({
          language,
          runtimeEnablement: { enabled: { [python!]: true }, installAuthorized: {} },
          manualInterpreters: [],
          packageMirror: {}
        })
      }
    })
    const scope = { projectId: 'macos-python', sessionId: 'target', workspaceCwd: root }
    const observedProcesses: Array<{ pid: number; uniqueId: string }> = []
    const recover = async (): Promise<void> => {
      pressureLevel = 'normal'
      expect(await policy.getState({ force: true })).toMatchObject({
        status: 'pressured',
        reason: { code: 'mac-memory-recovering' }
      })
      for (let elapsed = 0; elapsed < 20_000; elapsed += 5000) {
        now += 5000
        await policy.getState({ force: true })
      }
      expect(policy.currentState()).toMatchObject({ status: 'healthy' })
    }
    try {
      await service.bindRuntime({ ...scope, language: 'python', runtimeId: python! })
      const initial = await service.state(scope)
      const sentinel = join(initial.dataRoot, 'must-not-execute')
      const forbiddenCode = `kept = 999; __import__('pathlib').Path(${JSON.stringify(sentinel)}).write_text('ran')`
      const coldIntent = service.createExecutionIntent(scope)
      await expect(
        service.execute(withNotebookExecutionIntent({ ...scope, code: forbiddenCode }, coldIntent))
      ).rejects.toMatchObject({
        code: 'NOTEBOOK_MEMORY_PRESSURE',
        recovery: { execution: 'not-started' }
      })
      sampleFails = true
      expect(await policy.getState({ force: true })).toMatchObject({
        status: 'unavailable',
        reason: { code: 'sample-failed' }
      })
      const unavailableIntent = service.createExecutionIntent(scope)
      await expect(
        service.execute(
          withNotebookExecutionIntent({ ...scope, code: forbiddenCode }, unavailableIntent)
        )
      ).rejects.toMatchObject({
        code: 'NOTEBOOK_MEMORY_UNAVAILABLE',
        recovery: { execution: 'not-started' }
      })
      expect(preparations).toBe(0)
      expect(executions).toBe(0)
      expect(service.ownedResources(scope)).toEqual([])
      expect((await service.state(scope)).runs).toEqual([])
      expect(existsSync(sentinel)).toBe(false)

      sampleFails = false
      now += 30_001 // Honor the real sampler's unavailable backoff without sleeping or replaying.
      await recover()
      await service.getMemoryPolicyState({})
      expect(executions).toBe(0)
      for (const intent of [coldIntent, unavailableIntent])
        await expect(
          service.execute(withNotebookExecutionIntent({ ...scope, code: forbiddenCode }, intent))
        ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
      const warmIntent = service.createExecutionIntent(scope)
      const seeded = await service.execute(
        withNotebookExecutionIntent(
          { ...scope, code: 'import os, json; kept = 41; print(json.dumps({"pid": os.getpid()}))' },
          warmIntent
        )
      )
      expect(seeded.status, JSON.stringify(seeded)).toBe('completed')
      const { pid }: { pid: number } = JSON.parse(seeded.text.stdout.trim())
      const identity = native.getDarwinProcess(pid)
      expect(identity).toMatchObject({ pid, uniqueId: expect.any(String) })
      expect(identity!.uniqueId).not.toBe('0')
      const host = native.getDarwinProcess(identity!.ppid)
      expect(host?.uniqueId).toBe(identity!.parentUniqueId)
      observedProcesses.push(identity!, host!)
      const beforeRefusal = await service.state(scope)
      pressureLevel = 'warning'
      pressureEventSequence++
      await policy.getState({ force: true })
      await expect(
        service.execute(withNotebookExecutionIntent({ ...scope, code: forbiddenCode }, warmIntent))
      ).rejects.toMatchObject({ code: 'NOTEBOOK_MEMORY_PRESSURE' })
      expect(preparations).toBe(1)
      expect(executions).toBe(1)
      expect((await service.state(scope)).runs).toEqual(beforeRefusal.runs)
      expect(native.getDarwinProcess(pid)?.uniqueId).toBe(identity!.uniqueId)
      await recover()
      await service.getMemoryPolicyState({})
      expect((await service.state(scope)).runs).toEqual(beforeRefusal.runs)
      await expect(
        service.execute(withNotebookExecutionIntent({ ...scope, code: forbiddenCode }, warmIntent))
      ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })

      beforeDispatch = () => {
        // Final async prepare may legitimately refresh. Expire that sample after it returns,
        // so the synchronous check immediately before the real Python stdin write must refuse.
        afterMemoryCheck = () => {
          now += 2001
          afterMemoryCheck = undefined
        }
      }
      const finalIntent = service.createExecutionIntent(scope)
      const refused = await service.execute(
        withNotebookExecutionIntent({ ...scope, code: forbiddenCode }, finalIntent)
      )
      expect(refused).toMatchObject({ status: 'failed', recovery: { execution: 'not-started' } })
      expect(preparations).toBe(1)
      expect(executions).toBe(2)
      const afterRefusal = await service.state(scope)
      expect(afterRefusal.runs).toHaveLength(beforeRefusal.runs.length + 1)
      expect(afterRefusal.runs.at(-1)).toMatchObject({
        status: 'failed',
        kernelDispatched: false,
        executionStarted: false,
        recovery: { execution: 'not-started' }
      })
      expect(rejections.map(({ status, reason }) => ({ status, code: reason.code }))).toEqual([
        { status: 'pressured', code: 'mac-memory-warning' },
        { status: 'unavailable', code: 'sample-failed' },
        { status: 'pressured', code: 'mac-memory-warning' },
        { status: 'unavailable', code: 'sample-expired' }
      ])
      expect(existsSync(sentinel)).toBe(false)
      expect(native.getDarwinProcess(pid)?.uniqueId).toBe(identity!.uniqueId)
      beforeDispatch = undefined
      expect(await policy.getState({ force: true })).toMatchObject({ status: 'healthy' })
      await service.getMemoryPolicyState({})
      expect((await service.state(scope)).runs).toEqual(afterRefusal.runs)
      expect(executions).toBe(2)
      await expect(
        service.execute(withNotebookExecutionIntent({ ...scope, code: forbiddenCode }, finalIntent))
      ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
      const continuedIntent = service.createExecutionIntent(scope)
      const continued = await service.execute(
        withNotebookExecutionIntent(
          {
            ...scope,
            code: [
              'import subprocess, sys',
              'descendant = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
              'kept += 1',
              'print(json.dumps({"pid": os.getpid(), "kept": kept, "descendant": descendant.pid}))'
            ].join('\n')
          },
          continuedIntent
        )
      )
      expect(continued.status).toBe('completed')
      const workload: { pid: number; kept: number; descendant: number } = JSON.parse(
        continued.text.stdout.trim()
      )
      expect(workload).toMatchObject({ pid, kept: 42 })
      expect(native.getDarwinProcess(pid)?.uniqueId).toBe(identity!.uniqueId)
      expect(existsSync(sentinel)).toBe(false)
      const descendant = native.getDarwinProcess(workload.descendant)
      expect(descendant).toMatchObject({
        pid: workload.descendant,
        parentUniqueId: identity!.uniqueId,
        uniqueId: expect.any(String)
      })
      expect(descendant!.sid).toBe(workload.descendant)
      observedProcesses.push(descendant!)

      const repl = await service.executeControl(
        withNotebookExecutionIntent(
          { ...scope, code: 'globalThis.kept = 17; console.log(process.pid)' },
          continuedIntent
        )
      )
      expect(repl.status).toBe('completed')
      const replIdentity = native.getDarwinProcess(Number(repl.stdout.trim()))
      expect(replIdentity).toMatchObject({ uniqueId: expect.any(String) })
      const replHost = native.getDarwinProcess(replIdentity!.ppid)
      expect(replHost?.uniqueId).toBe(replIdentity!.parentUniqueId)
      observedProcesses.push(replIdentity!, replHost!)

      const other = { ...scope, sessionId: 'retained' }
      await service.bindRuntime({ ...other, language: 'python', runtimeId: python! })
      const otherIntent = service.createExecutionIntent(other)
      const retained = await service.execute(
        withNotebookExecutionIntent(
          { ...other, code: 'import os, json; kept = 73; print(os.getpid())' },
          otherIntent
        )
      )
      expect(retained.status).toBe('completed')
      const otherIdentity = native.getDarwinProcess(Number(retained.text.stdout.trim()))
      expect(otherIdentity).toMatchObject({ uniqueId: expect.any(String) })
      const otherHost = native.getDarwinProcess(otherIdentity!.ppid)
      expect(otherHost?.uniqueId).toBe(otherIdentity!.parentUniqueId)
      observedProcesses.push(otherIdentity!, otherHost!)

      const beforeRelease = await service.state(scope)
      const persistedBefore: NotebookRunDocument = JSON.parse(
        await readFile(beforeRelease.runJsonPath, 'utf8')
      )
      const group = (await service.getProjectResources(scope)).groups.find(
        ({ sessionId }) => sessionId === scope.sessionId
      )!
      expect(group.resources).toHaveLength(2)
      expect(group.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ group: 'kernel', kind: 'python', phase: 'idle' }),
          expect.objectContaining({ group: 'kernel', kind: 'repl', phase: 'idle' })
        ])
      )
      expect((await service.getProjectResources(scope)).groups).toContainEqual(group)
      const operation = await service.releaseSessionResources(
        { ...scope, revision: group.revision },
        () => undefined
      )
      await service.waitForSessionTeardown(scope)
      const release = service.getResourceRelease({ ...scope, operationId: operation.operationId })
      expect(release.status).toBe('released')
      expect(release.resources).toEqual(
        group.resources.map(({ id, group, kind, laneKey, environment }) => ({
          id,
          group,
          kind,
          laneKey,
          environment,
          status: 'released',
          processesTerminated: true,
          networkClosed: true,
          temporaryResourcesRemoved: true,
          projection: 'complete',
          error: undefined
        }))
      )
      const targetProcesses = [identity!, host!, descendant!, replIdentity!, replHost!]
      for (const original of targetProcesses) {
        expect(native.getDarwinProcess(original.pid)?.uniqueId).not.toBe(original.uniqueId)
        expect(() => process.kill(original.pid, 0)).toThrow()
      }
      expect(service.ownedResources(scope)).toEqual([])
      const afterRelease = await service.state(scope)
      const persistedAfter: NotebookRunDocument = JSON.parse(
        await readFile(afterRelease.runJsonPath, 'utf8')
      )
      expect(persistedAfter.version).toBe(1)
      expect(persistedAfter.runs).toEqual(persistedBefore.runs)
      expect(persistedAfter.kernel.terminatedKernelInstances).toEqual(
        expect.arrayContaining([
          { kind: 'python', environment: 'default-python' },
          { kind: 'repl' }
        ])
      )
      expect(afterRelease.environments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ processKey: 'python:default-python', status: 'terminated' }),
          expect.objectContaining({ processKey: 'repl', status: 'terminated' })
        ])
      )
      await expect(
        service.execute(
          withNotebookExecutionIntent({ ...scope, code: forbiddenCode }, continuedIntent)
        )
      ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
      expect((await service.state(scope)).runs).toEqual(afterRelease.runs)
      expect(service.ownedResources(scope)).toEqual([])
      expect(existsSync(sentinel)).toBe(false)
      expect(native.getDarwinProcess(otherIdentity!.pid)?.uniqueId).toBe(otherIdentity!.uniqueId)
      expect(native.getDarwinProcess(otherHost!.pid)?.uniqueId).toBe(otherHost!.uniqueId)
      const reusedOther = await service.execute(
        withNotebookExecutionIntent(
          { ...other, code: 'kept += 1; print(json.dumps({"pid": os.getpid(), "kept": kept}))' },
          otherIntent
        )
      )
      expect(reusedOther.status).toBe('completed')
      expect(JSON.parse(reusedOther.text.stdout.trim())).toEqual({
        pid: otherIdentity!.pid,
        kept: 74
      })
      expect(native.getDarwinProcess(otherIdentity!.pid)?.uniqueId).toBe(otherIdentity!.uniqueId)
      console.info(
        'macOS real Python admission and session release tracer',
        JSON.stringify({
          node: process.version,
          python,
          controlled: 'macOS pressure facts, policy clock and final beginExecution boundary',
          rejections,
          targetProcesses,
          otherIdentity,
          otherHost,
          preparations,
          executions,
          retainedHistory: persistedAfter.runs.length,
          release
        })
      )
    } finally {
      let disposal: { reaped: boolean } | undefined
      let ownerDisposed = false
      let rootRemoved = false
      try {
        try {
          disposal = await service.dispose()
          expect(disposal).toEqual({ reaped: true })
        } finally {
          try {
            await owner.dispose()
            ownerDisposed = true
          } finally {
            await resetOwnership()
          }
        }
        for (const original of observedProcesses)
          expect(native.getDarwinProcess(original.pid)?.uniqueId).not.toBe(original.uniqueId)
        await rm(root, { recursive: true, force: true })
        expect(existsSync(root)).toBe(false)
        rootRemoved = true
        console.info(
          'macOS real Python tracer cleanup',
          JSON.stringify({ root, removed: rootRemoved, originalProcesses: observedProcesses })
        )
      } finally {
        if (!rootRemoved)
          console.error('macOS real Python tracer fixture retained after incomplete cleanup', {
            root,
            disposal,
            ownerDisposed,
            originalProcesses: observedProcesses
          })
      }
    }
  },
  60_000
)
