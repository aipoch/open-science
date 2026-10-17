import { describe, expect, it, vi, type Mock } from 'vitest'
import type { ManagedExecutionObservationPort } from '../notebook/managed-execution-observation-port'
import type { ManagedRunObservationCoordinator } from './managed-coordinator'
import type { RunObservationRecordingHandle } from './recorder'
import { createManagedObservationPort } from './managed-port'

const target = { projectId: 'project', sessionId: 'session', executionInvocationId: 'execution' }
const context = {
  projectId: 'project',
  sessionId: 'session',
  provenanceContext: {
    rootFrameId: 'root',
    agentFrameId: 'agent',
    messageBranchId: 'branch',
    runtimeSegmentId: 'segment',
    promptMessageId: 'prompt'
  },
  saveAuxiliaryOutput: vi.fn()
} satisfies Parameters<ManagedExecutionObservationPort['begin']>[1]

type Coordinator = Pick<
  ManagedRunObservationCoordinator,
  'begin' | 'publish' | 'confirm' | 'reconcilePublished' | 'drain'
>
function setup(): ReturnType<typeof createManagedObservationPort> & {
  recording: RunObservationRecordingHandle
  coordinator: { [K in keyof Coordinator]: Mock<Coordinator[K]> }
} {
  const recording: RunObservationRecordingHandle = {
    recordingId: 'recording',
    target,
    sample: vi.fn(),
    appendMedia: vi.fn(),
    finish: vi.fn(),
    abort: vi.fn()
  }
  const coordinator = {
    begin: vi.fn<ManagedRunObservationCoordinator['begin']>().mockResolvedValue({
      result: { status: 'recording' },
      handle: recording
    }),
    publish: vi.fn<ManagedRunObservationCoordinator['publish']>().mockResolvedValue({
      result: { status: 'failed', warning: 'archive-save-failed' },
      savedInCurrentTurn: false
    }),
    confirm: vi.fn<ManagedRunObservationCoordinator['confirm']>(),
    reconcilePublished: vi.fn<ManagedRunObservationCoordinator['reconcilePublished']>(),
    drain: vi.fn<ManagedRunObservationCoordinator['drain']>()
  }
  return { recording, coordinator, ...createManagedObservationPort(coordinator) }
}

describe('managed observation capability adapter', () => {
  it('keeps concrete capture authority out of the execution owner and preserves publication results', async () => {
    const adapter = setup()
    const started = await adapter.port.begin(target, context)
    expect(started.handle).toEqual({})
    expect(started.handle).not.toBe(adapter.recording)
    expect(adapter.resolveRecording(started.handle!)).toBe(adapter.recording)
    const result = await adapter.port.publish({
      target,
      context,
      handle: started.handle,
      recovery: false
    })
    expect(adapter.coordinator.publish).toHaveBeenCalledWith({
      target,
      context,
      handle: adapter.recording,
      recovery: false
    })
    expect(result).toEqual({
      result: { status: 'failed', warning: 'archive-save-failed' },
      savedInCurrentTurn: false
    })
    await adapter.port.drain(started.handle!)
    expect(adapter.coordinator.drain).toHaveBeenCalledWith(adapter.recording)
  })

  it('rejects fabricated and foreign handles before capture or publication', async () => {
    const adapter = setup()
    const foreign = await setup().port.begin(target, context)
    for (const handle of [{ ...adapter.recording }, foreign.handle!]) {
      expect(() => adapter.resolveRecording(handle)).toThrow('not issued')
      expect(() => adapter.port.publish({ target, context, handle, recovery: false })).toThrow(
        'not issued'
      )
      expect(() => adapter.port.drain(handle)).toThrow('not issued')
    }
    expect(adapter.coordinator.publish).not.toHaveBeenCalled()
    expect(adapter.coordinator.drain).not.toHaveBeenCalled()
  })

  it('supports unavailable capture and exact recovery without a live handle', async () => {
    const adapter = setup()
    adapter.coordinator.begin.mockResolvedValue({ result: { status: 'unavailable' } })
    expect(await adapter.port.begin(target, context)).toEqual({ result: { status: 'unavailable' } })
    await adapter.port.publish({ target, context, recovery: true })
    expect(adapter.coordinator.publish).toHaveBeenCalledWith({
      target,
      context,
      recovery: true,
      handle: undefined
    })
    await adapter.port.confirm(target)
    await adapter.port.reconcilePublished(target)
    expect(adapter.coordinator.confirm).toHaveBeenCalledWith(target)
    expect(adapter.coordinator.reconcilePublished).toHaveBeenCalledWith(target)
  })
})
