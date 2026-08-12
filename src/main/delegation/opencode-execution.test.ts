import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionResponse } from '../../shared/acp'
import { opencodeFramework } from '../agent-framework'
import type { AcpDelegateExecutionCallbacks, AcpDelegateRuntime } from './acp-execution'
import {
  delegatedWorkCertificationContract,
  type DelegatedWorkCertificationDriver
} from './certification-contract.test'
import {
  auditOpenCodeNativeDelegation,
  createOpenCodeDelegateExecution,
  type PreparedOpenCodeDelegateExecution
} from './opencode-execution'
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

const provider = {
  type: 'custom' as const,
  baseUrl: 'https://provider.example/v1',
  model: 'certification-model',
  key: 'certification-key',
  apiEndpoints: ['openai' as const]
}

const modelConfig = (
  storageRoot: string
): ReturnType<typeof opencodeFramework.prepareModelConfig> =>
  opencodeFramework.prepareModelConfig(provider, {
    storageRoot,
    executablePath: '/bin/opencode'
  })

type RuntimeControl = Readonly<{
  callbacks: AcpDelegateExecutionCallbacks
  providerSessionId: string
  prompts: string[]
  responses: AcpPermissionResponse[]
  requests: Array<
    Readonly<{
      text: string
      provenanceContext?: {
        promptMessageId: string
        agentFrameId: string
        messageBranchId?: string
        runtimeSegmentId: string
      }
    }>
  >
  complete(response?: PromptResponse): void
  fail(error: Error): void
}>

type OpenCodeHarness = Readonly<{
  controls: Map<string, RuntimeControl>
  execution: ReturnType<typeof createOpenCodeDelegateExecution>
  inputs: DelegateExecutionInput[]
  prepared: PreparedOpenCodeDelegateExecution[]
}>

const makeHarness = (capacity: number): OpenCodeHarness => {
  const controls = new Map<string, RuntimeControl>()
  const inputs: DelegateExecutionInput[] = []
  const prepared: PreparedOpenCodeDelegateExecution[] = []
  const execution = createOpenCodeDelegateExecution({
    capacity,
    certificationConfig: () => modelConfig('/runtime/admission'),
    prepare: (input) => {
      inputs.push(input)
      const scope: PreparedOpenCodeDelegateExecution = {
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
        runtimeHome: `/runtime/${input.attemptId}`,
        frameworkId: 'opencode',
        modelConfig: modelConfig(`/runtime/${input.attemptId}`),
        capability: { revoke: async () => undefined }
      }
      prepared.push(scope)
      return scope
    },
    createRuntime: (scope, callbacks): AcpDelegateRuntime => {
      const prompt = deferred<PromptResponse>()
      const prompts: string[] = []
      const responses: AcpPermissionResponse[] = []
      const requests: RuntimeControl['requests'] = []
      const providerSessionId = `provider-${scope.executionId}`
      controls.set(scope.executionId, {
        callbacks,
        providerSessionId,
        prompts,
        responses,
        requests,
        complete: (response = { stopReason: 'end_turn' }) => prompt.resolve(response),
        fail: prompt.reject
      })
      return {
        createSession: async () => ({ sessionId: providerSessionId }),
        sendAppContinuation: (request) => {
          const { text } = request
          prompts.push(text)
          requests.push(request)
          return prompt.promise
        },
        cancelPrompt: async () => {
          prompt.resolve({ stopReason: 'cancelled' })
        },
        setPermissionProfile: async () => undefined,
        respondToPermission: async (response) => {
          responses.push(response)
        },
        deleteSession: async () => undefined,
        shutdownForQuit: async () => ({ reaped: true })
      }
    }
  })
  return { controls, execution, inputs, prepared }
}

delegatedWorkCertificationContract((options) => {
  const harness = makeHarness(options?.capacity ?? 4)
  const controlFor = async (attemptId: string): Promise<RuntimeControl> => {
    await vi.waitFor(() => expect(harness.controls.has(attemptId)).toBe(true))
    return harness.controls.get(attemptId)!
  }
  const driver: DelegatedWorkCertificationDriver = {
    waitForStart: async (attemptId) => {
      await controlFor(attemptId)
    },
    startedInputs: () => harness.inputs,
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
      const initial = harness.inputs.find((input) => input.attemptId === attemptId)?.task
      return (harness.controls.get(attemptId)?.prompts ?? []).filter((text) => text !== initial)
    },
    permissionResponses: (attemptId) => harness.controls.get(attemptId)?.responses ?? []
  }

  return {
    execution: harness.execution,
    driver,
    nativeEntryPoints: auditOpenCodeNativeDelegation(modelConfig('/runtime/audit'))
  }
})

describe('OpenCode delegated-work production adapter', () => {
  it('audits the production config and gives every child an isolated runtime configuration', async () => {
    expect(auditOpenCodeNativeDelegation(modelConfig('/runtime/audit'))).toEqual([
      { entryPoint: 'task', status: 'disabled' },
      { entryPoint: 'agent', status: 'disabled' },
      { entryPoint: 'multi-agent', status: 'disabled' }
    ])

    const harness = makeHarness(2)
    const reservation = await harness.execution.reserve(2)
    harness.execution.run(
      {
        session: { projectId: 'project', sessionId: 'session' },
        frameId: 'frame-1',
        attemptId: 'attempt-1',
        runtimeSegmentId: 'segment-1',
        task: 'one',
        inputs: [],
        continuation: false
      },
      reservation.slotIds[0]
    )
    harness.execution.run(
      {
        session: { projectId: 'project', sessionId: 'session' },
        frameId: 'frame-2',
        attemptId: 'attempt-2',
        runtimeSegmentId: 'segment-2',
        task: 'two',
        inputs: [],
        continuation: false
      },
      reservation.slotIds[1]
    )
    await vi.waitFor(() => expect(harness.prepared).toHaveLength(2))
    await vi.waitFor(() => expect(harness.controls.size).toBe(2))
    await vi.waitFor(() =>
      expect([...harness.controls.values()].map(({ requests }) => requests.length)).toEqual([1, 1])
    )
    expect(harness.prepared.map(({ runtimeHome }) => runtimeHome)).toEqual([
      '/runtime/attempt-1',
      '/runtime/attempt-2'
    ])
    expect(harness.prepared[0].modelConfig.env?.XDG_CONFIG_HOME).not.toBe(
      harness.prepared[1].modelConfig.env?.XDG_CONFIG_HOME
    )
    expect(harness.controls.get('attempt-1')?.requests[0]?.provenanceContext).toEqual({
      promptMessageId: 'prompt-attempt-1',
      agentFrameId: 'frame-1',
      messageBranchId: 'branch-frame-1',
      runtimeSegmentId: 'segment-1'
    })
    expect(harness.controls.get('attempt-2')?.requests[0]?.provenanceContext).toEqual({
      promptMessageId: 'prompt-attempt-2',
      agentFrameId: 'frame-2',
      messageBranchId: 'branch-frame-2',
      runtimeSegmentId: 'segment-2'
    })
  })

  it('rejects an unsupported config before preparing or creating a runtime', async () => {
    const prepare = vi.fn()
    const createRuntime = vi.fn()
    const unsafe = modelConfig('/runtime/unsafe')
    unsafe.env!.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { task: 'ask' } })
    const execution = createOpenCodeDelegateExecution({
      capacity: 1,
      certificationConfig: () => unsafe,
      prepare,
      createRuntime
    })

    await expect(execution.reserve(1)).rejects.toMatchObject({ code: 'unsupported_framework' })
    expect(prepare).not.toHaveBeenCalled()
    expect(createRuntime).not.toHaveBeenCalled()
  })
})
