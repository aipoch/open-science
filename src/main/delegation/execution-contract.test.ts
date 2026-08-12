import { describe, expect, it } from 'vitest'

import { createDeterministicDelegateExecution } from './deterministic-execution'
import type {
  DelegateExecution,
  DelegateExecutionEvent,
  DelegateExecutionInput,
  DelegatePermissionResponse
} from './execution-port'

type DelegateExecutionContractDriver = Readonly<{
  accept(attemptId: string): Promise<void>
  emit(attemptId: string, event: DelegateExecutionEvent): Promise<void>
  complete(attemptId: string, response: string): Promise<void>
  fail(attemptId: string, error: Error): Promise<void>
  deliveredMessages(attemptId: string): readonly string[]
  permissionResponses(attemptId: string): readonly DelegatePermissionResponse[]
}>

type DelegateExecutionContractHarness = Readonly<{
  execution: DelegateExecution
  driver: DelegateExecutionContractDriver
}>

const input = (attemptId: string): DelegateExecutionInput => ({
  session: { projectId: 'project-1', sessionId: 'session-1' },
  frameId: `frame-${attemptId}`,
  attemptId,
  runtimeSegmentId: `segment-${attemptId}`,
  task: `task-${attemptId}`,
  inputs: [],
  continuation: false
})

const delegateExecutionContract = (create: () => DelegateExecutionContractHarness): void => {
  describe('delegate execution adapter contract', () => {
    it('exposes acceptance separately from terminal completion', async () => {
      const { execution, driver } = create()
      const reservation = await execution.reserve(1)
      const running = execution.run(input('attempt-1'), reservation.slotIds[0])
      let completed = false
      void running.completion.then(() => {
        completed = true
      })

      await driver.accept('attempt-1')
      await expect(running.accepted).resolves.toBe('provider_prompt_accepted')
      expect(completed).toBe(false)
      await driver.complete('attempt-1', 'answer')
      await expect(running.completion).resolves.toEqual({ status: 'completed', response: 'answer' })
    })

    it('correlates events and message delivery to the running attempt', async () => {
      const { execution, driver } = create()
      const reservation = await execution.reserve(2)
      const first = execution.run(input('attempt-1'), reservation.slotIds[0])
      const second = execution.run(input('attempt-2'), reservation.slotIds[1])
      const firstEvents: DelegateExecutionEvent[] = []
      const secondEvents: DelegateExecutionEvent[] = []
      first.subscribe((event) => firstEvents.push(event))
      second.subscribe((event) => secondEvents.push(event))

      await driver.emit('attempt-1', {
        kind: 'permission',
        awaiting: true,
        requestId: 'permission-1',
        title: 'Read a file',
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
      })
      await driver.emit('attempt-2', { kind: 'message', text: 'second only' })
      await first.respondToPermission({ requestId: 'permission-1', optionId: 'allow' })
      const delivery = first.sendMessage('first only')

      expect(firstEvents).toEqual([
        {
          kind: 'permission',
          awaiting: true,
          requestId: 'permission-1',
          title: 'Read a file',
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
        },
        {
          kind: 'permission',
          awaiting: false,
          requestId: 'permission-1'
        }
      ])
      expect(secondEvents.filter((event) => event.kind !== 'runtime')).toEqual([
        { kind: 'message', text: 'second only' }
      ])
      expect(driver.permissionResponses('attempt-1')).toEqual([
        { requestId: 'permission-1', optionId: 'allow' }
      ])
      expect(driver.permissionResponses('attempt-2')).toEqual([])
      await driver.accept('attempt-1')
      await driver.accept('attempt-2')
      await driver.complete('attempt-1', 'one')
      await delivery
      await driver.complete('attempt-2', 'two')
      await Promise.all([first.completion, second.completion])
      expect(driver.deliveredMessages('attempt-1')).toEqual(['first only'])
      expect(driver.deliveredMessages('attempt-2')).toEqual([])
    })

    it('supports deterministic failure and cancellation terminalization', async () => {
      const { execution, driver } = create()
      const reservation = await execution.reserve(2)
      const failed = execution.run(input('attempt-failed'), reservation.slotIds[0])
      const cancelled = execution.run(input('attempt-cancelled'), reservation.slotIds[1])
      await driver.accept('attempt-failed')
      await driver.accept('attempt-cancelled')

      await driver.fail('attempt-failed', new Error('provider failed'))
      await expect(failed.completion).rejects.toThrow('provider failed')
      await cancelled.cancel()
      await expect(cancelled.completion).resolves.toEqual({ status: 'cancelled' })
    })
  })
}

const createFakeHarness = (): DelegateExecutionContractHarness => {
  const execution = createDeterministicDelegateExecution()
  return {
    execution,
    driver: {
      accept: async (attemptId) => execution.control(attemptId).accept(),
      emit: async (attemptId, event) => execution.control(attemptId).emit(event),
      complete: async (attemptId, response) => execution.control(attemptId).complete(response),
      fail: async (attemptId, error) => execution.control(attemptId).fail(error),
      deliveredMessages: (attemptId) => execution.control(attemptId).deliveredMessages(),
      permissionResponses: (attemptId) => execution.control(attemptId).permissionResponses()
    }
  }
}

delegateExecutionContract(createFakeHarness)

export { delegateExecutionContract }
export type { DelegateExecutionContractDriver, DelegateExecutionContractHarness }
