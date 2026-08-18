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
        segments: [{ kind: 'context', text: 'keep\n' }]
      }
    ])
    expect(lines[0]?.segments.map((segment) => segment.text).join('')).toBe('alpha beta\n')
    expect(lines[1]?.segments.map((segment) => segment.text).join('')).toBe('alpha gamma\n')
    expect(lines[0]?.segments.some((segment) => segment.kind === 'removed')).toBe(true)
    expect(lines[1]?.segments.some((segment) => segment.kind === 'added')).toBe(true)
  })

  it('preserves a shared CRLF on an unchanged context line', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'shared-crlf-context-line',
      before: 'same\r\n',
      after: 'same\r\n'
    })

    expect(lines).toEqual([
      {
        kind: 'context',
        oldLineNumber: 1,
        newLineNumber: 1,
        segments: [{ kind: 'context', text: 'same\r\n' }]
      }
    ])
  })

  it('preserves an unchanged CRLF as context on both sides of a changed line', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'shared-crlf-changed-line',
      before: 'old value\r\n',
      after: 'new value\r\n'
    })

    expect(lines).toEqual([
      {
        kind: 'removed',
        oldLineNumber: 1,
        segments: [
          { kind: 'removed', text: 'old' },
          { kind: 'context', text: ' value\r\n' }
        ]
      },
      {
        kind: 'added',
        newLineNumber: 1,
        segments: [
          { kind: 'added', text: 'new' },
          { kind: 'context', text: ' value\r\n' }
        ]
      }
    ])
  })

  it.each([
    {
      label: 'addition',
      before: 'line',
      after: 'line\n',
      expected: [
        {
          kind: 'removed',
          oldLineNumber: 1,
          segments: [{ kind: 'context', text: 'line' }]
        },
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [
            { kind: 'context', text: 'line' },
            { kind: 'added', text: '\n' }
          ]
        }
      ]
    },
    {
      label: 'removal',
      before: 'line\n',
      after: 'line',
      expected: [
        {
          kind: 'removed',
          oldLineNumber: 1,
          segments: [
            { kind: 'context', text: 'line' },
            { kind: 'removed', text: '\n' }
          ]
        },
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [{ kind: 'context', text: 'line' }]
        }
      ]
    }
  ])('preserves a trailing newline $label as an exact character segment', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `trailing-newline-${fixture.label}`,
      before: fixture.before,
      after: fixture.after
    })

    expect(lines).toEqual(fixture.expected)
  })

  it.each([
    {
      label: 'LF to CRLF',
      before: 'line\n',
      after: 'line\r\n',
      removedSegments: [
        { kind: 'context', text: 'line' },
        { kind: 'context', text: '\n' }
      ],
      addedSegments: [
        { kind: 'context', text: 'line' },
        { kind: 'added', text: '\r' },
        { kind: 'context', text: '\n' }
      ]
    },
    {
      label: 'CRLF to LF',
      before: 'line\r\n',
      after: 'line\n',
      removedSegments: [
        { kind: 'context', text: 'line' },
        { kind: 'removed', text: '\r' },
        { kind: 'context', text: '\n' }
      ],
      addedSegments: [
        { kind: 'context', text: 'line' },
        { kind: 'context', text: '\n' }
      ]
    }
  ])('preserves the shared newline during a trailing $label conversion', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `trailing-ending-conversion-${fixture.label}`,
      before: fixture.before,
      after: fixture.after
    })

    expect(lines).toEqual([
      { kind: 'removed', oldLineNumber: 1, segments: fixture.removedSegments },
      { kind: 'added', newLineNumber: 1, segments: fixture.addedSegments }
    ])
  })

  it.each([
    {
      label: 'bare CR to CRLF',
      before: 'line\r',
      after: 'line\r\n',
      removedSegments: [{ kind: 'context', text: 'line\r' }],
      addedSegments: [
        { kind: 'context', text: 'line\r' },
        { kind: 'added', text: '\n' }
      ]
    },
    {
      label: 'CRLF to bare CR',
      before: 'line\r\n',
      after: 'line\r',
      removedSegments: [
        { kind: 'context', text: 'line\r' },
        { kind: 'removed', text: '\n' }
      ],
      addedSegments: [{ kind: 'context', text: 'line\r' }]
    },
    {
      label: 'bare CR to LF',
      before: 'line\r',
      after: 'line\n',
      removedSegments: [
        { kind: 'context', text: 'line' },
        { kind: 'removed', text: '\r' }
      ],
      addedSegments: [
        { kind: 'context', text: 'line' },
        { kind: 'added', text: '\n' }
      ]
    }
  ])('preserves exact characters during a $label conversion', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `bare-cr-${fixture.label}`,
      before: fixture.before,
      after: fixture.after
    })

    expect(lines).toEqual([
      { kind: 'removed', oldLineNumber: 1, segments: fixture.removedSegments },
      { kind: 'added', newLineNumber: 1, segments: fixture.addedSegments }
    ])
  })

  it.each([
    { label: 'LINE SEPARATOR', character: '\u2028' },
    { label: 'PARAGRAPH SEPARATOR', character: '\u2029' }
  ])('keeps Unicode $label as a content character', async ({ character }) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'unicode-line-separator',
      before: `alpha${character}old`,
      after: `alpha${character}new`
    })

    expect(lines[0]?.segments.map((segment) => segment.text).join('')).toBe(`alpha${character}old`)
    expect(lines[1]?.segments.map((segment) => segment.text).join('')).toBe(`alpha${character}new`)
  })

  it('reconstructs both complete sources from a mixed-ending diff DTO', async () => {
    const before = 'same\r\nold value\nremove me\r\nunicode\u2029tail'
    const after = 'same\r\nnew value\nadded only\r\nunicode\u2029tail\n'
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'source-reconstruction',
      before,
      after
    })
    const reconstruct = (excludedKind: 'added' | 'removed'): string =>
      lines
        .filter((line) => line.kind !== excludedKind)
        .flatMap((line) => line.segments)
        .map((segment) => segment.text)
        .join('')

    expect(reconstruct('added')).toBe(before)
    expect(reconstruct('removed')).toBe(after)
  })

  it.each([
    {
      label: 'LF addition',
      before: '',
      after: 'line\n',
      expected: [
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [{ kind: 'added', text: 'line\n' }]
        }
      ]
    },
    {
      label: 'CRLF addition',
      before: '',
      after: 'line\r\n',
      expected: [
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [{ kind: 'added', text: 'line\r\n' }]
        }
      ]
    },
    {
      label: 'LF removal',
      before: 'line\n',
      after: '',
      expected: [
        {
          kind: 'removed',
          oldLineNumber: 1,
          segments: [{ kind: 'removed', text: 'line\n' }]
        }
      ]
    },
    {
      label: 'CRLF removal',
      before: 'line\r\n',
      after: '',
      expected: [
        {
          kind: 'removed',
          oldLineNumber: 1,
          segments: [{ kind: 'removed', text: 'line\r\n' }]
        }
      ]
    }
  ])('preserves line endings for a pure $label', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `pure-ending-${fixture.label}`,
      before: fixture.before,
      after: fixture.after
    })

    expect(lines).toEqual(fixture.expected)
  })

  it.each([
    {
      label: 'addition',
      before: 'plain',
      after: 'plain\ncontinuation\r\n',
      trailingKind: 'added',
      trailingText: 'continuation\r\n'
    },
    {
      label: 'removal',
      before: 'plain\ncontinuation\r\n',
      after: 'plain',
      trailingKind: 'removed',
      trailingText: 'continuation\r\n'
    }
  ])('preserves an unmatched trailing line ending after a line-count $label', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `unmatched-ending-${fixture.label}`,
      before: fixture.before,
      after: fixture.after
    })

    expect(lines.at(-1)).toMatchObject({
      kind: fixture.trailingKind,
      segments: [{ kind: fixture.trailingKind, text: fixture.trailingText }]
    })
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
