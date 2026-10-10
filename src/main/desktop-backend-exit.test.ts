import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { handleOwnedBackendDisconnect } from './desktop-backend-exit'

const childWith = (exitCode: number | null): EventEmitter & { exitCode: number | null } =>
  Object.assign(new EventEmitter(), { exitCode })

describe('handleOwnedBackendDisconnect', () => {
  it('quits when the owned backend already exited cleanly', () => {
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    handleOwnedBackendDisconnect({
      child: childWith(0) as never,
      error: new Error('disconnect'),
      updateCommitted: false,
      onCleanExit,
      onFailure
    })
    expect(onCleanExit).toHaveBeenCalledOnce()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('reports the disconnect as a failure when the backend already exited non-zero', () => {
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    const error = new Error('disconnect')
    handleOwnedBackendDisconnect({
      child: childWith(1) as never,
      error,
      updateCommitted: false,
      onCleanExit,
      onFailure
    })
    expect(onCleanExit).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith(error)
  })

  it('waits for the exit event when the backend is still running and quits on a clean exit', () => {
    const child = childWith(null)
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    handleOwnedBackendDisconnect({
      child: child as never,
      error: new Error('disconnect'),
      updateCommitted: false,
      onCleanExit,
      onFailure
    })
    expect(onCleanExit).not.toHaveBeenCalled()
    child.exitCode = 0
    child.emit('exit', 0, null)
    expect(onCleanExit).toHaveBeenCalledOnce()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('reports a failure when the running backend later exits non-zero', () => {
    const child = childWith(null)
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    const error = new Error('disconnect')
    handleOwnedBackendDisconnect({
      child: child as never,
      error,
      updateCommitted: false,
      onCleanExit,
      onFailure
    })
    child.exitCode = 1
    child.emit('exit', 1, null)
    expect(onCleanExit).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith(error)
  })

  it('does nothing when an update commit is in flight', () => {
    const child = childWith(null)
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    handleOwnedBackendDisconnect({
      child: child as never,
      error: new Error('disconnect'),
      updateCommitted: true,
      onCleanExit,
      onFailure
    })
    child.exitCode = 0
    child.emit('exit', 0, null)
    expect(onCleanExit).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })
})
