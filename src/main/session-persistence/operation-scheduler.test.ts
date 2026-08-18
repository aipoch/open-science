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
