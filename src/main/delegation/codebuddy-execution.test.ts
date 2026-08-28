import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionResponse } from '../../shared/acp'
import { codeBuddyFramework, type AgentSpawnInput } from '../agent-framework'
import type { AcpDelegateExecutionCallbacks, AcpDelegateRuntime } from './acp-execution'
import {
  delegatedWorkCertificationContract,
  type DelegatedWorkCertificationDriver
} from './certification-contract.test'
import {
  auditCodeBuddyNativeDelegation,
  createCodeBuddyDelegateExecution,
  type PreparedCodeBuddyDelegateExecution
} from './codebuddy-execution'
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

const codeBuddySpawn = (runtimeHome: string): AgentSpawnInput => {
  const config = codeBuddyFramework.prepareModelConfig(
    {
      type: 'custom',
      baseUrl: 'https://provider.example/v1',
      model: 'certification-model',
      key: 'certification-key',
      apiEndpoints: ['openai']
    },
    {
      storageRoot: runtimeHome,
      executablePath: '/bin/codebuddy',
      systemPromptAppends: ['Certification prompt']
    }
  )
  return {
    executablePath: '/bin/codebuddy',
    args: [...(config.args ?? [])],
    env: { ...(config.env ?? {}) }
  }
}

type RuntimeControl = Readonly<{
  callbacks: AcpDelegateExecutionCallbacks
  providerSessionId: string
  prompts: string[]
  responses: AcpPermissionResponse[]
  complete(response?: PromptResponse): void
  fail(error: Error): void
}>

const makeHarness = (
  capacity: number
): Readonly<{
  controls: Map<string, RuntimeControl>
  execution: ReturnType<typeof createCodeBuddyDelegateExecution>
  inputs: DelegateExecutionInput[]
}> => {
  const controls = new Map<string, RuntimeControl>()
  const inputs: DelegateExecutionInput[] = []
  const execution = createCodeBuddyDelegateExecution({
    capacity,
    framework: {
      spawn: () => ({ kill: vi.fn() }) as unknown as ChildProcessWithoutNullStreams
    },
    prepare: (input): PreparedCodeBuddyDelegateExecution => {
      inputs.push(input)
      return {
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
        frameworkId: 'codebuddy',
        spawn: codeBuddySpawn(`/runtime/${input.attemptId}`),
        capability: { revoke: async () => undefined }
      }
    },
    createRuntime: (scope, callbacks, agentProcess): AcpDelegateRuntime => {
      expect(agentProcess).toBeDefined()
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
        fail: prompt.reject
      })
      return {
        createSession: async () => ({ sessionId: providerSessionId }),
        sendAppContinuation: async ({ text }) => {
          prompts.push(text)
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
    }
  })
  return { controls, execution, inputs }
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
    nativeEntryPoints: auditCodeBuddyNativeDelegation(codeBuddySpawn('/runtime/audit'))
  }
})

describe('CodeBuddy delegated-work production adapter', () => {
  it('audits the exact tool allowlist and process locks', () => {
    expect(auditCodeBuddyNativeDelegation(codeBuddySpawn('/runtime/audit'))).toEqual([
      { entryPoint: 'task', status: 'disabled' },
      { entryPoint: 'agent', status: 'disabled' },
      { entryPoint: 'multi-agent', status: 'disabled' }
    ])

    const unsafe = codeBuddySpawn('/runtime/unsafe')
    unsafe.args = ['--tools', 'Read,Agent']
    expect(auditCodeBuddyNativeDelegation(unsafe).map(({ status }) => status)).toEqual([
      'enabled',
      'enabled',
      'enabled'
    ])
  })
})
