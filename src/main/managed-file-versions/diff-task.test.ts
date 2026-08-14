import { describe, expect, it } from 'vitest'

import { ManagedFileVersionError } from './service'
import { ManagedTextDiffTaskRunner } from './diff-task'

describe('ManagedTextDiffTaskRunner', () => {
  it('returns line numbers and intra-line segments for a replacement', async () => {
    const runner = new ManagedTextDiffTaskRunner()

    const lines = await runner.run({
      requestId: 'diff-1',
      before: 'alpha beta\nkeep\n',
      after: 'alpha gamma\nkeep\n'
    })
    expect(lines).toMatchObject([
      {
        kind: 'removed',
        oldLineNumber: 1
      },
      {
        kind: 'added',
        newLineNumber: 1
      },
      {
        kind: 'context',
        oldLineNumber: 2,
        newLineNumber: 2,
        segments: [{ kind: 'context', text: 'keep' }]
      }
    ])
    expect(lines[0]?.segments.map((segment) => segment.text).join('')).toBe('alpha beta')
    expect(lines[1]?.segments.map((segment) => segment.text).join('')).toBe('alpha gamma')
    expect(lines[0]?.segments.some((segment) => segment.kind === 'removed')).toBe(true)
    expect(lines[1]?.segments.some((segment) => segment.kind === 'added')).toBe(true)
  })

  it('terminates an active worker when its request is cancelled', async () => {
    let terminated = false
    const runner = new ManagedTextDiffTaskRunner({
      createWorker: () => ({
        once: () => undefined,
        terminate: async () => {
          terminated = true
          return 0
        }
      })
    })

    const pending = runner.run({ requestId: 'diff-cancel', before: 'a', after: 'b' })
    expect(runner.cancel('diff-cancel')).toBe(true)
    await expect(pending).rejects.toEqual(
      expect.objectContaining<Partial<ManagedFileVersionError>>({ code: 'DIFF_CANCELLED' })
    )
    expect(terminated).toBe(true)
  })

  it('terminates a worker that exceeds the hard task timeout', async () => {
    let terminated = false
    const runner = new ManagedTextDiffTaskRunner({
      timeoutMs: 5,
      createWorker: () => ({
        once: () => undefined,
        terminate: async () => {
          terminated = true
          return 0
        }
      })
    })

    await expect(
      runner.run({ requestId: 'diff-timeout', before: 'a', after: 'b' })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ManagedFileVersionError>>({ code: 'DIFF_TIMEOUT' })
    )
    expect(terminated).toBe(true)
  })

  it('rejects a complete diff beyond the line limit instead of returning a truncation', async () => {
    const runner = new ManagedTextDiffTaskRunner()
    const before = Array.from({ length: 20_001 }, (_, index) => `old-${index}`).join('\n')

    await expect(
      runner.run({ requestId: 'diff-output-limit', before, after: before })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ManagedFileVersionError>>({
        code: 'DIFF_OUTPUT_LIMIT_EXCEEDED'
      })
    )
  })

  it('creates workers with bounded heap and stack resources', async () => {
    let resourceLimits: unknown
    let emitMessage: ((value: unknown) => void) | undefined
    const runner = new ManagedTextDiffTaskRunner({
      createWorker: (_task, limits) => {
        resourceLimits = limits
        return {
          once: (event, listener) => {
            if (event === 'message') emitMessage = listener as (value: unknown) => void
          },
          terminate: async () => 0
        }
      }
    })

    const result = runner.run({ requestId: 'diff-limited-worker', before: 'a', after: 'b' })
    emitMessage?.([])

    await expect(result).resolves.toEqual([])
    expect(resourceLimits).toEqual({
      maxOldGenerationSizeMb: 32,
      maxYoungGenerationSizeMb: 8,
      stackSizeMb: 2
    })
  })
})
