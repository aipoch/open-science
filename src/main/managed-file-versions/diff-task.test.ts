import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { ManagedFileVersionError } from './service'
import { ManagedTextDiffTaskRunner, resolveDiffModulePath } from './diff-task'

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

  it('keeps an inserted line separate from the similar modified line that follows it', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'inserted-line-before-modified-line',
      before: '## What Is This?\nOriginal paragraph old.\n',
      after: '## What Is This?? ?\nWonderful\nOriginal paragraph new.\n'
    })

    expect(
      lines.map((line) => ({
        kind: line.kind,
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        text: line.segments.map((segment) => segment.text).join(''),
        changed: line.segments
          .filter((segment) => segment.kind === line.kind)
          .map((segment) => segment.text)
          .join('')
      }))
    ).toEqual([
      {
        kind: 'removed',
        oldLineNumber: 1,
        newLineNumber: undefined,
        text: '## What Is This?\n',
        changed: ''
      },
      {
        kind: 'added',
        oldLineNumber: undefined,
        newLineNumber: 1,
        text: '## What Is This?? ?\n',
        changed: '? ?'
      },
      {
        kind: 'added',
        oldLineNumber: undefined,
        newLineNumber: 2,
        text: 'Wonderful\n',
        changed: 'Wonderful\n'
      },
      {
        kind: 'removed',
        oldLineNumber: 2,
        newLineNumber: undefined,
        text: 'Original paragraph old.\n',
        changed: 'old'
      },
      {
        kind: 'added',
        oldLineNumber: undefined,
        newLineNumber: 3,
        text: 'Original paragraph new.\n',
        changed: 'new'
      }
    ])
  })

  it('does not anchor a paragraph insertion to the blank line before its matching paragraph', async () => {
    const beforeParagraph =
      "If you switch between Claude's official subscription and third-party API routing."
    const afterParagraph =
      'If you switch between official subscription and third-party API routing.'
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'blank-line-before-matching-paragraph',
      before: `## What Is This?\n\n${beforeParagraph}\n\nStable next.\n`,
      after: `## What Is This?？？\n\n### Wonderful\n\n${afterParagraph}\n\nStable next.\n`
    })
    const summary = lines.map((line) => ({
      kind: line.kind,
      text: line.segments.map((segment) => segment.text).join(''),
      changed: line.segments
        .filter((segment) => segment.kind === line.kind)
        .map((segment) => segment.text)
        .join('')
    }))

    expect(summary).toContainEqual({
      kind: 'added',
      text: '### Wonderful\n',
      changed: '### Wonderful\n'
    })
    expect(summary).toContainEqual({
      kind: 'removed',
      text: `${beforeParagraph}\n`,
      changed: "Claude's "
    })
    expect(summary).toContainEqual({
      kind: 'added',
      text: `${afterParagraph}\n`,
      changed: ''
    })
    expect(summary.findIndex((line) => line.text === '### Wonderful\n')).toBeLessThan(
      summary.findIndex((line) => line.text === `${afterParagraph}\n`)
    )
  })

  it.each([199, 200])(
    'preserves %i unchanged blank lines around a paragraph replacement',
    async (blankLineCount) => {
      const blankLines = '\n'.repeat(blankLineCount)
      const lines = await new ManagedTextDiffTaskRunner().run({
        requestId: `blank-line-alignment-budget-${blankLineCount}`,
        before: `Paragraph old.\n${blankLines}`,
        after: `Paragraph new.\n${blankLines}`
      })

      expect(lines.filter((line) => line.kind === 'context')).toHaveLength(blankLineCount)
      expect(
        lines
          .filter((line) => line.kind === 'context')
          .every(
            (line) =>
              line.segments.length === 1 &&
              line.segments[0].kind === 'context' &&
              line.segments[0].text === '\n'
          )
      ).toBe(true)
      expect(
        lines
          .filter((line) => line.kind !== 'context')
          .map((line) => ({
            kind: line.kind,
            text: line.segments.map((segment) => segment.text).join(''),
            changed: line.segments
              .filter((segment) => segment.kind === line.kind)
              .map((segment) => segment.text)
              .join('')
          }))
      ).toEqual([
        { kind: 'removed', text: 'Paragraph old.\n', changed: 'old' },
        { kind: 'added', text: 'Paragraph new.\n', changed: 'new' }
      ])
    }
  )

  it('preserves a long unchanged whitespace line across a paragraph replacement', async () => {
    const whitespaceLine = `${' '.repeat(24_990)}\n`
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'whitespace-line-alignment-character-budget',
      before: `Paragraph old.\n${whitespaceLine}`,
      after: `Paragraph new.\n${whitespaceLine}`
    })

    expect(lines.filter((line) => line.kind === 'context')).toEqual([
      expect.objectContaining({
        segments: [{ kind: 'context', text: whitespaceLine }]
      })
    ])
    expect(
      lines
        .filter((line) => line.kind !== 'context')
        .map((line) => ({
          kind: line.kind,
          changed: line.segments
            .filter((segment) => segment.kind === line.kind)
            .map((segment) => segment.text)
            .join('')
        }))
    ).toEqual([
      { kind: 'removed', changed: 'old' },
      { kind: 'added', changed: 'new' }
    ])
  })

  it('keeps a removed line separate from the similar modified line that follows it', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'removed-line-before-modified-line',
      before: '## What Is This?\nWonderful\nOriginal paragraph old.\n',
      after: '## What Is This?? ?\nOriginal paragraph new.\n'
    })

    expect(
      lines.map((line) => ({
        kind: line.kind,
        text: line.segments.map((segment) => segment.text).join(''),
        changed: line.segments
          .filter((segment) => segment.kind === line.kind)
          .map((segment) => segment.text)
          .join('')
      }))
    ).toEqual([
      { kind: 'removed', text: '## What Is This?\n', changed: '' },
      { kind: 'added', text: '## What Is This?? ?\n', changed: '? ?' },
      { kind: 'removed', text: 'Wonderful\n', changed: 'Wonderful\n' },
      { kind: 'removed', text: 'Original paragraph old.\n', changed: 'old' },
      { kind: 'added', text: 'Original paragraph new.\n', changed: 'new' }
    ])
  })

  it('does not force unrelated residual lines into a character replacement', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'unrelated-residual-lines',
      before: 'abcdefghij old\n',
      after: 'Wonderful\nuvwxyz new\n'
    })

    expect(
      lines.map((line) => ({
        kind: line.kind,
        text: line.segments.map((segment) => segment.text).join(''),
        changed: line.segments
          .filter((segment) => segment.kind === line.kind)
          .map((segment) => segment.text)
          .join('')
      }))
    ).toEqual([
      { kind: 'removed', text: 'abcdefghij old\n', changed: 'abcdefghij old\n' },
      { kind: 'added', text: 'Wonderful\n', changed: 'Wonderful\n' },
      { kind: 'added', text: 'uvwxyz new\n', changed: 'uvwxyz new\n' }
    ])
  })

  it.each([
    {
      label: 'insertion',
      before: 'Heading old.\n',
      after: 'Heading new.\nWonderful\n',
      trailingKind: 'added',
      trailingText: 'Wonderful\n'
    },
    {
      label: 'removal',
      before: 'Heading old.\nWonderful\n',
      after: 'Heading new.\n',
      trailingKind: 'removed',
      trailingText: 'Wonderful\n'
    }
  ])('keeps a line-count $label after a modified line separate', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `line-after-modification-${fixture.label}`,
      before: fixture.before,
      after: fixture.after
    })

    expect(lines.slice(0, 2).map((line) => line.segments.map((segment) => segment.text))).toEqual([
      ['Heading ', 'old', '.\n'],
      ['Heading ', 'new', '.\n']
    ])
    expect(lines.at(-1)).toMatchObject({
      kind: fixture.trailingKind,
      segments: [{ kind: fixture.trailingKind, text: fixture.trailingText }]
    })
  })

  it('aligns repeated similar lines around a true insertion', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'repeated-lines-around-insertion',
      before: 'Repeat alpha.\nRepeat alpha.\n',
      after: 'Repeat beta.\nInserted\nRepeat beta.\n'
    })

    expect(
      lines.map((line) => ({
        kind: line.kind,
        text: line.segments.map((segment) => segment.text).join(''),
        changed: line.segments
          .filter((segment) => segment.kind === line.kind)
          .map((segment) => segment.text)
          .join('')
      }))
    ).toEqual([
      { kind: 'removed', text: 'Repeat alpha.\n', changed: 'lpha' },
      { kind: 'added', text: 'Repeat beta.\n', changed: 'bet' },
      { kind: 'added', text: 'Inserted\n', changed: 'Inserted\n' },
      { kind: 'removed', text: 'Repeat alpha.\n', changed: 'lpha' },
      { kind: 'added', text: 'Repeat beta.\n', changed: 'bet' }
    ])
  })

  it('treats an equal-count unrelated line swap as whole-line removal and addition', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'equal-count-unrelated-line-swap',
      before: '## Heading\nObsolete\nParagraph old.\n',
      after: '## Heading?\nWonderful\nParagraph new.\n'
    })

    expect(
      lines.slice(2, 4).map((line) => ({
        kind: line.kind,
        text: line.segments.map((segment) => segment.text).join(''),
        changed: line.segments
          .filter((segment) => segment.kind === line.kind)
          .map((segment) => segment.text)
          .join('')
      }))
    ).toEqual([
      { kind: 'removed', text: 'Obsolete\n', changed: 'Obsolete' },
      { kind: 'added', text: 'Wonderful\n', changed: 'Wonderful' }
    ])
  })

  it.each([
    { label: 'short Markdown heading', before: '# A\n', after: '# B\n', common: '# ' },
    { label: 'short Chinese text', before: '你好甲\n', after: '你好乙\n', common: '你好' },
    { label: 'short prefix extension', before: 'Name\n', after: 'Name extended\n', common: 'Name' }
  ])('keeps the shared characters in a $label', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `short-line-${fixture.label}`,
      before: fixture.before,
      after: fixture.after
    })

    expect(
      lines[0]?.segments
        .filter((segment) => segment.kind === 'context')
        .map((segment) => segment.text)
        .join('')
    ).toContain(fixture.common)
    expect(
      lines[1]?.segments
        .filter((segment) => segment.kind === 'context')
        .map((segment) => segment.text)
        .join('')
    ).toContain(fixture.common)
  })

  it.each([
    {
      label: 'split',
      before: 'Hello world\n',
      after: 'Hello \nworld\n',
      removed: '',
      added: '\n'
    },
    {
      label: 'merge',
      before: 'Hello \nworld\n',
      after: 'Hello world\n',
      removed: '\n',
      added: ''
    }
  ])('marks only the changed line ending for a line $label', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `line-${fixture.label}`,
      before: fixture.before,
      after: fixture.after
    })

    expect(
      lines
        .filter((line) => line.kind !== 'added')
        .flatMap((line) => line.segments)
        .map((segment) => segment.text)
        .join('')
    ).toBe(fixture.before)
    expect(
      lines
        .filter((line) => line.kind !== 'removed')
        .flatMap((line) => line.segments)
        .map((segment) => segment.text)
        .join('')
    ).toBe(fixture.after)
    expect(
      lines
        .flatMap((line) => line.segments)
        .filter((segment) => segment.kind === 'removed')
        .map((segment) => segment.text)
        .join('')
    ).toBe(fixture.removed)
    expect(
      lines
        .flatMap((line) => line.segments)
        .filter((segment) => segment.kind === 'added')
        .map((segment) => segment.text)
        .join('')
    ).toBe(fixture.added)
  })

  it('preserves context symmetrically across a one-to-many line split', async () => {
    const before = 'StartMiddleEnd'
    const after = 'Start\ninserted Middle\nEnd'
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'one-to-many-line-split-context',
      before,
      after
    })

    expect(
      lines
        .filter((line) => line.kind !== 'added')
        .flatMap((line) => line.segments)
        .map((segment) => segment.text)
        .join('')
    ).toBe(before)
    expect(
      lines
        .filter((line) => line.kind !== 'removed')
        .flatMap((line) => line.segments)
        .map((segment) => segment.text)
        .join('')
    ).toBe(after)
    expect(
      lines
        .filter((line) => line.kind === 'removed')
        .flatMap((line) => line.segments)
        .filter((segment) => segment.kind === 'context')
        .map((segment) => segment.text)
        .join('')
    ).toBe('StartMiddleEnd')
    expect(
      lines
        .filter((line) => line.kind === 'added')
        .flatMap((line) => line.segments)
        .filter((segment) => segment.kind === 'context')
        .map((segment) => segment.text)
        .join('')
    ).toBe('StartMiddleEnd')
  })

  it('preserves cross-line anchors carried by an otherwise matched line', async () => {
    const before = 'Line one\nStartMiddleEnd'
    const after = 'New first\nMiddle\nEnd'
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'matched-line-cross-line-anchor',
      before,
      after
    })
    const beforeContext = lines
      .filter((line) => line.kind !== 'added')
      .flatMap((line) => line.segments)
      .filter((segment) => segment.kind === 'context')
      .map((segment) => segment.text)
      .join('')
    const afterContext = lines
      .filter((line) => line.kind !== 'removed')
      .flatMap((line) => line.segments)
      .filter((segment) => segment.kind === 'context')
      .map((segment) => segment.text)
      .join('')

    expect(beforeContext).toBe('\nMiddleEnd')
    expect(afterContext).toBe('\nMiddleEnd')
  })

  it('propagates cross-line anchors through all connected natural-language lines', async () => {
    const before = 'Intro\nMiddleEnd'
    const after = 'Intro Middle\nInserted End\nDone'
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'transitive-cross-line-anchors',
      before,
      after
    })

    for (const [excludedKind, expected] of [
      ['added', before],
      ['removed', after]
    ] as const) {
      expect(
        lines
          .filter((line) => line.kind !== excludedKind)
          .flatMap((line) => line.segments)
          .map((segment) => segment.text)
          .join('')
      ).toBe(expected)
    }
    const beforeContext = lines
      .filter((line) => line.kind !== 'added')
      .flatMap((line) => line.segments)
      .filter((segment) => segment.kind === 'context')
      .map((segment) => segment.text)
      .join('')
    const afterContext = lines
      .filter((line) => line.kind !== 'removed')
      .flatMap((line) => line.segments)
      .filter((segment) => segment.kind === 'context')
      .map((segment) => segment.text)
      .join('')

    expect(beforeContext).toBe('IntroMiddleEnd')
    expect(afterContext).toBe('IntroMiddleEnd')
  })

  it('uses conservative alignment when a changed hunk exceeds the line budget', async () => {
    const before = 'a\n'.repeat(1_001)
    const after = 'b\n'.repeat(1_001)
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'line-alignment-line-budget',
      before,
      after
    })

    expect(lines).toHaveLength(2_002)
    expect(lines[0]).toMatchObject({
      kind: 'removed',
      segments: [{ kind: 'removed', text: 'a\n' }]
    })
    expect(lines[1_000]).toMatchObject({ kind: 'removed' })
    expect(lines[1_001]).toMatchObject({
      kind: 'added',
      segments: [{ kind: 'added', text: 'b\n' }]
    })
  })

  it('uses conservative alignment before a repeated hunk can exhaust worker memory', async () => {
    const before = 'Repeat alpha.\n'.repeat(500)
    const after = 'Repeat beta.\n'.repeat(500)
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'line-alignment-repeated-hunk-budget',
      before,
      after
    })

    expect(lines).toHaveLength(1_000)
    expect(lines[0]).toMatchObject({
      kind: 'removed',
      segments: [{ kind: 'removed', text: 'Repeat alpha.\n' }]
    })
    expect(lines[499]).toMatchObject({ kind: 'removed' })
    expect(lines[500]).toMatchObject({
      kind: 'added',
      segments: [{ kind: 'added', text: 'Repeat beta.\n' }]
    })
  })

  it('uses conservative alignment when a changed hunk exceeds the character budget', async () => {
    const before = 'a'.repeat(125_001)
    const after = 'b'.repeat(125_001)
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'line-alignment-character-budget',
      before,
      after
    })

    expect(lines).toEqual([
      {
        kind: 'removed',
        oldLineNumber: 1,
        segments: [{ kind: 'removed', text: before }]
      },
      {
        kind: 'added',
        newLineNumber: 1,
        segments: [{ kind: 'added', text: after }]
      }
    ])
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

  it('resolves the diff module through an absolute path the worker can require', async () => {
    const diffModulePath = resolveDiffModulePath()
    expect(diffModulePath).toBeDefined()
    expect(diffModulePath).toMatch(/^\/|^[A-Za-z]:[\\/]/)
    if (!diffModulePath) throw new Error('Expected resolveDiffModulePath() to return a path.')
    // The path must be requirable on its own, without help from the process CWD.
    const resolved = createRequire(diffModulePath)('diff') as typeof import('diff')
    expect(typeof resolved.diffLines).toBe('function')
    expect(typeof resolved.diffChars).toBe('function')
    expect(typeof resolved.diffArrays).toBe('function')
  })

  it('keeps diffing when the process runs from a CWD without node_modules', async () => {
    // Regression guard for packaged launches (Finder/Dock sets CWD=/): an eval worker's bare
    // require('diff') resolves from the CWD and used to fail there with CONTENT_INTEGRITY_FAILED.
    const previousCwd = process.cwd()
    try {
      process.chdir('/')
      const lines = await new ManagedTextDiffTaskRunner().run({
        requestId: 'diff-from-root-cwd',
        before: 'one\ntwo\n',
        after: 'one\ntwo changed\n'
      })
      expect(lines).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'removed', oldLineNumber: 2 })])
      )
    } finally {
      process.chdir(previousCwd)
    }
  })
})
