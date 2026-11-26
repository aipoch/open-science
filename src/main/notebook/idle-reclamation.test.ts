import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  NotebookIdleReclamation,
  NOTEBOOK_SESSION_IDLE_MS,
  type IdleInterpreter
} from './idle-reclamation'
import { MemoryPolicyService } from './memory-policy'

afterEach(() => vi.useRealTimers())

function fixture(): {
  pool: NotebookIdleReclamation
  resources: IdleInterpreter[]
  busy: Set<string>
  onFailure: ReturnType<typeof vi.fn<(error: unknown) => void>>
  add: (group: IdleInterpreter['group'], sessionId: string, lastUsedAt?: number) => IdleInterpreter
} {
  vi.useFakeTimers()
  const resources: IdleInterpreter[] = []
  const busy = new Set<string>()
  const onFailure = vi.fn<(error: unknown) => void>()
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
      executionDomain: 'host',
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

const hostPressurePolicy = (availableBytes: () => number = () => 2): MemoryPolicyService =>
  new MemoryPolicyService({
    now: Date.now,
    adapter: {
      platform: 'win32',
      sample: async () => ({
        platform: 'win32',
        source: 'test-system',
        executionScope: 'windows:host',
        facts: {
          availableBytes: availableBytes(),
          totalBytes: 100,
          committedBytes: 50,
          commitLimitBytes: 100
        }
      })
    }
  })

describe('Notebook idle interpreter reclamation', () => {
  it('reclaims all idle interpreter kinds after five minutes of host memory pressure', async () => {
    const { pool: unused, resources, add } = fixture()
    await unused.dispose()
    for (const group of ['data', 'repl', 'shell'] as const) add(group, 'session')
    const policy = hostPressurePolicy()
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy: () => false,
      memoryPolicy: async () => policy,
      onFailure: vi.fn()
    })
    await pool.check()
    vi.setSystemTime(Date.now() + 5 * 60_000 - 1)
    await pool.check()
    expect(resources).toHaveLength(3)
    vi.setSystemTime(Date.now() + 1)
    await pool.check()
    expect(resources).toHaveLength(0)
    await pool.dispose()
    policy.dispose()
  })

  it('limits pressure passes to eight trees and waits five seconds despite sample notifications', async () => {
    const { pool: unused, resources, add } = fixture()
    await unused.dispose()
    for (const group of ['data', 'repl', 'shell'] as const)
      for (let index = 0; index < 3; index++) add(group, `${group}-${index}`)
    const policy = hostPressurePolicy()
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy: () => false,
      memoryPolicy: async () => policy,
      onFailure: vi.fn()
    })
    const unsubscribe = policy.subscribe(() => pool.refresh())
    await pool.check()
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await pool.check()
    expect(resources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(4999)
    expect(resources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(resources).toHaveLength(0)
    unsubscribe()
    await pool.dispose()
    policy.dispose()
  })

  it('preserves export holds without renewing the idle lifetime', async () => {
    const { pool: unused, resources, add } = fixture()
    await unused.dispose()
    add('data', 'exporting')
    let exporting = false
    const policy = hostPressurePolicy()
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy: () => false,
      isSessionHeld: () => exporting,
      memoryPolicy: async () => policy,
      onFailure: vi.fn()
    })
    await pool.check()
    exporting = true
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await pool.check()
    expect(resources).toHaveLength(1)
    exporting = false
    await pool.check()
    expect(resources).toHaveLength(0)
    await pool.dispose()
    policy.dispose()
  })

  it('does not use host pressure to reclaim resources whose execution domain is unknown', async () => {
    const { pool: unused, resources, add } = fixture()
    await unused.dispose()
    const unknown = add('shell', 'wsl')
    unknown.executionDomain = undefined
    add('data', 'native')
    const policy = hostPressurePolicy()
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy: () => false,
      memoryPolicy: async () => policy,
      onFailure: vi.fn()
    })
    await pool.check()
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await pool.check()
    expect(resources).toEqual([unknown])
    await pool.dispose()
    policy.dispose()
  })

  it('stops pressure reclamation as soon as the sample after a tree result has recovered', async () => {
    const { pool: unused, resources, add } = fixture()
    await unused.dispose()
    for (const group of ['data', 'repl', 'shell'] as const) add(group, group)
    const policy = hostPressurePolicy(() => (resources.length === 3 ? 2 : 50))
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy: () => false,
      memoryPolicy: async () => policy,
      onFailure: vi.fn()
    })
    await pool.check()
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await pool.check()
    expect(resources).toHaveLength(2)
    await pool.dispose()
    policy.dispose()
  })

  it('keeps the ordinary idle deadline when memory policy initialization fails', async () => {
    const { pool: unused, resources, add, onFailure } = fixture()
    await unused.dispose()
    add('data', 'one')
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy: () => false,
      memoryPolicy: async () => {
        throw new Error('sampler could not load')
      },
      onFailure
    })
    await pool.check()
    const start = Date.now()
    vi.setSystemTime(start + 5 * 60_000)
    await pool.check()
    expect(resources).toHaveLength(1)
    expect(onFailure).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(5000)
    pool.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(onFailure).toHaveBeenCalledOnce()
    vi.setSystemTime(start + NOTEBOOK_SESSION_IDLE_MS)
    await pool.check()
    expect(resources).toHaveLength(0)
    await pool.dispose()
  })

  it('rechecks sample freshness at the owner commit after asynchronous teardown preparation', async () => {
    const { pool: unused, resources, add } = fixture()
    await unused.dispose()
    const resource = add('data', 'one')
    resource.release = async (stillIdle) => {
      vi.setSystemTime(Date.now() + 10_001)
      if (!stillIdle()) return false
      resources.splice(resources.indexOf(resource), 1)
      return true
    }
    const policy = hostPressurePolicy()
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy: () => false,
      memoryPolicy: async () => policy,
      onFailure: vi.fn()
    })
    await pool.check()
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await pool.check()
    expect(resources).toEqual([resource])
    await pool.dispose()
    policy.dispose()
  })

  it.each(['unavailable', 'local-cgroup'] as const)(
    'preserves ordinary reclamation while %s cannot authorize a host pressure pass',
    async (sample) => {
      const { pool: unused, resources, add } = fixture()
      await unused.dispose()
      add('data', 'one')
      const policy = new MemoryPolicyService({
        now: Date.now,
        adapter: {
          platform: 'linux',
          sample: async () => {
            if (sample === 'unavailable') throw new Error('required signal is unavailable')
            return {
              platform: 'linux',
              source: 'test-cgroup',
              executionScope: 'linux:cgroup-v2:/limited',
              facts: {
                availableBytes: 50,
                totalBytes: 100,
                overcommitMode: 1,
                cgroup: {
                  version: 2,
                  ancestors: 'complete',
                  constraints: [{ path: '/limited', currentBytes: 95, maxBytes: 100 }]
                }
              }
            }
          }
        }
      })
      const pool = new NotebookIdleReclamation({
        resources: () => resources,
        isSessionBusy: () => false,
        memoryPolicy: async () => policy,
        onFailure: vi.fn()
      })
      await pool.check()
      const start = Date.now()
      vi.setSystemTime(start + 5 * 60_000)
      await pool.check()
      expect(resources).toHaveLength(1)
      vi.setSystemTime(start + NOTEBOOK_SESSION_IDLE_MS)
      await pool.check()
      expect(resources).toHaveLength(0)
      await pool.dispose()
      policy.dispose()
    }
  )

  it('leaves active and failed trees with their owner while reclaiming other eligible trees', async () => {
    const { pool: unused, resources, add, busy, onFailure } = fixture()
    await unused.dispose()
    const active = add('data', 'active')
    busy.add('active')
    const failed = add('repl', 'failed')
    failed.release = vi.fn(async () => {
      throw new Error('tree cleanup is unconfirmed')
    })
    add('shell', 'idle')
    const policy = hostPressurePolicy()
    const pool = new NotebookIdleReclamation({
      resources: () => resources,
      isSessionBusy: (_project, session) => busy.has(session),
      memoryPolicy: async () => policy,
      onFailure
    })
    await pool.check()
    vi.setSystemTime(Date.now() + 5 * 60_000)
    await pool.check()
    expect(resources).toEqual([active, failed])
    expect(onFailure).toHaveBeenCalledOnce()
    await pool.check()
    expect(failed.release).toHaveBeenCalledOnce()
    await pool.dispose()
    policy.dispose()
  })

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

  it('counts instances, not sessions, and evicts ordinary excess beyond the eight-tree pressure budget', async () => {
    const { pool, resources, add } = fixture()
    const oldest = ['data', 'repl', 'shell'].map((group) =>
      add(group as IdleInterpreter['group'], 'same', 1)
    )
    for (const group of ['data', 'repl', 'shell'] as const)
      for (let index = 0; index < 6; index++) add(group, 'same', index + 2)
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
    const resource = resources[0]
    isSessionBusy.mockResolvedValue(false)
    await pool.check()
    await vi.advanceTimersByTimeAsync(NOTEBOOK_SESSION_IDLE_MS)
    expect(resource.release).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledOnce()
    await pool.dispose()
  })
})
