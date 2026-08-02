import type { ClientConnection } from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import {
  AcpConnectionResourceOwner,
  type AcpConnectionResourceAttempt
} from './connection-resource-owner'

type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

const createDeferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const connection = (id: string): ClientConnection => ({ id }) as unknown as ClientConnection
const process = (id: string): ChildProcessWithoutNullStreams =>
  ({ id }) as unknown as ChildProcessWithoutNullStreams

const attachAndPublish = (
  attempt: AcpConnectionResourceAttempt,
  id: string
): ReturnType<AcpConnectionResourceAttempt['publish']> => {
  attempt.attach({
    process: process(id),
    connection: connection(id),
    framework: 'claude-code',
    bridgeLease: undefined
  })
  return attempt.publish({ close: true, delete: false, resume: true })
}

describe('AcpConnectionResourceOwner', () => {
  it('shares one publication attempt across concurrent connect callers', async () => {
    const owner = new AcpConnectionResourceOwner()
    const canPublish = createDeferred()
    const operation = vi.fn(async (attempt: AcpConnectionResourceAttempt) => {
      await canPublish.promise
      return attachAndPublish(attempt, 'shared')
    })

    const first = owner.connect(operation)
    expect(operation).toHaveBeenCalledOnce()
    const secondOperation = vi.fn(async (attempt: AcpConnectionResourceAttempt) =>
      attachAndPublish(attempt, 'unexpected')
    )
    const second = owner.connect(secondOperation)

    expect(second).toBe(first)
    canPublish.resolve()
    const [firstHandle, secondHandle] = await Promise.all([first, second])

    expect(operation).toHaveBeenCalledOnce()
    expect(secondOperation).not.toHaveBeenCalled()
    expect(secondHandle).toBe(firstHandle)
    expect(owner.connection).toBe(firstHandle.connection)
  })

  it('keeps an attached resource provisional until publication', async () => {
    const owner = new AcpConnectionResourceOwner()
    const attached = createDeferred()
    const canPublish = createDeferred()
    const pending = owner.connect(async (attempt) => {
      attempt.attach({
        process: process('provisional'),
        connection: connection('provisional'),
        framework: 'opencode',
        bridgeLease: undefined
      })
      attached.resolve()
      await canPublish.promise
      return attempt.publish({ close: false, delete: false, resume: true })
    })

    await attached.promise
    expect(owner.connection).toBeUndefined()
    expect(owner.capabilities).toEqual({ close: false, delete: false, resume: false })

    canPublish.resolve()
    const handle = await pending
    expect(owner.connection).toBe(handle.connection)
    expect(owner.capabilities.resume).toBe(true)
  })

  it('prevents a superseded attempt from publishing its attached resource', async () => {
    const owner = new AcpConnectionResourceOwner()
    const attached = createDeferred()
    const canPublish = createDeferred()
    const pending = owner.connect(async (attempt) => {
      attempt.attach({
        process: process('stale'),
        connection: connection('stale'),
        framework: 'codex',
        bridgeLease: undefined
      })
      attached.resolve()
      await canPublish.promise
      return attempt.publish({ close: false, delete: false, resume: false })
    })
    await attached.promise

    const teardownEpoch = owner.supersede()
    canPublish.resolve()

    await expect(pending).rejects.toThrow('ACP connection was superseded.')
    expect(owner.detach(teardownEpoch)?.connection).toMatchObject({ id: 'stale' })
  })

  it('transfers each resource once and ignores a stale detach after replacement', async () => {
    const owner = new AcpConnectionResourceOwner()
    const first = await owner.connect(async (attempt) => attachAndPublish(attempt, 'first'))
    const firstTeardownEpoch = owner.supersede()
    expect(owner.connection).toBeUndefined()
    const detachedFirst = owner.detach(firstTeardownEpoch)
    expect(detachedFirst?.connection).toBe(first.connection)
    expect(owner.detach(firstTeardownEpoch)).toBeUndefined()

    const replacement = await owner.connect(async (attempt) =>
      attachAndPublish(attempt, 'replacement')
    )
    expect(owner.detach(firstTeardownEpoch)).toBeUndefined()
    replacement.assertCurrent()
    expect(owner.connection).toBe(replacement.connection)

    expect(owner.detach(owner.epoch)?.connection).toBe(replacement.connection)
    expect(() => replacement.assertCurrent()).toThrow('ACP connection was superseded.')
  })

  it('restores only a still-attached published resource after teardown fails', async () => {
    const owner = new AcpConnectionResourceOwner()
    const handle = await owner.connect(async (attempt) => attachAndPublish(attempt, 'restored'))
    const teardownEpoch = owner.supersede()

    expect(owner.connection).toBeUndefined()
    expect(owner.restorePublished(teardownEpoch)).toBe(true)
    expect(owner.connection).toBe(handle.connection)

    const staleEpoch = teardownEpoch
    const replacementTeardownEpoch = owner.supersede()
    expect(owner.restorePublished(staleEpoch)).toBe(false)
    expect(owner.detach(replacementTeardownEpoch)?.connection).toBe(handle.connection)
    expect(owner.restorePublished(replacementTeardownEpoch)).toBe(false)
    expect(owner.connection).toBeUndefined()
  })

  it('never promotes a provisional resource through teardown rollback', async () => {
    const owner = new AcpConnectionResourceOwner()
    const attached = createDeferred()
    const canPublish = createDeferred()
    const pending = owner.connect(async (attempt) => {
      attempt.attach({
        process: process('provisional'),
        connection: connection('provisional'),
        framework: 'codex',
        bridgeLease: undefined
      })
      attached.resolve()
      await canPublish.promise
      return attempt.publish({ close: false, delete: false, resume: false })
    })
    await attached.promise

    const teardownEpoch = owner.supersede()
    expect(owner.restorePublished(teardownEpoch)).toBe(false)
    expect(owner.connection).toBeUndefined()

    canPublish.resolve()
    await expect(pending).rejects.toThrow('ACP connection was superseded.')
    expect(owner.detach(teardownEpoch)?.connection).toMatchObject({ id: 'provisional' })
  })

  it('exposes an immutable ready handle without process or bridge release authority', async () => {
    const owner = new AcpConnectionResourceOwner()
    const handle = await owner.connect(async (attempt) => attachAndPublish(attempt, 'ready'))

    expect(Object.keys(handle).sort()).toEqual([
      'assertCurrent',
      'capabilities',
      'connection',
      'epoch',
      'framework'
    ])
    expect(Object.isFrozen(handle)).toBe(true)
    expect(Object.isFrozen(handle.capabilities)).toBe(true)
    expect(handle).not.toHaveProperty('process')
    expect(handle).not.toHaveProperty('bridgeLease')
    expect(handle).not.toHaveProperty('release')
  })
})
