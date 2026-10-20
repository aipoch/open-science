import { ChildProcess } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { handleOwnedBackendDisconnect } from './desktop-backend-exit'

const childWith = (exitCode: number | null): ChildProcess =>
  Object.assign(new ChildProcess(), { pid: 123, exitCode })

afterEach(() => vi.useRealTimers())

describe('handleOwnedBackendDisconnect', () => {
  it('quits when the owned backend already exited cleanly', () => {
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    handleOwnedBackendDisconnect({
      child: childWith(0),
      runtimePid: 123,
      error: new Error('disconnect'),
      isUpdateCommitted: () => false,
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
      child: childWith(1),
      runtimePid: 123,
      error,
      isUpdateCommitted: () => false,
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
      child: child,
      runtimePid: 123,
      error: new Error('disconnect'),
      isUpdateCommitted: () => false,
      onCleanExit,
      onFailure
    })
    expect(onCleanExit).not.toHaveBeenCalled()
    Object.assign(child, { exitCode: 0 })
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
      child: child,
      runtimePid: 123,
      error,
      isUpdateCommitted: () => false,
      onCleanExit,
      onFailure
    })
    Object.assign(child, { exitCode: 1 })
    child.emit('exit', 1, null)
    expect(onCleanExit).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith(error)
  })

  it.each([0, 1])('reports timeout once and still observes a later exit code %s', (exitCode) => {
    vi.useFakeTimers()
    const child = childWith(null)
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    const error = new Error('disconnect')
    handleOwnedBackendDisconnect({
      child: child,
      runtimePid: 123,
      error,
      isUpdateCommitted: () => false,
      onCleanExit,
      onFailure,
      exitSettleTimeoutMs: 1_000
    })
    vi.advanceTimersByTime(1_000)
    expect(onCleanExit).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith(error)
    expect(child.listenerCount('exit')).toBe(1)
    Object.assign(child, { exitCode })
    child.emit('exit', exitCode, null)
    expect(onCleanExit).toHaveBeenCalledTimes(exitCode === 0 ? 1 : 0)
    expect(onFailure).toHaveBeenCalledOnce()
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([456, undefined])(
    'does not treat another runtime PID (%s) as the owned child',
    (runtimePid) => {
      const onCleanExit = vi.fn()
      const onFailure = vi.fn()
      const error = new Error('disconnect')
      const child = childWith(0)
      handleOwnedBackendDisconnect({
        child,
        runtimePid,
        error,
        isUpdateCommitted: () => false,
        onCleanExit,
        onFailure
      })
      expect(onCleanExit).not.toHaveBeenCalled()
      expect(onFailure).toHaveBeenCalledWith(error)
      expect(child.listenerCount('exit')).toBe(0)
    }
  )

  it.each([true, false])('reports signal termination (already exited: %s)', (alreadyExited) => {
    vi.useFakeTimers()
    const child = childWith(null)
    if (alreadyExited) Object.assign(child, { signalCode: 'SIGTERM' })
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    const error = new Error('disconnect')
    handleOwnedBackendDisconnect({
      child,
      runtimePid: 123,
      error,
      isUpdateCommitted: () => false,
      onCleanExit,
      onFailure
    })
    if (!alreadyExited) {
      expect(onFailure).not.toHaveBeenCalled()
      Object.assign(child, { signalCode: 'SIGTERM' })
      child.emit('exit', null, 'SIGTERM')
    }
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(error)
    expect(onCleanExit).not.toHaveBeenCalled()
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rechecks update precedence while waiting for the child', () => {
    vi.useFakeTimers()
    const child = childWith(null)
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    let updateCommitted = false
    handleOwnedBackendDisconnect({
      child,
      runtimePid: 123,
      error: new Error('disconnect'),
      isUpdateCommitted: () => updateCommitted,
      onCleanExit,
      onFailure
    })
    updateCommitted = true
    vi.advanceTimersByTime(10_000)
    Object.assign(child, { exitCode: 0 })
    child.emit('exit', 0, null)
    expect(onCleanExit).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('does nothing when an update commit is in flight', () => {
    const child = childWith(null)
    const onCleanExit = vi.fn()
    const onFailure = vi.fn()
    handleOwnedBackendDisconnect({
      child: child,
      runtimePid: 123,
      error: new Error('disconnect'),
      isUpdateCommitted: () => true,
      onCleanExit,
      onFailure
    })
    Object.assign(child, { exitCode: 0 })
    child.emit('exit', 0, null)
    expect(onCleanExit).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })
})
