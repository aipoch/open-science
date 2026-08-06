import { describe, expect, it, vi } from 'vitest'

import { createSettingsWriteCoordinator } from './settings-write-coordinator'

const deferred = <T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} => {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('settings write coordinator', () => {
  it('fences stale same-key writes and preserves later cross-key failures', () => {
    const errors: Array<string | undefined> = []
    const writes = createSettingsWriteCoordinator((error) => errors.push(error))

    const stale = writes.begin('reasoningEffort')
    const current = writes.begin('reasoningEffort')
    stale.fail('stale reasoning failure')
    current.fail('reasoning failure')

    const clearsExisting = writes.begin('notifications')
    writes.begin('appIcon').fail('app icon failure')
    clearsExisting.succeed()

    expect(errors).toEqual([
      'reasoning failure',
      'reasoning failure app icon failure',
      'app icon failure'
    ])
  })

  it('serializes one preference while unrelated preferences remain independent', async () => {
    const writes = createSettingsWriteCoordinator(vi.fn())
    const firstGate = deferred<string>()
    const order: string[] = []
    const first = writes.beginOptimistic<string>('reasoningEffort', 'default')
    const second = writes.beginOptimistic<string>('reasoningEffort', 'default')

    const firstPending = first.run(() => {
      order.push('reasoning:first')
      return firstGate.promise
    })
    const secondPending = second.run(async () => {
      order.push('reasoning:second')
      return 'max'
    })
    const unrelatedPending = writes
      .beginOptimistic<boolean>('notifications', true)
      .run(async () => {
        order.push('notifications')
        return false
      })

    await unrelatedPending
    expect(order).toEqual(['reasoning:first', 'notifications'])

    firstGate.resolve('high')
    await Promise.all([firstPending, secondPending])
    expect(order).toEqual(['reasoning:first', 'notifications', 'reasoning:second'])
  })

  it('rolls back to the last confirmed value after a queued write fails', async () => {
    const writes = createSettingsWriteCoordinator(vi.fn())
    const first = writes.beginOptimistic<string>('reasoningEffort', 'default')
    const second = writes.beginOptimistic<string>('reasoningEffort', 'default')

    const confirmed = await first.run(async () => 'high')
    first.complete({ value: confirmed })
    await expect(
      second.run(async () => {
        throw new Error('write failed')
      })
    ).rejects.toThrow('write failed')

    expect(second.complete()).toBe('high')
  })

  it('keeps coordinator instances isolated', () => {
    const firstError = vi.fn()
    const secondError = vi.fn()
    const first = createSettingsWriteCoordinator(firstError)
    const second = createSettingsWriteCoordinator(secondError)

    first.begin('notifications').fail('first failure')
    second.begin('notifications').succeed()

    expect(firstError).toHaveBeenLastCalledWith('first failure')
    expect(secondError).toHaveBeenLastCalledWith(undefined)
  })

  it('clears visible failures without cancelling an in-flight write', () => {
    const onError = vi.fn()
    const writes = createSettingsWriteCoordinator(onError)
    const pending = writes.begin('notifications')

    writes.begin('appIcon').fail('app icon failure')
    writes.clearFailures()
    pending.fail('notification failure')

    expect(onError.mock.calls.map(([error]) => error)).toEqual([
      'app icon failure',
      undefined,
      'notification failure'
    ])
  })
})
