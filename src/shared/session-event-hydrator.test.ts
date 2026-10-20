import { expect, it, vi } from 'vitest'
import { createSessionEventHydrator } from './session-event-hydrator'

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const notice = (
  revision: number,
  originClientId = 'main:runtime-transcript'
): { channel: string; payload: unknown } => ({
  channel: 'session:updated',
  payload: {
    kind: 'session-invalidation',
    projectId: 'project',
    sessionId: 'session',
    revision,
    originClientId
  }
})
const session = (revision: number): unknown => ({
  id: 'session',
  projectId: 'project',
  revision,
  conversationGraph: {
    branches: [{ id: 'branch-a' }, { id: 'branch-b' }],
    frames: [{ activeBranchId: 'branch-b' }]
  }
})

it('holds later events until a complete Session has been resolved, preserving every distinct authority', async () => {
  const read = deferred<unknown>()
  const load = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(session(2))
  const deliver = vi.fn(),
    onFailure = vi.fn()
  const owner = createSessionEventHydrator({ load, deliver, onFailure })
  owner.receive(notice(1), 100)
  owner.receive(notice(2, 'main:permission-wait'), 100)
  owner.receive({ channel: 'acp:event', payload: ['later'] }, 100)
  expect(deliver).not.toHaveBeenCalled()
  read.resolve(session(1))
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(3))
  expect(load).toHaveBeenCalledWith({ projectId: 'project', sessionId: 'session' })
  expect(deliver.mock.calls.map(([event]) => event.channel)).toEqual([
    'session:updated',
    'session:updated',
    'acp:event'
  ])
  expect(deliver.mock.calls.slice(0, 2).map(([event]) => event.payload.originClientId)).toEqual([
    'main:runtime-transcript',
    'main:permission-wait'
  ])
  expect(deliver.mock.calls[0][0].payload.session).toEqual(session(2))
  expect(onFailure).not.toHaveBeenCalled()
})

it.each(['session:deleted', 'project:deleted'])(
  'does not resurrect a Session deleted during its read (%s)',
  async (channel) => {
    const read = deferred<unknown>(),
      deliver = vi.fn(),
      onFailure = vi.fn()
    const owner = createSessionEventHydrator({ load: () => read.promise, deliver, onFailure })
    owner.receive(notice(1), 100)
    owner.receive({ channel, payload: { projectId: 'project', sessionId: 'session' } }, 100)
    read.resolve(session(1))
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
    expect(deliver.mock.calls[0][0].channel).toBe(channel)
    expect(onFailure).not.toHaveBeenCalled()
  }
)

it('coalesces only adjacent notifications from the same origin and keeps the latest revision', async () => {
  const read = deferred<unknown>(),
    deliver = vi.fn()
  const owner = createSessionEventHydrator({
    load: vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue(session(3)),
    deliver,
    onFailure: vi.fn()
  })
  owner.receive(notice(1), 100)
  owner.receive(notice(2, 'other-window'), 100)
  owner.receive(notice(3, 'other-window'), 100)
  read.resolve(session(3))
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
  expect(deliver.mock.calls[1][0].payload.originClientId).toBe('other-window')
  expect(deliver.mock.calls[1][0].payload.session.revision).toBe(3)
})

it('does not install a stale revision or spin repeated reads when the authority cannot serve it', async () => {
  const load = vi.fn().mockResolvedValue(session(1)),
    deliver = vi.fn(),
    onFailure = vi.fn()
  const owner = createSessionEventHydrator({ load, deliver, onFailure })
  owner.receive(notice(2), 100)
  await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce())
  expect(load).toHaveBeenCalledOnce()
  expect(deliver).not.toHaveBeenCalled()
})

it('bounds buffered events while a Session is loading and ignores its late completion after disposal', async () => {
  const read = deferred<unknown>(),
    deliver = vi.fn(),
    onFailure = vi.fn()
  const owner = createSessionEventHydrator({ load: () => read.promise, deliver, onFailure })
  owner.receive(notice(1), 100)
  owner.receive({ channel: 'acp:event', payload: [] }, 64 * 1024 * 1024)
  expect(onFailure).toHaveBeenCalledOnce()
  read.resolve(session(1))
  await read.promise
  expect(deliver).not.toHaveBeenCalled()
})
