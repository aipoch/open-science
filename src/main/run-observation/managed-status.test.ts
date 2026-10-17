import { describe, expect, it, vi, type Mock } from 'vitest'
import { createManagedRecordingStatusReader } from './managed-status'

type Dependencies = Parameters<typeof createManagedRecordingStatusReader>[0]
const identity = {
  projectId: 'project',
  sessionId: 'session',
  operationId: 'operation',
  executionInvocationId: 'invocation',
  runId: 'run'
}
const target = { projectId: 'project', sessionId: 'session', runId: 'run' }
const canonical = {
  projectId: 'project',
  sessionId: 'session',
  operationId: 'operation',
  executionInvocationId: 'invocation'
}

function setup(): {
  inspect: Mock<Dependencies['inspect']>
  confirm: Mock<Dependencies['coordinator']['confirm']>
  load: Mock<Dependencies['recorder']['load']>
  versions: Mock<Dependencies['artifacts']['resolveVersionDescriptors']>
  read: ReturnType<typeof createManagedRecordingStatusReader>
} {
  const inspect = vi.fn<Dependencies['inspect']>().mockResolvedValue({
    identity,
    recordObservation: true,
    observation: { status: 'recording' }
  })
  const confirm = vi.fn<Dependencies['coordinator']['confirm']>()
  const load = vi.fn<Dependencies['recorder']['load']>()
  const versions = vi.fn<Dependencies['artifacts']['resolveVersionDescriptors']>()
  const read = createManagedRecordingStatusReader({
    inspect,
    coordinator: { confirm },
    recorder: { load },
    artifacts: { resolveVersionDescriptors: versions }
  })
  return { inspect, confirm, load, versions, read }
}

describe('managed recording status', () => {
  it('reports the caller selector without changing it to the recorder storage identity', async () => {
    const h = setup()
    expect(await h.read(target)).toEqual({ target, state: 'recording' })
    expect(h.confirm).toHaveBeenCalledWith(canonical)
    expect(h.load).toHaveBeenCalledWith(canonical)
    expect(h.versions).not.toHaveBeenCalled()
  })

  it('does not start or reconcile a recording for an ordinary unrecorded execution', async () => {
    const h = setup()
    h.inspect.mockResolvedValue({ identity })
    expect(await h.read(target)).toEqual({ target, state: 'not-recorded' })
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.load).not.toHaveBeenCalled()
  })

  it('rejects missing or mismatched execution inspections before reading recording data', async () => {
    const h = setup()
    h.inspect.mockResolvedValue(undefined)
    await expect(h.read(target)).rejects.toThrow('unavailable')
    for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
      h.inspect.mockResolvedValue({
        identity: { ...identity, [key]: 'other' },
        recordObservation: true
      })
      await expect(h.read(identity)).rejects.toThrow('another execution')
    }
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.load).not.toHaveBeenCalled()
  })

  it('retains an honest failure when optional capture never started', async () => {
    const h = setup()
    h.inspect.mockResolvedValue({
      identity,
      recordObservation: true,
      observation: { status: 'failed', warning: 'capture-start-failed' }
    })
    expect(await h.read(target)).toEqual({ target, state: 'failed' })
  })
})
