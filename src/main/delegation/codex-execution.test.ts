import type { PromptResponse } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionResponse } from '../../shared/acp'
import { CODEX_ACP_VERSION, CODEX_VERSION } from '../settings/managed-codex'
import type { AcpDelegateExecutionCallbacks, AcpDelegateRuntime } from './acp-execution'
import {
  createCodexDelegateExecution,
  getCodexNativeDelegationAudit,
  type PreparedCodexDelegateExecution
} from './codex-execution'
import {
  delegatedWorkCertificationContract,
  type DelegatedWorkCertificationDriver
} from './certification-contract.test'
import { createInMemoryDelegatedWorkRecords } from './durable-delegated-work'
import { createTestDurableDelegatedWork as createDurableDelegatedWork } from './durable-delegated-work-test-fixture'
import type { DelegateExecutionInput } from './execution-port'

type Deferred<Value> = Readonly<{
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
}>

const deferred = <Value>(): Deferred<Value> => {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

type RuntimeControl = Readonly<{
  callbacks: AcpDelegateExecutionCallbacks
  providerSessionId: string
  prompts: string[]
  responses: AcpPermissionResponse[]
  complete(response?: PromptResponse): void
  fail(error: Error): void
}>

type CertificationHarness = Readonly<{
  adapter: ReturnType<typeof createCodexDelegateExecution>
  driver: DelegatedWorkCertificationDriver
  scopes: PreparedCodexDelegateExecution[]
  processSpawns: string[]
  agentProcesses: ChildProcessWithoutNullStreams[]
  runtimeConnections: AcpDelegateRuntime[]
}>

const makeCertificationAdapter = (capacity = 4): CertificationHarness => {
  const controls = new Map<string, RuntimeControl>()
  const inputs: DelegateExecutionInput[] = []
  const scopes: PreparedCodexDelegateExecution[] = []
  const processSpawns: string[] = []
  const agentProcesses: ChildProcessWithoutNullStreams[] = []
  const runtimeConnections: AcpDelegateRuntime[] = []
  let processId = 8_000
  const adapter = createCodexDelegateExecution({
    capacity,
    runtime: { nativeVersion: CODEX_VERSION, adapterVersion: CODEX_ACP_VERSION },
    framework: {
      spawn: ({ env }) => {
        processSpawns.push(`${++processId}:${env.CODEX_HOME}`)
        return { pid: processId } as ChildProcessWithoutNullStreams
      }
    },
    prepare(input) {
      inputs.push(input)
      const runtimeHome = `/runtime/codex/${input.attemptId}`
      const scope: PreparedCodexDelegateExecution = {
        executionId: input.attemptId,
        provenance: {
          projectId: input.session.projectId,
          sessionId: input.session.sessionId,
          agentFrameId: input.frameId,
          runtimeSegmentId: input.runtimeSegmentId,
          promptMessageId: `prompt-${input.attemptId}`,
          messageBranchId: `branch-${input.frameId}`
        },
        workspace: { cwd: `/workspace/${input.frameId}` },
        runtimeHome,
        capability: { revoke: async () => undefined },
        spawn: {
          executablePath: '/runtime/codex-acp',
          args: [],
          env: {
            HOME: runtimeHome,
            CODEX_HOME: runtimeHome,
            CODEX_CONFIG: JSON.stringify({
              features: { multi_agent: false, multi_agent_v2: false }
            })
          }
        }
      }
      scopes.push(scope)
      return scope
    },
    createRuntime(scope, callbacks, agentProcess): AcpDelegateRuntime {
      agentProcesses.push(agentProcess)
      const prompt = deferred<PromptResponse>()
      const prompts: string[] = []
      const responses: AcpPermissionResponse[] = []
      const providerSessionId = `provider-${scope.executionId}`
      controls.set(scope.executionId, {
        callbacks,
        providerSessionId,
        prompts,
        responses,
        complete: (response = { stopReason: 'end_turn' }) => prompt.resolve(response),
        fail: (error) => prompt.reject(error)
      })
      const runtime: AcpDelegateRuntime = {
        createSession: async () => ({ sessionId: providerSessionId }),
        sendAppContinuation: async ({ text }) => {
          prompts.push(text)
          callbacks.onProviderPromptAccepted(providerSessionId)
          return prompt.promise
        },
        cancelPrompt: async () => prompt.resolve({ stopReason: 'cancelled' }),
        setPermissionProfile: async () => undefined,
        respondToPermission: async (response) => {
          responses.push(response)
        },
        deleteSession: async () => undefined,
        shutdownForQuit: async () => ({ reaped: true })
      }
      runtimeConnections.push(runtime)
      return runtime
    }
  })

  const controlFor = async (attemptId: string): Promise<RuntimeControl> => {
    await vi.waitFor(() => expect(controls.has(attemptId)).toBe(true))
    return controls.get(attemptId)!
  }
  const driver: DelegatedWorkCertificationDriver = {
    waitForStart: async (attemptId) => {
      await controlFor(attemptId)
    },
    startedInputs: () => inputs,
    accept: async (attemptId) => {
      const control = await controlFor(attemptId)
      control.callbacks.onProviderPromptAccepted(control.providerSessionId)
    },
    emit: async (attemptId, event) => {
      const control = await controlFor(attemptId)
      if (event.kind === 'message') {
        control.callbacks.onEvent({
          id: `event-${attemptId}`,
          timestamp: 1,
          kind: 'message',
          level: 'info',
          sessionId: control.providerSessionId,
          role: 'assistant',
          text: event.text
        })
      } else if (event.kind === 'permission' && event.awaiting) {
        control.callbacks.onPermissionRequest({
          requestId: event.requestId,
          sessionId: control.providerSessionId,
          toolCallId: `tool-${attemptId}`,
          title: event.title,
          options: [...event.options]
        })
      }
    },
    complete: async (attemptId, response) => {
      const control = await controlFor(attemptId)
      control.callbacks.onEvent({
        id: `terminal-${attemptId}`,
        timestamp: 2,
        kind: 'message',
        level: 'info',
        sessionId: control.providerSessionId,
        role: 'assistant',
        text: response
      })
      control.complete()
    },
    fail: async (attemptId, error) => (await controlFor(attemptId)).fail(error),
    deliveredMessages: (attemptId) => {
      const initial = inputs.find((input) => input.attemptId === attemptId)?.task
      return (controls.get(attemptId)?.prompts ?? []).filter((prompt) => prompt !== initial)
    },
    permissionResponses: (attemptId) => controls.get(attemptId)?.responses ?? []
  }
  return { adapter, driver, scopes, processSpawns, agentProcesses, runtimeConnections }
}

describe('Codex delegated-work production adapter', () => {
  it('audits the pinned runtime and fails closed for an unreviewed runtime pair', () => {
    expect(
      getCodexNativeDelegationAudit({
        nativeVersion: CODEX_VERSION,
        adapterVersion: CODEX_ACP_VERSION
      })
    ).toEqual([
      { entryPoint: 'task', status: 'not-present' },
      { entryPoint: 'agent', status: 'not-present' },
      { entryPoint: 'multi-agent', status: 'disabled' }
    ])

    expect(
      getCodexNativeDelegationAudit({ nativeVersion: 'future', adapterVersion: CODEX_ACP_VERSION })
    ).toEqual([
      { entryPoint: 'task', status: 'unknown' },
      { entryPoint: 'agent', status: 'unknown' },
      { entryPoint: 'multi-agent', status: 'unknown' }
    ])
  })
})

delegatedWorkCertificationContract((options) => {
  const harness = makeCertificationAdapter(options?.capacity)
  return {
    execution: harness.adapter.execution,
    nativeEntryPoints: harness.adapter.nativeEntryPoints,
    driver: harness.driver
  }
})

describe('Codex delegated-work isolation evidence', () => {
  it('rejects uncertified runtimes and unavailable providers before durable admission', async () => {
    for (const candidate of [
      {
        runtime: { nativeVersion: 'unreviewed', adapterVersion: CODEX_ACP_VERSION }
      },
      {
        runtime: { nativeVersion: CODEX_VERSION, adapterVersion: CODEX_ACP_VERSION },
        assertProviderAvailable: () => {
          throw new Error('provider configuration is unavailable')
        }
      }
    ]) {
      const prepare = vi.fn()
      const adapter = createCodexDelegateExecution({
        capacity: 1,
        ...candidate,
        prepare,
        createRuntime: () => {
          throw new Error('must not create a runtime')
        }
      })
      const session = { projectId: 'project', sessionId: 'session' }
      const records = createInMemoryDelegatedWorkRecords({
        session,
        rootFrameId: 'root-frame',
        originMessageId: 'root-message'
      })
      const work = createDurableDelegatedWork({
        execution: adapter.execution,
        records,
        assertAvailable: adapter.assertAvailable
      })

      await expect(
        work.delegate(
          {
            session,
            frameId: 'root-frame',
            role: 'main',
            originMessageId: 'root-message',
            toolInvocationId: 'delegate-call'
          },
          { task: 'must not start', name: 'must not start' },
          { wait: false }
        )
      ).rejects.toMatchObject({ code: 'unsupported_framework' })
      expect(prepare).not.toHaveBeenCalled()
      expect((await records.snapshot()).records).toEqual([])
    }
  })

  it('creates one process/connection, home, cwd, prompt attachment, and capability scope per Attempt', async () => {
    const { adapter, driver, scopes, processSpawns, agentProcesses, runtimeConnections } =
      makeCertificationAdapter(2)
    const reservation = await adapter.execution.reserve(2)
    for (const [index, attemptId] of ['attempt-a', 'attempt-b'].entries()) {
      adapter.execution.run(
        {
          session: { projectId: 'project', sessionId: 'session' },
          frameId: `frame-${index}`,
          attemptId,
          runtimeSegmentId: `segment-${index}`,
          task: `task-${index}`,
          inputs: [],
          continuation: false
        },
        reservation.slotIds[index]
      )
    }
    await Promise.all(['attempt-a', 'attempt-b'].map(driver.waitForStart))

    expect(new Set(scopes.map(({ runtimeHome }) => runtimeHome)).size).toBe(2)
    expect(new Set(scopes.map(({ workspace }) => workspace.cwd)).size).toBe(2)
    expect(new Set(scopes.map(({ capability }) => capability)).size).toBe(2)
    expect(new Set(agentProcesses).size).toBe(2)
    expect(new Set(runtimeConnections).size).toBe(2)
    expect(scopes.map(({ provenance }) => provenance.promptMessageId)).toEqual([
      'prompt-attempt-a',
      'prompt-attempt-b'
    ])
    expect(processSpawns).toEqual([
      '8001:/runtime/codex/attempt-a',
      '8002:/runtime/codex/attempt-b'
    ])
    await Promise.all(['attempt-a', 'attempt-b'].map((id) => driver.complete(id, `${id} done`)))
  })
})
