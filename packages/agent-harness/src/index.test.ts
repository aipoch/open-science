import { describe, expect, it } from 'vitest'
import { createAgentRunner } from './index'

describe('agent runner ownership', () => {
  it('continues settled steps and allows the next turn', async () => {
    const runner = createAgentRunner({ maxSteps: 3 })
    const seen: number[] = []
    expect(
      await runner.run(async (_signal, index) => {
        seen.push(index)
        return index === 1 ? 'complete' : 'continue'
      })
    ).toBe('complete')
    expect(seen).toEqual([0, 1])
    expect(await runner.run(async () => 'complete')).toBe('complete')
  })
  it('budget exhaustion is distinct from completion', async () => {
    const runner = createAgentRunner({ maxSteps: 2 })
    let calls = 0
    expect(
      await runner.run(async () => {
        calls++
        return 'continue'
      })
    ).toBe('budget')
    expect(calls).toBe(2)
  })
  it('holds ownership through cancellation cleanup and rejects late completion', async () => {
    const runner = createAgentRunner({ maxSteps: 2 })
    const gate = Promise.withResolvers<void>()
    let signal!: AbortSignal
    const pending = runner.run(async (s) => {
      signal = s
      await gate.promise
      return 'complete'
    })
    await expect(runner.run(async () => 'complete')).rejects.toThrow('busy')
    runner.cancel()
    expect(signal.aborted).toBe(true)
    await expect(runner.run(async () => 'complete')).rejects.toThrow('busy')
    let disposed = false
    const disposal = runner.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    gate.resolve()
    expect(await pending).toBe('cancelled')
    await disposal
    await runner.dispose()
    await expect(runner.run(async () => 'complete')).rejects.toThrow('disposed')
  })
  it('does not retry failures or reuse an incomplete history', async () => {
    const runner = createAgentRunner({ maxSteps: 3 })
    const error = new Error('tool outcome unknown')
    await expect(
      runner.run(async () => {
        throw error
      })
    ).rejects.toBe(error)
    await expect(runner.run(async () => 'complete')).rejects.toThrow('new runner')
  })
  it.each([0, -1, 1.2, Infinity, NaN])('rejects invalid budget %s', (maxSteps) => {
    expect(() => createAgentRunner({ maxSteps })).toThrow('budget')
  })
})
