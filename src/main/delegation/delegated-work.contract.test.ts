import { describe, expect, it } from 'vitest'

import {
  DelegatedWorkError,
  createDelegatedWork,
  createDelegatedWorkMemoryState,
  type AgentCaller,
  type DelegatedWork
} from './delegated-work'
import { createDeterministicDelegateExecution } from './deterministic-execution'

const mainCaller: AgentCaller = {
  session: { projectId: 'project-1', sessionId: 'session-1' },
  frameId: 'main-frame',
  role: 'main'
}

const named = (task: string, name = task): Readonly<{ task: string; name: string }> => ({
  task,
  name
})

type Harness = Readonly<{
  work: DelegatedWork
  execution: ReturnType<typeof createDeterministicDelegateExecution>
}>

const createHarness = (): Harness => {
  const execution = createDeterministicDelegateExecution()
  return { work: createDelegatedWork({ execution }), execution }
}

const delegatedWorkContract = (create: () => Harness): void => {
  describe('delegated work contract', () => {
    it('rejects the removed own context field before capacity reservation', async () => {
      const { work, execution } = create()

      await expect(
        work.delegate(
          mainCaller,
          [
            named('valid sibling'),
            { task: 'legacy child', name: 'legacy child', context: undefined } as never
          ],
          { wait: false }
        )
      ).rejects.toMatchObject({
        code: 'admission_rejection',
        message: expect.stringMatching(/context.*removed.*task/i)
      })
      expect(execution.reservationCounts()).toEqual([])
    })

    it('shares required, non-emoji, 48-code-point name admission before capacity reservation', async () => {
      const { work, execution } = create()

      await expect(
        work.delegate(mainCaller, { task: 'Missing name' } as never, { wait: false })
      ).rejects.toMatchObject({
        code: 'admission_rejection',
        message: expect.stringMatching(/1–48-code-point non-emoji name.*retry/i)
      })
      await expect(
        work.delegate(mainCaller, named('Emoji name', 'Evidence 🧪'), { wait: false })
      ).rejects.toMatchObject({ code: 'admission_rejection' })
      await expect(
        work.delegate(mainCaller, named('Too long', '界'.repeat(49)), { wait: false })
      ).rejects.toMatchObject({
        code: 'admission_rejection',
        message: expect.stringMatching(/48 Unicode code points.*shorten.*retry/i)
      })
      expect(execution.reservationCounts()).toEqual([])

      await expect(
        work.delegate(mainCaller, named('At boundary', '界'.repeat(48)), { wait: false })
      ).resolves.toMatchObject({ children: [{ name: '界'.repeat(48) }] })

      const outcomes = await Promise.allSettled([
        work.delegate(mainCaller, named('First task', 'Source audit'), { wait: false }),
        work.delegate(mainCaller, named('Second task', 'source audit'), { wait: false })
      ])
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1)
      expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
        reason: { code: 'admission_rejection' }
      })
      expect(execution.reservationCounts()).toEqual([1, 1])
      await expect(work.children(mainCaller)).resolves.toHaveLength(2)
    })

    it('returns a durable running receipt without waiting when wait is false', async () => {
      const { work } = create()

      const outcome = await work.delegate(mainCaller, named('trace the source'), { wait: false })

      expect(outcome).toEqual({
        kind: 'receipts',
        children: [
          {
            frameId: 'frame-1',
            attemptId: 'attempt-1',
            name: 'trace the source',
            status: 'running'
          }
        ]
      })
    })

    it('owns the default blocking wait and returns results in request order', async () => {
      const { work, execution } = create()
      execution.plan({ status: 'completed', response: 'first answer' })
      execution.plan({ status: 'completed', response: 'second answer' })

      const outcome = await work.delegate(mainCaller, [named('first'), named('second')])

      expect(outcome).toEqual({
        kind: 'results',
        children: [
          {
            frameId: 'frame-1',
            attemptId: 'attempt-1',
            name: 'first',
            status: 'completed',
            terminalMessageId: 'message-1',
            response: 'first answer'
          },
          {
            frameId: 'frame-2',
            attemptId: 'attempt-2',
            name: 'second',
            status: 'completed',
            terminalMessageId: 'message-2',
            response: 'second answer'
          }
        ]
      })
    })

    it('projects direct children and collects requested children in requested order', async () => {
      const { work, execution } = create()
      const dispatched = await work.delegate(
        mainCaller,
        [
          { task: 'alpha', name: 'Alpha' },
          { task: 'beta', name: 'Beta' }
        ],
        { wait: false }
      )
      expect(dispatched.kind).toBe('receipts')
      execution.control('attempt-1').accept()
      execution.control('attempt-2').accept()
      execution.control('attempt-2').complete('B')
      execution.control('attempt-1').complete('A')

      await expect(work.children(mainCaller)).resolves.toEqual([
        { frameId: 'frame-1', attemptId: 'attempt-1', title: 'Alpha', status: 'running' },
        { frameId: 'frame-2', attemptId: 'attempt-2', title: 'Beta', status: 'running' }
      ])
      const results = await work.collect(mainCaller, ['frame-2', 'frame-1'])
      expect(results.map((result) => result.response)).toEqual(['B', 'A'])
    })

    it('projects permission waiting state without exposing execution attachments', async () => {
      const { work, execution } = create()
      await work.delegate(mainCaller, named('permission task'), { wait: false })
      const control = execution.control('attempt-1')
      control.accept()
      control.emit({
        kind: 'permission',
        awaiting: true,
        requestId: 'permission-1',
        title: 'Read a file',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
      })

      await expect(work.children(mainCaller, ['frame-1'])).resolves.toEqual([
        {
          frameId: 'frame-1',
          attemptId: 'attempt-1',
          title: 'permission task',
          status: 'running',
          awaitingPermission: true
        }
      ])
      control.emit({ kind: 'permission', awaiting: false, requestId: 'permission-1' })
      control.complete('done')
    })

    it('atomically chooses delivery for a running child and continuation for a terminal child', async () => {
      const { work, execution } = create()
      await work.delegate(mainCaller, named('initial'), { wait: false })
      const first = execution.control('attempt-1')
      first.accept()

      await expect(work.sendMessage(mainCaller, 'frame-1', 'more context')).resolves.toEqual({
        kind: 'queued',
        targetFrameId: 'frame-1',
        attemptId: 'attempt-1'
      })
      expect(first.deliveredMessages()).toEqual(['more context'])
      first.complete('initial result')
      await work.collect(mainCaller, ['frame-1'])

      await expect(work.sendMessage(mainCaller, 'frame-1', 'continue now')).resolves.toEqual({
        kind: 'continued',
        child: { frameId: 'frame-1', attemptId: 'attempt-2', name: 'initial', status: 'running' }
      })
      expect(execution.control('attempt-2').input).toMatchObject({
        frameId: 'frame-1',
        task: 'continue now',
        continuation: true
      })
    })

    it('stops children independently and preserves sibling execution', async () => {
      const { work, execution } = create()
      await work.delegate(mainCaller, [named('one'), named('two')], { wait: false })
      execution.control('attempt-1').accept()
      execution.control('attempt-2').accept()

      await expect(work.stop(mainCaller, ['frame-1'])).resolves.toEqual([
        { frameId: 'frame-1', status: 'cancelled' }
      ])
      execution.control('attempt-2').complete('sibling survived')
      const [stopped, sibling] = await work.collect(mainCaller, ['frame-1', 'frame-2'])
      expect(stopped).toMatchObject({ status: 'cancelled', cancellationReason: 'main_agent_stop' })
      expect(sibling).toMatchObject({ status: 'completed', response: 'sibling survived' })
    })

    it('cascades Session stop across running children without changing terminal siblings', async () => {
      const { work, execution } = create()
      execution.plan({ status: 'completed', response: 'already done' })
      await work.delegate(mainCaller, named('done'))
      await work.delegate(mainCaller, [named('running one'), named('running two')], {
        wait: false
      })

      await expect(work.stopSession(mainCaller.session)).resolves.toEqual([
        { frameId: 'frame-2', status: 'cancelled' },
        { frameId: 'frame-3', status: 'cancelled' }
      ])
      const results = await work.collect(mainCaller, ['frame-1', 'frame-2', 'frame-3'])
      expect(results.map((result) => [result.status, result.cancellationReason])).toEqual([
        ['completed', undefined],
        ['cancelled', 'session_stop'],
        ['cancelled', 'session_stop']
      ])
      await expect.poll(() => execution.releasedFrames()).toEqual(['frame-1', 'frame-2', 'frame-3'])
    })

    it('recovers persisted running attempts as interrupted without restarting execution', async () => {
      const execution = createDeterministicDelegateExecution()
      const state = createDelegatedWorkMemoryState()
      const beforeRestart = createDelegatedWork({ execution, state })
      await beforeRestart.delegate(mainCaller, named('unfinished'), { wait: false })
      const afterRestart = createDelegatedWork({ execution, state })

      await expect(afterRestart.recoverInterrupted()).resolves.toEqual({
        interrupted: [
          {
            frameId: 'frame-1',
            attemptId: 'attempt-1',
            name: 'unfinished',
            status: 'cancelled',
            cancellationReason: 'runtime_interrupted'
          }
        ]
      })
      expect(execution.controls()).toHaveLength(1)
    })

    it('rejects array admission atomically when capacity is unavailable', async () => {
      const { work, execution } = create()
      execution.rejectNextReservation('capacity', 'two slots unavailable')

      await expect(
        work.delegate(mainCaller, [named('one'), named('two')], { wait: false })
      ).rejects.toMatchObject({ code: 'capacity', message: 'two slots unavailable' })
      await expect(work.children(mainCaller)).resolves.toEqual([])
      expect(execution.controls()).toEqual([])
    })

    it('distinguishes an unsupported framework before admitting children', async () => {
      const { work, execution } = create()
      execution.rejectNextReservation('unsupported_framework', 'native delegation is enabled')

      await expect(
        work.delegate(mainCaller, named('unsafe'), { wait: false })
      ).rejects.toMatchObject({
        code: 'unsupported_framework',
        message: 'native delegation is enabled'
      })
      await expect(work.children(mainCaller)).resolves.toEqual([])
    })

    it('terminalizes post-admission execution failure as a collectable result', async () => {
      const { work, execution } = create()
      execution.plan({ status: 'failed', error: new Error('provider exited') })
      await work.delegate(mainCaller, named('fragile'), { wait: false })

      await expect(work.collect(mainCaller, ['frame-1'])).resolves.toEqual([
        {
          frameId: 'frame-1',
          attemptId: 'attempt-1',
          name: 'fragile',
          status: 'error',
          error: { code: 'execution_failure', message: 'provider exited' }
        }
      ])
    })

    it('enforces parent authority without leaking whether another child exists', async () => {
      const { work } = create()
      await work.delegate(mainCaller, named('private'), { wait: false })
      const otherMain: AgentCaller = { ...mainCaller, frameId: 'other-main' }

      await expect(work.children(otherMain, ['frame-1'])).rejects.toMatchObject({
        code: 'authorization'
      })
      await expect(
        work.delegate({ ...mainCaller, role: 'delegate' }, named('nested'), { wait: false })
      ).rejects.toMatchObject({ code: 'authorization' })
    })

    it('publishes a stable and exhaustive domain error taxonomy', () => {
      const codes = [
        'admission_rejection',
        'authorization',
        'conflict',
        'capacity',
        'unsupported_framework',
        'execution_failure',
        'durability_failure',
        'interruption'
      ] as const

      expect(codes.map((code) => new DelegatedWorkError(code, code).code)).toEqual(codes)
    })
  })
}

delegatedWorkContract(createHarness)

export { delegatedWorkContract }
export type { Harness as DelegatedWorkContractHarness }
