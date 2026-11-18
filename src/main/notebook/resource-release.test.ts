import { describe, expect, it, vi } from 'vitest'

import type { NotebookResourceRelease } from '../../shared/notebook-resources'
import type { NotebookOwnedResource } from './owned-resources'
import { NotebookResourceReleaseOwner } from './resource-release'

const scopeFor = (
  projectId: string,
  sessionId: string
): { projectId: string; sessionId: string } => ({ projectId, sessionId })

const originalOwner = (): {
  owner: NotebookResourceReleaseOwner
  resources: NotebookOwnedResource[]
  add: (projectId: string, sessionId: string, reaped?: boolean) => NotebookOwnedResource
  settle: (sessionId?: string) => Promise<void>
  release: (projectId: string, sessionId: string) => Promise<NotebookResourceRelease>
} => {
  const resources: NotebookOwnedResource[] = []
  const operations = new Map<string, Promise<void>>()
  const owner = new NotebookResourceReleaseOwner({
    resources: ({ projectId, sessionId }) =>
      resources.filter(
        (resource) =>
          (!projectId || resource.projectId === projectId) &&
          (!sessionId || resource.sessionId === sessionId)
      ),
    hold: () => () => undefined,
    observe: (scope, operation) => operations.set(JSON.stringify(scope), operation),
    block: () => [],
    decisions: () => [],
    changed: () => undefined,
    blockedReason: () => undefined,
    logger: { info: vi.fn(), error: vi.fn() }
  })
  const add = (projectId: string, sessionId: string, reaped = true): NotebookOwnedResource => {
    const resource: NotebookOwnedResource = {
      identity: {},
      group: 'kernel',
      kind: 'repl',
      phase: 'idle',
      startedAt: 1,
      projectId,
      sessionId,
      laneKey: sessionId,
      release: async () => {
        resources.splice(resources.indexOf(resource), 1)
        return { reaped }
      }
    }
    resources.push(resource)
    return resource
  }
  const settle = async (sessionId?: string): Promise<void> => {
    await Promise.all(
      [...operations]
        .filter(([scope]) => !sessionId || JSON.parse(scope).sessionId === sessionId)
        .map(([, operation]) => operation)
    )
  }
  const release = async (
    projectId: string,
    sessionId: string
  ): Promise<NotebookResourceRelease> => {
    const group = (await owner.project(projectId)).groups.find(
      (entry) => entry.sessionId === sessionId
    )!
    const result = owner.release(
      { projectId, sessionId, revision: group.revision },
      () => undefined
    )
    await settle(sessionId)
    return result
  }
  return { owner, resources, add, settle, release }
}

describe('Notebook resource memory sampling', () => {
  it('rotates through large inventories, samples other projects and drops failed measurements', async () => {
    vi.useFakeTimers()
    try {
      const { owner, add } = originalOwner()
      const sample =
        (pid: number): NonNullable<NotebookOwnedResource['sampleMemory']> =>
        async () => ({
          metric: 'rss' as const,
          sampledAt: Date.now(),
          complete: true,
          processes: [{ pid, birth: String(pid), rssBytes: pid }]
        })
      for (let pid = 1; pid <= 129; pid++) add('large', 'session').sampleMemory = sample(pid)
      const probe = vi.fn(sample(1))
      add('other', 'session').sampleMemory = probe
      const [large, other] = await Promise.all([owner.project('large'), owner.project('other')])
      expect(large.groups[0].resources.at(-1)?.memory).toEqual({
        coverage: 'unknown',
        metric: process.platform === 'win32' ? 'private-bytes-and-working-set' : 'rss'
      })
      expect(other.groups[0].resources[0].memory.rssBytes).toBe(1)
      await owner.project('other')
      expect(probe).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect((await owner.project('large')).groups[0].resources.at(-1)?.memory.rssBytes).toBe(129)
      probe.mockRejectedValueOnce(new Error('unavailable'))
      const failed = (await owner.project('other')).groups[0].resources[0].memory
      expect(failed.coverage).toBe('unknown')
      expect(failed.sampledAt).toBeUndefined()
      expect(failed.rssBytes).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('finishes at the deadline and advances past a stalled owner; ignores late samples', async () => {
    vi.useFakeTimers()
    try {
      const { owner, add } = originalOwner()
      const stuck = add('project', 'session')
      let finish!: () => void
      stuck.sampleMemory = vi.fn<NonNullable<NotebookOwnedResource['sampleMemory']>>(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                metric: 'rss',
                sampledAt: Date.now(),
                complete: true,
                processes: [{ pid: 1, birth: 'a', rssBytes: 10 }]
              })
          })
      )
      add('project', 'session').sampleMemory = async () => ({
        metric: 'rss',
        sampledAt: Date.now(),
        complete: true,
        processes: [{ pid: 2, birth: 'b', rssBytes: 20 }]
      })
      const first = owner.project('project')
      await vi.advanceTimersByTimeAsync(1500)
      expect((await first).groups[0].resources[0].memory.coverage).toBe('unknown')
      await vi.advanceTimersByTimeAsync(3500)
      const second = owner.project('project')
      await vi.advanceTimersByTimeAsync(1500)
      const [slow, healthy] = (await second).groups[0].resources
      expect(slow.memory.coverage).toBe('unknown')
      expect(healthy.memory.rssBytes).toBe(20)
      expect(stuck.sampleMemory).toHaveBeenCalledTimes(1)
      finish()
      const cached = await owner.project('project')
      expect(cached.groups[0].resources[0].memory.sampledAt).toBeUndefined()
      vi.setSystemTime(Date.now() + 60_000)
      expect((await owner.project('project')).groups[0].resources[1].memory.coverage).toBe(
        'unknown'
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('NotebookResourceReleaseOwner retention', () => {
  it('retains only the latest 20 successful operations per Project through the public projection', async () => {
    const original = originalOwner()
    const completed: NotebookResourceRelease[] = []
    for (let index = 0; index < 21; index++) {
      original.add('project-a', `session-${index}`)
      completed.push(await original.release('project-a', `session-${index}`))
    }
    original.add('project-b', 'other-session')
    const other = await original.release('project-b', 'other-session')

    expect((await original.owner.project('project-a')).releases).toHaveLength(20)
    expect((await original.owner.project('project-b')).releases).toHaveLength(1)
    expect(() =>
      original.owner.get({
        ...scopeFor('project-a', 'session-0'),
        operationId: completed[0].operationId
      })
    ).toThrow(/unavailable/)
    expect(
      original.owner.get({
        ...scopeFor('project-a', 'session-1'),
        operationId: completed[1].operationId
      }).status
    ).toBe('released')
    expect(
      original.owner.get({
        ...scopeFor('project-b', 'other-session'),
        operationId: other.operationId
      }).status
    ).toBe('released')
  })

  it('keeps retryable partial operations and their original cleanup handles beyond the success limit', async () => {
    const original = originalOwner()
    const failed = original.add('project-a', 'partial', false)
    let reaped = false
    failed.release = async () => {
      if (reaped) original.resources.splice(original.resources.indexOf(failed), 1)
      return { reaped }
    }
    original.add('project-a', 'partial')
    const group = (await original.owner.project('project-a')).groups[0]
    const partial = original.owner.release(
      { ...scopeFor('project-a', 'partial'), revision: group.revision },
      () => undefined
    )
    await original.settle('partial')

    for (let index = 0; index < 20; index++) {
      original.add('project-a', `session-${index}`)
      await original.release('project-a', `session-${index}`)
    }

    const projected = await original.owner.project('project-a')
    expect(projected.releases).toHaveLength(21)
    expect(projected.releases.filter(({ status }) => status === 'released')).toHaveLength(20)
    expect(projected.releases[0]).toMatchObject({
      operationId: partial.operationId,
      status: 'partial'
    })
    reaped = true
    const retry = original.owner.retry(
      { ...scopeFor('project-a', 'partial'), operationId: partial.operationId },
      () => undefined
    )
    await original.settle('partial')
    expect(retry.status).toBe('releasing')
    expect(
      original.owner.get({
        ...scopeFor('project-a', 'partial'),
        operationId: partial.operationId
      }).status
    ).toBe('released')
    expect(original.resources).not.toContain(failed)
    expect((await original.owner.project('project-a')).releases).toHaveLength(20)
  })

  it('retains an in-flight operation while completed operations reach the retention limit', async () => {
    const original = originalOwner()
    const cleanup = Promise.withResolvers<void>()
    original.add('project-a', 'in-flight').release = async () => {
      await cleanup.promise
      return { reaped: true }
    }
    const group = (await original.owner.project('project-a')).groups[0]
    const active = original.owner.release(
      { ...scopeFor('project-a', 'in-flight'), revision: group.revision },
      () => undefined
    )
    const previous: NotebookResourceRelease[] = []
    for (let index = 0; index < 20; index++) {
      original.add('project-a', `previous-${index}`)
      previous.push(await original.release('project-a', `previous-${index}`))
    }

    expect(active.status).toBe('releasing')
    expect((await original.owner.project('project-a')).releases).toHaveLength(21)
    expect(
      original.owner.get({ ...scopeFor('project-a', 'in-flight'), operationId: active.operationId })
        .status
    ).toBe('releasing')
    cleanup.resolve()
    await vi.waitFor(() =>
      expect(
        original.owner.get({
          ...scopeFor('project-a', 'in-flight'),
          operationId: active.operationId
        }).status
      ).toBe('released')
    )
    await original.settle('in-flight')
    expect((await original.owner.project('project-a')).releases).toHaveLength(20)
    expect(() =>
      original.owner.get({
        ...scopeFor('project-a', 'previous-0'),
        operationId: previous[0].operationId
      })
    ).toThrow(/unavailable/)
    expect(
      original.owner.get({ ...scopeFor('project-a', 'in-flight'), operationId: active.operationId })
        .status
    ).toBe('released')
  })
})
