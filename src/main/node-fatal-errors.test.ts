import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installNodeFatalErrors } from './node-fatal-errors'

describe('Node fatal failures', () => {
  it.each(['uncaughtException', 'unhandledRejection'] as const)(
    'exits once after %s even when reporting fails',
    (kind) => {
      const emitter = new EventEmitter()
      const exit = vi.fn()
      const report = vi.fn(() => {
        throw new Error('log disk unavailable')
      })
      const remove = installNodeFatalErrors({
        process: Object.assign(emitter, { exit }) as unknown as NodeJS.Process,
        report
      })
      const failure = new Error('fatal failure')
      expect(() => emitter.emit(kind, failure)).toThrow('log disk unavailable')
      expect(report).toHaveBeenCalledWith(failure, kind)
      expect(exit).toHaveBeenCalledWith(1)
      emitter.emit(kind, failure)
      expect(exit).toHaveBeenCalledOnce()
      remove()
      expect(emitter.listenerCount(kind)).toBe(0)
    }
  )
})
