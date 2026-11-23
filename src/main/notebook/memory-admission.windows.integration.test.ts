import { createRequire } from 'node:module'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { inspectOwnedWindowsProcessIds } from '../process-tree-windows'
import type { NotebookMemoryPolicyPort } from './execution-admission'
import { withNotebookExecutionIntent } from './execution-intent'
import { createWindowsStandardProcessSandbox } from './fixtures/windows-standard-process-sandbox'
import { MemoryPolicyService, type MemoryPolicyObservation } from './memory-policy'
import { NotebookRuntimeService } from './runtime-service'

const requireNative = createRequire(import.meta.url)
const resetOwnership = configureTestRuntimeMetadata()
const refusals = [
  { label: 'physical pressure', status: 'pressured', reason: 'windows-physical-low' },
  { label: 'Commit pressure', status: 'pressured', reason: 'windows-commit-low' },
  { label: 'unavailable sampling', status: 'unavailable', reason: 'sample-failed' }
] as const

describe.skipIf(process.platform !== 'win32')(
  'Windows final memory admission (real REPL and Job owner, controlled observations)',
  () => {
    let root: string
    let sandbox: Awaited<ReturnType<typeof createWindowsStandardProcessSandbox>>
    let service: NotebookRuntimeService
    let observation: MemoryPolicyObservation
    let policy: NotebookMemoryPolicyPort
    let beforeDispatch: (() => void) | undefined
    let afterMemoryCheck: (() => void) | undefined
    let executions: number
    let preparations: number
    let rejections: MemoryPolicyObservation[]

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'notebook-windows-admission-'))
      vi.stubEnv('OPEN_SCIENCE_E2E_STORAGE_ROOT', root)
      sandbox = await createWindowsStandardProcessSandbox()
      observation = {
        status: 'healthy',
        reason: { code: 'healthy' },
        source: 'controlled-test-observation',
        executionScope: 'windows-test:host'
      }
      beforeDispatch = undefined
      afterMemoryCheck = undefined
      executions = 0
      preparations = 0
      rejections = []
      policy = {
        getState: async () => observation,
        currentState: () => observation
      }
      const wrap = sandbox.port.wrap
      sandbox.port.wrap = async (invocation) => {
        preparations++
        const wrapped = await wrap(invocation)
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
      service = new NotebookRuntimeService({
        configRoot: root,
        dataRoot: root,
        projectId: 'project',
        callbacks: { onMemoryPolicyRejected: (_context, state) => rejections.push(state) },
        memoryPolicy: {
          getState: async (request) => {
            const state = await policy.getState(request)
            afterMemoryCheck?.()
            return state
          },
          currentState: (request) => policy.currentState(request),
          dispose: () => policy.dispose?.()
        },
        processSandbox: sandbox.port
      })
    })

    afterEach(async () => {
      let disposal: { reaped: boolean } | undefined
      let ownedJobMembers: number[] | undefined
      let sandboxDisposed = false
      let rootRemoved = false
      try {
        try {
          disposal = await service?.dispose()
          expect(disposal).toEqual({ reaped: true })
          ownedJobMembers = inspectOwnedWindowsProcessIds()
          expect(ownedJobMembers).toEqual([])
        } finally {
          try {
            if (sandbox) {
              await sandbox.dispose()
              sandboxDisposed = true
            }
          } finally {
            await resetOwnership()
          }
        }
        if (root) {
          await rm(root, { recursive: true, force: true })
          await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
          rootRemoved = true
        }
      } finally {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        if (root && !rootRemoved)
          console.error('Windows admission fixture retained after incomplete cleanup', {
            root,
            disposal,
            ownedJobMembers,
            sandboxDisposed
          })
      }
    })

    it.each(refusals)(
      'refuses $label before initial creation and reuse without queueing either request',
      async ({ status, reason }) => {
        const native: typeof import('@aipoch/process-tree-native') = requireNative(
          '../../../packages/process-tree-native'
        )
        const scope = { projectId: 'project', sessionId: 'every-execution', workspaceCwd: root }
        const initialIntent = service.createExecutionIntent(scope)
        const sentinel = join(root, 'must-not-run')
        const code = `kept = 999; require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`
        observation = { ...observation, status, reason: { code: reason } }
        const expectedCode =
          status === 'pressured' ? 'NOTEBOOK_MEMORY_PRESSURE' : 'NOTEBOOK_MEMORY_UNAVAILABLE'
        await expect(
          service.executeControl(withNotebookExecutionIntent({ ...scope, code }, initialIntent))
        ).rejects.toMatchObject({ code: expectedCode, recovery: { execution: 'not-started' } })
        expect(rejections).toEqual([expect.objectContaining({ status, reason: { code: reason } })])
        expect(executions).toBe(0)
        expect(preparations).toBe(0)
        expect(inspectOwnedWindowsProcessIds()).toEqual([])
        expect(service.ownedResources(scope)).toEqual([])
        expect((await service.state(scope)).runs).toEqual([])
        await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })

        observation = { ...observation, status: 'healthy', reason: { code: 'healthy' } }
        await service.getMemoryPolicyState({})
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(executions).toBe(0)
        expect(preparations).toBe(0)
        expect(inspectOwnedWindowsProcessIds()).toEqual([])
        await expect(
          service.executeControl(withNotebookExecutionIntent({ ...scope, code }, initialIntent))
        ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
        const reuseIntent = service.createExecutionIntent(scope)
        const created = await service.executeControl(
          withNotebookExecutionIntent(
            { ...scope, code: 'globalThis.kept = 41; console.log(process.pid)' },
            reuseIntent
          )
        )
        expect(created.status).toBe('completed')
        const pid = Number(created.stdout.trim())
        const birth = native.getWindowsProcessCreationTime(pid)
        expect(birth).not.toBeNull()
        const members = inspectOwnedWindowsProcessIds()
        const runs = (await service.state(scope)).runs
        observation = { ...observation, status, reason: { code: reason } }
        await expect(
          service.executeControl(withNotebookExecutionIntent({ ...scope, code }, reuseIntent))
        ).rejects.toMatchObject({ code: expectedCode, recovery: { execution: 'not-started' } })
        expect(executions).toBe(1)
        expect(preparations).toBe(1)
        expect((await service.state(scope)).runs).toEqual(runs)
        expect(native.getWindowsProcessCreationTime(pid)).toBe(birth)
        expect(inspectOwnedWindowsProcessIds()).toEqual(members)

        observation = { ...observation, status: 'healthy', reason: { code: 'healthy' } }
        await service.getMemoryPolicyState({})
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect((await service.state(scope)).runs).toEqual(runs)
        expect(executions).toBe(1)
        await expect(
          service.executeControl(withNotebookExecutionIntent({ ...scope, code }, reuseIntent))
        ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
        await expect(
          service.executeControl(
            withNotebookExecutionIntent(
              { ...scope, code: 'console.log(JSON.stringify({ kept: ++kept, pid: process.pid }))' },
              service.createExecutionIntent(scope)
            )
          )
        ).resolves.toMatchObject({
          status: 'completed',
          stdout: expect.stringContaining(JSON.stringify({ kept: 42, pid }))
        })
        expect(executions).toBe(2)
        expect(native.getWindowsProcessCreationTime(pid)).toBe(birth)
        await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
      },
      30_000
    )

    it.each([
      ...refusals,
      { label: 'expired sample', status: 'unavailable', reason: 'sample-expired' } as const
    ])(
      'refuses $label after beginExecution while retaining the original namespace and Job',
      async ({ status, reason }) => {
        const native: typeof import('@aipoch/process-tree-native') = requireNative(
          '../../../packages/process-tree-native'
        )
        let monotonicNow = 0
        if (reason === 'sample-expired') {
          // Only the policy clock is controlled. Kernel/Job processes and their timers stay real.
          policy = new MemoryPolicyService({
            adapter: {
              platform: 'win32',
              sample: async () => ({
                platform: 'win32',
                source: 'controlled-test-sample',
                executionScope: 'windows-test:host',
                facts: {
                  totalBytes: 1000,
                  availableBytes: 800,
                  committedBytes: 200,
                  commitLimitBytes: 1000
                }
              })
            },
            now: () => monotonicNow,
            wallNow: () => 1_000_000 + monotonicNow
          })
        }
        const scope = { projectId: 'project', sessionId: 'final-admission', workspaceCwd: root }
        const intent = service.createExecutionIntent(scope)
        const first = await service.executeControl(
          withNotebookExecutionIntent(
            { ...scope, code: 'globalThis.kept = 41; console.log(process.pid)' },
            intent
          )
        )
        expect(first.status).toBe('completed')
        const pid = Number(first.stdout.trim())
        const birth = native.getWindowsProcessCreationTime(pid)
        expect(birth).not.toBeNull()
        await expect(
          service.executeControl(
            withNotebookExecutionIntent({ ...scope, code: 'console.log(++kept)' }, intent)
          )
        ).resolves.toMatchObject({ status: 'completed', stdout: expect.stringContaining('42') })
        const members = inspectOwnedWindowsProcessIds()
        expect(members).toContain(pid)
        const memberBirths = members.map((member) => native.getWindowsProcessCreationTime(member))
        expect(memberBirths.every((memberBirth) => memberBirth !== null)).toBe(true)
        const receiptsRoot = join(root, 'runtime', 'kernel-processes')
        const receipts = await Promise.all(
          (await readdir(receiptsRoot)).map(async (name) =>
            readFile(join(receiptsRoot, name), 'utf8')
          )
        )
        expect(receipts.some((receipt) => receipt.includes('Local\\\\OpenScience.Notebook.'))).toBe(
          true
        )
        const sentinel = join(root, 'must-not-dispatch')
        beforeDispatch = () => {
          if (reason === 'sample-expired') {
            // sendRequest may legitimately resample an expired sample in prepare('dispatch').
            // Expire the real policy sample after that final async preparation returns.
            afterMemoryCheck = () => {
              monotonicNow += 2001
              afterMemoryCheck = undefined
            }
          } else observation = { ...observation, status, reason: { code: reason } }
        }
        const refused = await service.executeControl(
          withNotebookExecutionIntent(
            {
              ...scope,
              code: `kept = 999; require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`
            },
            intent
          )
        )
        expect(executions).toBe(3)
        expect(refused).toMatchObject({
          status: 'failed',
          recovery: { execution: 'not-started' }
        })
        expect(rejections).toEqual([expect.objectContaining({ status, reason: { code: reason } })])
        const afterRefusal = await service.state(scope)
        expect(afterRefusal.runs.at(-1)).toMatchObject({
          status: 'failed',
          kernelDispatched: false,
          executionStarted: false,
          recovery: { execution: 'not-started' }
        })
        await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(native.getWindowsProcessCreationTime(pid)).toBe(birth)
        expect(inspectOwnedWindowsProcessIds()).toEqual(members)
        expect(members.map((member) => native.getWindowsProcessCreationTime(member))).toEqual(
          memberBirths
        )

        beforeDispatch = undefined
        observation = { ...observation, status: 'healthy', reason: { code: 'healthy' } }
        await service.getMemoryPolicyState({})
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect((await service.state(scope)).runs).toEqual(afterRefusal.runs)
        expect(executions).toBe(3)
        await expect(
          service.executeControl(
            withNotebookExecutionIntent({ ...scope, code: 'kept = 999' }, intent)
          )
        ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
        const fresh = service.createExecutionIntent(scope)
        await expect(
          service.executeControl(
            withNotebookExecutionIntent(
              { ...scope, code: 'console.log(JSON.stringify({ kept: ++kept, pid: process.pid }))' },
              fresh
            )
          )
        ).resolves.toMatchObject({
          status: 'completed',
          stdout: expect.stringContaining(JSON.stringify({ kept: 43, pid }))
        })
        expect(executions).toBe(4)
        expect(preparations).toBe(1)
        await expect(
          service.executeControl(
            withNotebookExecutionIntent({ ...scope, code: 'kept = 999' }, intent)
          )
        ).rejects.toMatchObject({ code: 'NOTEBOOK_EXECUTION_REQUIRES_USER_ACTION' })
        expect(native.getWindowsProcessCreationTime(pid)).toBe(birth)
        expect(inspectOwnedWindowsProcessIds()).toEqual(members)
        expect(members.map((member) => native.getWindowsProcessCreationTime(member))).toEqual(
          memberBirths
        )
        expect(
          await Promise.all(
            (await readdir(receiptsRoot)).map(async (name) =>
              readFile(join(receiptsRoot, name), 'utf8')
            )
          )
        ).toEqual(receipts)
        await expect(access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' })
        console.info('Windows final dispatch admission tracer', {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          memory: reason === 'sample-expired' ? 'controlled-test-sample/clock' : observation.source,
          refusal: reason,
          pid,
          birth,
          jobMembers: members,
          refusedRun: {
            status: afterRefusal.runs.at(-1)?.status,
            kernelDispatched: afterRefusal.runs.at(-1)?.kernelDispatched,
            executionStarted: afterRefusal.runs.at(-1)?.executionStarted,
            recovery: afterRefusal.runs.at(-1)?.recovery
          },
          executions
        })
      },
      30_000
    )
  }
)
