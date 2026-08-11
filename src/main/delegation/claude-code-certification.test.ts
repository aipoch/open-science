import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionResponse } from '../../shared/acp'
import { claudeCodeFramework } from '../agent-framework'
import {
  assertClaudeCodeDelegatedWorkAvailable,
  createClaudeCodeDelegateExecution,
  claudeCodeNativeDelegationAudit,
  type AcpDelegateExecutionCallbacks,
  type AcpDelegateRuntime,
  type PreparedDelegateExecution
} from './claude-code-execution'
import {
  delegatedWorkCertificationContract,
  type DelegatedWorkCertificationDriver
} from './certification-contract.test'
import type { DelegateExecutionInput } from './execution-port'
import {
  createInMemoryDelegatedWorkRecords,
  type AuthenticatedDelegateCaller
} from './durable-delegated-work'
import { createTestDurableDelegatedWork as createDurableDelegatedWork } from './durable-delegated-work-test-fixture'
import { createDeterministicDelegateExecution } from './deterministic-execution'

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
  complete(): void
  fail(error: Error): void
}>

delegatedWorkCertificationContract((options) => {
  const controls = new Map<string, RuntimeControl>()
  const inputs: DelegateExecutionInput[] = []
  const runtimeInstances: Array<
    Readonly<{
      executionId: string
      runtimeHome: string
      cwd: string
      connectionId: string
      capabilityToken?: string
    }>
  > = []
  const execution = createClaudeCodeDelegateExecution({
    capacity: options?.capacity ?? 4,
    prepare: (input): PreparedDelegateExecution => {
      inputs.push(input)
      return {
        executionId: input.attemptId,
        provenance: {
          projectId: input.session.projectId,
          sessionId: input.session.sessionId,
          agentFrameId: input.frameId,
          runtimeSegmentId: input.runtimeSegmentId
        },
        workspace: { cwd: `/workspace/${input.frameId}` },
        runtimeHome: `/runtime/${input.attemptId}`,
        frameworkId: 'claude-code',
        capability: { token: `capability-${input.attemptId}`, revoke: async () => undefined }
      }
    },
    createRuntime: (scope, callbacks): AcpDelegateRuntime => {
      const prompt = deferred<PromptResponse>()
      const providerSessionId = `provider-${scope.executionId}`
      const prompts: string[] = []
      const responses: AcpPermissionResponse[] = []
      runtimeInstances.push({
        executionId: scope.executionId,
        runtimeHome: scope.runtimeHome,
        cwd: scope.workspace.cwd,
        connectionId: providerSessionId,
        capabilityToken: scope.capability.token
      })
      controls.set(scope.executionId, {
        callbacks,
        providerSessionId,
        prompts,
        responses,
        complete: () => prompt.resolve({ stopReason: 'end_turn' }),
        fail: (error) => prompt.reject(error)
      })
      return {
        createSession: async () => ({ sessionId: providerSessionId }),
        sendAppContinuation: ({ text }) => {
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
    }
  })
  const controlFor = async (attemptId: string): Promise<RuntimeControl> => {
    await vi.waitFor(() => expect(controls.has(attemptId)).toBe(true))
    return controls.get(attemptId)!
  }
  const driver: DelegatedWorkCertificationDriver = {
    waitForStart: async (attemptId) => {
      await controlFor(attemptId)
      const started = runtimeInstances.filter(({ executionId }) => executionId === attemptId)
      expect(started).toHaveLength(1)
      expect(new Set(runtimeInstances.map(({ runtimeHome }) => runtimeHome)).size).toBe(
        runtimeInstances.length
      )
      expect(new Set(runtimeInstances.map(({ connectionId }) => connectionId)).size).toBe(
        runtimeInstances.length
      )
      expect(started[0].cwd).toBe(
        `/workspace/${inputs.find(({ attemptId: id }) => id === attemptId)!.frameId}`
      )
      expect(new Set(runtimeInstances.map(({ capabilityToken }) => capabilityToken)).size).toBe(
        runtimeInstances.length
      )
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
      const initialTask = inputs.find((input) => input.attemptId === attemptId)?.task
      return (controls.get(attemptId)?.prompts ?? []).filter((prompt) => prompt !== initialTask)
    },
    permissionResponses: (attemptId) => controls.get(attemptId)?.responses ?? []
  }

  return {
    execution,
    driver,
    nativeEntryPoints: claudeCodeNativeDelegationAudit(
      claudeCodeFramework.buildSessionSetup({ systemPromptAppends: [] })
    )
  }
})

describe('Claude Code delegated-work admission', () => {
  it('rejects an unsafe provider session configuration before reservations or durable child creation', async () => {
    const execution = createDeterministicDelegateExecution()
    const session = { projectId: 'project-admission', sessionId: 'session-admission' } as const
    const caller: AuthenticatedDelegateCaller = {
      session,
      frameId: 'root-frame',
      role: 'main',
      originMessageId: 'root-message',
      toolInvocationId: 'delegate-call'
    }
    const records = createInMemoryDelegatedWorkRecords({
      session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      assertAvailable: () =>
        assertClaudeCodeDelegatedWorkAvailable({
          meta: {
            claudeCode: {
              options: {
                tools: { type: 'preset', preset: 'claude_code' },
                disallowedTools: []
              }
            }
          }
        })
    })

    await expect(
      work.delegate(caller, { task: 'must not start', name: 'must not start' }, { wait: false })
    ).rejects.toMatchObject({
      code: 'unsupported_framework',
      message: 'Claude Code native Task/Agent/multi-agent delegation is not completely disabled.'
    })
    expect(execution.reservationCounts()).toEqual([])
    expect(execution.controls()).toEqual([])
    expect((await records.snapshot()).records).toEqual([])
  })
})
