import { marked } from 'marked'
import { describe, expect, it, vi } from 'vitest'

import { ManagedTextDiffTaskRunner } from '../../../../main/managed-file-versions/diff-task'
import type { ManagedFileVersionDiffResult } from '../../../../shared/managed-file-versions'
import { toDiffPresentationBlocks, type DiffRenderBlock } from './managed-version-diff-presentation'

const diffMarkdown = async (
  before: string,
  after: string,
  requestId: string
): Promise<DiffRenderBlock[]> => {
  const lines = await new ManagedTextDiffTaskRunner().run({ requestId, before, after })
  return toDiffPresentationBlocks(
    { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
    'markdown'
  )
}

const escapedMarkdownChange = (kind: 'added' | 'removed', content: string): string => {
  const escaped = content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const tag = `managed-diff-${kind}`
  return `<${tag}>${escaped}</${tag}>`
}

const markdownChangeMarker = (kind: 'added' | 'removed'): string =>
  `<managed-diff-${kind}></managed-diff-${kind}>`

describe('managed version diff presentation', () => {
  it('keeps unchanged and inline-changed prose in renderable Markdown blocks', async () => {
    const blocks = await diffMarkdown(
      '# Stable heading\n\nSub title two\n',
      '# Stable heading\n\nSub title three\n',
      'rendered-prose'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `# Stable heading\n\nSub title t${escapedMarkdownChange('removed', 'wo')}${escapedMarkdownChange('added', 'hree')}`,
        startIndex: 0
      }
    ])
  })

  it('keeps an ATX heading rendered while marking its changed text inline', async () => {
    const blocks = await diffMarkdown(
      '# Old title\nStable paragraph\n',
      '# New title\nStable paragraph\n',
      'rendered-atx-heading'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `# ${escapedMarkdownChange('removed', 'Old')}${escapedMarkdownChange('added', 'New')} title\nStable paragraph`,
        startIndex: 0
      }
    ])
  })

  it('keeps a Setext heading rendered while marking its changed text inline', async () => {
    const blocks = await diffMarkdown(
      'Old title\n===\nStable paragraph\n',
      'New title\n===\nStable paragraph\n',
      'rendered-setext-heading'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `${escapedMarkdownChange('removed', 'Old')}${escapedMarkdownChange('added', 'New')} title\n===\nStable paragraph`,
        startIndex: 0
      }
    ])
  })

  it('renders both complete Setext headings when the marker changes', async () => {
    const blocks = await diffMarkdown(
      'Stable title\n===\n',
      'Stable title\n---\n',
      'setext-marker-change'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'removed',
        content: 'Stable title\n===',
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'added',
        content: 'Stable title\n---',
        startIndex: 0
      }
    ])
  })

  it('keeps entity replacements as complete rendered Markdown blocks', async () => {
    const blocks = await diffMarkdown('Copyright &copy;\n', 'Copyright &reg;\n', 'entity-change')

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'removed',
        content: 'Copyright &copy;',
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'added',
        content: 'Copyright &reg;',
        startIndex: 1
      }
    ])
  })

  it('shows changed reference definitions as raw single-column rows', async () => {
    const blocks = await diffMarkdown(
      '[guide]: https://old.example\n',
      '[guide]: https://new.example\n',
      'reference-definition-change'
    )

    expect(blocks).toEqual([
      {
        kind: 'text',
        changeKind: 'removed',
        segments: [{ kind: 'removed', text: '[guide]: https://old.example' }],
        startIndex: 0
      },
      {
        kind: 'text',
        changeKind: 'added',
        segments: [{ kind: 'added', text: '[guide]: https://new.example' }],
        startIndex: 1
      }
    ])
  })

  it('keeps reference-style links intact by falling back to complete Markdown blocks', async () => {
    const blocks = await diffMarkdown(
      'See [guide][old]\n',
      'See [guide][new]\n',
      'reference-link-change'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'removed',
        content: 'See [guide][old]',
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'added',
        content: 'See [guide][new]',
        startIndex: 1
      }
    ])
  })

  it('marks only the changed list item text inside one rendered list', async () => {
    const blocks = await diffMarkdown(
      '- old one\n- stable item\n',
      '- new one\n- stable item\n',
      'list-item-change'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `- ${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')} one\n- stable item`,
        startIndex: 0
      }
    ])
  })

  it('marks only the changed table row cell inside one rendered table', async () => {
    const blocks = await diffMarkdown(
      '| Name | Value |\n| --- | --- |\n| A | old |\n',
      '| Name | Value |\n| --- | --- |\n| A | new |\n',
      'table-row-change'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `| Name | Value |\n| --- | --- |\n| A | ${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')} |`,
        startIndex: 0
      }
    ])
  })

  it.each([
    {
      label: 'added',
      before: '- stable one\n- stable two\n',
      after: '- stable one\n- inserted item\n- stable two\n',
      expected: `- stable one\n- ${escapedMarkdownChange('added', 'inserted item')}\n- stable two`
    },
    {
      label: 'removed',
      before: '- stable one\n- removed item\n- stable two\n',
      after: '- stable one\n- stable two\n',
      expected: `- stable one\n- ${escapedMarkdownChange('removed', 'removed item')}\n- stable two`
    }
  ])('marks only a standalone $label list item', async ({ before, after, expected }) => {
    expect(
      await diffMarkdown(before, after, `standalone-list-${before.length}-${after.length}`)
    ).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: expected,
        startIndex: 0
      }
    ])
  })

  it.each([
    {
      label: 'added',
      before: '| Name | Value |\n| --- | --- |\n| A | stable |\n',
      after: '| Name | Value |\n| --- | --- |\n| B | inserted |\n| A | stable |\n',
      row: `| ${escapedMarkdownChange('added', 'B')} | ${escapedMarkdownChange('added', 'inserted')} |`
    },
    {
      label: 'removed',
      before: '| Name | Value |\n| --- | --- |\n| B | removed |\n| A | stable |\n',
      after: '| Name | Value |\n| --- | --- |\n| A | stable |\n',
      row: `| ${escapedMarkdownChange('removed', 'B')} | ${escapedMarkdownChange('removed', 'removed')} |`
    }
  ])('marks only a standalone $label table row', async ({ before, after, row }) => {
    expect(
      await diffMarkdown(before, after, `standalone-table-${before.length}-${after.length}`)
    ).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `| Name | Value |\n| --- | --- |\n${row}\n| A | stable |`,
        startIndex: 0
      }
    ])
  })

  it('keeps inline Markdown rendered inside a standalone added list item', async () => {
    const blocks = await diffMarkdown(
      '- stable item\n',
      '- stable item\n- **important** [guide](https://example.com)\n',
      'standalone-complex-list-item'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `- stable item\n- ${markdownChangeMarker('added')}**important** [guide](https://example.com)`,
        startIndex: 0
      }
    ])
  })

  it('keeps a standalone nested list item at item granularity', async () => {
    const blocks = await diffMarkdown(
      '- parent\n    - stable nested\n',
      '- parent\n    - **new nested**\n    - stable nested\n',
      'standalone-nested-list-item'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `- parent\n    - ${markdownChangeMarker('added')}**new nested**\n    - stable nested`,
        startIndex: 0
      }
    ])
  })

  it('keeps inline Markdown rendered inside a standalone removed table row', async () => {
    const blocks = await diffMarkdown(
      '| Name | Value |\n| --- | --- |\n| A | stable |\n| B | [old](https://example.com) |\n',
      '| Name | Value |\n| --- | --- |\n| A | stable |\n',
      'standalone-complex-table-row'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `| Name | Value |\n| --- | --- |\n| A | stable |\n| ${escapedMarkdownChange('removed', 'B')} | ${markdownChangeMarker('removed')}[old](https://example.com) |`,
        startIndex: 0
      }
    ])
  })

  it.each([
    { label: 'emphasis', before: 'This is plain\n', after: 'This is *plain*\n' },
    { label: 'math', before: 'Value is plain\n', after: 'Value is $plain$\n' }
  ])(
    'falls back to complete Markdown blocks across $label boundaries',
    async ({ before, after }) => {
      const blocks = await diffMarkdown(before, after, `markdown-${before.length}-${after.length}`)

      expect(blocks).toEqual([
        {
          kind: 'markdown',
          changeKind: 'removed',
          content: before.trimEnd(),
          startIndex: 0
        },
        {
          kind: 'markdown',
          changeKind: 'added',
          content: after.trimEnd(),
          startIndex: 1
        }
      ])
    }
  )

  it('keeps consecutive added prose lines in one Markdown block', async () => {
    const blocks = await diffMarkdown(
      '',
      'First soft line\nsecond soft line\nthird soft line\n',
      'consecutive-added-prose'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'added',
        content: 'First soft line\nsecond soft line\nthird soft line',
        startIndex: 0
      }
    ])
  })

  it('renders complete paragraphs when a replacement crosses inline Markdown syntax', async () => {
    const blocks = await diffMarkdown(
      'Opening line\nThis is plain\nclosing line\n',
      'Opening line\nThis is *plain*\nclosing line\n',
      'multiline-emphasis-boundary'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'removed',
        content: 'Opening line\nThis is plain\nclosing line',
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'added',
        content: 'Opening line\nThis is *plain*\nclosing line',
        startIndex: 0
      }
    ])
  })

  it('does not absorb adjacent paragraphs into a changed ATX heading', async () => {
    const blocks = await diffMarkdown(
      'Intro paragraph\n# Old heading\nOutro paragraph\n',
      'Intro paragraph\n## New heading\nOutro paragraph\n',
      'atx-prefix-boundary'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'context',
        content: 'Intro paragraph',
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'removed',
        content: '# Old heading',
        startIndex: 1
      },
      {
        kind: 'markdown',
        changeKind: 'added',
        content: '## New heading',
        startIndex: 1
      },
      {
        kind: 'markdown',
        changeKind: 'context',
        content: 'Outro paragraph',
        startIndex: 3
      }
    ])
  })

  it('renders complete ATX headings when a closing marker changes', async () => {
    const blocks = await diffMarkdown(
      '# Stable heading #\n',
      '# Stable heading ##\n',
      'atx-closing-marker-change'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'removed',
        content: '# Stable heading #',
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'added',
        content: '# Stable heading ##',
        startIndex: 0
      }
    ])
  })

  it('keeps a plain inserted paragraph line in the surrounding rendered block', async () => {
    const blocks = await diffMarkdown(
      'Opening line\nclosing line\n',
      'Opening line\ninserted line\nclosing line\n',
      'inserted-paragraph-line'
    )

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `Opening line\n${escapedMarkdownChange('added', 'inserted line')}\nclosing line`,
        startIndex: 0
      }
    ])
  })

  it('keeps an inserted blank line as a visible single-column row', async () => {
    const blocks = await diffMarkdown(
      'Opening line\nclosing line\n',
      'Opening line\n\nclosing line\n',
      'inserted-blank-line'
    )

    expect(blocks).toContainEqual({
      kind: 'text',
      changeKind: 'added',
      segments: [{ kind: 'added', text: '' }],
      startIndex: 1
    })
  })

  it('shows a trailing-newline-only change as complete old and new rows', async () => {
    const blocks = await diffMarkdown('line', 'line\n', 'trailing-newline-change')

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'removed',
        content: 'line',
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'added',
        content: 'line',
        startIndex: 1
      }
    ])
  })

  it.each([
    { label: 'total source budget', content: '**x**'.repeat(14_000) },
    { label: 'single-line budget', content: `**${'x'.repeat(2_100)}**` }
  ])('falls back before lexing Markdown over the $label', ({ content }) => {
    const lexer = vi.spyOn(marked, 'lexer')
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [{ kind: 'added', text: content }]
        }
      ]
    }

    const blocks = toDiffPresentationBlocks(result, 'markdown')

    expect(lexer).not.toHaveBeenCalled()
    expect(blocks).toEqual([
      {
        kind: 'text',
        changeKind: 'added',
        segments: [{ kind: 'added', text: content }],
        startIndex: 0
      }
    ])
    lexer.mockRestore()
  })

  it('falls back to raw single-column diff for any oversized Markdown source', () => {
    const content = '[ '.repeat(20_000)
    const lexer = vi.spyOn(marked, 'lexer')
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [{ kind: 'added', text: content }]
        }
      ]
    }

    const blocks = toDiffPresentationBlocks(result, 'markdown')

    expect(lexer).not.toHaveBeenCalled()
    expect(blocks).toEqual([
      {
        kind: 'text',
        changeKind: 'added',
        segments: [{ kind: 'added', text: content }],
        startIndex: 0
      }
    ])
    lexer.mockRestore()
  })

  it('falls back to raw single-column diff before lexing oversized semantic Markdown', () => {
    const content = `${'[ '.repeat(20_000)}|`
    const lexer = vi.spyOn(marked, 'lexer')
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [{ kind: 'added', text: content }]
        }
      ]
    }

    const blocks = toDiffPresentationBlocks(result, 'markdown')

    expect(lexer).not.toHaveBeenCalled()
    expect(blocks).toEqual([
      {
        kind: 'text',
        changeKind: 'added',
        segments: [{ kind: 'added', text: content }],
        startIndex: 0
      }
    ])
    lexer.mockRestore()
  })

  it('keeps a long valid list rendered when its individual lines stay within budget', async () => {
    const content = Array.from({ length: 500 }, (_, index) => `- valid list item ${index}`).join(
      '\n'
    )

    const blocks = await diffMarkdown('', content, 'long-valid-list')

    expect(blocks).toEqual([
      {
        kind: 'markdown',
        changeKind: 'added',
        content,
        startIndex: 0
      }
    ])
  })

  it('falls back to raw single-column diff when the Markdown lexer throws', () => {
    const lexer = vi.spyOn(marked, 'lexer').mockImplementation(() => {
      throw new Error('synthetic lexer failure')
    })
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'removed',
          oldLineNumber: 1,
          segments: [{ kind: 'removed', text: '- old item' }]
        },
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [{ kind: 'added', text: '- new item' }]
        }
      ]
    }

    const blocks = toDiffPresentationBlocks(result, 'markdown')

    expect(blocks).toEqual([
      {
        kind: 'text',
        changeKind: 'removed',
        segments: [{ kind: 'removed', text: '- old item' }],
        startIndex: 0
      },
      {
        kind: 'text',
        changeKind: 'added',
        segments: [{ kind: 'added', text: '- new item' }],
        startIndex: 1
      }
    ])
    lexer.mockRestore()
  })

  it('merges prose replacements into one whitespace-preserving segment sequence', () => {
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'removed',
          oldLineNumber: 991,
          segments: [
            { kind: 'context', text: 'Hello ' },
            { kind: 'removed', text: 'old' },
            { kind: 'context', text: '  world' }
          ]
        },
        {
          kind: 'added',
          newLineNumber: 992,
          segments: [
            { kind: 'context', text: 'Hello ' },
            { kind: 'added', text: 'new' },
            { kind: 'context', text: '  world' }
          ]
        }
      ]
    }

    const blocks = toDiffPresentationBlocks(result, 'prose')

    expect(blocks).toEqual([
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: 'Hello ' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '  world' }
        ],
        startIndex: 0
      }
    ])
    expect(JSON.stringify(blocks)).not.toMatch(/oldLineNumber|newLineNumber|991|992/u)
  })

  it('presents structured replacements as one line with character-level changes', () => {
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'removed',
          oldLineNumber: 1,
          segments: [
            { kind: 'context', text: 'const value = "' },
            { kind: 'removed', text: 'old' },
            { kind: 'context', text: '"' }
          ]
        },
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [
            { kind: 'context', text: 'const value = "' },
            { kind: 'added', text: 'new' },
            { kind: 'context', text: '"' }
          ]
        }
      ]
    }

    expect(toDiffPresentationBlocks(result, 'structured')).toEqual([
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: 'const value = "' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '"' }
        ],
        startIndex: 0
      }
    ])
  })

  it.each([
    { kind: 'added' as const, lineNumber: { newLineNumber: 1 } },
    { kind: 'removed' as const, lineNumber: { oldLineNumber: 1 } }
  ])('keeps a standalone structured $kind line as a whole-line change', ({ kind, lineNumber }) => {
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind,
          ...lineNumber,
          segments: [{ kind, text: 'standalone change' }]
        }
      ]
    }

    expect(toDiffPresentationBlocks(result, 'structured')).toEqual([
      {
        kind: 'text',
        changeKind: kind,
        segments: [{ kind, text: 'standalone change' }],
        startIndex: 0
      }
    ])
  })

  it('escapes changed text before placing it inside semantic Markdown tags', () => {
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'removed',
          oldLineNumber: 1,
          segments: [
            { kind: 'context', text: 'Owner: ' },
            { kind: 'removed', text: 'R&D "old"' }
          ]
        },
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [
            { kind: 'context', text: 'Owner: ' },
            { kind: 'added', text: 'A&B "new"' }
          ]
        }
      ]
    }

    expect(toDiffPresentationBlocks(result, 'markdown')).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `Owner: ${escapedMarkdownChange('removed', 'R&D "old"')}${escapedMarkdownChange('added', 'A&B "new"')}`,
        startIndex: 0
      }
    ])
  })

  it('returns no presentation blocks for an empty diff', () => {
    expect(
      toDiffPresentationBlocks(
        { baseVersionId: 'v1', selectedVersionId: 'v2', lines: [] },
        'markdown'
      )
    ).toEqual([])
  })
})
