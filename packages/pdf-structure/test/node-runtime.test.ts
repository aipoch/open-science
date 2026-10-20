import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { nodeProcessRuntime } from '../src/node-runtime.js'

const child = (kill: () => boolean): ChildProcessWithoutNullStreams =>
  Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill
  }) as ChildProcessWithoutNullStreams

afterEach(() => vi.useRealTimers())

it('rejects a failed kill without leaking a close listener or timer', async () => {
  vi.useFakeTimers()
  const process = child(() => false)
  await expect(nodeProcessRuntime.stop(process)).rejects.toThrow('termination is unconfirmed')
  expect(process.listenerCount('close')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('requires close confirmation, bounds the wait, and supports retry', async () => {
  vi.useFakeTimers()
  const process = child(vi.fn(() => true))
  const stopping = expect(nodeProcessRuntime.stop(process)).rejects.toThrow(
    'termination is unconfirmed'
  )
  await vi.advanceTimersByTimeAsync(5_000)
  await stopping
  expect(process.listenerCount('close')).toBe(0)
  const retry = nodeProcessRuntime.stop(process)
  process.emit('close', null, 'SIGKILL')
  await retry
  expect(process.kill).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})
