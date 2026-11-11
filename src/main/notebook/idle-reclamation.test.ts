import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NotebookIdleReclamation,
  NOTEBOOK_SESSION_IDLE_MS,
  type IdleInterpreter
} from './idle-reclamation'

afterEach(() => vi.useRealTimers())

function fixture(): {
  pool: NotebookIdleReclamation
  resources: IdleInterpreter[]
  busy: Set<string>
  onFailure: ReturnType<typeof vi.fn>
  add: (group: IdleInterpreter['group'], sessionId: string, lastUsedAt?: number) => IdleInterpreter
} {
  vi.useFakeTimers()
  const resources: IdleInterpreter[] = []
  const busy = new Set<string>()
  const onFailure = vi.fn()
  const pool = new NotebookIdleReclamation({
    resources: () => resources,
    isSessionBusy: (_project, session) => busy.has(session),
    onFailure
  })
  const add = (
    group: IdleInterpreter['group'],
    sessionId: string,
    lastUsedAt = Date.now()
  ): IdleInterpreter => {
    const resource: IdleInterpreter = {
      identity: {},
      projectId: 'project',
      sessionId,
      group,
      lastUsedAt,
      release: vi.fn(async () => {
        resources.splice(resources.indexOf(resource), 1)
        return true
      })
    }
    resources.push(resource)
    return resource
  }
  return { pool, resources, busy, onFailure, add }
}

describe('Notebook idle interpreter reclamation', () => {
  it('discards a busy result observed before a read settled for every interpreter in the session', async () => {
    const resources = (['data', 'repl', 'shell'] as const).map((group) => ({
      identity: {},
      projectId: 'p',
      sessionId: 's',
      group,
      lastUsedAt: 0,
      release: vi.fn(async () => true)
    }))
    const busy = vi.fn<() => boolean | Promise<boolean>>(() => false)
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy: busy,
      onFailure: vi.fn()
    })
    await pool.check()
    vi.setSystemTime(Date.now() + NOTEBOOK_SESSION_IDLE_MS)
    let resolveBusy!: (value: boolean) => void
    busy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveBusy = resolve
        })
    )
    const checking = pool.check()
    const finishRead = pool.observeSession('s')
    finishRead()
    resolveBusy(true)
    await checking
    await pool.check()
    for (const resource of resources) expect(resource.release).toHaveBeenCalledOnce()
    await pool.dispose()
  })

  it('expires all groups after 15 idle minutes even below the capacity limit', async () => {
    const { pool, resources, add } = fixture()
    for (const group of ['data', 'repl', 'shell'] as const) add(group, 'one-session')
    await pool.check()
    await vi.advanceTimersByTimeAsync(NOTEBOOK_SESSION_IDLE_MS - 1)
    expect(resources).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(resources).toHaveLength(0)
    await pool.dispose()
  })

  it('counts instances, not sessions, and evicts oldest independently in each group', async () => {
    const { pool, resources, add } = fixture()
    const oldest = ['data', 'repl', 'shell'].map((group) =>
      add(group as IdleInterpreter['group'], 'same', 1)
    )
    for (const group of ['data', 'repl', 'shell'] as const)
      for (let index = 0; index < 3; index++) add(group, 'same', index + 2)
    await pool.check()
    expect(resources).toHaveLength(9)
    for (const resource of oldest) expect(resource.release).toHaveBeenCalledOnce()
    await pool.dispose()
  })

  it('protects every interpreter in active sessions and starts a fresh idle interval on completion', async () => {
    const { pool, resources, busy, add } = fixture()
    busy.add('active')
    for (let index = 0; index < 5; index++) add('data', 'active')
    add('repl', 'active')
    await pool.check()
    await vi.advanceTimersByTimeAsync(NOTEBOOK_SESSION_IDLE_MS * 2)
    expect(resources).toHaveLength(6)
    busy.delete('active')
    pool.activityChanged('active')
    await vi.advanceTimersByTimeAsync(0)
    expect(resources.filter(({ group }) => group === 'data')).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(NOTEBOOK_SESSION_IDLE_MS - 1)
    expect(resources).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(resources).toHaveLength(0)
    await pool.dispose()
  })

  it('cancels expiry when new activity arrives during the final asynchronous busy check', async () => {
    vi.useFakeTimers()
    const release = vi.fn(async () => true)
    const resource: IdleInterpreter = {
      identity: {},
      projectId: 'p',
      sessionId: 's',
      group: 'data',
      lastUsedAt: 0,
      release
    }
    let resolve!: (busy: boolean) => void
    const isSessionBusy = vi.fn().mockResolvedValue(false)
    const pool = new NotebookIdleReclamation({
      resources: () => [resource],
      isSessionBusy,
      onFailure: vi.fn()
    })
    await pool.check()
    vi.setSystemTime(Date.now() + NOTEBOOK_SESSION_IDLE_MS)
    isSessionBusy.mockResolvedValueOnce(false).mockImplementationOnce(
      () =>
        new Promise<boolean>((r) => {
          resolve = r
        })
    )
    const check = pool.check()
    await Promise.resolve()
    await Promise.resolve()
    pool.activityChanged('s')
    resolve(false)
    await check
    expect(release).not.toHaveBeenCalled()
    await pool.dispose()
  })

  it('reports failed cleanup without counting it as a reclaimed interpreter or retrying in a tight loop', async () => {
    const { pool, resources, onFailure, add } = fixture()
    const first = add('data', 's', 1)
    first.release = vi.fn(async () => {
      throw new Error('cleanup unconfirmed')
    })
    for (let index = 0; index < 3; index++) add('data', 's', index + 2)
    await pool.check()
    expect(onFailure).toHaveBeenCalledOnce()
    expect(resources).toContain(first)
    expect(resources).toHaveLength(3)
    expect(first.release).toHaveBeenCalledOnce()
    await pool.dispose()
  })

  it('does not evict another idle interpreter when the excess candidate becomes active', async () => {
    const { pool: unused, resources, add } = fixture()
    await unused.dispose()
    for (let index = 0; index < 4; index++) add('data', `s${index}`, index)
    const isSessionBusy = vi.fn().mockResolvedValue(false)
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy,
      onFailure: vi.fn()
    })
    // Four initial checks see idle; the oldest session starts work before its final check.
    for (let index = 0; index < 4; index++) isSessionBusy.mockResolvedValueOnce(false)
    isSessionBusy.mockResolvedValueOnce(true)
    await pool.check()
    for (const resource of resources) expect(resource.release).not.toHaveBeenCalled()
    await pool.dispose()
  })

  it('backs off and preserves processes if the activity query fails at expiry', async () => {
    const { pool: unused, resources, add } = fixture()
    await unused.dispose()
    add('data', 's')
    const isSessionBusy = vi.fn().mockResolvedValue(false)
    const onFailure = vi.fn()
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy,
      onFailure
    })
    await pool.check()
    isSessionBusy.mockRejectedValue(new Error('activity unavailable'))
    vi.setSystemTime(Date.now() + NOTEBOOK_SESSION_IDLE_MS)
    await pool.check()
    await vi.advanceTimersByTimeAsync(1000)
    expect(onFailure).toHaveBeenCalledOnce()
    expect(resources[0].release).not.toHaveBeenCalled()
    await pool.dispose()
  })
})
