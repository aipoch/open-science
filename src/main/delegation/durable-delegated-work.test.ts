import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ArtifactFile } from '../../shared/artifacts'
import type { ReviewWithChecks } from '../../shared/reviewer'
import { createSpecialistService } from '../specialist/service'
import { createDeterministicDelegateExecution } from './deterministic-execution'
import { DelegateMessagePreAcceptanceError } from './execution-port'
import {
  createInMemoryDelegatedWorkRecords,
  type AuthenticatedDelegateCaller,
  type DelegatedArtifactEvidence,
  type DelegatedReviewEvidence
} from './durable-delegated-work'
import { createTestDurableDelegatedWork as createDurableDelegatedWork } from './durable-delegated-work-test-fixture'

const caller: AuthenticatedDelegateCaller = {
  session: { projectId: 'project-1', sessionId: 'session-1' },
  frameId: 'root-frame',
  role: 'main',
  originMessageId: 'origin-message',
  toolInvocationId: 'tool-call-1'
}

type SpecialistFixture = {
  id: string
  name: string
  displayName: string
  enabled: boolean
  setupPending: boolean
  revision: number
}

const specialist = (overrides: Partial<SpecialistFixture> = {}): SpecialistFixture => ({
  id: 'specialist-stable-id',
  name: 'EVIDENCE_ANALYST',
  displayName: 'Evidence Analyst',
  enabled: true,
  setupPending: false,
  revision: 7,
  ...overrides
})

describe('durable delegated work', () => {
  it('durably queues delegated user questions and resumes only after atomic confirmation', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const ids = {
      frame: ['child-frame'],
      attempt: ['source-attempt', 'answer-attempt'],
      message: ['child-prompt', 'answer-prompt'],
      runtime: ['source-runtime', 'answer-runtime'],
      question: ['question-request']
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })

    await work.delegate(caller, { task: 'Audit the cohort', name: 'Source audit' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const delegatedCaller: AuthenticatedDelegateCaller = {
      session: caller.session,
      frameId: 'child-frame',
      role: 'delegate',
      attemptId: 'source-attempt',
      originMessageId: 'child-prompt',
      toolInvocationId: 'ask-user-tool-call'
    }
    const questionRequest = {
      sessionId: caller.session.sessionId,
      questions: [
        {
          question: 'Which cohort definition should I use?',
          header: 'Cohort',
          options: [
            { label: 'Strict', description: 'Use published exclusions.' },
            { label: 'Broad', description: 'Include the exploratory subgroup.' }
          ]
        }
      ]
    }
    await expect(
      work.requestUserInput(delegatedCaller, questionRequest, 'question-request')
    ).resolves.toEqual({ action: 'pending' })
    await expect(
      work.requestUserInput(delegatedCaller, questionRequest, 'question-request')
    ).resolves.toEqual({ action: 'pending' })
    await expect(
      work.requestUserInput(
        delegatedCaller,
        {
          ...questionRequest,
          questions: [
            { question: 'Different question?', options: [{ label: 'Yes' }, { label: 'No' }] }
          ]
        },
        'question-request'
      )
    ).rejects.toMatchObject({ code: 'conflict' })

    const admitted = await records.snapshot()
    expect(admitted.questionRequests).toMatchObject([
      {
        requestId: 'question-request',
        sourceFrameId: 'child-frame',
        sourceAttemptId: 'source-attempt',
        sourceName: 'Source audit',
        sequence: 1,
        status: 'pending',
        draftAnswers: [],
        draftQuestionIndex: 0
      }
    ])
    expect(admitted.messages).toHaveLength(1)
    expect(admitted.messageCommands).toHaveLength(0)

    await work.updateQuestionDraft(caller.session, {
      requestId: 'question-request',
      draftAnswers: [{ questionIndex: 0, value: 'Strict' }],
      questionIndex: 0
    })
    expect(execution.controls()).toHaveLength(1)

    execution.controls()[0].complete('Waiting for the user choice.')
    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0].status)
      .toBe('completed')
    await expect(work.children(caller)).resolves.toMatchObject([
      { frameId: 'child-frame', attemptId: 'source-attempt', status: 'awaiting_user' }
    ])

    await expect(
      work.confirmQuestion(caller.session, {
        requestId: 'question-request',
        answers: [{ questionIndex: 0, value: 'Strict' }]
      })
    ).resolves.toMatchObject({
      requestId: 'question-request',
      continuationAttemptId: 'answer-attempt'
    })
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls()[1].input).toMatchObject({
      frameId: 'child-frame',
      attemptId: 'answer-attempt',
      continuation: true
    })
    expect(execution.controls()[1].input.task).toContain('Strict')
    await expect(
      work.confirmQuestion(caller.session, {
        requestId: 'question-request',
        answers: [{ questionIndex: 0, value: 'Strict' }]
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(execution.controls()).toHaveLength(2)
  })

  it('cancels pending delegated questions on Stop and rejects a late confirmation', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const ids = {
      frame: ['child-stop'],
      attempt: ['attempt-stop'],
      message: ['message-stop'],
      runtime: ['runtime-stop'],
      question: ['question-stop']
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    await work.delegate(caller, { task: 'Ask then stop', name: 'Stopping child' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    await work.requestUserInput(
      {
        session: caller.session,
        frameId: 'child-stop',
        role: 'delegate',
        attemptId: 'attempt-stop',
        originMessageId: 'message-stop',
        toolInvocationId: 'ask-before-stop'
      },
      {
        sessionId: caller.session.sessionId,
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }]
      },
      'question-stop'
    )

    await work.stopSession(caller.session)

    await expect(
      work.confirmQuestion(caller.session, {
        requestId: 'question-stop',
        answers: [{ questionIndex: 0, value: 'Yes' }]
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect((await records.snapshot()).questionRequests[0]).toMatchObject({ status: 'cancelled' })
    expect(execution.controls()).toHaveLength(1)
  })

  it('returns awaiting_user instead of a final result from blocking delegate', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const ids = {
      frame: ['child-waiting'],
      attempt: ['attempt-waiting'],
      message: ['message-waiting'],
      runtime: ['runtime-waiting'],
      question: ['question-waiting']
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    const outcome = work.delegate(caller, {
      task: 'Ask before finishing',
      name: 'Blocking question child'
    })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    await work.requestUserInput(
      {
        session: caller.session,
        frameId: 'child-waiting',
        role: 'delegate',
        attemptId: 'attempt-waiting',
        originMessageId: 'message-waiting',
        toolInvocationId: 'ask-while-blocking'
      },
      {
        sessionId: caller.session.sessionId,
        questions: [{ question: 'Scope?', options: [{ label: 'Focused' }, { label: 'Broad' }] }]
      },
      'question-waiting'
    )
    execution.controls()[0].complete('Waiting for the user.')

    await expect(outcome).resolves.toEqual({
      kind: 'observations',
      children: [
        {
          frameId: 'child-waiting',
          attemptId: 'attempt-waiting',
          title: 'Blocking question child',
          name: 'Blocking question child',
          agentName: 'Main Agent',
          status: 'awaiting_user'
        }
      ]
    })
    await expect(
      work.collect(caller, [{ frameId: 'child-waiting', attemptId: 'attempt-waiting' }])
    ).resolves.toMatchObject([{ status: 'completed' }])
  })

  it('requires an explicit name for every request before model resolution, reservation, or persistence', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const resolveExecutionModel = vi.fn()
    const work = createDurableDelegatedWork({ execution, records, resolveExecutionModel })

    await expect(
      work.delegate(caller, { task: 'Missing name' } as never, { wait: false })
    ).rejects.toMatchObject({
      code: 'admission_rejection',
      message: expect.stringMatching(/provide a 1–48-code-point non-emoji name and retry/i)
    })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'missing-name-batch' },
        [{ task: 'Named child', name: 'Named child' }, { task: 'Missing name in batch' } as never],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(resolveExecutionModel).not.toHaveBeenCalled()
    expect(execution.reservationCounts()).toEqual([])
    await expect(records.snapshot()).resolves.toMatchObject({ records: [], messages: [] })
  })

  it('normalizes broad Unicode explicit names and atomically rejects invalid names', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const accepted = await work.delegate(
      caller,
      { task: 'accepted', name: '  Café\u2003证据 — ∑ №  ' },
      { wait: false }
    )
    expect(accepted.children[0].name).toBe('Café 证据 — ∑ №')

    const invalidNames: ReadonlyArray<readonly [string, RegExp]> = [
      ['\u2003 ', /empty.*1–48-code-point non-emoji name.*retry/i],
      ['line\nbreak', /newline or control.*remove.*retry/i],
      ['control\u0000name', /newline or control.*remove.*retry/i],
      ['control\u0085name', /newline or control.*remove.*retry/i],
      ['界'.repeat(49), /48 Unicode code points.*shorten.*retry/i],
      ['single 🧪', /emoji.*non-emoji name.*retry/i],
      ['family 👨‍👩‍👧‍👦', /emoji.*non-emoji name.*retry/i],
      ['modifier 👍🏽', /emoji.*non-emoji name.*retry/i],
      ['flag 🇨🇳', /emoji.*non-emoji name.*retry/i],
      ['keycap 1️⃣', /emoji.*non-emoji name.*retry/i],
      ['variation ☀️', /emoji.*non-emoji name.*retry/i]
    ]
    for (const [index, [name, message]] of invalidNames.entries()) {
      await expect(
        work.delegate(
          { ...caller, toolInvocationId: `invalid-name-${index}` },
          [
            { task: 'must not persist', name },
            { task: 'valid sibling', name: 'Valid sibling' }
          ],
          { wait: false }
        )
      ).rejects.toMatchObject({
        code: 'admission_rejection',
        message: expect.stringMatching(message)
      })
    }
    expect(execution.reservationCounts()).toEqual([1])
    expect((await records.snapshot()).records).toHaveLength(1)
  })

  it('accepts exactly 48 code points and gives actionable conflict guidance without renaming', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const base = '界'.repeat(48)

    const outcome = await work.delegate(
      caller,
      { task: 'exactly forty-eight', name: base },
      { wait: false }
    )
    expect(outcome.children[0].name).toBe(base)
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'bounded-conflict' },
        { task: 'duplicate forty-eight', name: base },
        { wait: false }
      )
    ).rejects.toMatchObject({
      code: 'admission_rejection',
      message: expect.stringMatching(/occupied on the current branch.*different name.*retry/i)
    })
    expect((await records.snapshot()).records).toHaveLength(1)
  })

  it('rejects an entire explicit-name-conflict batch using NFC, whitespace, and lowercase keys', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    await expect(
      work.delegate(
        caller,
        [
          { task: 'one', name: 'CAFÉ\u2003Evidence' },
          { task: 'two', name: 'cafe\u0301 evidence' }
        ],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(execution.reservationCounts()).toEqual([])
    await expect(records.snapshot()).resolves.toMatchObject({ records: [] })
  })

  it('keeps terminal sibling names occupied across calls and releases a rejected reservation', async () => {
    const execution = createDeterministicDelegateExecution(2)
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    execution.plan({ status: 'completed', response: 'done' })
    await work.delegate(caller, { task: 'Trace sources', name: 'Trace sources' })

    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'explicit-conflict' },
        { task: 'Must not persist', name: 'trace sources' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })

    const redispatched = await work.delegate(
      { ...caller, toolInvocationId: 'distinct-redispatch' },
      { task: 'Trace sources', name: 'Trace sources 2' },
      { wait: false }
    )
    expect(redispatched.children[0].name).toBe('Trace sources 2')
    expect(execution.reservationCounts()).toEqual([1, 1, 1])
    expect((await records.snapshot()).records).toHaveLength(2)
  })

  it('resolves one model snapshot before reservation and gives it to every child in the batch', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const snapshot = {
      frameworkId: 'opencode' as const,
      providerId: 'provider-b',
      backendId: 'opencode:provider-b',
      modelRoute: 'opencode-openai' as const,
      model: 'model-b',
      reasoningEffort: 'high' as const
    }
    const admissionRelease = vi.fn(async () => undefined)
    const claimReleases = [vi.fn(async () => undefined), vi.fn(async () => undefined)]
    let nextClaim = 0
    const backend = {
      framework: { id: 'opencode' },
      env: { OPENAI_API_KEY: 'admission-memory-secret' }
    } as never
    const backendLease = {
      claim: vi.fn(() => ({ backend, release: claimReleases[nextClaim++] })),
      release: admissionRelease
    }
    const resolveExecutionModel = vi.fn(async () => ({ snapshot, backendLease }))
    const work = createDurableDelegatedWork({ execution, records, resolveExecutionModel })

    await work.delegate(
      caller,
      [
        { task: 'one', name: 'one' },
        { task: 'two', name: 'two' }
      ],
      { wait: false }
    )

    expect(resolveExecutionModel).toHaveBeenCalledOnce()
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(backendLease.claim).toHaveBeenCalledTimes(2)
    expect(admissionRelease).toHaveBeenCalledOnce()
    expect(execution.controls().map(({ input }) => input.executionBackend)).toEqual([
      backend,
      backend
    ])
    expect(execution.controls().map(({ input }) => input.executionModel)).toEqual([
      expect.objectContaining({
        providerId: 'provider-b',
        model: 'model-b',
        reasoningEffort: 'high'
      }),
      expect.objectContaining({
        providerId: 'provider-b',
        model: 'model-b',
        reasoningEffort: 'high'
      })
    ])
    expect(
      (await records.snapshot()).records.map((child) => child.attempts[0].executionModel)
    ).toEqual([
      expect.objectContaining({ providerId: 'provider-b', model: 'model-b' }),
      expect.objectContaining({ providerId: 'provider-b', model: 'model-b' })
    ])
    expect(JSON.stringify(await records.snapshot())).not.toContain('admission-memory-secret')
    expect(claimReleases[0]).not.toHaveBeenCalled()
    expect(claimReleases[1]).not.toHaveBeenCalled()
    execution.controls()[0].accept()
    execution.controls()[0].fail(new Error('first child failed after launch'))
    execution.controls()[1].accept()
    execution.controls()[1].cancel()
    await expect
      .poll(() => claimReleases.every((release) => release.mock.calls.length === 1))
      .toBe(true)
  })

  it('releases an admission backend lease when batch capacity reservation fails', async () => {
    const execution = createDeterministicDelegateExecution()
    execution.rejectNextReservation('capacity')
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const release = vi.fn(async () => undefined)
    const claim = vi.fn()
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveExecutionModel: async () => ({
        snapshot: {
          frameworkId: 'opencode',
          providerId: 'provider-b',
          backendId: 'opencode:provider-b',
          modelRoute: 'opencode-openai',
          model: 'model-b',
          reasoningEffort: 'high'
        },
        backendLease: { claim, release }
      })
    })

    await expect(
      work.delegate(caller, [
        { task: 'one', name: 'one' },
        { task: 'two', name: 'two' }
      ])
    ).rejects.toMatchObject({
      code: 'capacity'
    })
    expect(release).toHaveBeenCalledOnce()
    expect(claim).not.toHaveBeenCalled()
    await expect(records.snapshot()).resolves.toMatchObject({ records: [] })
  })

  it('rejects an unavailable configured model without capacity or durable child side effects', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveExecutionModel: async () => {
        throw new Error('configured model unavailable')
      }
    })

    await expect(
      work.delegate(caller, { task: 'must not start', name: 'must not start' })
    ).rejects.toThrow('configured model unavailable')
    expect(execution.reservationCounts()).toEqual([])
    await expect(records.snapshot()).resolves.toMatchObject({ records: [] })
  })

  it('returns timed observations only after every child has established launch', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    await expect(
      work.delegate(
        caller,
        [
          { task: 'finish during startup', name: 'finish during startup' },
          { task: 'keep running', name: 'keep running' }
        ],
        {
          timeoutSeconds: 0
        }
      )
    ).resolves.toMatchObject({
      kind: 'observations',
      children: [{ status: 'running' }, { status: 'running' }]
    })
    expect(execution.controls()).toHaveLength(2)
  })

  it('terminalizes cancellation that wins before a timed launch establishes its handle', async () => {
    const execution = createDeterministicDelegateExecution()
    let releaseWorkspace!: () => void
    const workspaceBarrier = new Promise<void>((resolve) => {
      releaseWorkspace = resolve
    })
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        async prepare() {
          await workspaceBarrier
          return { cwd: '/workspace/child' }
        }
      }
    })

    const observing = work.delegate(
      caller,
      { task: 'cancel before launch', name: 'cancel before launch' },
      { timeoutSeconds: 0 }
    )
    await expect.poll(async () => (await records.snapshot()).records).toHaveLength(1)
    const cancelling = work.cancelTurn(caller.session, caller.originMessageId)
    releaseWorkspace()

    await expect(cancelling).resolves.toEqual([expect.objectContaining({ status: 'cancelled' })])
    await expect(observing).resolves.toMatchObject({
      kind: 'observations',
      children: [{ status: 'cancelled' }]
    })
    expect(execution.controls()).toEqual([])
  })

  it('rejects conflicting or invalid timed delegate options before reservation', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    await expect(
      work.delegate(
        caller,
        { task: 'never admitted', name: 'never admitted' },
        { wait: false, timeoutSeconds: 1 }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'invalid-timeout' },
        { task: 'never admitted either', name: 'never admitted either' },
        { timeoutSeconds: Number.NaN }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(execution.reservationCounts()).toEqual([])
    await expect(records.snapshot()).resolves.toMatchObject({ records: [] })
  })

  it('cancels only Attempts initiated by the fenced Turn and rejects later admission', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId,
      originMessageIds: ['turn-a', 'turn-b']
    })
    const work = createDurableDelegatedWork({ execution, records })
    const turnA = { ...caller, originMessageId: 'turn-a', toolInvocationId: 'delegate-a' }
    const turnB = { ...caller, originMessageId: 'turn-b', toolInvocationId: 'delegate-b' }
    const childA = await work.delegate(turnA, { task: 'A child', name: 'A child' }, { wait: false })
    const childB = await work.delegate(turnB, { task: 'B child', name: 'B child' }, { wait: false })

    await work.cancelTurn(caller.session, 'turn-b')
    await expect(work.children(turnA)).resolves.toEqual([
      expect.objectContaining({ frameId: childA.children[0].frameId, status: 'running' }),
      expect.objectContaining({ frameId: childB.children[0].frameId, status: 'cancelled' })
    ])
    await expect(
      work.delegate(
        { ...turnB, toolInvocationId: 'late-b' },
        { task: 'late B child', name: 'late B child' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(execution.controls()[0].input.attemptId).toBe(childA.children[0].attemptId)
  })

  it('durably terminalizes every fenced-Turn Attempt when cleanup partially fails', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let failedOnce = false
    const work = createDurableDelegatedWork({
      execution,
      records,
      async revokeAttemptWrites() {
        if (!failedOnce) {
          failedOnce = true
          throw new Error('injected Turn cleanup failure')
        }
      }
    })
    await work.delegate(
      caller,
      [
        { task: 'first', name: 'first' },
        { task: 'second', name: 'second' }
      ],
      { wait: false }
    )

    await expect(work.cancelTurn(caller.session, caller.originMessageId)).rejects.toThrow(
      'could not be stopped'
    )
    expect(
      (await records.snapshot()).records.map((child) => child.attempts.at(-1)!.status)
    ).toEqual(['cancelled', 'cancelled'])
    await expect.poll(() => execution.releasedFrames()).toHaveLength(2)
  })

  it('linearizes a Turn fence before an initial admission waiting to commit', async () => {
    const execution = createDeterministicDelegateExecution()
    let releaseReservation!: () => void
    const reservationBarrier = new Promise<void>((resolve) => {
      releaseReservation = resolve
    })
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution: {
        ...execution,
        async reserve(count) {
          const reservation = await execution.reserve(count)
          await reservationBarrier
          return reservation
        }
      },
      records
    })
    const pending = work.delegate(
      caller,
      { task: 'racing admission', name: 'racing admission' },
      { wait: false }
    )
    await expect.poll(() => execution.reservationCounts()).toEqual([1])

    await work.cancelTurn(caller.session, caller.originMessageId)
    releaseReservation()
    await expect(pending).rejects.toMatchObject({ code: 'conflict' })
    await expect(records.snapshot()).resolves.toMatchObject({ records: [] })
  })

  it('publishes live runtime updates only for their trusted running Attempt', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const updates: unknown[] = []
    const ids = {
      frame: ['child-frame'],
      attempt: ['child-attempt'],
      message: ['child-prompt'],
      runtime: ['child-runtime'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!,
      onAgentRuntimeUpdate: (update) => updates.push(update)
    })

    await work.delegate(
      caller,
      { task: 'Stream evidence', name: 'Stream evidence' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.controls()[0]
    control.emit({
      kind: 'runtime',
      update: {
        scope: {
          projectId: 'project-1',
          sessionId: 'session-1',
          agentFrameId: 'child-frame',
          attemptId: 'child-attempt',
          runtimeSegmentId: 'child-runtime',
          promptMessageId: 'child-prompt'
        },
        event: {
          id: 'tool-1:start',
          timestamp: 10,
          kind: 'tool',
          level: 'info',
          toolCallId: 'tool-1',
          title: 'Read source',
          status: 'in_progress'
        }
      }
    })

    expect(updates).toEqual([
      expect.objectContaining({
        scope: expect.objectContaining({
          agentFrameId: 'child-frame',
          attemptId: 'child-attempt',
          runtimeSegmentId: 'child-runtime',
          promptMessageId: 'child-prompt'
        }),
        event: expect.objectContaining({ kind: 'tool', toolCallId: 'tool-1' })
      })
    ])

    control.complete('done')
  })

  it('correlates root permission cards to the trusted current Frame and Attempt', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const permissionEvents: unknown[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      onRootPermissionEvent: (event) => permissionEvents.push(event)
    })
    const dispatched = await work.delegate(
      caller,
      [
        { task: 'Inspect alpha', name: 'Alpha child' },
        { task: 'Inspect beta', name: 'Beta child' }
      ],
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)

    execution.controls()[0].emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-alpha',
      title: 'Read alpha.csv',
      options: [{ optionId: 'allow-alpha', name: 'Allow once', kind: 'allow_once' }]
    })
    execution.controls()[1].emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-beta',
      title: 'Run beta check',
      options: [{ optionId: 'deny-beta', name: 'Deny', kind: 'reject_once' }]
    })

    expect(permissionEvents).toMatchObject([
      { kind: 'requested', request: { requestId: 'permission-alpha' } },
      { kind: 'requested', request: { requestId: 'permission-beta' } }
    ])

    await expect(work.rootPermissionRequests(caller.session)).resolves.toEqual([
      {
        requestId: 'permission-alpha',
        frameId: dispatched.children[0].frameId,
        attemptId: dispatched.children[0].attemptId,
        childTitle: 'Alpha child',
        action: 'Read alpha.csv',
        riskScope: 'This call only',
        options: [{ optionId: 'allow-alpha', name: 'Allow once', kind: 'allow_once' }]
      },
      {
        requestId: 'permission-beta',
        frameId: dispatched.children[1].frameId,
        attemptId: dispatched.children[1].attemptId,
        childTitle: 'Beta child',
        action: 'Run beta check',
        riskScope: 'This call only',
        options: [{ optionId: 'deny-beta', name: 'Deny', kind: 'reject_once' }]
      }
    ])
    await expect(work.sessionSummary(caller.session)).resolves.toEqual({
      runningCount: 2,
      children: [
        {
          frameId: dispatched.children[0].frameId,
          title: 'Alpha child',
          status: 'running',
          awaitingPermission: true
        },
        {
          frameId: dispatched.children[1].frameId,
          title: 'Beta child',
          status: 'running',
          awaitingPermission: true
        }
      ]
    })

    await work.respondToPermission(caller.session, {
      requestId: 'permission-beta',
      frameId: dispatched.children[1].frameId,
      attemptId: dispatched.children[1].attemptId,
      optionId: 'deny-beta'
    })
    expect(execution.controls()[0].permissionResponses()).toEqual([])
    expect(execution.controls()[1].permissionResponses()).toEqual([
      { requestId: 'permission-beta', optionId: 'deny-beta' }
    ])
    expect(permissionEvents.at(-1)).toMatchObject({
      kind: 'settled',
      request: { requestId: 'permission-beta' }
    })
    await expect(work.rootPermissionRequests(caller.session)).resolves.toMatchObject([
      { requestId: 'permission-alpha' }
    ])

    execution.controls()[0].complete('done')
    execution.controls()[1].complete('denied')
  })

  it('removes delegated permissions on branch change and rejects a stale response', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let activeOrigins = [caller.originMessageId]
    const records = {
      ...durableRecords,
      async snapshot() {
        return { ...(await durableRecords.snapshot()), originMessageIds: [...activeOrigins] }
      }
    }
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      { task: 'permission work', name: 'permission work' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-stale',
      title: 'Read evidence',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })
    const response = {
      requestId: 'permission-stale',
      frameId: dispatched.children[0].frameId,
      attemptId: dispatched.children[0].attemptId,
      optionId: 'allow'
    }
    await expect(work.rootPermissionRequests(caller.session)).resolves.toHaveLength(1)

    activeOrigins = ['other-branch']
    await expect(work.rootPermissionRequests(caller.session)).resolves.toEqual([])
    await expect(work.respondToPermission(caller.session, response)).rejects.toMatchObject({
      code: 'conflict'
    })
    expect(execution.controls()[0].permissionResponses()).toEqual([])
  })

  it('settles permission response, terminal, and Stop races exactly once', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      { task: 'Risky child', name: 'Risky child' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.controls()[0]
    control.emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-race',
      title: 'Run command',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })

    const first = work.respondToPermission(caller.session, {
      requestId: 'permission-race',
      frameId: dispatched.children[0].frameId,
      attemptId: dispatched.children[0].attemptId,
      optionId: 'allow'
    })
    const duplicate = work.respondToPermission(caller.session, {
      requestId: 'permission-race',
      frameId: dispatched.children[0].frameId,
      attemptId: dispatched.children[0].attemptId,
      cancelled: true
    })
    await expect(first).resolves.toBeUndefined()
    await expect(duplicate).rejects.toMatchObject({ code: 'conflict' })
    expect(control.permissionResponses()).toEqual([
      { requestId: 'permission-race', optionId: 'allow' }
    ])

    control.emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-stop',
      title: 'Write file',
      options: [{ optionId: 'allow-write', name: 'Allow', kind: 'allow_once' }]
    })
    await work.stopSession(caller.session)
    await expect(
      work.respondToPermission(caller.session, {
        requestId: 'permission-stop',
        frameId: dispatched.children[0].frameId,
        attemptId: dispatched.children[0].attemptId,
        optionId: 'allow-write'
      })
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(work.rootPermissionRequests(caller.session)).resolves.toEqual([])
    await expect(
      work.readAgentFrame(caller.session, dispatched.children[0].frameId)
    ).resolves.toMatchObject({
      status: 'cancelled'
    })
  })

  it('restores unresolved permission cards when Stop submission fails', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      revokeAttemptWrites: async () => {
        throw new Error('stop transport unavailable')
      }
    })
    await work.delegate(
      caller,
      { task: 'Permission child', name: 'Permission child' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].emit({
      kind: 'permission',
      awaiting: true,
      requestId: 'permission-retry',
      title: 'Read evidence',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    })

    await expect(work.stopSession(caller.session)).rejects.toThrow('stop transport unavailable')
    await expect(work.rootPermissionRequests(caller.session)).resolves.toMatchObject([
      { requestId: 'permission-retry' }
    ])
    await expect(work.sessionSummary(caller.session)).resolves.toMatchObject({
      children: [{ status: 'running', awaitingPermission: true }]
    })
  })

  it('durably delivers each Main message to the current running child Attempt', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let nextId = 0
    const work = createDurableDelegatedWork({
      execution,
      records,
      now: () => 100 + nextId,
      createId: (kind) => `${kind}-${++nextId}`
    })
    const dispatched = await work.delegate(
      caller,
      { task: 'Long investigation', name: 'Long investigation' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'message-one' },
        dispatched.children[0].frameId,
        'Use newer evidence',
        { kind: 'info' }
      )
    ).resolves.toMatchObject({
      status: 'queued',
      disposition: 'message',
      message_id: expect.any(String)
    })
    await work.sendMessage(
      { ...caller, toolInvocationId: 'message-two' },
      dispatched.children[0].frameId,
      'Use newer evidence',
      { kind: 'info' }
    )

    expect(execution.controls()[0].deliveredMessages()).toEqual([
      'Use newer evidence',
      'Use newer evidence'
    ])
    const pending = (await records.snapshot()).messageCommands
    expect(pending).toHaveLength(2)
    expect(new Set(pending.map(({ messageId }) => messageId)).size).toBe(2)
    expect(pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceFrameId: caller.frameId,
          targetFrameId: dispatched.children[0].frameId,
          targetAttemptId: dispatched.children[0].attemptId,
          text: 'Use newer evidence',
          kind: 'info',
          receipt: expect.objectContaining({ status: 'accepted' })
        })
      ])
    )
  })

  it('delivers a running Delegate question only to its authenticated parent with attribution', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const deliveries: unknown[] = []
    let upwardDeliveryCount = 0
    const work = createDurableDelegatedWork({
      execution,
      records,
      deliverToParent: async (delivery) => {
        upwardDeliveryCount += 1
        if (upwardDeliveryCount === 2) {
          throw new DelegateMessagePreAcceptanceError('root provider rejected before admission')
        }
        await delivery.startDispatch()
        deliveries.push(delivery)
        return 'provider_prompt_completed'
      }
    })
    const dispatched = await work.delegate(
      caller,
      { task: 'Investigate', name: 'Investigate' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    const child = dispatched.children[0]
    const delegateCaller: AuthenticatedDelegateCaller = {
      session: caller.session,
      frameId: child.frameId,
      attemptId: child.attemptId,
      role: 'delegate',
      originMessageId: caller.originMessageId,
      toolInvocationId: 'child-question'
    }

    await expect(
      work.sendMessage(delegateCaller, 'parent', 'Which cohort?', { kind: 'question' })
    ).resolves.toMatchObject({
      status: 'queued',
      direction: 'to_parent',
      target_frame_id: caller.frameId,
      source_attempt_id: child.attemptId
    })
    expect(deliveries).toEqual([
      expect.objectContaining({
        session: caller.session,
        sourceFrameId: child.frameId,
        sourceAttemptId: child.attemptId,
        targetFrameId: caller.frameId,
        text: 'Which cohort?',
        kind: 'question'
      })
    ])
    expect((await records.snapshot()).messageCommands).toEqual([
      expect.objectContaining({
        sourceFrameId: child.frameId,
        sourceAttemptId: child.attemptId,
        targetFrameId: caller.frameId,
        receipt: expect.objectContaining({
          status: 'accepted',
          evidence: 'provider_prompt_completed'
        })
      })
    ])

    const rejected = await work.sendMessage(
      { ...delegateCaller, toolInvocationId: 'child-pre-accept-rejection' },
      'parent',
      'Can the root accept this?',
      { kind: 'question' }
    )
    await expect
      .poll(async () => (await records.snapshot()).messageCommands[1].receipt)
      .toMatchObject({
        status: 'failed',
        error: expect.objectContaining({ code: 'root_pre_accept_failure' })
      })
    await expect(
      work.messageReceipt(
        { ...delegateCaller, toolInvocationId: 'read-child-pre-accept-rejection' },
        rejected.message_id,
        { timeoutSeconds: 0 }
      )
    ).resolves.toMatchObject({
      status: 'failed',
      error: { delivery_may_have_occurred: false }
    })

    await expect(
      work.sendMessage(
        {
          ...delegateCaller,
          session: { ...caller.session, sessionId: 'forged' },
          toolInvocationId: 'forged'
        },
        'parent',
        'Forged',
        { kind: 'info' }
      )
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(
      work.sendMessage(
        { ...delegateCaller, attemptId: 'superseded-attempt', toolInvocationId: 'stale' },
        'parent',
        'Late',
        { kind: 'info' }
      )
    ).rejects.toMatchObject({ code: 'authorization' })
  })

  it('never redispatches a fenced upward message when receipt settlement is temporarily unavailable', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let settlementAvailable = false
    let settlementAttempts = 0
    const records: typeof durableRecords = {
      ...durableRecords,
      async settleMessage(messageId, receipt) {
        settlementAttempts += 1
        if (!settlementAvailable) throw new Error('receipt commit unavailable')
        return durableRecords.settleMessage(messageId, receipt)
      }
    }
    let deliveries = 0
    const work = createDurableDelegatedWork({
      execution,
      records,
      deliverToParent: async (delivery) => {
        expect(await delivery.startDispatch()).toBe('started')
        deliveries += 1
        return 'provider_prompt_accepted'
      }
    })
    const delegated = await work.delegate(
      caller,
      { task: 'Investigate', name: 'Investigate' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    const child = delegated.children[0]

    await work.sendMessage(
      {
        session: caller.session,
        frameId: child.frameId,
        attemptId: child.attemptId,
        role: 'delegate',
        originMessageId: caller.originMessageId,
        toolInvocationId: 'post-fence-settlement-failure'
      },
      'parent',
      'Provider accepted this once.'
    )
    await expect.poll(() => settlementAttempts).toBe(2)
    expect(deliveries).toBe(1)

    await work.wakeMessages()
    await Promise.resolve()
    expect(settlementAttempts).toBe(2)
    expect(deliveries).toBe(1)

    settlementAvailable = true
    await work.wakeMessages()
    await expect
      .poll(async () => (await records.snapshot()).messageCommands[0].receipt.status)
      .toBe('queued')
    expect(deliveries).toBe(1)

    await work.recoverInterrupted()
    await expect
      .poll(async () => (await records.snapshot()).messageCommands[0].receipt.status)
      .toBe('uncertain')
    expect(deliveries).toBe(1)
  })

  it('deduplicates one successful message invocation by identity, not by text', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      { task: 'Investigate', name: 'Investigate' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    const messageCaller = { ...caller, toolInvocationId: 'stable-message-call' }

    const [first, duplicate] = await Promise.all([
      work.sendMessage(messageCaller, dispatched.children[0].frameId, 'Same text'),
      work.sendMessage(messageCaller, dispatched.children[0].frameId, 'Same text')
    ])

    expect(duplicate.message_id).toBe(first.message_id)
    expect(execution.controls()[0].deliveredMessages()).toEqual(['Same text'])
    expect((await records.snapshot()).messageCommands).toHaveLength(1)
  })

  it('retains uncertain delivery as undelivered history and does not replay it after restart', async () => {
    const baseExecution = createDeterministicDelegateExecution()
    const execution = {
      ...baseExecution,
      run(input: Parameters<typeof baseExecution.run>[0], slotId: string) {
        const handle = baseExecution.run(input, slotId)
        return {
          ...handle,
          sendMessage: async () => Promise.reject(new Error('provider unavailable'))
        }
      }
    }
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      { task: 'Investigate', name: 'Investigate' },
      { wait: false }
    )
    await expect.poll(() => baseExecution.controls()).toHaveLength(1)
    baseExecution.controls()[0].accept()

    const admitted = await work.sendMessage(
      { ...caller, toolInvocationId: 'failed-message' },
      dispatched.children[0].frameId,
      'Additional context'
    )
    expect(admitted).toMatchObject({ status: 'queued' })
    await expect
      .poll(async () => (await records.snapshot()).messageCommands[0].receipt.status)
      .toBe('uncertain')
    await expect(
      work.messageReceipt({ ...caller, toolInvocationId: 'observe-message' }, admitted.message_id, {
        timeoutSeconds: 0
      })
    ).resolves.toMatchObject({ status: 'uncertain', resolution: 'pending' })
    await expect(
      work.resolveMessage({ ...caller, toolInvocationId: 'resolve-message' }, admitted.message_id, {
        action: 'acknowledge_uncertain'
      })
    ).resolves.toMatchObject({ status: 'uncertain', resolution: 'acknowledged' })

    const restartedExecution = createDeterministicDelegateExecution()
    const restarted = createDurableDelegatedWork({ execution: restartedExecution, records })
    await restarted.recoverInterrupted()
    expect(restartedExecution.controls()).toEqual([])
    expect((await records.snapshot()).messageCommands[0].receipt.status).toBe('uncertain')
  })

  it('maps adapter acceptance evidence and proven pre-accept rejection into durable receipts', async () => {
    const baseExecution = createDeterministicDelegateExecution()
    let deliveryCount = 0
    const execution = {
      ...baseExecution,
      run(input: Parameters<typeof baseExecution.run>[0], slotId: string) {
        const handle = baseExecution.run(input, slotId)
        return {
          ...handle,
          async sendMessage() {
            deliveryCount += 1
            if (deliveryCount === 1) return 'provider_prompt_completed' as const
            throw new DelegateMessagePreAcceptanceError('provider rejected before admission')
          }
        }
      }
    }
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const delegated = await work.delegate(
      caller,
      { task: 'Investigate', name: 'Investigate' },
      { wait: false }
    )
    await expect.poll(() => baseExecution.controls()).toHaveLength(1)
    baseExecution.controls()[0].accept()

    const completed = await work.sendMessage(
      { ...caller, toolInvocationId: 'completed-evidence' },
      delegated.children[0].frameId,
      'completed evidence'
    )
    await expect
      .poll(async () => (await records.snapshot()).messageCommands[0].receipt)
      .toMatchObject({ status: 'accepted', evidence: 'provider_prompt_completed' })

    const rejected = await work.sendMessage(
      { ...caller, toolInvocationId: 'pre-accept-rejection' },
      delegated.children[0].frameId,
      'rejected before admission'
    )
    await expect
      .poll(async () => (await records.snapshot()).messageCommands[1].receipt)
      .toMatchObject({
        status: 'failed',
        error: expect.objectContaining({ code: 'provider_pre_accept_failure' })
      })
    await expect(
      work.messageReceipt(
        { ...caller, toolInvocationId: 'read-completed-evidence' },
        completed.message_id,
        { timeoutSeconds: 0 }
      )
    ).resolves.toMatchObject({
      status: 'accepted',
      evidence: 'provider_prompt_completed'
    })
    await expect(
      work.messageReceipt(
        { ...caller, toolInvocationId: 'read-pre-accept-rejection' },
        rejected.message_id,
        { timeoutSeconds: 0 }
      )
    ).resolves.toMatchObject({ status: 'failed', error: { delivery_may_have_occurred: false } })
  })

  it('keeps an uncertain lane head fenced and reliably schedules its successor after acknowledge', async () => {
    const baseExecution = createDeterministicDelegateExecution()
    let deliveryCount = 0
    const execution = {
      ...baseExecution,
      run(input: Parameters<typeof baseExecution.run>[0], slotId: string) {
        const handle = baseExecution.run(input, slotId)
        return {
          ...handle,
          sendMessage: async () => {
            deliveryCount += 1
            if (deliveryCount === 1) throw new Error('acceptance evidence unavailable')
            return 'provider_prompt_accepted' as const
          }
        }
      }
    }
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const delegated = await work.delegate(
      caller,
      { task: 'Investigate', name: 'Investigate' },
      { wait: false }
    )
    await expect.poll(() => baseExecution.controls()).toHaveLength(1)
    baseExecution.controls()[0].accept()

    const first = await work.sendMessage(
      { ...caller, toolInvocationId: 'lane-first' },
      delegated.children[0].frameId,
      'first'
    )
    await work.sendMessage(
      { ...caller, toolInvocationId: 'lane-second' },
      delegated.children[0].frameId,
      'second'
    )
    await expect
      .poll(async () => (await records.snapshot()).messageCommands[0].receipt.status)
      .toBe('uncertain')
    expect(deliveryCount).toBe(1)

    await work.resolveMessage({ ...caller, toolInvocationId: 'lane-ack' }, first.message_id, {
      action: 'acknowledge_uncertain'
    })
    await expect.poll(() => deliveryCount).toBe(2)
    await expect
      .poll(async () => (await records.snapshot()).messageCommands[1].receipt.status)
      .toBe('accepted')
  })

  it('keeps the admitted running-Attempt route when the target terminalizes after command commit', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let raced = false
    const records: typeof durableRecords = {
      ...durableRecords,
      async admitMessage(command) {
        const result = await durableRecords.admitMessage(command)
        if (!raced) {
          raced = true
          await durableRecords.terminalize({
            frameId: command.targetFrameId,
            attemptId: command.targetAttemptId!,
            status: 'cancelled',
            endedAt: command.queuedAt,
            cancellationReason: 'main_agent_stop'
          })
          execution.control(command.targetAttemptId!).cancel()
        }
        return result
      }
    }
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      { task: 'Investigate', name: 'Investigate' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'racing-message' },
        dispatched.children[0].frameId,
        'Continue after terminal'
      )
    ).resolves.toMatchObject({
      disposition: 'message',
      target_frame_id: dispatched.children[0].frameId
    })
  })

  it('marks a queued Main-to-child message only after the execution delivery boundary resolves', async () => {
    const baseExecution = createDeterministicDelegateExecution()
    let acceptDelivery!: () => void
    const deliveryBoundary = new Promise<'provider_prompt_accepted'>((resolve) => {
      acceptDelivery = () => resolve('provider_prompt_accepted')
    })
    const execution = {
      ...baseExecution,
      run(input: Parameters<typeof baseExecution.run>[0], slotId: string) {
        const handle = baseExecution.run(input, slotId)
        return { ...handle, sendMessage: async () => deliveryBoundary }
      }
    }
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      { task: 'Investigate', name: 'Investigate' },
      { wait: false }
    )
    await expect.poll(() => baseExecution.controls()).toHaveLength(1)
    baseExecution.controls()[0].accept()

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'delivery-boundary' },
        dispatched.children[0].frameId,
        'Accepted later'
      )
    ).resolves.toMatchObject({ status: 'queued' })
    expect((await records.snapshot()).messageCommands[0].receipt.status).toBe('queued')

    acceptDelivery()

    await expect
      .poll(async () => (await records.snapshot()).messageCommands[0].receipt.status)
      .toBe('accepted')
  })

  it('rejects late delivery after cancellation without fabricating deliveredAt', async () => {
    const baseExecution = createDeterministicDelegateExecution()
    let releaseDelivery!: () => void
    const deliveryGate = new Promise<'provider_prompt_accepted'>((resolve) => {
      releaseDelivery = () => resolve('provider_prompt_accepted')
    })
    const execution = {
      ...baseExecution,
      run(input: Parameters<typeof baseExecution.run>[0], slotId: string) {
        const handle = baseExecution.run(input, slotId)
        return { ...handle, sendMessage: async () => deliveryGate }
      }
    }
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      { task: 'Investigate', name: 'Investigate' },
      { wait: false }
    )
    await expect.poll(() => baseExecution.controls()).toHaveLength(1)
    baseExecution.controls()[0].accept()
    const delivery = work.sendMessage(
      { ...caller, toolInvocationId: 'late-message' },
      dispatched.children[0].frameId,
      'Too late'
    )
    await expect.poll(async () => (await records.snapshot()).messageCommands).toHaveLength(1)

    await work.stopChildren(caller, [dispatched.children[0].frameId])
    releaseDelivery()

    await expect(delivery).resolves.toMatchObject({ status: 'queued' })
    await expect
      .poll(async () => (await records.snapshot()).messageCommands[0].receipt.status)
      .toBe('accepted')
  })

  it('projects finalized child Artifact evidence from its execution-scoped owner', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const artifacts = [
      {
        id: 'artifact-version-1',
        artifactId: 'artifact-1',
        versionId: 'artifact-version-1',
        versionNumber: 1,
        checksum: 'abc123',
        createdAt: '2026-08-07T00:00:00.000Z',
        projectId: 'project-1',
        sessionId: 'session-1',
        runId: 'artifact-run-1',
        name: 'evidence.md',
        path: '/managed/evidence.md',
        fileUrl: 'file:///managed/evidence.md',
        mimeType: 'text/markdown',
        size: 8,
        mtimeMs: 1
      }
    ]
    const finalize = vi.fn(async () => undefined)
    const dispose = vi.fn(async () => undefined)
    const open = vi.fn(async () => ({ finalize, dispose }))
    const project = vi.fn(async () => artifacts)
    const artifactEvidence: DelegatedArtifactEvidence = { open, project }
    const counts = { frame: 0, attempt: 0, message: 0, runtime: 0, question: 0 }
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence,
      createId: (kind) => `${kind}-${++counts[kind]}`
    })

    const pending = work.delegate(caller, { task: 'Create evidence', name: 'Create evidence' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(open).toHaveBeenCalledWith({
      session: caller.session,
      executionId: 'attempt-1',
      attemptId: 'attempt-1',
      rootFrameId: 'root-frame',
      agentFrameId: 'frame-1',
      messageBranchId: 'branch-frame-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'message-1',
      agentName: 'Main Agent'
    })
    execution.controls()[0].accept()
    execution.controls()[0].complete('Evidence is ready')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'completed',
          terminalMessageId: 'message-2',
          artifactsCreated: artifacts
        }
      ]
    })
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(project).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: 'attempt-1',
        runtimeSegmentIds: ['runtime-1'],
        terminalMessageId: 'message-2'
      })
    )
    await expect(work.readAgentFrame(caller.session, 'frame-1')).resolves.toMatchObject({
      messages: [
        { role: 'user', content: 'Create evidence' },
        { role: 'assistant', content: 'Evidence is ready', artifacts }
      ]
    })
    expect((await records.snapshot()).records[0].attempts[0]).not.toHaveProperty('artifactsCreated')
  })

  it('reuses existing Review card projection after reopen without changing child lifecycle state', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const persistedReview: ReviewWithChecks = {
      id: 'review-child-1',
      projectId: caller.session.projectId,
      sessionId: caller.session.sessionId,
      turnMessageId: 'message-2',
      scope: {
        turnMessageId: 'message-2',
        agentFrameId: 'frame-1',
        messageBranchId: 'branch-frame-1',
        blocks: [],
        artifactVersionIds: []
      },
      lifecycle: 'complete',
      outcome: 'flagged',
      model: 'reviewer-model',
      reviewerLog: [],
      createdAt: 20,
      updatedAt: 21,
      checks: [
        {
          id: 'check-1',
          reviewId: 'review-child-1',
          status: 'warn',
          claim: 'Qualification is missing',
          evidence: 'The terminal response overstates the result.',
          resolution: 'open',
          sortIndex: 0,
          reflagCount: 0
        }
      ]
    }
    const project = vi.fn(async () => [persistedReview])
    const reviewEvidence: DelegatedReviewEvidence = { project }
    const counts = { frame: 0, attempt: 0, message: 0, runtime: 0, question: 0 }
    const first = createDurableDelegatedWork({
      execution,
      records,
      reviewEvidence,
      createId: (kind) => `${kind}-${++counts[kind]}`
    })

    const pending = first.delegate(caller, {
      task: 'Review this child turn',
      name: 'Review this child turn'
    })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Child answer')
    await pending

    const beforeProjection = structuredClone((await records.snapshot()).records[0].attempts[0])
    await expect(first.readAgentFrame(caller.session, 'frame-1')).resolves.toMatchObject({
      status: 'completed',
      messages: [
        { role: 'user', content: 'Review this child turn' },
        { role: 'assistant', content: 'Child answer', reviews: [persistedReview] }
      ]
    })
    expect(project).toHaveBeenCalledWith({
      session: caller.session,
      attemptId: 'attempt-1',
      agentFrameId: 'frame-1',
      messageBranchId: 'branch-frame-1',
      terminalMessageId: 'message-2',
      artifactVersionIds: []
    })

    const reopened = createDurableDelegatedWork({ execution, records, reviewEvidence })
    await expect(reopened.readAgentFrame(caller.session, 'frame-1')).resolves.toMatchObject({
      status: 'completed',
      messages: [{ role: 'user' }, { role: 'assistant', reviews: [persistedReview] }]
    })
    expect((await records.snapshot()).records[0].attempts[0]).toEqual(beforeProjection)
  })

  it('keeps Reviewer authority read-only across delegated lifecycle commands', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const pending = work.delegate(caller, {
      task: 'Immutable child lifecycle',
      name: 'Immutable child lifecycle'
    })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Done')
    const completed = await pending
    const frameId = completed.children[0].frameId
    const reviewer = {
      ...caller,
      role: 'reviewer' as const,
      toolInvocationId: 'reviewer-forged-command'
    }
    const before = await records.snapshot()

    await expect(
      work.delegate(reviewer, { task: 'forged dispatch', name: 'forged dispatch' })
    ).rejects.toMatchObject({
      code: 'authorization'
    })
    await expect(work.sendMessage(reviewer, frameId, 'forged resume')).rejects.toMatchObject({
      code: 'authorization'
    })
    await expect(work.stopChildren(reviewer, [frameId])).rejects.toMatchObject({
      code: 'authorization'
    })
    expect(await records.snapshot()).toEqual(before)
  })

  it('revokes a cancelled child Artifact handle before cancellation without affecting its sibling', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const lifecycle: string[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async ({ attemptId }) => ({
          execution: { currentRunFile: `/handoff/${attemptId}.json` },
          finalize: async () => {
            lifecycle.push(`finalize:${attemptId}`)
          },
          dispose: async () => {
            lifecycle.push(`dispose:${attemptId}`)
          }
        }),
        project: async () => []
      },
      createId: (() => {
        const counts = { frame: 0, attempt: 0, message: 0, runtime: 0, question: 0 }
        return (kind) => `${kind}-${++counts[kind]}`
      })()
    })
    const dispatched = await work.delegate(
      caller,
      [
        { task: 'cancel me', name: 'cancel me' },
        { task: 'keep writing', name: 'keep writing' }
      ],
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls().map(({ input }) => input.artifactCurrentRunFile)).toEqual([
      '/handoff/attempt-1.json',
      '/handoff/attempt-2.json'
    ])
    execution.controls()[0].accept()
    execution.controls()[1].accept()

    await work.stopChildren(caller, [dispatched.children[0].frameId])
    expect(lifecycle[0]).toBe('dispose:attempt-1')
    execution.controls()[1].complete('sibling evidence')

    await expect(
      work.collect(
        caller,
        dispatched.children.map(({ frameId }) => frameId)
      )
    ).resolves.toMatchObject([
      { status: 'cancelled' },
      { status: 'completed', response: 'sibling evidence' }
    ])
    expect(lifecycle).toContain('finalize:attempt-2')
  })

  it('keeps parallel child Artifact projections isolated when siblings finalize out of order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const finalized = new Set<string>()
    const evidenceFor = (attemptId: string): ArtifactFile[] => [
      {
        id: `version-${attemptId}`,
        projectId: 'project-1',
        sessionId: 'session-1',
        name: `${attemptId}.md`,
        path: `/managed/${attemptId}.md`,
        fileUrl: `file:///managed/${attemptId}.md`,
        size: 1,
        mtimeMs: 1,
        versionId: `version-${attemptId}`
      }
    ]
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async ({ attemptId }) => ({
          finalize: async () => {
            finalized.add(attemptId)
          },
          dispose: async () => undefined
        }),
        project: async ({ attemptId }) => (finalized.has(attemptId) ? evidenceFor(attemptId) : [])
      },
      createId: (() => {
        const counts = { frame: 0, attempt: 0, message: 0, runtime: 0, question: 0 }
        return (kind) => `${kind}-${++counts[kind]}`
      })()
    })
    const dispatched = await work.delegate(
      caller,
      [
        { task: 'first', name: 'first' },
        { task: 'second', name: 'second' }
      ],
      {
        wait: false
      }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)
    for (const control of execution.controls()) control.accept()
    execution.control('attempt-2').complete('second done')
    execution.control('attempt-1').complete('first done')

    await expect(
      work.collect(
        caller,
        dispatched.children.map(({ frameId }) => frameId)
      )
    ).resolves.toMatchObject([
      { attemptId: 'attempt-1', artifactsCreated: [{ versionId: 'version-attempt-1' }] },
      { attemptId: 'attempt-2', artifactsCreated: [{ versionId: 'version-attempt-2' }] }
    ])
  })

  it('fails completion closed when Artifact finalization fails and preserves owner evidence', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const existing = {
      id: 'version-existing',
      projectId: 'project-1',
      sessionId: 'session-1',
      name: 'existing.md',
      path: '/managed/existing.md',
      fileUrl: 'file:///managed/existing.md',
      size: 1,
      mtimeMs: 1,
      versionId: 'version-existing'
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async () => ({
          finalize: async () => {
            throw new Error('Artifact finalization proof failed')
          },
          dispose: async () => undefined
        }),
        project: async () => [existing]
      }
    })
    const pending = work.delegate(caller, { task: 'fragile Artifact', name: 'fragile Artifact' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('response written before finalize')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'error',
          artifactsCreated: [existing],
          error: { code: 'execution_failure', message: 'Artifact finalization proof failed' }
        }
      ]
    })
    expect((await records.snapshot()).records[0].attempts[0]).not.toHaveProperty('artifactsCreated')
  })

  it('revokes an orphan Artifact capability during restart recovery while preserving durable evidence', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const opened = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async () => ({ finalize: async () => undefined, dispose: async () => undefined }),
        project: async () => []
      }
    })
    await opened.delegate(
      caller,
      { task: 'interrupted Artifact', name: 'interrupted Artifact' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)

    const revoke = vi.fn(async () => undefined)
    const preserved = {
      id: 'version-preserved',
      projectId: 'project-1',
      sessionId: 'session-1',
      name: 'preserved.md',
      path: '/managed/preserved.md',
      fileUrl: 'file:///managed/preserved.md',
      size: 1,
      mtimeMs: 1,
      versionId: 'version-preserved'
    }
    const reopened = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async () => ({ finalize: async () => undefined, dispose: async () => undefined }),
        revoke,
        project: async () => [preserved]
      }
    })

    await expect(reopened.recoverInterrupted()).resolves.toMatchObject({
      interrupted: [
        {
          status: 'cancelled',
          cancellationReason: 'runtime_interrupted',
          artifactsCreated: [preserved]
        }
      ]
    })
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: expect.any(String),
        agentFrameId: expect.any(String),
        runtimeSegmentIds: [expect.any(String)]
      })
    )
  })

  it('disposes a capability that finishes opening after its Attempt was cancelled', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let resolveOpen!: (handle: {
      finalize(terminalMessageId: string): Promise<void>
      dispose(): Promise<void>
    }) => void
    const opening = new Promise<{
      finalize(terminalMessageId: string): Promise<void>
      dispose(): Promise<void>
    }>((resolve) => {
      resolveOpen = resolve
    })
    const dispose = vi.fn(async () => undefined)
    const work = createDurableDelegatedWork({
      execution,
      records,
      artifactEvidence: {
        open: async () => opening,
        project: async () => []
      }
    })
    const dispatched = await work.delegate(
      caller,
      { task: 'cancel while opening', name: 'cancel while opening' },
      { wait: false }
    )
    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0].runtimeSegmentIds)
      .toHaveLength(1)
    const stopping = work.stopChildren(caller, [dispatched.children[0].frameId])
    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0].status)
      .toBe('cancelled')
    resolveOpen({ finalize: async () => undefined, dispose })

    await expect(stopping).resolves.toMatchObject([{ status: 'cancelled' }])
    await expect.poll(() => dispose).toHaveBeenCalled()
    expect(execution.controls()).toEqual([])
  })
  it('defaults an omitted profile to Main Agent without consulting a Specialist resolver', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const resolveSpecialist = vi.fn(async () => specialist())
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    const outcome = await work.delegate(
      caller,
      { task: 'Use the default agent', name: 'Use the default agent' },
      { wait: false }
    )

    expect(resolveSpecialist).not.toHaveBeenCalled()
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual({
      kind: 'main'
    })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input).not.toHaveProperty('profile')
    await expect(
      work.readAgentFrame(caller.session, outcome.children[0].frameId)
    ).resolves.toMatchObject({ resolvedAgent: { kind: 'main' } })
  })

  it('inherits the authenticated parent Specialist for omitted profiles while explicit profiles override it', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const resolveSpecialist = vi.fn(async (profileId: string) =>
      specialist({
        id: profileId,
        displayName: profileId === 'parent-specialist' ? 'Parent Specialist' : 'Explicit Specialist'
      })
    )
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    const outcome = await work.delegate(
      { ...caller, parentSpecialistId: 'parent-specialist' },
      [
        { task: 'Inherited first', name: 'Inherited first' },
        { task: 'Explicit second', name: 'Explicit second', profile: 'explicit-specialist' },
        { task: 'Inherited third', name: 'Inherited third' }
      ],
      { wait: false }
    )

    expect(resolveSpecialist).toHaveBeenCalledWith('parent-specialist')
    expect(resolveSpecialist).toHaveBeenCalledWith('explicit-specialist')
    expect(outcome.children.map((child) => child.agentName)).toEqual([
      'Parent Specialist',
      'Explicit Specialist',
      'Parent Specialist'
    ])
    expect(
      (await records.snapshot()).records.map((child) => child.attempts[0].resolvedAgent)
    ).toEqual([
      {
        kind: 'specialist',
        profileId: 'parent-specialist',
        revision: 7,
        displayName: 'Parent Specialist'
      },
      {
        kind: 'specialist',
        profileId: 'explicit-specialist',
        revision: 7,
        displayName: 'Explicit Specialist'
      },
      {
        kind: 'specialist',
        profileId: 'parent-specialist',
        revision: 7,
        displayName: 'Parent Specialist'
      }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(3)
    expect(execution.controls().map(({ input }) => input.profile)).toEqual([
      'parent-specialist',
      'explicit-specialist',
      'parent-specialist'
    ])
  })

  it('fails an unavailable inherited Specialist batch before capacity, workspace, or durable mutation', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const prepare = vi.fn()
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async (profileId) =>
        profileId === 'explicit-specialist' ? specialist({ id: profileId }) : undefined,
      workspace: { prepare }
    })

    await expect(
      work.delegate(
        { ...caller, parentSpecialistId: 'deleted-parent-specialist' },
        [
          { task: 'Inherited child', name: 'Inherited child' },
          { task: 'Explicit child', name: 'Explicit child', profile: 'explicit-specialist' }
        ],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })

    expect(execution.reservationCounts()).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
    expect((await records.snapshot()).records).toEqual([])
  })

  it('accepts either a stable Specialist id or its unique exact public name while an omitted profile stays Main', async () => {
    const storage = await mkdtemp(join(tmpdir(), 'delegated-profile-reference-'))
    try {
      const profiles = createSpecialistService(storage)
      const selected = await profiles.create({
        name: 'EVIDENCE_ANALYST',
        displayName: 'Evidence Analyst'
      })
      await profiles.create({ name: selected.id, displayName: 'ID-shaped public name' })
      const execution = createDeterministicDelegateExecution()
      const records = createInMemoryDelegatedWorkRecords({
        session: caller.session,
        rootFrameId: caller.frameId,
        originMessageId: caller.originMessageId
      })
      const work = createDurableDelegatedWork({
        execution,
        records,
        resolveSpecialist: (profileId) => profiles.resolveRunnableById(profileId),
        resolveSpecialistReference: (reference) => profiles.resolveRunnableByReference(reference)
      })

      await work.delegate(
        caller,
        [
          { task: 'Select by stable id', name: 'Select by stable id', profile: selected.id },
          { task: 'Select by public name', name: 'Select by public name', profile: selected.name },
          { task: 'Use Main Agent', name: 'Use Main Agent' }
        ],
        { wait: false }
      )

      await expect.poll(() => execution.controls()).toHaveLength(3)
      expect(execution.controls().map(({ input }) => input.profile)).toEqual([
        selected.id,
        selected.id,
        undefined
      ])
      expect(
        (await records.snapshot()).records.map((child) => child.attempts[0].resolvedAgent)
      ).toEqual([
        {
          kind: 'specialist',
          profileId: selected.id,
          revision: 1,
          displayName: 'Evidence Analyst'
        },
        {
          kind: 'specialist',
          profileId: selected.id,
          revision: 1,
          displayName: 'Evidence Analyst'
        },
        { kind: 'main' }
      ])
    } finally {
      await rm(storage, { recursive: true, force: true })
    }
  })

  it('resolves an explicit stable Specialist identity and preserves its dispatch snapshot', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const profile = specialist()
    const resolveSpecialist = vi.fn(async () => profile)
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    const outcome = await work.delegate(
      caller,
      { task: 'Audit the evidence', name: 'Audit the evidence', profile: 'specialist-stable-id' },
      { wait: false }
    )

    expect(resolveSpecialist).toHaveBeenCalledWith('specialist-stable-id')
    profile.displayName = 'Renamed after dispatch'
    profile.revision = 8
    const expectedSnapshot = {
      kind: 'specialist',
      profileId: 'specialist-stable-id',
      revision: 7,
      displayName: 'Evidence Analyst'
    }
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual(
      expectedSnapshot
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input.profile).toBe('specialist-stable-id')
    await expect(
      work.readAgentFrame(caller.session, outcome.children[0].frameId)
    ).resolves.toMatchObject({ resolvedAgent: expectedSnapshot })
    execution.controls()[0].accept()
    execution.controls()[0].complete('Specialist result')
    await expect
      .poll(() => work.readAgentFrame(caller.session, outcome.children[0].frameId))
      .toMatchObject({ status: 'completed', resolvedAgent: expectedSnapshot })
  })

  it('rejects unknown, disabled, and setup-incomplete Specialists before reservation or mutation', async () => {
    for (const [profileId, resolved] of [
      ['unknown-id', undefined],
      ['disabled-id', specialist({ id: 'disabled-id', enabled: false })],
      ['setup-incomplete-id', specialist({ id: 'setup-incomplete-id', setupPending: true })]
    ] as const) {
      const execution = createDeterministicDelegateExecution()
      const records = createInMemoryDelegatedWorkRecords({
        session: caller.session,
        rootFrameId: caller.frameId,
        originMessageId: caller.originMessageId
      })
      const work = createDurableDelegatedWork({
        execution,
        records,
        resolveSpecialist: async () => resolved
      })

      await expect(
        work.delegate(
          { ...caller, toolInvocationId: `tool-call-${profileId}` },
          { task: 'Must not run', name: 'Must not run', profile: profileId },
          { wait: false }
        )
      ).rejects.toMatchObject({ code: 'admission_rejection' })
      expect(execution.reservationCounts()).toEqual([])
      expect((await records.snapshot()).records).toEqual([])
    }
  })

  it('keeps Specialist history stable when the live profile is renamed, disabled, or deleted', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let liveProfile: ReturnType<typeof specialist> | undefined = specialist()
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async () => liveProfile
    })
    const first = await work.delegate(
      caller,
      {
        task: 'Preserve this history',
        name: 'Preserve this history',
        profile: 'specialist-stable-id'
      },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Historical result')
    await expect
      .poll(() => work.readAgentFrame(caller.session, first.children[0].frameId))
      .toMatchObject({ status: 'completed' })

    liveProfile = specialist({ displayName: 'Renamed Specialist', revision: 8 })
    const afterRename = await work.delegate(
      { ...caller, toolInvocationId: 'renamed-redispatch' },
      {
        task: 'Resolve the renamed profile',
        name: 'Resolve the renamed profile',
        profile: 'specialist-stable-id'
      },
      { wait: false }
    )
    expect((await records.snapshot()).records[1].attempts[0].resolvedAgent).toEqual({
      kind: 'specialist',
      profileId: 'specialist-stable-id',
      revision: 8,
      displayName: 'Renamed Specialist'
    })
    await expect.poll(() => execution.controls()).toHaveLength(2)
    execution.controls()[1].accept()
    execution.controls()[1].complete('Renamed result')
    await expect
      .poll(() => work.readAgentFrame(caller.session, afterRename.children[0].frameId))
      .toMatchObject({ status: 'completed' })

    liveProfile = specialist({ displayName: 'Renamed Specialist', revision: 8, enabled: false })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'disabled-redispatch' },
        {
          task: 'Rejected after disable',
          name: 'Rejected after disable',
          profile: 'specialist-stable-id'
        },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    liveProfile = undefined
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'deleted-redispatch' },
        {
          task: 'Rejected after delete',
          name: 'Rejected after delete',
          profile: 'specialist-stable-id'
        },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })

    await expect(
      work.readAgentFrame(caller.session, first.children[0].frameId)
    ).resolves.toMatchObject({
      status: 'completed',
      resolvedAgent: {
        kind: 'specialist',
        profileId: 'specialist-stable-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      }
    })
    expect((await records.snapshot()).records).toHaveLength(2)
    expect(execution.reservationCounts()).toEqual([1, 1])
  })

  it('admits an array atomically and starts every accepted child in request order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const prepared: string[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        async prepare(_session, frameId) {
          prepared.push(frameId)
          return new Promise(() => undefined)
        }
      },
      createId: (() => {
        const counts = { frame: 0, attempt: 0, message: 0, runtime: 0, question: 0 }
        return (kind) => `${kind}-${++counts[kind]}`
      })()
    })

    const outcome = await work.delegate(
      caller,
      [
        { task: 'First investigation', name: 'Explicit title' },
        { task: 'Second investigation', name: 'Second investigation' },
        { task: 'Third investigation', name: 'Third investigation' }
      ],
      { wait: false }
    )

    expect(execution.reservationCounts()).toEqual([3])
    expect(outcome).toEqual({
      kind: 'receipts',
      children: [
        {
          frameId: 'frame-1',
          attemptId: 'attempt-1',
          name: 'Explicit title',
          agentName: 'Main Agent',
          status: 'running'
        },
        {
          frameId: 'frame-2',
          attemptId: 'attempt-2',
          name: 'Second investigation',
          agentName: 'Main Agent',
          status: 'running'
        },
        {
          frameId: 'frame-3',
          attemptId: 'attempt-3',
          name: 'Third investigation',
          agentName: 'Main Agent',
          status: 'running'
        }
      ]
    })
    expect(prepared).toEqual(['frame-1', 'frame-2', 'frame-3'])
    await expect(work.sessionSummary(caller.session)).resolves.toEqual({
      runningCount: 3,
      children: [
        { frameId: 'frame-1', title: 'Explicit title', status: 'running' },
        { frameId: 'frame-2', title: 'Second investigation', status: 'running' },
        { frameId: 'frame-3', title: 'Third investigation', status: 'running' }
      ]
    })
  })

  it('resolves every explicit Specialist in a batch before reserving and preserves each agent snapshot', async () => {
    const rejectedExecution = createDeterministicDelegateExecution()
    const rejectedRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const rejectedWork = createDurableDelegatedWork({
      execution: rejectedExecution,
      records: rejectedRecords,
      resolveSpecialist: async () => undefined
    })

    await expect(
      rejectedWork.delegate(
        caller,
        [
          { task: 'Main child', name: 'Main child' },
          { task: 'Unavailable child', name: 'Unavailable child', profile: 'missing-profile' }
        ],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(rejectedExecution.reservationCounts()).toEqual([])
    expect((await rejectedRecords.snapshot()).records).toEqual([])

    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const resolveSpecialist = vi.fn(async (profileId: string) => specialist({ id: profileId }))
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })

    await work.delegate(
      { ...caller, toolInvocationId: 'mixed-agent-batch' },
      [
        { task: 'Default Main child', name: 'Default Main child' },
        { task: 'Specialist child', name: 'Specialist child', profile: 'specialist-id' }
      ],
      { wait: false }
    )

    expect(resolveSpecialist).toHaveBeenCalledTimes(1)
    expect(resolveSpecialist).toHaveBeenCalledWith('specialist-id')
    expect(execution.reservationCounts()).toEqual([2])
    expect(
      (await records.snapshot()).records.map((child) => child.attempts[0].resolvedAgent)
    ).toEqual([
      { kind: 'main' },
      {
        kind: 'specialist',
        profileId: 'specialist-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls().map((control) => control.input.profile)).toEqual([
      undefined,
      'specialist-id'
    ])
  })

  it('rejects an invalid or over-capacity array without any durable child state', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      validateInput: (identity) => identity.startsWith('upload-version:')
    })

    await expect(
      work.delegate(
        caller,
        [
          { task: 'valid', name: 'valid' },
          { task: 'invalid', name: 'invalid', inputs: ['mutable/path.csv'] }
        ],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await expect(
      work.delegate({ ...caller, toolInvocationId: 'empty-array' }, [], { wait: false })
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(execution.reservationCounts()).toEqual([])
    expect(await records.snapshot()).toMatchObject({ records: [], messages: [] })

    execution.rejectNextReservation('capacity', 'batch capacity unavailable')
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'capacity-array' },
        [
          { task: 'one', name: 'one' },
          { task: 'two', name: 'two' }
        ],
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'capacity', message: 'batch capacity unavailable' })
    expect(execution.reservationCounts()).toEqual([2])
    expect(await records.snapshot()).toMatchObject({ records: [], messages: [] })
  })

  it('fails closed when immutable inputs have no validator and passes the prepared Frame cwd to execution', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const unvalidated = createDurableDelegatedWork({ execution, records })

    await expect(
      unvalidated.delegate(
        caller,
        { task: 'inspect', name: 'inspect', inputs: ['upload-version:one'] },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    expect(execution.controls()).toEqual([])
    expect((await records.snapshot()).records).toEqual([])

    const prepared = createDurableDelegatedWork({
      execution,
      records,
      validateInput: () => true,
      workspace: {
        prepare: async () => ({ cwd: '/stable/frame-workspace' })
      },
      createId: (kind) =>
        ({
          frame: 'cwd-frame',
          attempt: 'cwd-attempt',
          message: 'cwd-message',
          runtime: 'cwd-runtime',
          question: 'cwd-question'
        })[kind]
    })
    const result = prepared.delegate(
      { ...caller, toolInvocationId: 'validated-cwd' },
      { task: 'inspect', name: 'inspect', inputs: ['upload-version:one'] }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input).toMatchObject({
      workspaceCwd: '/stable/frame-workspace'
    })
    execution.control('cwd-attempt').accept()
    execution.control('cwd-attempt').complete('done')
    await result
  })

  it('leaves no partial durable batch when atomic admission rejects after reservation', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const backendRelease = vi.fn(async () => undefined)
    const backendClaim = vi.fn()
    const failingReservationRelease = vi.fn(async () => {
      throw new Error('injected reservation cleanup failure')
    })
    const work = createDurableDelegatedWork({
      execution: {
        ...execution,
        async reserve(count) {
          const reservation = await execution.reserve(count)
          return { ...reservation, releaseAll: failingReservationRelease }
        }
      },
      records,
      createId: (kind) => `duplicate-${kind}`,
      resolveExecutionModel: async () => ({
        snapshot: {
          frameworkId: 'codex',
          providerId: 'test-provider',
          backendId: 'codex:test-provider',
          modelRoute: 'codex-responses',
          model: 'test-model',
          reasoningEffort: 'default'
        },
        backendLease: { claim: backendClaim, release: backendRelease }
      })
    })

    await expect(
      work.delegate(
        caller,
        [
          { task: 'one', name: 'one' },
          { task: 'two', name: 'two' }
        ],
        { wait: false }
      )
    ).rejects.toThrow('Duplicate delegated-work identity')
    expect(execution.reservationCounts()).toEqual([2])
    expect(execution.controls()).toEqual([])
    expect(await records.snapshot()).toMatchObject({ records: [], messages: [] })
    expect(failingReservationRelease).toHaveBeenCalledOnce()
    expect(backendClaim).not.toHaveBeenCalled()
    expect(backendRelease).toHaveBeenCalledOnce()
  })

  it('isolates sibling terminal outcomes and returns wait results in request order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const pending = work.delegate(caller, [
      { task: 'complete last', name: 'complete last' },
      { task: 'fail first', name: 'fail first' },
      { task: 'cancel second', name: 'cancel second' }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(3)
    for (const control of execution.controls()) control.accept()
    execution.controls()[1].fail(new Error('provider startup failed'))
    execution.controls()[2].cancel()

    await expect
      .poll(() => work.children(caller))
      .toEqual([
        {
          frameId: expect.any(String),
          attemptId: expect.any(String),
          title: 'complete last',
          name: 'complete last',
          agentName: 'Main Agent',
          status: 'running'
        },
        {
          frameId: expect.any(String),
          attemptId: expect.any(String),
          title: 'fail first',
          name: 'fail first',
          agentName: 'Main Agent',
          status: 'error'
        },
        {
          frameId: expect.any(String),
          attemptId: expect.any(String),
          title: 'cancel second',
          name: 'cancel second',
          agentName: 'Main Agent',
          status: 'cancelled'
        }
      ])
    execution.controls()[0].complete('surviving evidence')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        { status: 'completed', response: 'surviving evidence' },
        {
          status: 'error',
          error: { code: 'execution_failure', message: 'provider startup failed' }
        },
        { status: 'cancelled', cancellationReason: 'main_agent_stop' }
      ]
    })
  })

  it('terminalizes one child finalization failure without cancelling its sibling', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let failFirstCompletion = true
    const records: typeof durableRecords = {
      ...durableRecords,
      async terminalize(input) {
        if (failFirstCompletion && input.frameId === 'frame-1' && input.status === 'completed') {
          failFirstCompletion = false
          throw new Error('terminal assistant Message write failed')
        }
        await durableRecords.terminalize(input)
      }
    }
    const counts = { frame: 0, attempt: 0, message: 0, runtime: 0, question: 0 }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => `${kind}-${++counts[kind]}`
    })

    const pending = work.delegate(caller, [
      { task: 'fragile finalization', name: 'fragile finalization' },
      { task: 'sibling', name: 'sibling' }
    ])
    await expect.poll(() => execution.controls()).toHaveLength(2)
    for (const control of execution.controls()) control.accept()
    execution.controls()[0].complete('lost response')
    execution.controls()[1].complete('preserved response')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          frameId: 'frame-1',
          status: 'error',
          error: {
            code: 'execution_failure',
            message: 'terminal assistant Message write failed'
          }
        },
        { frameId: 'frame-2', status: 'completed', response: 'preserved response' }
      ]
    })
  })

  it('keeps children in admission order and collects selected children in caller order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let nextId = 1
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => `${kind}-${nextId++}`
    })

    const dispatched = await work.delegate(
      caller,
      [
        { task: 'alpha', name: 'alpha' },
        { task: 'beta', name: 'beta' }
      ],
      {
        wait: false
      }
    )
    const [alpha, beta] = dispatched.children
    await expect.poll(() => execution.controls()).toHaveLength(2)
    execution.control(alpha.attemptId).accept()
    execution.control(beta.attemptId).accept()
    execution.control(beta.attemptId).complete('B')

    const collecting = work.collect(caller, [beta.frameId, alpha.frameId])
    await expect
      .poll(() => work.children(caller))
      .toMatchObject([
        { frameId: alpha.frameId, status: 'running' },
        { frameId: beta.frameId, status: 'completed' }
      ])
    execution.control(alpha.attemptId).complete('A')

    await expect(collecting).resolves.toMatchObject([
      { frameId: beta.frameId, response: 'B' },
      { frameId: alpha.frameId, response: 'A' }
    ])
  })

  it('returns a bounded mixed observation without stopping the running child', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      [
        { task: 'finished', name: 'finished' },
        { task: 'still running', name: 'still running' }
      ],
      {
        wait: false
      }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)
    for (const control of execution.controls()) control.accept()
    execution.controls()[0].complete('done')
    await expect
      .poll(() => work.children(caller))
      .toMatchObject([{ status: 'completed' }, { status: 'running' }])

    await expect(
      work.collect(
        caller,
        dispatched.children.map(({ frameId }) => frameId),
        { timeoutSeconds: 0 }
      )
    ).resolves.toEqual([
      expect.objectContaining({
        frameId: dispatched.children[0].frameId,
        attemptId: dispatched.children[0].attemptId,
        status: 'completed',
        response: 'done',
        artifactsCreated: []
      }),
      {
        frameId: dispatched.children[1].frameId,
        attemptId: dispatched.children[1].attemptId,
        name: 'still running',
        agentName: 'Main Agent',
        status: 'running'
      }
    ])
    await expect(work.children(caller)).resolves.toMatchObject([
      { status: 'completed' },
      { status: 'running' }
    ])

    execution.controls()[1].complete('later')
    await expect
      .poll(() => work.children(caller))
      .toMatchObject([{ status: 'completed' }, { status: 'completed' }])
    await expect(
      work.collect(caller, [dispatched.children[1].frameId], { timeoutSeconds: 0 })
    ).resolves.toMatchObject([{ status: 'completed', response: 'later' }])
  })

  it('returns every pinned observation in caller order when any Attempt settles', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records, collectPollIntervalMs: 1 })
    const dispatched = await work.delegate(
      caller,
      [
        { task: 'first', name: 'first' },
        { task: 'second', name: 'second' }
      ],
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)
    for (const control of execution.controls()) control.accept()

    await expect(
      work.collect(caller, [dispatched.children[1].frameId, dispatched.children[0].frameId], {
        returnWhen: 'any',
        timeoutSeconds: 0
      })
    ).resolves.toMatchObject([{ status: 'running' }, { status: 'running' }])

    const collecting = work.collect(
      caller,
      [dispatched.children[1].frameId, dispatched.children[0].frameId],
      { returnWhen: 'any', timeoutSeconds: 1 }
    )
    execution.controls()[0].complete('first result')

    await expect(collecting).resolves.toMatchObject([
      { frameId: dispatched.children[1].frameId, status: 'running' },
      {
        frameId: dispatched.children[0].frameId,
        status: 'completed',
        response: 'first result'
      }
    ])
    await expect(work.children(caller)).resolves.toMatchObject([
      { status: 'completed' },
      { status: 'running' }
    ])
    execution.controls()[1].complete('second result')
  })

  it('validates collect returnWhen before observing and defaults to all', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      [
        { task: 'terminal', name: 'terminal' },
        { task: 'running', name: 'running' }
      ],
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)
    for (const control of execution.controls()) control.accept()
    execution.controls()[0].complete('done')
    await expect
      .poll(() => work.children(caller))
      .toMatchObject([{ status: 'completed' }, { status: 'running' }])

    await expect(
      work.collect(
        caller,
        dispatched.children.map(({ frameId }) => frameId),
        {
          returnWhen: 'any'
        }
      )
    ).resolves.toMatchObject([{ status: 'completed' }, { status: 'running' }])
    await expect(
      work.collect(
        caller,
        dispatched.children.map(({ frameId }) => frameId),
        {
          timeoutSeconds: 0
        }
      )
    ).resolves.toMatchObject([{ status: 'completed' }, { status: 'running' }])
    await expect(
      work.collect(caller, [dispatched.children[0].frameId], {
        returnWhen: 'first' as 'any'
      })
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    execution.controls()[1].complete('later')
  })

  it('pins explicit Attempt handles and rejects mismatched pairs as one batch', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      { task: 'historical', name: 'historical' },
      { wait: false }
    )
    const handle = dispatched.children[0]
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('historical result')
    await expect.poll(() => work.children(caller)).toMatchObject([{ status: 'completed' }])
    const continuation = await work.sendMessage(
      { ...caller, toolInvocationId: 'continue-after-pin' },
      handle.frameId,
      'continue'
    )
    expect(continuation.disposition).toBe('continued')

    await expect(
      work.collect(caller, [{ frameId: handle.frameId, attemptId: handle.attemptId }], {
        returnWhen: 'any',
        timeoutSeconds: 0
      })
    ).resolves.toEqual([
      {
        frameId: handle.frameId,
        attemptId: handle.attemptId,
        name: 'historical',
        agentName: 'Main Agent',
        status: 'completed',
        terminalMessageId: expect.any(String),
        response: 'historical result',
        artifactsCreated: []
      }
    ])
    await expect(
      work.collect(caller, [handle.frameId, handle.frameId], { timeoutSeconds: 0 })
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'running',
        attemptId: expect.not.stringMatching(handle.attemptId)
      }),
      expect.objectContaining({
        status: 'running',
        attemptId: expect.not.stringMatching(handle.attemptId)
      })
    ])
    await expect(
      work.collect(caller, [{ frameId: handle.frameId, attemptId: 'wrong-attempt' }], {
        timeoutSeconds: 0
      })
    ).rejects.toMatchObject({ code: 'authorization' })
  })

  it('uses the 30 second default, accepts 1800, and rejects invalid wait budgets', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const readings = [0, 30_000, 0, 1_800_000]
    const work = createDurableDelegatedWork({
      execution,
      records,
      collectMonotonicNow: () => readings.shift() ?? 1_800_000
    })
    const dispatched = await work.delegate(
      caller,
      { task: 'bounded', name: 'bounded' },
      { wait: false }
    )
    await expect(work.collect(caller, [dispatched.children[0].frameId])).resolves.toMatchObject([
      { status: 'running' }
    ])
    await expect(
      work.collect(caller, [dispatched.children[0].frameId], { timeoutSeconds: 1800 })
    ).resolves.toMatchObject([{ status: 'running' }])
    for (const timeoutSeconds of [-1, 1801, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        work.collect(caller, [dispatched.children[0].frameId], { timeoutSeconds })
      ).rejects.toMatchObject({ code: 'admission_rejection' })
    }
  })

  it('uses one post-deadline durable snapshot as the final race decision', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const dispatched = await createDurableDelegatedWork({
      execution,
      records: durableRecords
    }).delegate(caller, { task: 'deadline race', name: 'deadline race' }, { wait: false })
    let snapshots = 0
    const readings = [0, 1000]
    const observing = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      collectMonotonicNow: () => readings.shift() ?? 1000,
      records: {
        ...durableRecords,
        async snapshot() {
          const snapshot = await durableRecords.snapshot()
          snapshots += 1
          if (snapshots < 2) return snapshot
          snapshot.records[0].attempts[0].status = 'completed'
          snapshot.records[0].attempts[0].terminalMessageId = 'deadline-terminal'
          return {
            ...snapshot,
            messages: [
              ...snapshot.messages,
              {
                id: 'deadline-terminal',
                frameId: dispatched.children[0].frameId,
                role: 'assistant' as const,
                content: 'committed at deadline',
                responseToMessageId: snapshot.messages[0].id,
                createdAt: 1000
              }
            ]
          }
        }
      }
    })

    await expect(
      observing.collect(caller, [dispatched.children[0].frameId], { timeoutSeconds: 1 })
    ).resolves.toMatchObject([{ status: 'completed', response: 'committed at deadline' }])
    expect(snapshots).toBe(2)
  })

  it('fails closed when active-branch authorization changes during a bounded collect', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const dispatched = await createDurableDelegatedWork({
      execution,
      records: durableRecords
    }).delegate(caller, { task: 'keep running', name: 'keep running' }, { wait: false })
    let snapshots = 0
    const observing = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      collectPollIntervalMs: 1,
      records: {
        ...durableRecords,
        async snapshot() {
          const snapshot = await durableRecords.snapshot()
          snapshots += 1
          return snapshots > 1 ? { ...snapshot, originMessageIds: ['another-branch'] } : snapshot
        }
      }
    })

    await expect(
      observing.collect(caller, [dispatched.children[0].frameId], { timeoutSeconds: 1 })
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(
      createDurableDelegatedWork({ execution, records: durableRecords }).children(caller)
    ).resolves.toMatchObject([{ status: 'running' }])
  })

  it('hides legacy-unavailable children and diagnoses direct access fail-closed', async () => {
    const execution = createDeterministicDelegateExecution()
    const durableRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const dispatched = await createDurableDelegatedWork({
      execution,
      records: durableRecords
    }).delegate(caller, { task: 'legacy child', name: 'legacy child' }, { wait: false })
    const legacyRecords = {
      ...durableRecords,
      async snapshot() {
        const snapshot = await durableRecords.snapshot()
        return {
          ...snapshot,
          records: snapshot.records.map((child) => ({
            ...child,
            originBindingState: 'legacy-unavailable' as const
          }))
        }
      }
    }
    const observing = createDurableDelegatedWork({ execution, records: legacyRecords })

    await expect(observing.children(caller)).resolves.toEqual([])
    await expect(
      observing.collect(caller, [dispatched.children[0].frameId], { timeoutSeconds: 0 })
    ).rejects.toMatchObject({
      code: 'authorization',
      message: expect.stringContaining('legacy')
    })
  })

  it('blocks by default and projects the result from the durable terminal Message', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const pending = work.delegate(caller, { task: 'Trace the source', name: 'Source trace' })

    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toEqual({
        runningCount: 1,
        children: [
          {
            frameId: expect.any(String),
            title: 'Source trace',
            status: 'running'
          }
        ]
      })
    execution.controls()[0].accept()
    execution.controls()[0].complete('The durable answer')

    await expect(pending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'completed',
          response: 'The durable answer',
          terminalMessageId: expect.any(String),
          artifactsCreated: []
        }
      ]
    })
    const durable = await records.snapshot()
    expect(durable.records[0].attempts[0]).not.toHaveProperty('response')
    expect(durable.messages.find((message) => message.role === 'assistant')?.content).toBe(
      'The durable answer'
    )
  })

  it('returns durable cancelled and error results from the default blocking call', async () => {
    const cancelledExecution = createDeterministicDelegateExecution()
    const cancelledRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const cancelledWork = createDurableDelegatedWork({
      execution: cancelledExecution,
      records: cancelledRecords
    })
    const cancelledPending = cancelledWork.delegate(caller, {
      task: 'Cancelable work',
      name: 'Cancelable work'
    })
    await expect.poll(() => cancelledExecution.controls()).toHaveLength(1)
    cancelledExecution.controls()[0].accept()
    cancelledExecution.controls()[0].cancel()

    await expect(cancelledPending).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'cancelled',
          cancellationReason: 'main_agent_stop',
          artifactsCreated: []
        }
      ]
    })

    const failedExecution = createDeterministicDelegateExecution()
    failedExecution.plan({ status: 'failed', error: new Error('provider startup failed') })
    const failedRecords = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const failedWork = createDurableDelegatedWork({
      execution: failedExecution,
      records: failedRecords
    })

    await expect(
      failedWork.delegate(
        { ...caller, toolInvocationId: 'failed-tool-call' },
        { task: 'Fragile work', name: 'Fragile work' }
      )
    ).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'error',
          error: { code: 'execution_failure', message: 'provider startup failed' },
          artifactsCreated: []
        }
      ]
    })
  })

  it('validates authenticated admission before reserving or creating durable state', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({
      execution,
      records,
      validateInput: async (identity) => identity.startsWith('upload-version:')
    })

    await expect(
      work.delegate(
        { ...caller, originMessageId: 'forged-origin', toolInvocationId: 'forged-call' },
        { task: 'private', name: 'private' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(
      work.delegate(
        {
          ...caller,
          role: 'delegate',
          attemptId: 'nested-source-attempt',
          toolInvocationId: 'nested-delegate-call'
        },
        { task: 'nested work', name: 'nested work' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'bad-input-call' },
        { task: 'inspect', name: 'inspect', inputs: ['workspace/current.csv'] },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'profile-call' },
        { task: 'inspect', name: 'inspect', profile: '' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'admission_rejection' })
    for (const [toolInvocationId, request] of [
      ['blank-task-call', { task: '   ', name: '   ' }],
      ['blank-name-call', { task: 'inspect', name: '   ' }]
    ] as const) {
      await expect(
        work.delegate({ ...caller, toolInvocationId }, request, { wait: false })
      ).rejects.toMatchObject({ code: 'admission_rejection' })
    }

    for (const [toolInvocationId, request] of [
      [
        'removed-context-call',
        { task: 'inspect', name: 'inspect', context: 'legacy detail' } as never
      ],
      [
        'removed-context-batch-call',
        [
          { task: 'first', name: 'first' },
          { task: 'second', name: 'second', context: undefined } as never
        ]
      ]
    ] as const) {
      await expect(
        work.delegate({ ...caller, toolInvocationId }, request, { wait: false })
      ).rejects.toMatchObject({
        code: 'admission_rejection',
        message: expect.stringMatching(/context.*removed.*task/i)
      })
    }

    expect(execution.controls()).toEqual([])
    expect(execution.reservationCounts()).toEqual([])
    expect((await records.snapshot()).records).toEqual([])
  })

  it('treats only an own context property as the removed request field', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const request = Object.assign(Object.create({ context: 'prototype detail' }), {
      task: 'inspect',
      name: 'inspect'
    })

    const pending = work.delegate(
      { ...caller, toolInvocationId: 'prototype-context-call' },
      request,
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()

    await expect(pending).resolves.toMatchObject({ kind: 'receipts' })
  })

  it('rejects unavailable delegated-work capability or framework before reserving durable work', async () => {
    for (const availabilityError of [
      new Error('delegated-work capability is unavailable'),
      new Error('framework cannot isolate delegated execution')
    ]) {
      const execution = createDeterministicDelegateExecution()
      const records = createInMemoryDelegatedWorkRecords({
        session: caller.session,
        rootFrameId: caller.frameId,
        originMessageId: caller.originMessageId
      })
      const work = createDurableDelegatedWork({
        execution,
        records,
        assertAvailable: async () => {
          throw availabilityError
        }
      })

      await expect(
        work.delegate(
          caller,
          { task: 'Must not be admitted', name: 'Must not be admitted' },
          { wait: false }
        )
      ).rejects.toMatchObject({ code: 'unsupported_framework', message: availabilityError.message })
      expect(execution.reservationCounts()).toEqual([])
      expect((await records.snapshot()).records).toEqual([])
    }
  })

  it('deduplicates the same authenticated delivery and exposes read-only child conversation detail', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })

    const first = await work.delegate(
      caller,
      { task: 'One child', name: 'One child' },
      { wait: false }
    )
    const duplicate = await work.delegate(
      caller,
      { task: 'Ignored duplicate', name: 'Ignored duplicate' },
      { wait: false }
    )

    expect(duplicate).toEqual(first)
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect((await records.snapshot()).records).toHaveLength(1)
    const frameId = first.children[0].frameId
    const detail = await work.readAgentFrame(caller.session, frameId)
    expect(detail).toEqual({
      frameId,
      title: 'One child',
      status: 'running',
      resolvedAgent: { kind: 'main' },
      messages: [{ role: 'user', content: 'One child' }]
    })
    expect(Object.isFrozen(detail)).toBe(true)
    expect(Object.isFrozen(detail?.messages)).toBe(true)
  })

  it('isolates a child workspace startup failure while its accepted sibling continues', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const workspaceSettlers: Array<{
      resolve(value: { cwd: string }): void
      reject(error: Error): void
    }> = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        prepare: async () =>
          new Promise<{ cwd: string }>((resolve, reject) => {
            workspaceSettlers.push({ resolve, reject })
          })
      }
    })

    const receipt = await work.delegate(
      caller,
      [
        { task: 'Prepare inputs', name: 'Prepare inputs' },
        { task: 'Fragile staging', name: 'Fragile staging' }
      ],
      { wait: false }
    )
    expect(receipt).toMatchObject({
      kind: 'receipts',
      children: [{ status: 'running' }, { status: 'running' }]
    })
    expect(workspaceSettlers).toHaveLength(2)
    workspaceSettlers[1].reject(new Error('immutable input staging failed'))
    workspaceSettlers[0].resolve({ cwd: '/workspace/first' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()

    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toMatchObject({
        runningCount: 1,
        children: [
          {
            frameId: receipt.children[0].frameId,
            status: 'running'
          },
          {
            frameId: receipt.children[1].frameId,
            status: 'error'
          }
        ]
      })
    execution.controls()[0].complete('sibling completed')
    await expect(work.collect(caller, [receipt.children[0].frameId])).resolves.toMatchObject([
      { status: 'completed', response: 'sibling completed' }
    ])
  })

  it('stops a direct child without changing its running sibling or accepting late completion', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let nextId = 1
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async () => specialist(),
      createId: (kind) => `${kind}-${nextId++}`
    })
    const first = await work.delegate(
      caller,
      { task: 'Stop me', name: 'Stop me', profile: 'specialist-stable-id' },
      { wait: false }
    )
    const second = await work.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Keep running', name: 'Keep running' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(2)

    await expect(work.stopChildren(caller, [first.children[0].frameId])).resolves.toEqual([
      { frameId: first.children[0].frameId, status: 'cancelled' }
    ])
    execution.controls()[0].complete('too late')

    await expect(work.sessionSummary(caller.session)).resolves.toEqual({
      runningCount: 1,
      children: [
        { frameId: first.children[0].frameId, title: 'Stop me', status: 'cancelled' },
        { frameId: second.children[0].frameId, title: 'Keep running', status: 'running' }
      ]
    })
    await expect(work.readAgentFrame(caller.session, first.children[0].frameId)).resolves.toEqual({
      frameId: first.children[0].frameId,
      title: 'Stop me',
      status: 'cancelled',
      resolvedAgent: {
        kind: 'specialist',
        profileId: 'specialist-stable-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      },
      messages: [{ role: 'user', content: 'Stop me' }]
    })
  })

  it('stops the running Session snapshot while preserving terminal history and rejecting new dispatch', async () => {
    const execution = createDeterministicDelegateExecution()
    execution.plan({ status: 'completed', response: 'Keep this evidence' })
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    let nextId = 1
    const work = createDurableDelegatedWork({
      execution,
      records,
      settleAttemptCleanup: async () => cleanup,
      createId: (kind) => `${kind}-${nextId++}`
    })
    const completed = await work.delegate(caller, { task: 'Already done', name: 'Already done' })
    const first = await work.delegate(
      { ...caller, toolInvocationId: 'running-1' },
      { task: 'Running one', name: 'Running one' },
      { wait: false }
    )
    const second = await work.delegate(
      { ...caller, toolInvocationId: 'running-2' },
      { task: 'Running two', name: 'Running two' },
      { wait: false }
    )

    const stopping = work.stopSession(caller.session)
    await expect(
      work.delegate(
        { ...caller, toolInvocationId: 'rejected-during-stop' },
        { task: 'Too late', name: 'Too late' },
        { wait: false }
      )
    ).rejects.toMatchObject({ code: 'conflict' })
    releaseCleanup()

    await expect(stopping).resolves.toEqual([
      { frameId: first.children[0].frameId, status: 'cancelled' },
      { frameId: second.children[0].frameId, status: 'cancelled' }
    ])
    await expect(
      work.readAgentFrame(caller.session, completed.children[0].frameId)
    ).resolves.toMatchObject({
      status: 'completed',
      messages: [
        { role: 'user', content: 'Already done' },
        { role: 'assistant', content: 'Keep this evidence' }
      ]
    })
  })

  it('recovers persisted running Attempts as interrupted without restarting a child or deleting its workspace', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const deleteSession = vi.fn(async () => undefined)
    const beforeRestart = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async () => specialist()
    })
    const receipt = await beforeRestart.delegate(
      caller,
      { task: 'Interrupted', name: 'Interrupted', profile: 'specialist-stable-id' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)

    const afterRestart = createDurableDelegatedWork({
      execution,
      records,
      workspace: { prepare: async () => ({ cwd: '/stable-frame' }), deleteSession }
    })
    await expect(afterRestart.recoverInterrupted()).resolves.toEqual({
      interrupted: [
        {
          frameId: receipt.children[0].frameId,
          attemptId: receipt.children[0].attemptId,
          name: 'Interrupted',
          agentName: 'Evidence Analyst',
          status: 'cancelled',
          cancellationReason: 'runtime_interrupted',
          artifactsCreated: []
        }
      ]
    })

    expect(execution.controls()).toHaveLength(1)
    expect(deleteSession).not.toHaveBeenCalled()
    expect((await records.snapshot()).records[0].attempts).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        cancellationReason: 'runtime_interrupted',
        resolvedAgent: {
          kind: 'specialist',
          profileId: 'specialist-stable-id',
          revision: 7,
          displayName: 'Evidence Analyst'
        }
      })
    ])
    await expect(
      afterRestart.collect(caller, [receipt.children[0].frameId], { timeoutSeconds: 0 })
    ).resolves.toMatchObject([{ status: 'cancelled', cancellationReason: 'runtime_interrupted' }])
  })

  it('deletes child workspaces only after Session children have terminal history', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const observedStatuses: string[][] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        prepare: async () => ({ cwd: '/stable-frame' }),
        deleteSession: async () => {
          observedStatuses.push(
            (await records.snapshot()).records.map((child) => child.attempts.at(-1)!.status)
          )
        }
      }
    })
    await work.delegate(caller, { task: 'Delete safely', name: 'Delete safely' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)

    await work.deleteSession(caller.session)

    expect(observedStatuses).toEqual([['cancelled']])
  })

  it('lists only the authenticated Main Agent direct children in durable admission order', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const first = await work.delegate(
      caller,
      { task: 'First task', name: 'First' },
      { wait: false }
    )
    const second = await work.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Second task', name: 'Second' },
      { wait: false }
    )

    await expect(work.children(caller)).resolves.toEqual([
      {
        frameId: first.children[0].frameId,
        attemptId: first.children[0].attemptId,
        title: 'First',
        name: 'First',
        agentName: 'Main Agent',
        status: 'running'
      },
      {
        frameId: second.children[0].frameId,
        attemptId: second.children[0].attemptId,
        title: 'Second',
        name: 'Second',
        agentName: 'Main Agent',
        status: 'running'
      }
    ])
    await expect(
      work.children({ ...caller, session: { ...caller.session, sessionId: 'session-2' } })
    ).rejects.toMatchObject({ code: 'authorization' })
    await expect(work.children({ ...caller, frameId: 'other-parent' })).rejects.toMatchObject({
      code: 'authorization'
    })
  })

  it('projects explicitly requested direct children in request order and rejects the whole unauthorized set', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const first = await work.delegate(caller, { task: 'First', name: 'First' }, { wait: false })
    const second = await work.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Second', name: 'Second' },
      { wait: false }
    )
    const firstId = first.children[0].frameId
    const secondId = second.children[0].frameId

    await expect(work.children(caller, [secondId, firstId])).resolves.toEqual([
      {
        frameId: secondId,
        attemptId: second.children[0].attemptId,
        title: 'Second',
        name: 'Second',
        agentName: 'Main Agent',
        status: 'running'
      },
      {
        frameId: firstId,
        attemptId: first.children[0].attemptId,
        title: 'First',
        name: 'First',
        agentName: 'Main Agent',
        status: 'running'
      }
    ])
    await expect(work.children(caller, [firstId, 'unknown-frame'])).rejects.toMatchObject({
      code: 'authorization'
    })

    const unrelatedParentView = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      records: {
        ...records,
        async snapshot() {
          const snapshot = await records.snapshot()
          return {
            ...snapshot,
            records: snapshot.records.map((child) => ({
              ...child,
              parentFrameId: child.frameId === firstId ? 'another-parent' : child.parentFrameId
            }))
          }
        }
      }
    })
    await expect(unrelatedParentView.children(caller, [firstId])).rejects.toMatchObject({
      code: 'authorization'
    })
    await expect(unrelatedParentView.collect(caller, [firstId])).rejects.toMatchObject({
      code: 'authorization'
    })
  })

  it('collects durable terminal results after reopen only when every requested child is terminal', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const dispatchingWork = createDurableDelegatedWork({ execution, records })
    const first = await dispatchingWork.delegate(
      caller,
      { task: 'First', name: 'First' },
      { wait: false }
    )
    const second = await dispatchingWork.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Second', name: 'Second' },
      { wait: false }
    )
    const firstId = first.children[0].frameId
    const secondId = second.children[0].frameId
    await expect.poll(() => execution.controls()).toHaveLength(2)
    execution.controls()[0].accept()
    execution.controls()[1].accept()

    const reopenedWork = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      records
    })
    let settled = false
    const pending = reopenedWork.collect(caller, [secondId, firstId]).finally(() => {
      settled = true
    })
    execution.controls()[1].complete('Second durable answer')
    await expect
      .poll(async () => (await dispatchingWork.children(caller, [secondId]))[0].status)
      .toBe('completed')
    expect(settled).toBe(false)

    execution.controls()[0].complete('First durable answer')
    await expect(pending).resolves.toEqual([
      {
        frameId: secondId,
        attemptId: second.children[0].attemptId,
        name: 'Second',
        agentName: 'Main Agent',
        status: 'completed',
        terminalMessageId: expect.any(String),
        response: 'Second durable answer',
        artifactsCreated: []
      },
      {
        frameId: firstId,
        attemptId: first.children[0].attemptId,
        name: 'First',
        agentName: 'Main Agent',
        status: 'completed',
        terminalMessageId: expect.any(String),
        response: 'First durable answer',
        artifactsCreated: []
      }
    ])
    await expect(reopenedWork.children(caller)).resolves.toEqual([
      {
        frameId: firstId,
        attemptId: first.children[0].attemptId,
        title: 'First',
        name: 'First',
        agentName: 'Main Agent',
        status: 'completed'
      },
      {
        frameId: secondId,
        attemptId: second.children[0].attemptId,
        title: 'Second',
        name: 'Second',
        agentName: 'Main Agent',
        status: 'completed'
      }
    ])
  })

  it('treats cancelled and error children as terminal and rejects unauthorized collect targets', async () => {
    const execution = createDeterministicDelegateExecution()
    execution.plan({ status: 'failed', error: new Error('safe provider failure') })
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const failed = await work.delegate(
      caller,
      { task: 'Failure', name: 'Failure' },
      { wait: false }
    )
    const cancelled = await work.delegate(
      { ...caller, toolInvocationId: 'tool-call-2' },
      { task: 'Cancellation', name: 'Cancellation' },
      { wait: false }
    )
    const running = await work.delegate(
      { ...caller, toolInvocationId: 'tool-call-3' },
      { task: 'Running', name: 'Running' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(3)
    execution.controls()[1].accept()
    execution.controls()[1].cancel()
    execution.controls()[2].accept()

    await expect(
      work.collect(caller, [failed.children[0].frameId, running.children[0].frameId], {
        returnWhen: 'any'
      })
    ).resolves.toMatchObject([{ status: 'error' }, { status: 'running' }])
    await expect(
      work.collect(caller, [running.children[0].frameId, cancelled.children[0].frameId], {
        returnWhen: 'any'
      })
    ).resolves.toMatchObject([{ status: 'running' }, { status: 'cancelled' }])

    await expect(
      work.collect(caller, [cancelled.children[0].frameId, failed.children[0].frameId])
    ).resolves.toEqual([
      {
        frameId: cancelled.children[0].frameId,
        attemptId: cancelled.children[0].attemptId,
        name: 'Cancellation',
        agentName: 'Main Agent',
        status: 'cancelled',
        artifactsCreated: [],
        cancellationReason: 'main_agent_stop'
      },
      {
        frameId: failed.children[0].frameId,
        attemptId: failed.children[0].attemptId,
        name: 'Failure',
        agentName: 'Main Agent',
        status: 'error',
        artifactsCreated: [],
        error: { code: 'execution_failure', message: 'safe provider failure' }
      }
    ])
    await expect(work.collect(caller, [])).rejects.toMatchObject({
      code: 'admission_rejection'
    })
    await expect(
      work.collect(caller, [failed.children[0].frameId, 'unknown-frame'], {
        returnWhen: 'any'
      })
    ).rejects.toMatchObject({ code: 'authorization' })
    execution.controls()[2].complete('later')
    await expect(
      work.collect({ ...caller, session: { ...caller.session, sessionId: 'session-2' } }, [
        failed.children[0].frameId
      ])
    ).rejects.toMatchObject({ code: 'authorization' })
  })

  it('keeps lifecycle state unchanged when a children query fails and allows a clean retry', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const lifecycleWork = createDurableDelegatedWork({ execution, records })
    const receipt = await lifecycleWork.delegate(
      caller,
      { task: 'Keep running', name: 'Keep running' },
      { wait: false }
    )
    let failNextRead = true
    const observingWork = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      records: {
        ...records,
        async snapshot() {
          if (failNextRead) {
            failNextRead = false
            throw new Error('temporary Session read failure')
          }
          return records.snapshot()
        }
      }
    })

    await expect(observingWork.children(caller)).rejects.toThrow('temporary Session read failure')
    await expect(lifecycleWork.children(caller)).resolves.toMatchObject([
      { frameId: receipt.children[0].frameId, status: 'running' }
    ])
    await expect(observingWork.children(caller)).resolves.toMatchObject([
      { frameId: receipt.children[0].frameId, status: 'running' }
    ])
  })

  it('continues a terminal Main Agent child in the same Frame and conversation', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const workspaceFrames: string[] = []
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveExecutionModel: async () => ({
        snapshot: {
          frameworkId: 'codex',
          providerId: 'stable-provider',
          backendId: 'codex:stable-provider',
          modelRoute: 'codex-responses',
          model: 'stable-model',
          reasoningEffort: 'max'
        }
      }),
      workspace: {
        async prepare(_session, frameId) {
          workspaceFrames.push(frameId)
          return { cwd: `/workspaces/${frameId}` }
        }
      }
    })
    const dispatched = await work.delegate(
      caller,
      { task: 'Inspect the evidence', name: 'Inspect the evidence' },
      { wait: false }
    )
    const frameId = dispatched.children[0].frameId
    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input.runtimeSegmentId).toBe(
      (await records.snapshot()).records[0].attempts[0].runtimeSegmentIds[0]
    )
    execution.controls()[0].accept()
    execution.controls()[0].complete('Initial finding')
    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toMatchObject({
        runningCount: 0,
        children: [{ frameId, status: 'completed' }]
      })

    const continued = await work.sendMessage(
      { ...caller, toolInvocationId: 'continuation-call' },
      frameId,
      'Check a counterexample'
    )

    expect(continued).toMatchObject({
      disposition: 'continued',
      target_frame_id: frameId,
      continuation_attempt_id: expect.any(String)
    })
    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls()[1].input.runtimeSegmentId).toBe(
      (await records.snapshot()).records[0].attempts[1].runtimeSegmentIds[0]
    )
    expect(execution.controls()[1].input).toMatchObject({
      frameId,
      task: 'Check a counterexample',
      continuation: true,
      executionModel: {
        providerId: 'stable-provider',
        model: 'stable-model',
        reasoningEffort: 'max'
      }
    })
    expect(
      (await records.snapshot()).records[0].attempts.map((attempt) => attempt.executionModel)
    ).toEqual([
      expect.objectContaining({ providerId: 'stable-provider', model: 'stable-model' }),
      expect.objectContaining({ providerId: 'stable-provider', model: 'stable-model' })
    ])
    expect(execution.controls()[1].input).not.toHaveProperty('profile')
    expect(workspaceFrames).toEqual([frameId, frameId])
    await expect(work.sessionSummary(caller.session)).resolves.toEqual({
      runningCount: 1,
      children: [{ frameId, title: 'Inspect the evidence', status: 'running' }]
    })
    await expect(work.readAgentFrame(caller.session, frameId)).resolves.toMatchObject({
      frameId,
      title: 'Inspect the evidence',
      status: 'running',
      resolvedAgent: { kind: 'main' },
      messages: [
        { role: 'user', content: 'Inspect the evidence' },
        { role: 'assistant', content: 'Initial finding' },
        { role: 'user', content: 'Check a counterexample' }
      ]
    })
    expect((await records.snapshot()).records).toHaveLength(1)
    expect((await records.snapshot()).records[0].attempts).toHaveLength(2)
  })

  it('re-resolves a terminal Specialist by stable identity while retaining its prior snapshot', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let liveProfile = specialist()
    const resolveSpecialist = vi.fn(async () => liveProfile)
    const work = createDurableDelegatedWork({ execution, records, resolveSpecialist })
    const dispatched = await work.delegate(
      { ...caller, parentSpecialistId: liveProfile.id },
      { task: 'Specialist analysis', name: 'Specialist analysis' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('First analysis')
    await expect.poll(async () => (await work.sessionSummary(caller.session)).runningCount).toBe(0)
    liveProfile = specialist({ displayName: 'Renamed Evidence Analyst', revision: 8 })

    await work.sendMessage(
      {
        ...caller,
        parentSpecialistId: 'different-current-parent',
        toolInvocationId: 'specialist-continuation'
      },
      dispatched.children[0].frameId,
      'Recheck the analysis'
    )

    await expect.poll(() => execution.controls()).toHaveLength(2)
    expect(execution.controls()[1].input.profile).toBe('specialist-stable-id')
    const attempts = (await records.snapshot()).records[0].attempts
    expect(attempts.map(({ resolvedAgent }) => resolvedAgent)).toEqual([
      {
        kind: 'specialist',
        profileId: 'specialist-stable-id',
        revision: 7,
        displayName: 'Evidence Analyst'
      },
      {
        kind: 'specialist',
        profileId: 'specialist-stable-id',
        revision: 8,
        displayName: 'Renamed Evidence Analyst'
      }
    ])
    expect(resolveSpecialist).toHaveBeenLastCalledWith('specialist-stable-id')
  })

  it('leaves terminal Specialist history unchanged when continuation re-resolution is unavailable', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let liveProfile: ReturnType<typeof specialist> | undefined = specialist()
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async () => liveProfile
    })
    const dispatched = await work.delegate(
      caller,
      {
        task: 'Preserve terminal evidence',
        name: 'Preserve terminal evidence',
        profile: 'specialist-stable-id'
      },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Historical evidence')
    await expect.poll(async () => (await work.sessionSummary(caller.session)).runningCount).toBe(0)
    const before = await records.snapshot()

    for (const [toolInvocationId, unavailable] of [
      ['disabled-continuation', specialist({ enabled: false })],
      ['deleted-continuation', undefined]
    ] as const) {
      liveProfile = unavailable
      await expect(
        work.sendMessage(
          { ...caller, toolInvocationId },
          dispatched.children[0].frameId,
          'Must not mutate history'
        )
      ).rejects.toMatchObject({ code: 'admission_rejection' })
      expect(await records.snapshot()).toEqual(before)
    }
    expect(execution.reservationCounts()).toEqual([1])
  })

  it('queues a message without creating a continuation while the latest Attempt is running', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    const work = createDurableDelegatedWork({ execution, records })
    const dispatched = await work.delegate(
      caller,
      { task: 'Still running', name: 'Still running' },
      { wait: false }
    )

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'overlapping-continuation' },
        dispatched.children[0].frameId,
        'Do not overlap'
      )
    ).resolves.toMatchObject({
      status: 'queued',
      target_frame_id: dispatched.children[0].frameId,
      target_attempt_id: dispatched.children[0].attemptId
    })
    expect((await records.snapshot()).records[0].attempts).toHaveLength(1)
    expect((await records.snapshot()).messages).toHaveLength(1)
    expect(execution.reservationCounts()).toEqual([1])
  })

  it('terminalizes only each new Attempt when continuation startup fails', async () => {
    const execution = createDeterministicDelegateExecution()
    const records = createInMemoryDelegatedWorkRecords({
      session: caller.session,
      rootFrameId: caller.frameId,
      originMessageId: caller.originMessageId
    })
    let prepares = 0
    const work = createDurableDelegatedWork({
      execution,
      records,
      workspace: {
        async prepare() {
          prepares += 1
          if (prepares === 2) throw new Error('continuation workspace failed')
          return { cwd: '/stable-frame-workspace' }
        }
      }
    })
    const dispatched = await work.delegate(
      caller,
      { task: 'Initial task', name: 'Initial task' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.controls()[0].accept()
    execution.controls()[0].complete('Preserved answer')
    await expect.poll(async () => (await work.sessionSummary(caller.session)).runningCount).toBe(0)

    await work.sendMessage(
      { ...caller, toolInvocationId: 'failed-startup-continuation' },
      dispatched.children[0].frameId,
      'Continuation that cannot start'
    )

    await expect
      .poll(() => work.sessionSummary(caller.session))
      .toMatchObject({
        runningCount: 0,
        children: [{ frameId: dispatched.children[0].frameId, status: 'error' }]
      })
    const snapshot = await records.snapshot()
    expect(snapshot.records[0].attempts).toMatchObject([
      { status: 'completed', terminalMessageId: expect.any(String) },
      {
        status: 'error',
        error: { code: 'execution_failure', message: 'continuation workspace failed' }
      }
    ])
    expect(snapshot.messages.map(({ content }) => content)).toEqual([
      'Initial task',
      'Preserved answer',
      'Continuation that cannot start'
    ])
    expect(execution.controls()).toHaveLength(1)

    execution.plan({ status: 'failed', error: new Error('continuation provider failed') })
    await work.sendMessage(
      { ...caller, toolInvocationId: 'failed-provider-continuation' },
      dispatched.children[0].frameId,
      'Retry after workspace recovery'
    )
    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts)
      .toMatchObject([
        { status: 'completed', terminalMessageId: expect.any(String) },
        { status: 'error', error: { message: 'continuation workspace failed' } },
        {
          status: 'error',
          error: { code: 'execution_failure', message: 'continuation provider failed' }
        }
      ])
    expect((await records.snapshot()).messages.map(({ content }) => content)).toEqual([
      'Initial task',
      'Preserved answer',
      'Continuation that cannot start',
      'Retry after workspace recovery'
    ])
  })
})
