import { describe, expect, it, vi } from 'vitest'
import { executeToolCall, type ToolExecutionReceipt } from './tool-execution'

const fixture = (): {
  options: Parameters<typeof executeToolCall<{ path: string; nested: { value: number } }>>[0]
  events: ToolExecutionReceipt[]
  controller: AbortController
} => {
  const events: ToolExecutionReceipt[] = []
  const controller = new AbortController()
  return {
    events,
    controller,
    options: {
      callId: 'call',
      signal: controller.signal,
      input: { path: 'allowed', nested: { value: 1 } },
      validate: (value) => value as { path: string; nested: { value: number } },
      authorize: vi.fn(async () => true),
      execute: vi.fn(async () => 'result'),
      record: vi.fn(async (event) => {
        events.push(event)
      })
    }
  }
}

describe('durable tool execution', () => {
  it('writes intent before effects and records the result before returning', async () => {
    const { options, events } = fixture()
    options.execute = vi.fn(async () => {
      expect(events).toEqual([{ callId: 'call', status: 'started' }])
      return 'result'
    })
    expect(await executeToolCall(options)).toEqual({ status: 'completed', output: 'result' })
    expect(events.at(-1)).toEqual({ callId: 'call', status: 'completed', output: 'result' })
  })

  it('authorizes and executes the same frozen validated snapshot', async () => {
    const { options } = fixture()
    let approved: unknown
    options.authorize = async (args) => {
      approved = args
      ;(options.input as { path: string }).path = 'changed'
      expect(() => {
        args.nested.value = 2
      }).toThrow()
      return true
    }
    options.execute = async (args) => {
      expect(args).toBe(approved)
      expect(args.path).toBe('allowed')
      return 'result'
    }
    await executeToolCall(options)
  })

  it('records denial without execution or intent', async () => {
    const { options, events } = fixture()
    options.authorize = async () => false
    expect(await executeToolCall(options)).toEqual({
      status: 'denied',
      output: 'Permission denied'
    })
    expect(options.execute).not.toHaveBeenCalled()
    expect(events).toEqual([{ callId: 'call', status: 'denied', output: 'Permission denied' }])
  })

  it.each([new Map([['path', 'allowed']]), new Set(['allowed']), new Date()])(
    'rejects mutable built-ins that Object.freeze cannot protect',
    async (input) => {
      const { options } = fixture()
      options.input = input
      await expect(executeToolCall(options)).rejects.toThrow('plain objects')
      expect(options.authorize).not.toHaveBeenCalled()
      expect(options.execute).not.toHaveBeenCalled()
    }
  )

  it.each(['validation', 'authorization', 'intent'] as const)(
    'fails before effects on %s failure',
    async (phase) => {
      const { options } = fixture()
      const fail = (): never => {
        throw new Error('failed')
      }
      if (phase === 'validation') options.validate = fail
      if (phase === 'authorization') options.authorize = fail
      if (phase === 'intent') options.record = fail
      await expect(executeToolCall(options)).rejects.toThrow('failed')
      expect(options.execute).not.toHaveBeenCalled()
    }
  )

  it('records unknown after an execution error and never retries', async () => {
    const { options, events } = fixture()
    options.execute = vi.fn(async () => {
      throw new Error('effect may have happened')
    })
    await expect(executeToolCall(options)).rejects.toThrow('effect may have happened')
    expect(options.execute).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toEqual({ callId: 'call', status: 'unknown' })
  })

  it('retains both failures if unknown-state recording also fails', async () => {
    const { options } = fixture()
    options.execute = async () => {
      throw new Error('execution')
    }
    options.record = async (event) => {
      if (event.status === 'unknown') throw new Error('storage')
    }
    await expect(executeToolCall(options)).rejects.toMatchObject({
      errors: [expect.any(Error), expect.any(Error)]
    })
  })

  it('does not overwrite an uncertain terminal write or repeat effects', async () => {
    const { options } = fixture()
    options.record = vi.fn(async (event) => {
      if (event.status === 'completed') throw new Error('storage')
    })
    await expect(executeToolCall(options)).rejects.toThrow('storage')
    expect(options.execute).toHaveBeenCalledTimes(1)
    expect(options.record).toHaveBeenCalledTimes(2)
  })

  it('cancels after approval without effects', async () => {
    const { options, controller } = fixture()
    options.authorize = async () => {
      controller.abort()
      return true
    }
    await expect(executeToolCall(options)).rejects.toThrow()
    expect(options.execute).not.toHaveBeenCalled()
    expect(options.record).not.toHaveBeenCalled()
  })

  it('records an acknowledged result even if cancellation happened during execution', async () => {
    const { options, events, controller } = fixture()
    options.execute = async () => {
      controller.abort()
      return 'effect completed'
    }
    await expect(executeToolCall(options)).rejects.toThrow()
    expect(events.at(-1)).toEqual({
      callId: 'call',
      status: 'completed',
      output: 'effect completed'
    })
  })
})
