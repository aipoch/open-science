import { describe, expect, it, vi } from 'vitest'

import { createDeterministicDelegateExecution } from './deterministic-execution'
import {
  createDurableDelegatedWork,
  createInMemoryDelegatedWorkRecords,
  type AuthenticatedDelegateCaller
} from './durable-delegated-work'

const parent: AuthenticatedDelegateCaller = {
  session: { projectId: 'project-1', sessionId: 'session-1' },
  frameId: 'root-frame',
  role: 'main',
  originMessageId: 'origin-message',
  toolInvocationId: 'delegate-call'
}

const createStructuredOutputWork = (
  options: Omit<Parameters<typeof createDurableDelegatedWork>[0], 'resolveExecutionModel'>
): ReturnType<typeof createDurableDelegatedWork> =>
  createDurableDelegatedWork({
    ...options,
    resolveExecutionModel: async () => ({
      snapshot: {
        frameworkId: 'opencode',
        providerId: 'test-provider',
        backendId: 'opencode:test-provider',
        modelRoute: 'opencode-anthropic',
        model: 'test-model',
        reasoningEffort: 'default'
      }
    })
  })

describe('DurableDelegatedWork structured output', () => {
  it('accepts one child-owned value, makes equal retry idempotent, and projects it at terminal', async () => {
    const execution = createDeterministicDelegateExecution()
    const work = createStructuredOutputWork({
      execution,
      records: createInMemoryDelegatedWorkRecords({
        session: parent.session,
        rootFrameId: parent.frameId,
        originMessageId: parent.originMessageId
      })
    })
    const dispatch = await work.delegate(
      parent,
      {
        task: 'Extract',
        name: 'Extract structured answer',
        outputSchema: {
          type: 'object',
          required: ['answer'],
          properties: { answer: { type: 'number' } },
          additionalProperties: false
        }
      },
      { wait: false }
    )
    const child = dispatch.children[0]
    const caller: AuthenticatedDelegateCaller = {
      ...parent,
      frameId: child.frameId,
      attemptId: child.attemptId,
      role: 'delegate',
      toolInvocationId: 'submit-call'
    }

    await expect(work.submitOutput(caller, { answer: 42 })).resolves.toEqual({ accepted: true })
    await expect(work.submitOutput(caller, { answer: 42 })).resolves.toEqual({ accepted: true })
    await expect(work.submitOutput(caller, { answer: 43 })).rejects.toMatchObject({
      code: 'conflict'
    })
    execution.control(child.attemptId).complete('Text remains')
    await expect(
      work.collect(parent, [{ frameId: child.frameId, attemptId: child.attemptId }])
    ).resolves.toMatchObject([
      {
        status: 'completed',
        response: 'Text remains',
        structuredOutput: { answer: 42 },
        structuredOutputUnsatisfied: false
      }
    ])
  })

  it('keeps running observations private and marks a missing terminal submission unsatisfied', async () => {
    const execution = createDeterministicDelegateExecution()
    const work = createStructuredOutputWork({
      execution,
      records: createInMemoryDelegatedWorkRecords({
        session: parent.session,
        rootFrameId: parent.frameId,
        originMessageId: parent.originMessageId
      })
    })
    const dispatch = await work.delegate(
      parent,
      { task: 'Extract', name: 'Extract', outputSchema: true },
      { wait: false }
    )
    const child = dispatch.children[0]
    expect(await work.collect(parent, [child.frameId], { timeoutSeconds: 0 })).toEqual([
      expect.not.objectContaining({ structuredOutputUnsatisfied: expect.anything() })
    ])
    execution.control(child.attemptId).complete('No value')
    await expect(work.collect(parent, [child.frameId])).resolves.toMatchObject([
      { status: 'completed', structuredOutputUnsatisfied: true }
    ])
  })

  it('rejects schema batches before capacity reservation and rejects late or unauthorized submit', async () => {
    const execution = createDeterministicDelegateExecution()
    const work = createStructuredOutputWork({
      execution,
      records: createInMemoryDelegatedWorkRecords({
        session: parent.session,
        rootFrameId: parent.frameId,
        originMessageId: parent.originMessageId
      })
    })
    await expect(
      work.delegate(
        parent,
        [
          { task: 'ok', name: 'ok', outputSchema: true },
          { task: 'bad', name: 'bad', outputSchema: { format: 'email' } }
        ],
        { wait: false }
      )
    ).rejects.toThrow()
    expect(execution.reservationCounts()).toEqual([])

    const dispatch = await work.delegate(
      { ...parent, toolInvocationId: 'second' },
      { task: 'done', name: 'done', outputSchema: true },
      { wait: false }
    )
    const child = dispatch.children[0]
    await expect
      .poll(() =>
        execution.controls().some((control) => control.input.attemptId === child.attemptId)
      )
      .toBe(true)
    execution.control(child.attemptId).complete('done')
    await expect
      .poll(
        async () => (await work.collect(parent, [child.frameId], { timeoutSeconds: 0 }))[0].status
      )
      .not.toBe('running')
    await expect(
      work.submitOutput(
        { ...parent, role: 'delegate', frameId: child.frameId, attemptId: child.attemptId },
        null
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(work.submitOutput(parent, null)).rejects.toMatchObject({ code: 'authorization' })
  })

  it('rejects an invalid schema before resolving Specialists or validating inputs', async () => {
    const resolveSpecialist = vi.fn(async () => ({
      id: 'specialist-1',
      name: 'EVIDENCE_ANALYST',
      displayName: 'Evidence Analyst',
      enabled: true,
      setupPending: false,
      revision: 1
    }))
    const validateInput = vi.fn(async () => true)
    const work = createStructuredOutputWork({
      execution: createDeterministicDelegateExecution(),
      records: createInMemoryDelegatedWorkRecords({
        session: parent.session,
        rootFrameId: parent.frameId,
        originMessageId: parent.originMessageId
      }),
      resolveSpecialist,
      validateInput
    })

    await expect(
      work.delegate(
        parent,
        {
          task: 'Extract',
          name: 'Extract',
          profile: 'specialist-1',
          inputs: ['upload-version-1'],
          outputSchema: { format: 'email' }
        },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'unsupported_schema' })
    expect(resolveSpecialist).not.toHaveBeenCalled()
    expect(validateInput).not.toHaveBeenCalled()
  })

  it('retains a submission committed before stop and rejects the terminal-first race order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: parent.session,
      rootFrameId: parent.frameId,
      originMessageId: parent.originMessageId
    })
    const work = createStructuredOutputWork({ execution, records })
    const first = await work.delegate(
      parent,
      { task: 'first', name: 'first', outputSchema: true },
      { wait: false }
    )
    const firstChild = first.children[0]
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const firstCaller = {
      ...parent,
      frameId: firstChild.frameId,
      attemptId: firstChild.attemptId,
      role: 'delegate' as const
    }
    await work.submitOutput(firstCaller, null)
    await work.stopChildren(parent, [firstChild.frameId])
    await expect(work.collect(parent, [firstChild.frameId])).resolves.toMatchObject([
      {
        status: 'cancelled',
        structuredOutput: null,
        structuredOutputUnsatisfied: false
      }
    ])

    const second = await work.delegate(
      { ...parent, toolInvocationId: 'third' },
      { task: 'second', name: 'second', outputSchema: true },
      { wait: false }
    )
    const secondChild = second.children[0]
    await records.terminalize({
      frameId: secondChild.frameId,
      attemptId: secondChild.attemptId,
      status: 'cancelled',
      endedAt: Date.now(),
      cancellationReason: 'main_agent_stop'
    })
    await expect(
      work.submitOutput(
        {
          ...parent,
          frameId: secondChild.frameId,
          attemptId: secondChild.attemptId,
          role: 'delegate'
        },
        null
      )
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('fails terminal projection closed when reserved Message evidence is malformed', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: parent.session,
      rootFrameId: parent.frameId,
      originMessageId: parent.originMessageId
    })
    const work = createStructuredOutputWork({ execution, records })
    const dispatch = await work.delegate(
      parent,
      { task: 'corrupt', name: 'corrupt', outputSchema: true },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].complete('done')
    await expect.poll(async () => (await work.children(parent))[0].status).toBe('completed')
    const corruptRecords = {
      ...records,
      async snapshot() {
        const snapshot = await records.snapshot()
        return {
          ...snapshot,
          messages: snapshot.messages.map((message, index) =>
            index === 0
              ? {
                  ...message,
                  structuredOutputEvidence: undefined,
                  structuredOutputEvidenceInvalid: true as const
                }
              : message
          )
        }
      }
    }
    const reopened = createStructuredOutputWork({
      execution: createDeterministicDelegateExecution(),
      records: corruptRecords
    })
    await expect(reopened.collect(parent, [dispatch.children[0].frameId])).rejects.toThrow(
      'malformed or cannot be associated'
    )
  })

  it('fails submit and projection closed when valid evidence is attached to a sibling Frame', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: parent.session,
      rootFrameId: parent.frameId,
      originMessageId: parent.originMessageId
    })
    const work = createStructuredOutputWork({ execution, records })
    const dispatch = await work.delegate(
      parent,
      [
        { task: 'target', name: 'target', outputSchema: true },
        { task: 'sibling', name: 'sibling', outputSchema: true }
      ],
      { wait: false }
    )
    const [target, sibling] = dispatch.children
    const misassociatedRecords = {
      ...records,
      async snapshot() {
        const snapshot = await records.snapshot()
        return {
          ...snapshot,
          messages: snapshot.messages.map((message) =>
            message.structuredOutputEvidence?.attemptId === target.attemptId
              ? { ...message, frameId: sibling.frameId }
              : message
          )
        }
      }
    }
    const reopened = createStructuredOutputWork({ execution, records: misassociatedRecords })
    await expect(
      reopened.submitOutput(
        { ...parent, role: 'delegate', frameId: target.frameId, attemptId: target.attemptId },
        null
      )
    ).rejects.toMatchObject({ code: 'durability_failure' })
    execution.control(target.attemptId).complete('done')
    await expect.poll(async () => (await reopened.children(parent))[0].status).toBe('completed')
    await expect(reopened.collect(parent, [target.frameId])).rejects.toThrow(
      'malformed or cannot be associated'
    )
  })
})
