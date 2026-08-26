import type { PromptResponse } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { AcpPermissionResponse, AcpRuntimeEvent } from '../../shared/acp'
import {
  createAcpDelegateExecution,
  type AcpDelegateExecutionCallbacks,
  type AcpDelegateRuntime,
  type PreparedDelegateExecution
} from './acp-execution'
import {
  delegatedWorkCertificationContract,
  type DelegatedWorkCertificationDriver
} from './certification-contract.test'
import { delegateExecutionContract } from './execution-contract.test'
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
  createdSessions: Parameters<AcpDelegateRuntime['createSession']>[0][]
  permissionProfiles: string[]
  prompts: string[]
  responses: AcpPermissionResponse[]
  complete(response?: PromptResponse): void
  fail(error: Error): void
}>

const makeInput = (attemptId: string): DelegateExecutionInput => ({
  session: { projectId: 'project-1', sessionId: 'session-1' },
  frameId: `frame-${attemptId}`,
  attemptId,
  runtimeSegmentId: `segment-${attemptId}`,
  task: `task-${attemptId}`,
  inputs: [],
  continuation: false
})

const makeHarness = (
  capacity = 4,
  scopePaths: Readonly<{
    runtimeHome?(input: DelegateExecutionInput): string
    workspace?(input: DelegateExecutionInput): string
    createSessionError?(executionId: string): Error | undefined
    permissionResponseError?(executionId: string): Error | undefined
    permissionProfile?(
      input: DelegateExecutionInput
    ): PreparedDelegateExecution['permissionProfile']
  }> = {}
): Readonly<{
  execution: ReturnType<typeof createAcpDelegateExecution>
  controls: Map<string, RuntimeControl>
  prepared: PreparedDelegateExecution[]
  inputs: DelegateExecutionInput[]
  cleanup: string[]
}> => {
  const controls = new Map<string, RuntimeControl>()
  const prepared: PreparedDelegateExecution[] = []
  const inputs: DelegateExecutionInput[] = []
  const cleanup: string[] = []
  const execution = createAcpDelegateExecution({
    capacity,
    prepare: async (input) => {
      inputs.push(input)
      const scope: PreparedDelegateExecution = {
        executionId: input.attemptId,
        provenance: {
          projectId: input.session.projectId,
          sessionId: input.session.sessionId,
          agentFrameId: input.frameId,
          runtimeSegmentId: input.runtimeSegmentId,
          promptMessageId: `prompt-${input.attemptId}`,
          messageBranchId: `branch-${input.attemptId}`
        },
        workspace: { cwd: scopePaths.workspace?.(input) ?? `/workspace/${input.frameId}` },
        runtimeHome: scopePaths.runtimeHome?.(input) ?? `/runtime/${input.attemptId}`,
        frameworkId: 'certified-test',
        permissionProfile: scopePaths.permissionProfile?.(input),
        capability: {
          revoke: async () => {
            cleanup.push(`revoke:${input.attemptId}`)
          }
        },
        disposeResources: async () => {
          cleanup.push(`resources:${input.attemptId}`)
        }
      }
      prepared.push(scope)
      return scope
    },
    assertFrameworkNativeDelegationDisabled: async () => undefined,
    createRuntime: (scope, callbacks): AcpDelegateRuntime => {
      const prompt = deferred<PromptResponse>()
      const createdSessions: Parameters<AcpDelegateRuntime['createSession']>[0][] = []
      const permissionProfiles: string[] = []
      const prompts: string[] = []
      const responses: AcpPermissionResponse[] = []
      const providerSessionId = `provider-${scope.executionId}`
      const control: RuntimeControl = {
        callbacks,
        providerSessionId,
        createdSessions,
        permissionProfiles,
        prompts,
        responses,
        complete: (response = { stopReason: 'end_turn' }) => prompt.resolve(response),
        fail: (error) => prompt.reject(error)
      }
      controls.set(scope.executionId, control)
      return {
        createSession: async (request) => {
          createdSessions.push(request)
          const error = scopePaths.createSessionError?.(scope.executionId)
          if (error) throw error
          return { sessionId: providerSessionId }
        },
        sendAppContinuation: ({ text }) => {
          prompts.push(text)
          callbacks.onProviderPromptAccepted(providerSessionId)
          return prompt.promise
        },
        cancelPrompt: async () => {
          prompt.resolve({ stopReason: 'cancelled' })
        },
        respondToPermission: async (response) => {
          const error = scopePaths.permissionResponseError?.(scope.executionId)
          if (error) throw error
          responses.push(response)
        },
        setPermissionProfile: async ({ profile }: { profile: string }) => {
          permissionProfiles.push(profile)
        },
        deleteSession: async () => {
          cleanup.push(`delete:${scope.executionId}`)
        },
        shutdownForQuit: async () => {
          cleanup.push(`shutdown:${scope.executionId}`)
          return { reaped: true }
        }
      }
    }
  })
  return { execution, controls, prepared, inputs, cleanup }
}

delegateExecutionContract(() => {
  const harness = makeHarness()
  const controlFor = async (attemptId: string): Promise<RuntimeControl> => {
    await vi.waitFor(() => expect(harness.controls.has(attemptId)).toBe(true))
    return harness.controls.get(attemptId)!
  }
  return {
    execution: harness.execution,
    driver: {
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
      deliveredMessages: (attemptId) =>
        (harness.controls.get(attemptId)?.prompts ?? []).filter(
          (prompt) => prompt !== `task-${attemptId}`
        ),
      permissionResponses: (attemptId) => harness.controls.get(attemptId)?.responses ?? []
    }
  }
})

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
      const initialTask = harness.inputs.find((input) => input.attemptId === attemptId)?.task
      return (harness.controls.get(attemptId)?.prompts ?? []).filter(
        (prompt) => prompt !== initialTask
      )
    },
    permissionResponses: (attemptId) => harness.controls.get(attemptId)?.responses ?? []
  }
  return {
    execution: harness.execution,
    driver,
    nativeEntryPoints: [
      { entryPoint: 'task', status: 'disabled' },
      { entryPoint: 'agent', status: 'not-present' },
      { entryPoint: 'multi-agent', status: 'disabled' }
    ]
  }
})

describe('ACP delegate execution production adapter', () => {
  it('composes initial prompts from task, read-only inputs, and structured output without leaking identities', async () => {
    const cases: Array<
      Readonly<{
        attemptId: string
        input: Partial<DelegateExecutionInput>
        expected: string
      }>
    > = [
      { attemptId: 'task-only', input: {}, expected: 'Review evidence.' },
      {
        attemptId: 'with-inputs',
        input: { inputs: ['upload-version:secret', 'artifact-version:internal'] },
        expected:
          'Review evidence.\n\nImmutable input copies are available in the read-only ./inputs/ directory. Inspect that directory and read the relevant files.'
      },
      {
        attemptId: 'with-schema',
        input: { outputSchema: { type: 'number' } },
        expected:
          'Review evidence.\n\nReturn ordinary text and any Artifacts as usual. Before finishing, submit the structured result with host.submitOutput(value) using this JSON Schema:\n{"type":"number"}'
      },
      {
        attemptId: 'with-both',
        input: {
          inputs: ['upload-version:secret'],
          outputSchema: { type: 'object', required: ['answer'] }
        },
        expected:
          'Review evidence.\n\nImmutable input copies are available in the read-only ./inputs/ directory. Inspect that directory and read the relevant files.\n\nReturn ordinary text and any Artifacts as usual. Before finishing, submit the structured result with host.submitOutput(value) using this JSON Schema:\n{"type":"object","required":["answer"]}'
      }
    ]

    for (const candidate of cases) {
      const { execution, controls } = makeHarness(1)
      const reservation = await execution.reserve(1)
      const running = execution.run(
        {
          ...makeInput(candidate.attemptId),
          task: 'Review evidence.',
          ...candidate.input
        },
        reservation.slotIds[0]
      )
      await running.accepted
      const prompts = controls.get(candidate.attemptId)?.prompts ?? []
      expect(prompts).toEqual([candidate.expected])
      expect(prompts.join('\n')).not.toContain('/workspace/')
      expect(prompts.join('\n')).not.toMatch(/upload-version|artifact-version/)
      controls.get(candidate.attemptId)?.complete()
      await running.completion
    }
  })

  it('repeats the input hint for a new continuation Attempt but not for messages in one Attempt', async () => {
    const { execution, controls } = makeHarness(1)
    const reservation = await execution.reserve(1)
    const running = execution.run(
      {
        ...makeInput('continuation'),
        task: 'Continue the audit.',
        inputs: ['upload-version:secret'],
        continuation: true
      },
      reservation.slotIds[0]
    )
    await running.accepted
    const delivery = running.sendMessage('Focus on table 2.')
    controls.get('continuation')?.complete()
    await delivery
    await running.completion

    expect(controls.get('continuation')?.prompts).toEqual([
      'Continue the audit.\n\nImmutable input copies are available in the read-only ./inputs/ directory. Inspect that directory and read the relevant files.',
      'Focus on table 2.'
    ])
  })
  it('publishes the current Turn stop while retaining aggregate Attempt usage', async () => {
    const firstPrompt = deferred<PromptResponse>()
    const secondPrompt = deferred<PromptResponse>()
    const secondStarted = deferred<void>()
    let callbacks!: AcpDelegateExecutionCallbacks
    const completedTurns: unknown[] = []
    const execution = createAcpDelegateExecution({
      capacity: 1,
      prepare: async (input) => ({
        executionId: input.attemptId,
        provenance: {
          projectId: input.session.projectId,
          sessionId: input.session.sessionId,
          agentFrameId: input.frameId,
          runtimeSegmentId: input.runtimeSegmentId,
          promptMessageId: 'prompt-message-boundary'
        },
        workspace: { cwd: '/workspace/message-boundary' },
        runtimeHome: '/runtime/message-boundary',
        frameworkId: 'certified-test',
        capability: { revoke: async () => undefined }
      }),
      assertFrameworkNativeDelegationDisabled: async () => undefined,
      createRuntime: (_scope, runtimeCallbacks) => {
        callbacks = runtimeCallbacks
        let promptCount = 0
        return {
          createSession: async () => ({ sessionId: 'provider-message-boundary' }),
          sendAppContinuation: async () => {
            promptCount += 1
            if (promptCount === 1) {
              callbacks.onProviderPromptAccepted('provider-message-boundary')
              return firstPrompt.promise
            }
            secondStarted.resolve()
            return secondPrompt.promise
          },
          cancelPrompt: async () => undefined,
          respondToPermission: async () => undefined,
          setPermissionProfile: async () => undefined,
          deleteSession: async () => undefined,
          shutdownForQuit: async () => ({ reaped: true })
        }
      }
    })
    const reservation = await execution.reserve(1)
    const running = execution.run(
      {
        ...makeInput('message-boundary'),
        turn: {
          promptMessageId: 'prompt-message-boundary',
          messageBranchId: 'branch-message-boundary',
          runtimeSegmentId: 'segment-message-boundary',
          complete: async (_response, usage, _unavailable, modelCalls) => {
            completedTurns.push(['first', usage, modelCalls])
          }
        }
      },
      reservation.slotIds[0]
    )
    const events: unknown[] = []
    running.subscribe((event) => events.push(event))
    await running.accepted

    let delivered = false
    const delivery = running
      .sendMessage('new parent context', {
        promptMessageId: 'prompt-message-second',
        messageBranchId: 'branch-message-boundary',
        runtimeSegmentId: 'segment-message-second',
        complete: async (_response, usage, _unavailable, modelCalls) => {
          completedTurns.push(['second', usage, modelCalls])
        }
      })
      .then(() => {
        delivered = true
      })
    await Promise.resolve()
    expect(delivered).toBe(false)

    callbacks.onEvent({
      id: 'first-provider-stop',
      timestamp: 10,
      kind: 'stop',
      level: 'info',
      sessionId: 'provider-message-boundary',
      turnUsage: { inputTokens: 10, cacheTokens: 2, outputTokens: 3, turnCount: 1 },
      modelCallUsage: [
        {
          id: 'prompt-message-boundary:model-call:0',
          index: 0,
          inputTokens: 10,
          cacheTokens: 2,
          outputTokens: 3
        }
      ]
    })
    expect(events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'runtime' })])
    )
    firstPrompt.resolve({ stopReason: 'end_turn' })
    await secondStarted.promise
    expect(delivered).toBe(false)

    callbacks.onProviderPromptAccepted('provider-message-boundary')
    await delivery
    expect(delivered).toBe(true)

    callbacks.onEvent({
      id: 'second-provider-stop',
      timestamp: 20,
      kind: 'stop',
      level: 'info',
      sessionId: 'provider-message-boundary',
      turnUsage: { inputTokens: 20, cacheTokens: 4, outputTokens: 5, turnCount: 1 },
      modelCallUsage: [
        {
          id: 'prompt-message-second:model-call:0',
          index: 0,
          inputTokens: 20,
          cacheTokens: 4,
          outputTokens: 5
        }
      ]
    })
    callbacks.onEvent({
      id: 'first-provider-stop',
      timestamp: 30,
      kind: 'stop',
      level: 'warning',
      sessionId: 'provider-message-boundary',
      turnUsage: { inputTokens: 100, cacheTokens: 20, outputTokens: 30, turnCount: 10 }
    })
    expect(events).toEqual([])
    secondPrompt.resolve({ stopReason: 'end_turn' })
    await expect(running.completion).resolves.toMatchObject({
      status: 'completed',
      turnUsage: { inputTokens: 30, cacheTokens: 6, outputTokens: 8, turnCount: 2 },
      modelCallUsage: [
        {
          id: 'prompt-message-boundary:model-call:0',
          index: 0,
          inputTokens: 10,
          cacheTokens: 2,
          outputTokens: 3
        },
        {
          id: 'prompt-message-second:model-call:0',
          index: 1,
          inputTokens: 20,
          cacheTokens: 4,
          outputTokens: 5
        }
      ]
    })
    expect(completedTurns).toEqual([
      [
        'first',
        { inputTokens: 10, cacheTokens: 2, outputTokens: 3, turnCount: 1 },
        [
          {
            id: 'prompt-message-boundary:model-call:0',
            index: 0,
            inputTokens: 10,
            cacheTokens: 2,
            outputTokens: 3
          }
        ]
      ],
      [
        'second',
        { inputTokens: 20, cacheTokens: 4, outputTokens: 5, turnCount: 1 },
        [
          {
            id: 'prompt-message-second:model-call:0',
            index: 0,
            inputTokens: 20,
            cacheTokens: 4,
            outputTokens: 5
          }
        ]
      ]
    ])
    expect(events).toEqual([
      {
        kind: 'runtime',
        update: {
          scope: {
            projectId: 'project-1',
            sessionId: 'session-1',
            agentFrameId: 'frame-message-boundary',
            attemptId: 'message-boundary',
            runtimeSegmentId: 'segment-message-second',
            promptMessageId: 'prompt-message-second'
          },
          event: {
            id: 'second-provider-stop',
            timestamp: 20,
            kind: 'stop',
            level: 'info',
            turnUsage: { inputTokens: 20, cacheTokens: 4, outputTokens: 5, turnCount: 1 },
            modelCallUsage: [
              {
                id: 'prompt-message-second:model-call:0',
                index: 0,
                inputTokens: 20,
                cacheTokens: 4,
                outputTokens: 5
              }
            ]
          }
        }
      }
    ])
  })

  it('rejects an unaccepted Main-to-child delivery when the continuation transport fails', async () => {
    const firstPrompt = deferred<PromptResponse>()
    let callbacks!: AcpDelegateExecutionCallbacks
    const execution = createAcpDelegateExecution({
      capacity: 1,
      prepare: async (input) => ({
        executionId: input.attemptId,
        provenance: {
          projectId: input.session.projectId,
          sessionId: input.session.sessionId,
          agentFrameId: input.frameId,
          runtimeSegmentId: input.runtimeSegmentId
        },
        workspace: { cwd: '/workspace/message-failure' },
        runtimeHome: '/runtime/message-failure',
        frameworkId: 'certified-test',
        capability: { revoke: async () => undefined }
      }),
      assertFrameworkNativeDelegationDisabled: async () => undefined,
      createRuntime: (_scope, runtimeCallbacks) => {
        callbacks = runtimeCallbacks
        let promptCount = 0
        return {
          createSession: async () => ({ sessionId: 'provider-message-failure' }),
          sendAppContinuation: async () => {
            promptCount += 1
            if (promptCount === 1) {
              callbacks.onProviderPromptAccepted('provider-message-failure')
              return firstPrompt.promise
            }
            throw new Error('continuation transport failed')
          },
          cancelPrompt: async () => undefined,
          respondToPermission: async () => undefined,
          setPermissionProfile: async () => undefined,
          deleteSession: async () => undefined,
          shutdownForQuit: async () => ({ reaped: true })
        }
      }
    })
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('message-failure'), reservation.slotIds[0])
    await running.accepted
    const delivery = running.sendMessage('will not arrive')

    firstPrompt.resolve({ stopReason: 'end_turn' })

    await expect(delivery).rejects.toThrow('continuation transport failed')
    await expect(running.completion).rejects.toThrow('continuation transport failed')
  })

  it('starts the delegated Session in the parent project with its permission profile', async () => {
    const { execution, controls } = makeHarness(1, { permissionProfile: () => 'full' })
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('full-access'), reservation.slotIds[0])

    await running.accepted
    expect(controls.get('full-access')?.createdSessions).toEqual([
      {
        cwd: '/workspace/frame-full-access',
        projectId: 'project-1',
        permissionProfile: 'full'
      }
    ])

    controls.get('full-access')?.complete()
    await running.completion
  })

  it('changes the permission profile for an active delegated Session', async () => {
    const { execution, controls } = makeHarness(1)
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('profile-change'), reservation.slotIds[0])
    await running.accepted

    await running.setPermissionProfile('ask')

    expect(controls.get('profile-change')?.permissionProfiles).toEqual(['ask'])
    controls.get('profile-change')?.complete()
    await running.completion
  })

  it('settles cancellation requested while preparation is still in flight', async () => {
    const prepare = deferred<PreparedDelegateExecution>()
    const createRuntime = vi.fn()
    const execution = createAcpDelegateExecution({
      capacity: 1,
      prepare: () => prepare.promise,
      assertFrameworkNativeDelegationDisabled: async () => undefined,
      createRuntime
    })
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('preparing'), reservation.slotIds[0])
    const cancelled = running.cancel()

    prepare.resolve({
      executionId: 'preparing',
      provenance: {
        projectId: 'project-1',
        sessionId: 'session-1',
        agentFrameId: 'frame-preparing',
        runtimeSegmentId: 'segment-preparing'
      },
      workspace: { cwd: '/workspace/frame-preparing' },
      runtimeHome: '/runtime/preparing',
      frameworkId: 'certified-test',
      capability: { revoke: async () => undefined }
    })

    await cancelled
    await expect(running.accepted).rejects.toMatchObject({
      name: 'DelegateMessagePreAcceptanceError'
    })
    await expect(running.completion).resolves.toEqual({ status: 'cancelled' })
    expect(createRuntime).not.toHaveBeenCalled()
    await expect(execution.reserve(1)).resolves.toHaveProperty('slotIds')
  })

  it('reserves an entire batch atomically and releases terminal slots', async () => {
    const { execution, controls } = makeHarness(2)
    const reservation = await execution.reserve(2)
    expect(reservation.slotIds).toHaveLength(2)
    await expect(execution.reserve(1)).rejects.toMatchObject({
      code: 'capacity'
    })

    const first = execution.run(makeInput('one'), reservation.slotIds[0])
    const second = execution.run(makeInput('two'), reservation.slotIds[1])
    await Promise.all([first.accepted, second.accepted])
    controls.get('one')?.complete()
    controls.get('two')?.complete()
    await Promise.all([first.completion, second.completion])

    await expect(execution.reserve(2)).resolves.toHaveProperty('slotIds')
  })

  it('does not let failed duplicate scope cleanup release a running sibling scope', async () => {
    const { execution, controls } = makeHarness(3, {
      runtimeHome: () => '/runtime/shared'
    })
    const reservation = await execution.reserve(2)
    const first = execution.run(makeInput('scope-owner'), reservation.slotIds[0])
    const duplicate = execution.run(makeInput('scope-duplicate'), reservation.slotIds[1])
    await first.accepted
    await expect(duplicate.completion).rejects.toThrow('runtime home is already active')

    const nextReservation = await execution.reserve(1)
    const stillDuplicate = execution.run(makeInput('scope-third'), nextReservation.slotIds[0])
    await expect(stillDuplicate.completion).rejects.toThrow('runtime home is already active')

    controls.get('scope-owner')!.complete()
    await expect(first.completion).resolves.toMatchObject({ status: 'completed' })
    const afterRelease = await execution.reserve(1)
    expect(afterRelease.slotIds).toHaveLength(1)
  })

  it('routes graph provenance, workspace, runtime home, events, permission, and cancel by Attempt', async () => {
    const { execution, controls, prepared } = makeHarness(2)
    const reservation = await execution.reserve(2)
    const first = execution.run(makeInput('one'), reservation.slotIds[0])
    const second = execution.run(makeInput('two'), reservation.slotIds[1])
    const firstEvents: string[] = []
    const secondEvents: string[] = []
    first.subscribe((event) => firstEvents.push(JSON.stringify(event)))
    second.subscribe((event) => secondEvents.push(JSON.stringify(event)))
    await Promise.all([first.accepted, second.accepted])

    controls.get('one')?.callbacks.onEvent({
      id: 'first-message',
      timestamp: 1,
      kind: 'message',
      level: 'info',
      sessionId: 'provider-one',
      role: 'assistant',
      text: 'first only'
    })
    controls.get('two')?.callbacks.onPermissionRequest({
      requestId: 'permission-two',
      sessionId: 'provider-two',
      toolCallId: 'tool-two',
      title: 'second only',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_always', scope: 'session' }]
    })
    await second.respondToPermission({ requestId: 'permission-two', optionId: 'allow' })
    await first.cancel()

    expect(prepared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          executionId: 'one',
          runtimeHome: '/runtime/one',
          workspace: { cwd: '/workspace/frame-one' },
          provenance: expect.objectContaining({
            sessionId: 'session-1',
            agentFrameId: 'frame-one',
            runtimeSegmentId: 'segment-one'
          })
        }),
        expect.objectContaining({ executionId: 'two', runtimeHome: '/runtime/two' })
      ])
    )
    expect(firstEvents.join('\n')).toContain('first only')
    expect(firstEvents.join('\n')).not.toContain('second only')
    expect(secondEvents.join('\n')).toContain('permission-two')
    expect(secondEvents.join('\n')).toContain('"scope":"session"')
    expect(controls.get('two')?.responses).toEqual([
      { requestId: 'permission-two', optionId: 'allow' }
    ])
    expect(controls.get('two')?.prompts).toEqual(['task-two'])
    controls.get('two')?.complete()
    await second.completion
  })

  it('forwards rich runtime events with app-owned Attempt provenance', async () => {
    const { execution, controls } = makeHarness(1)
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('rich-events'), reservation.slotIds[0])
    const events: unknown[] = []
    running.subscribe((event) => events.push(event))
    await running.accepted

    controls.get('rich-events')?.callbacks.onEvent({
      id: 'tool-event',
      timestamp: 10,
      kind: 'tool',
      level: 'info',
      sessionId: 'provider-rich-events',
      promptMessageId: 'provider-owned-prompt',
      toolCallId: 'tool-1',
      title: 'Inspect evidence',
      status: 'in_progress',
      rawInput: { path: 'paper.pdf' }
    })
    controls.get('rich-events')?.callbacks.onEvent({
      id: 'stop-event',
      timestamp: 20,
      kind: 'stop',
      level: 'info',
      sessionId: 'provider-rich-events',
      promptMessageId: 'provider-owned-prompt',
      turnUsage: {
        inputTokens: 100,
        cacheTokens: 20,
        outputTokens: 30,
        turnCount: 1
      },
      modelCallUsage: [
        {
          id: 'prompt-rich-events:model-call:0',
          index: 0,
          inputTokens: 100,
          cacheTokens: 20,
          outputTokens: 30,
          contextUsedTokens: 120,
          contextWindowSize: 200_000
        }
      ]
    })
    controls.get('rich-events')?.complete()
    await expect(running.completion).resolves.toMatchObject({
      status: 'completed',
      turnUsage: {
        inputTokens: 100,
        cacheTokens: 20,
        outputTokens: 30,
        turnCount: 1
      },
      modelCallUsage: [
        {
          id: 'prompt-rich-events:model-call:0',
          index: 0,
          inputTokens: 100,
          cacheTokens: 20,
          outputTokens: 30,
          contextUsedTokens: 120,
          contextWindowSize: 200_000
        }
      ]
    })

    expect(events).toEqual([
      {
        kind: 'runtime',
        update: {
          scope: {
            projectId: 'project-1',
            sessionId: 'session-1',
            agentFrameId: 'frame-rich-events',
            attemptId: 'rich-events',
            runtimeSegmentId: 'segment-rich-events',
            promptMessageId: 'prompt-rich-events'
          },
          event: {
            id: 'tool-event',
            timestamp: 10,
            kind: 'tool',
            level: 'info',
            toolCallId: 'tool-1',
            title: 'Inspect evidence',
            status: 'in_progress',
            rawInput: { path: 'paper.pdf' }
          }
        }
      },
      {
        kind: 'runtime',
        update: {
          scope: {
            projectId: 'project-1',
            sessionId: 'session-1',
            agentFrameId: 'frame-rich-events',
            attemptId: 'rich-events',
            runtimeSegmentId: 'segment-rich-events',
            promptMessageId: 'prompt-rich-events'
          },
          event: {
            id: 'stop-event',
            timestamp: 20,
            kind: 'stop',
            level: 'info',
            turnUsage: {
              inputTokens: 100,
              cacheTokens: 20,
              outputTokens: 30,
              turnCount: 1
            },
            modelCallUsage: [
              {
                id: 'prompt-rich-events:model-call:0',
                index: 0,
                inputTokens: 100,
                cacheTokens: 20,
                outputTokens: 30,
                contextUsedTokens: 120,
                contextWindowSize: 200_000
              }
            ]
          }
        }
      }
    ])
  })

  it('ignores a replayed stop without corrupting its usage or final event', async () => {
    const { execution, controls } = makeHarness(1)
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('replayed-stop'), reservation.slotIds[0])
    const events: unknown[] = []
    running.subscribe((event) => events.push(event))
    await running.accepted

    controls.get('replayed-stop')?.callbacks.onEvent({
      id: 'provider-stop',
      timestamp: 20,
      kind: 'stop',
      level: 'info',
      sessionId: 'provider-replayed-stop',
      turnUsage: {
        inputTokens: 100,
        cacheTokens: 20,
        outputTokens: 30,
        turnCount: 1
      }
    })
    controls.get('replayed-stop')?.callbacks.onEvent({
      id: 'provider-stop',
      timestamp: 21,
      kind: 'stop',
      level: 'warning',
      sessionId: 'provider-replayed-stop'
    })
    controls.get('replayed-stop')?.complete()

    await expect(running.completion).resolves.toEqual({
      status: 'completed',
      response: '',
      turnUsage: {
        inputTokens: 100,
        cacheTokens: 20,
        outputTokens: 30,
        turnCount: 1
      }
    })
    expect(events).toEqual([
      {
        kind: 'runtime',
        update: {
          scope: {
            projectId: 'project-1',
            sessionId: 'session-1',
            agentFrameId: 'frame-replayed-stop',
            attemptId: 'replayed-stop',
            runtimeSegmentId: 'segment-replayed-stop',
            promptMessageId: 'prompt-replayed-stop'
          },
          event: {
            id: 'provider-stop',
            timestamp: 20,
            kind: 'stop',
            level: 'info',
            turnUsage: {
              inputTokens: 100,
              cacheTokens: 20,
              outputTokens: 30,
              turnCount: 1
            }
          }
        }
      }
    ])
  })

  it('does not let a replay add usage that the original stop omitted', async () => {
    const { execution, controls } = makeHarness(1)
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('replayed-unavailable-stop'), reservation.slotIds[0])
    const events: unknown[] = []
    running.subscribe((event) => events.push(event))
    await running.accepted

    controls.get('replayed-unavailable-stop')?.callbacks.onEvent({
      id: 'provider-stop',
      timestamp: 20,
      kind: 'stop',
      level: 'info',
      sessionId: 'provider-replayed-unavailable-stop'
    })
    controls.get('replayed-unavailable-stop')?.callbacks.onEvent({
      id: 'provider-stop',
      timestamp: 21,
      kind: 'stop',
      level: 'info',
      sessionId: 'provider-replayed-unavailable-stop',
      turnUsage: {
        inputTokens: 100,
        cacheTokens: 20,
        outputTokens: 30,
        turnCount: 1
      }
    })
    controls.get('replayed-unavailable-stop')?.complete()

    await expect(running.completion).resolves.toEqual({
      status: 'completed',
      response: '',
      turnUsageUnavailable: true
    })
    expect(events).toEqual([
      {
        kind: 'runtime',
        update: {
          scope: {
            projectId: 'project-1',
            sessionId: 'session-1',
            agentFrameId: 'frame-replayed-unavailable-stop',
            attemptId: 'replayed-unavailable-stop',
            runtimeSegmentId: 'segment-replayed-unavailable-stop',
            promptMessageId: 'prompt-replayed-unavailable-stop'
          },
          event: {
            id: 'provider-stop',
            timestamp: 20,
            kind: 'stop',
            level: 'info'
          }
        }
      }
    ])
  })

  it('keeps a permission request retryable when the ACP response transport fails', async () => {
    let shouldFail = true
    const { execution, controls } = makeHarness(1, {
      permissionResponseError: () =>
        shouldFail ? new Error('response transport failed') : undefined
    })
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('permission-retry'), reservation.slotIds[0])
    await running.accepted
    controls.get('permission-retry')?.callbacks.onPermissionRequest({
      requestId: 'permission-1',
      sessionId: 'provider-permission-retry',
      toolCallId: 'tool-1',
      title: 'Read evidence',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })

    await expect(
      running.respondToPermission({ requestId: 'permission-1', optionId: 'allow' })
    ).rejects.toThrow('response transport failed')
    shouldFail = false
    await expect(
      running.respondToPermission({ requestId: 'permission-1', optionId: 'allow' })
    ).resolves.toBeUndefined()
    expect(controls.get('permission-retry')?.responses).toEqual([
      { requestId: 'permission-1', optionId: 'allow' }
    ])
    controls.get('permission-retry')?.complete()
    await running.completion
  })

  it('revokes writes before cleanup and drops late provider events', async () => {
    const { execution, controls, cleanup } = makeHarness(1)
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('cleanup'), reservation.slotIds[0])
    const events: string[] = []
    running.subscribe((event) => events.push(JSON.stringify(event)))
    await running.accepted
    controls.get('cleanup')?.complete()
    await running.completion

    controls.get('cleanup')?.callbacks.onEvent({
      id: 'late',
      timestamp: 2,
      kind: 'message',
      level: 'info',
      sessionId: 'provider-cleanup',
      role: 'assistant',
      text: 'too late'
    })

    expect(events.join('\n')).not.toContain('too late')
    expect(cleanup).toEqual([
      'revoke:cleanup',
      'delete:cleanup',
      'shutdown:cleanup',
      'resources:cleanup'
    ])
  })

  it('fails closed before runtime creation when framework certification fails', async () => {
    const createRuntime = vi.fn()
    const execution = createAcpDelegateExecution({
      capacity: 1,
      prepare: async (input) => ({
        executionId: input.attemptId,
        provenance: {
          projectId: input.session.projectId,
          sessionId: input.session.sessionId,
          agentFrameId: input.frameId,
          runtimeSegmentId: 'segment-unsafe'
        },
        workspace: { cwd: '/workspace/unsafe' },
        runtimeHome: '/runtime/unsafe',
        frameworkId: 'unsafe',
        capability: { revoke: async () => undefined }
      }),
      assertFrameworkNativeDelegationDisabled: async () => {
        throw new Error(
          'native delegation remains enabled: sk-provider-secret capability-token-secret private prompt\n    at provider.ts:42'
        )
      },
      createRuntime
    })
    const reservation = await execution.reserve(1)
    const running = execution.run(makeInput('unsafe'), reservation.slotIds[0])

    const failure = await running.completion.catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'unsupported_framework' })
    if (!(failure instanceof Error)) throw new Error('expected framework certification failure')
    expect(failure.message).toBe(
      'Delegated work is unavailable for unsafe because its native Task/Agent/multi-agent bypass audit failed. Disable every native delegation entry point and re-run framework certification.'
    )
    expect(failure.message).not.toContain('sk-provider-secret')
    expect(failure.message).not.toContain('private prompt')
    expect(failure.message).not.toContain('provider.ts')
    expect(createRuntime).not.toHaveBeenCalled()
  })

  it('rejects an adapter that replaces the staged Frame cwd', async () => {
    const { execution, controls, cleanup } = makeHarness(1, {
      workspace: () => '/workspace/adapter-selected'
    })
    const reservation = await execution.reserve(1)
    const running = execution.run(
      { ...makeInput('workspace-scope'), workspaceCwd: '/workspace/main-staged' },
      reservation.slotIds[0]
    )

    await expect(running.completion).rejects.toThrow(
      'workspace does not match the staged Frame cwd'
    )
    expect(controls.size).toBe(0)
    expect(cleanup).toEqual(['revoke:workspace-scope', 'resources:workspace-scope'])
  })

  it('contains provider startup failure to its child and keeps the sibling runtime alive', async () => {
    const { execution, controls } = makeHarness(2, {
      createSessionError: (executionId) =>
        executionId === 'bad-startup' ? new Error('provider startup failed') : undefined
    })
    const reservation = await execution.reserve(2)
    const failed = execution.run(makeInput('bad-startup'), reservation.slotIds[0])
    const sibling = execution.run(makeInput('good-startup'), reservation.slotIds[1])

    await expect(failed.completion).rejects.toThrow('provider startup failed')
    await expect(sibling.accepted).resolves.toBe('provider_prompt_accepted')
    controls.get('good-startup')!.complete()
    await expect(sibling.completion).resolves.toMatchObject({ status: 'completed' })
  })

  it('contains provider execution failure to its child and keeps the sibling runtime alive', async () => {
    const { execution, controls } = makeHarness(2)
    const reservation = await execution.reserve(2)
    const badInput = makeInput('bad')
    const goodInput = makeInput('good')
    const original = execution.run(badInput, reservation.slotIds[0])
    const sibling = execution.run(goodInput, reservation.slotIds[1])
    await vi.waitFor(() => expect(controls.has('bad')).toBe(true))
    await vi.waitFor(() => expect(controls.has('good')).toBe(true))
    controls.get('bad')!.fail(new Error('provider startup failed'))

    await expect(original.completion).rejects.toThrow('provider startup failed')
    let siblingDone = false
    void sibling.completion.then(() => {
      siblingDone = true
    })
    await Promise.resolve()
    expect(siblingDone).toBe(false)
    controls.get('good')?.complete()
    await expect(sibling.completion).resolves.toMatchObject({ status: 'completed' })
  })
})

const _eventTypeCheck: AcpRuntimeEvent | undefined = undefined
void _eventTypeCheck
