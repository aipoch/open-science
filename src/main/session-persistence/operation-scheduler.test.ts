import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'

import { SessionPersistenceOperationScheduler } from './operation-scheduler'

const createDeferred = <Value = void>(): {
  promise: Promise<Value>
  resolve: (value: Value) => void
} => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('SessionPersistenceOperationScheduler', () => {
  it.each([false, true])(
    'rejects identity expansion behind a successor without bypassing earlier owners (transitive: %s)',
    async (transitive) => {
      const scheduler = new SessionPersistenceOperationScheduler()
      const identityGate = createDeferred()
      const extendGate = createDeferred()
      const order: string[] = []
      const identity = scheduler.runSessionIdentity('session-1', async () => {
        order.push('identity:start')
        await identityGate.promise
        order.push('identity:end')
      })
      const project = scheduler.runProject('project-1', async (scope) => {
        await extendGate.promise
        return scope.runSessionIdentities(['unclaimed-session', 'session-1'], async () => {
          order.push('nested')
        })
      })
      const successor = scheduler.runSession('project-1', 'session-1', async () => {
        order.push('successor')
      })
      const indirect = transitive
        ? scheduler.runSession('project-2', 'session-1', async () => {
            order.push('indirect')
          })
        : undefined
      const global = scheduler.runGlobal(async () => {
        order.push('global')
      })
      const later = scheduler.runProject('project-3', async () => {
        order.push('later')
      })
      let projectSettled = false
      const projectResult = Promise.allSettled([project]).then((results) => {
        projectSettled = true
        return results
      })
      extendGate.resolve()
      await setImmediate()
      expect(projectSettled).toBe(true)
      expect(await projectResult).toEqual([
        {
          status: 'rejected',
          reason: new Error(
            'Session identity reservation conflicted with a later operation. Retry the operation.'
          )
        }
      ])
      expect(order).toEqual(['identity:start'])

      let allSettled = false
      const completion = Promise.allSettled([identity, successor, indirect, global, later])
      void completion.then(() => {
        allSettled = true
      })
      identityGate.resolve()
      await setImmediate()
      expect(allSettled).toBe(true)
      expect((await completion).every((result) => result.status === 'fulfilled')).toBe(true)
      expect(order).toEqual([
        'identity:start',
        'identity:end',
        'successor',
        ...(transitive ? ['indirect'] : []),
        'global',
        'later'
      ])
      await expect(
        scheduler.runSessionIdentity('unclaimed-session', async () => 'available')
      ).resolves.toBe('available')
    }
  )

  it('allows independent Projects to progress concurrently', async () => {
    const scheduler = new SessionPersistenceOperationScheduler()
    const projectOneGate = createDeferred()
    const projectOneStarted = createDeferred()
    const projectTwoStarted = createDeferred()

    const projectOne = scheduler.runProject('project-1', async () => {
      projectOneStarted.resolve()
      await projectOneGate.promise
    })
    await projectOneStarted.promise
    const projectTwo = scheduler.runProject('project-2', async () => {
      projectTwoStarted.resolve()
    })

    const outcome = await Promise.race([
      projectTwoStarted.promise.then(() => 'started' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50))
    ])
    projectOneGate.resolve()
    await Promise.all([projectOne, projectTwo])

    expect(outcome).toBe('started')
  })

  it('serializes a Project after failure without poisoning its tail', async () => {
    const scheduler = new SessionPersistenceOperationScheduler()
    const order: string[] = []

    const failed = scheduler.runProject('project-1', async () => {
      order.push('failed')
      throw new Error('isolated failure')
    })
    const recovered = scheduler.runProject('project-1', async () => {
      order.push('recovered')
    })

    await expect(failed).rejects.toThrow('isolated failure')
    await expect(recovered).resolves.toBeUndefined()
    expect(order).toEqual(['failed', 'recovered'])
  })

  it('serializes the same Session identity across Projects', async () => {
    const scheduler = new SessionPersistenceOperationScheduler()
    const firstGate = createDeferred()
    let secondStarted = false

    const first = scheduler.runSession('project-1', 'shared-session', async () => {
      await firstGate.promise
    })
    const second = scheduler.runSession('project-2', 'shared-session', async () => {
      secondStarted = true
    })
    await flushMicrotasks()
    expect(secondStarted).toBe(false)

    firstGate.resolve()
    await Promise.all([first, second])
    expect(secondStarted).toBe(true)
  })

  it('holds a set of Session identities without blocking unrelated identities', async () => {
    const scheduler = new SessionPersistenceOperationScheduler()
    const batchGate = createDeferred()
    const batchStarted = createDeferred()
    const order: string[] = []

    const batch = scheduler.runSessionIdentities(['session-1', 'session-2'], async () => {
      order.push('batch:start')
      batchStarted.resolve()
      await batchGate.promise
      order.push('batch:end')
    })
    await batchStarted.promise
    const firstIdentity = scheduler.runSessionIdentity('session-1', async () => {
      order.push('session-1')
    })
    const secondIdentity = scheduler.runSessionIdentity('session-2', async () => {
      order.push('session-2')
    })
    const independentIdentity = scheduler.runSessionIdentity('session-3', async () => {
      order.push('session-3')
    })
    await flushMicrotasks()
    expect(order).toEqual(['batch:start', 'session-3'])

    batchGate.resolve()
    await Promise.all([batch, firstIdentity, secondIdentity, independentIdentity])
    expect(order.slice(0, 3)).toEqual(['batch:start', 'session-3', 'batch:end'])
    expect(new Set(order.slice(3))).toEqual(new Set(['session-1', 'session-2']))
  })

  it('promotes a Session continuation to a global barrier', async () => {
    const scheduler = new SessionPersistenceOperationScheduler()
    const unrelatedGate = createDeferred()
    const unrelatedStarted = createDeferred()
    const globalGate = createDeferred()
    const globalStarted = createDeferred()
    const order: string[] = []

    const unrelated = scheduler.runProject('project-2', async () => {
      order.push('unrelated:start')
      unrelatedStarted.resolve()
      await unrelatedGate.promise
      order.push('unrelated:end')
    })
    await unrelatedStarted.promise
    const transition = scheduler.runSessionThenGlobal(
      'project-1',
      'session-1',
      async () => {
        order.push('session')
        return 'deleted'
      },
      async (result) => {
        order.push(`global:${result}`)
        globalStarted.resolve()
        await globalGate.promise
      }
    )
    await flushMicrotasks()
    expect(order).toEqual(['unrelated:start', 'session'])

    unrelatedGate.resolve()
    await globalStarted.promise
    const laterProject = scheduler.runProject('project-3', async () => {
      order.push('later-project')
    })
    await flushMicrotasks()
    expect(order).toEqual(['unrelated:start', 'session', 'unrelated:end', 'global:deleted'])

    globalGate.resolve()
    await Promise.all([unrelated, transition, laterProject])
    expect(order).toEqual([
      'unrelated:start',
      'session',
      'unrelated:end',
      'global:deleted',
      'later-project'
    ])
  })

  it('lets an active Project extend its identity scope ahead of a later global barrier', async () => {
    const scheduler = new SessionPersistenceOperationScheduler()
    const activeIdentityGate = createDeferred()
    const activeIdentityStarted = createDeferred()
    const extendScope = createDeferred()
    const projectStarted = createDeferred()
    const order: string[] = []

    const activeIdentity = scheduler.runSessionIdentity('session-1', async () => {
      order.push('active-identity:start')
      activeIdentityStarted.resolve()
      await activeIdentityGate.promise
      order.push('active-identity:end')
    })
    await activeIdentityStarted.promise
    const project = scheduler.runProject('project-1', async (scope) => {
      order.push('project:start')
      projectStarted.resolve()
      await extendScope.promise
      await scope.runSessionIdentities(['session-1'], async () => {
        order.push('project:identity-cleanup')
      })
      order.push('project:end')
    })
    await projectStarted.promise
    const global = scheduler.runGlobal(async () => {
      order.push('global')
    })
    const laterIdentity = scheduler.runSessionIdentity('session-1', async () => {
      order.push('later-identity')
    })

    extendScope.resolve()
    await flushMicrotasks()
    expect(order).toEqual(['active-identity:start', 'project:start'])
    activeIdentityGate.resolve()
    await Promise.all([activeIdentity, project, global, laterIdentity])
    expect(order).toEqual([
      'active-identity:start',
      'project:start',
      'active-identity:end',
      'project:identity-cleanup',
      'project:end',
      'global',
      'later-identity'
    ])
  })

  it('does not wait on a Session identity already held by the current operation', async () => {
    const scheduler = new SessionPersistenceOperationScheduler()

    const result = await Promise.race([
      scheduler.runSession('project-1', 'session-1', (scope) =>
        scope.runSessionIdentities(['session-1', 'session-1'], async () => 'completed')
      ),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50))
    ])

    expect(result).toBe('completed')
  })

  it('makes global operations exclusive with earlier and later scoped work', async () => {
    const scheduler = new SessionPersistenceOperationScheduler()
    const projectGate = createDeferred()
    const globalGate = createDeferred()
    const order: string[] = []

    const firstProject = scheduler.runProject('project-1', async () => {
      order.push('project-1:start')
      await projectGate.promise
      order.push('project-1:end')
    })
    const global = scheduler.runGlobal(async () => {
      order.push('global:start')
      await globalGate.promise
      order.push('global:end')
    })
    const laterProject = scheduler.runProject('project-2', async () => {
      order.push('project-2')
    })
    await flushMicrotasks()
    expect(order).toEqual(['project-1:start'])

    projectGate.resolve()
    await firstProject
    await flushMicrotasks()
    expect(order).toEqual(['project-1:start', 'project-1:end', 'global:start'])

    globalGate.resolve()
    await Promise.all([global, laterProject])
    expect(order).toEqual([
      'project-1:start',
      'project-1:end',
      'global:start',
      'global:end',
      'project-2'
    ])
  })

  it('orders manifest writes while allowing them to overlap Project work', async () => {
    const scheduler = new SessionPersistenceOperationScheduler()
    const firstManifestGate = createDeferred()
    const projectStarted = createDeferred()
    const order: string[] = []

    const firstManifest = scheduler.runManifest(async () => {
      order.push('manifest-1:start')
      await firstManifestGate.promise
      order.push('manifest-1:end')
    })
    const secondManifest = scheduler.runManifest(async () => {
      order.push('manifest-2')
    })
    const project = scheduler.runProject('project-1', async () => {
      order.push('project')
      projectStarted.resolve()
    })
    await projectStarted.promise
    expect(order).toEqual(['manifest-1:start', 'project'])

    firstManifestGate.resolve()
    await Promise.all([firstManifest, secondManifest, project])
    expect(order).toEqual(['manifest-1:start', 'project', 'manifest-1:end', 'manifest-2'])
  })
})
