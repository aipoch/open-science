import { marked } from 'marked'
import { describe, expect, it, vi } from 'vitest'

import { ManagedTextDiffTaskRunner } from '../../../../main/managed-file-versions/diff-task'
import type { ManagedFileVersionDiffResult } from '../../../../shared/managed-file-versions'
import {
  toDiffPresentationBlocks,
  type DiffRenderBlock,
  type MarkdownChangeTags
} from './managed-version-diff-presentation'

const diffMarkdown = async (
  before: string,
  after: string,
  requestId: string,
  tags?: MarkdownChangeTags
): Promise<DiffRenderBlock[]> => {
  const lines = await new ManagedTextDiffTaskRunner().run({ requestId, before, after })
  return toDiffPresentationBlocks(
    { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
    'markdown',
    tags
  )
}

const escapedMarkdownChange = (kind: 'added' | 'removed', content: string): string => {
  const escaped = content.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const tag = `managed-diff-${kind}`
  return `<${tag}>${escaped}</${tag}>`
}

const markdownChangeMarker = (kind: 'added' | 'removed'): string =>
  `<managed-diff-${kind}></managed-diff-${kind}>`

const expectPresentation = (actual: DiffRenderBlock[], expected: object[]): void => {
  const expectedWithFallback = expected.map((block) => {
    if (
      'kind' in block &&
      'changeKind' in block &&
      block.kind === 'markdown' &&
      block.changeKind === 'mixed' &&
      !('fallbackSegments' in block)
    ) {
      return { ...block, fallbackSegments: expect.any(Array) }
    }
    return block
  })
  expect(actual).toEqual(expectedWithFallback)
}

const expectSourceReconstruction = (
  segments: ManagedFileVersionDiffResult['lines'][number]['segments'],
  before: string,
  after: string
): void => {
  expect(
    segments
      .filter((segment) => segment.kind !== 'added')
      .map((segment) => segment.text)
      .join('')
  ).toBe(before)
  expect(
    segments
      .filter((segment) => segment.kind !== 'removed')
      .map((segment) => segment.text)
      .join('')
  ).toBe(after)
}

describe('managed version diff presentation', () => {
  it('keeps unchanged and inline-changed prose in renderable Markdown blocks', async () => {
    const blocks = await diffMarkdown(
      '# Stable heading\n\nSub title two\n',
      '# Stable heading\n\nSub title three\n',
      'rendered-prose'
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `# Stable heading\n\nSub title t${escapedMarkdownChange('removed', 'wo')}${escapedMarkdownChange('added', 'hree')}`,
        startIndex: 0
      }
    ])
  })

  it('carries exact source segments with every rich Markdown replacement', async () => {
    const blocks = await diffMarkdown(
      '# Stable heading\n\nSub title two\n',
      '# Stable heading\n\nSub title three\n',
      'rendered-prose-fallback-segments'
    )

    expectPresentation(blocks, [
      expect.objectContaining({
        kind: 'markdown',
        changeKind: 'mixed',
        fallbackSegments: [
          { kind: 'context', text: '# Stable heading\n\nSub title t' },
          { kind: 'removed', text: 'wo' },
          { kind: 'added', text: 'hree' },
          { kind: 'context', text: '\n' }
        ]
      })
    ])
  })

  it('keeps an ATX heading rendered while marking its changed text inline', async () => {
    const blocks = await diffMarkdown(
      '# Old title\nStable paragraph\n',
      '# New title\nStable paragraph\n',
      'rendered-atx-heading'
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `# ${escapedMarkdownChange('removed', 'Old')}${escapedMarkdownChange('added', 'New')} title\nStable paragraph`,
        startIndex: 0
      }
    ])
  })

  it('keeps a stable HTML heading wrapper rendered while marking only changed text', async () => {
    const blocks = await diffMarkdown(
      '<h1 align="center">Claude Local Session Sync</h1>\n',
      '<h1 align="center">Claude Local Session Sync C</h1>\n',
      'rendered-html-heading-text-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `<h1 align="center">Claude Local Session Sync${escapedMarkdownChange('added', ' C')}</h1>`,
        startIndex: 0
      }
    ])
  })

  it('keeps stable nested HTML rendered with the caller-provided change tags', async () => {
    const tags = {
      added: 'managed-diff-added-r4nd0m',
      removed: 'managed-diff-removed-r4nd0m'
    }
    const blocks = await diffMarkdown(
      '<div class="summary"><strong>Old value</strong></div>\n',
      '<div class="summary"><strong>New value</strong></div>\n',
      'rendered-nested-html-text-change',
      tags
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `<div class="summary"><strong><${tags.removed}>Old</${tags.removed}><${tags.added}>New</${tags.added}> value</strong></div>`,
        startIndex: 0
      }
    ])
  })

  it('falls back when user content collides with a caller-provided change tag', async () => {
    const tags = {
      added: 'managed-diff-added-r4nd0m',
      removed: 'managed-diff-removed-r4nd0m'
    }
    const blocks = await diffMarkdown(
      `<${tags.added}>user content</${tags.added}> old\n`,
      `<${tags.added}>user content</${tags.added}> new\n`,
      'internal-tag-collision',
      tags
    )

    expectPresentation(blocks, [expect.objectContaining({ kind: 'text', changeKind: 'mixed' })])
    expect(
      blocks.some((block) => block.kind === 'markdown' && block.content.includes(tags.added))
    ).toBe(false)
  })

  it('keeps a stable multiline HTML wrapper rendered while marking only changed text', async () => {
    const blocks = await diffMarkdown(
      '<h1 align="center">\nOld value\n</h1>\n',
      '<h1 align="center">\nNew value\n</h1>\n',
      'rendered-multiline-html-text-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `<h1 align="center">\n${escapedMarkdownChange('removed', 'Old')}${escapedMarkdownChange('added', 'New')} value\n</h1>`,
        startIndex: 0
      }
    ])
  })

  it.each([
    { replacementCount: 128, expectedKind: 'markdown' as const },
    { replacementCount: 129, expectedKind: 'text' as const }
  ])(
    'uses $expectedKind at the rendered marker budget boundary for $replacementCount replacements',
    ({ replacementCount, expectedKind }) => {
      const changedSegments = Array.from({ length: replacementCount }, (_, index) => [
        { kind: 'removed' as const, text: 'a' },
        { kind: 'added' as const, text: 'b' },
        { kind: 'context' as const, text: index === replacementCount - 1 ? '</p>\n' : ' ' }
      ]).flat()
      const result: ManagedFileVersionDiffResult = {
        baseVersionId: 'v1',
        selectedVersionId: 'v2',
        lines: [
          {
            kind: 'removed',
            segments: [
              { kind: 'context', text: '<p>' },
              ...changedSegments.filter((segment) => segment.kind !== 'added')
            ]
          },
          {
            kind: 'added',
            segments: [
              { kind: 'context', text: '<p>' },
              ...changedSegments.filter((segment) => segment.kind !== 'removed')
            ]
          }
        ]
      }

      const blocks = toDiffPresentationBlocks(result, 'markdown')

      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toMatchObject({ kind: expectedKind, changeKind: 'mixed' })
      if (expectedKind === 'text') expect(blocks[0]).not.toHaveProperty('content')
    }
  )

  it.each([
    {
      label: 'removed',
      before: '<h1>Old</h1>\n',
      after: '<h1></h1>\n',
      content: `<h1>${escapedMarkdownChange('removed', 'Old')}</h1>`
    },
    {
      label: 'added',
      before: '<h1></h1>\n',
      after: '<h1>New</h1>\n',
      content: `<h1>${escapedMarkdownChange('added', 'New')}</h1>`
    }
  ])('keeps a stable HTML wrapper rendered when its text is fully $label', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `rendered-empty-html-text-${fixture.label}`
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: fixture.content,
        startIndex: 0
      }
    ])
  })

  it('keeps an HTML attribute change in a character-level raw block', async () => {
    const blocks = await diffMarkdown(
      '<h1 align="center">Claude Local Session Sync</h1>\n',
      '<h1 align="left">Claude Local Session Sync</h1>\n',
      'raw-html-attribute-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '<h1 align="' },
          { kind: 'removed', text: 'c' },
          { kind: 'added', text: 'l' },
          { kind: 'context', text: 'e' },
          { kind: 'removed', text: 'n' },
          { kind: 'added', text: 'f' },
          { kind: 'context', text: 't' },
          { kind: 'removed', text: 'er' },
          { kind: 'context', text: '">Claude Local Session Sync</h1>' }
        ],
        startIndex: 0
      }
    ])
  })

  it('keeps an HTML tag change in a character-level raw block', async () => {
    const blocks = await diffMarkdown(
      '<h1 align="center">Claude Local Session Sync</h1>\n',
      '<h2 align="center">Claude Local Session Sync</h2>\n',
      'raw-html-tag-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '<h' },
          { kind: 'removed', text: '1' },
          { kind: 'added', text: '2' },
          { kind: 'context', text: ' align="center">Claude Local Session Sync</h' },
          { kind: 'removed', text: '1' },
          { kind: 'added', text: '2' },
          { kind: 'context', text: '>' }
        ],
        startIndex: 0
      }
    ])
  })

  it('keeps an HTML structure change in a character-level raw block', async () => {
    const blocks = await diffMarkdown(
      '<h1 align="center">Claude Local Session Sync</h1>\n',
      '<h1 align="center"><em>Claude Local Session Sync</em></h1>\n',
      'raw-html-structure-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '<h1 align="center">' },
          { kind: 'added', text: '<em>' },
          { kind: 'context', text: 'Claude Local Session Sync</' },
          { kind: 'added', text: 'em></' },
          { kind: 'context', text: 'h1>' }
        ],
        startIndex: 0
      }
    ])
  })

  it('keeps unchanged HTML entities rendered while marking nearby plain text', async () => {
    const blocks = await diffMarkdown(
      '<h1>A &amp; old</h1>\n',
      '<h1>A &amp; new</h1>\n',
      'rendered-html-near-entity-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `<h1>A &amp; ${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')}</h1>`,
        startIndex: 0
      }
    ])
  })

  it('keeps a changed HTML entity in a character-level raw block', async () => {
    const blocks = await diffMarkdown(
      '<h1>A &amp; B</h1>\n',
      '<h1>A &copy; B</h1>\n',
      'raw-html-entity-source-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '<h1>A &' },
          { kind: 'removed', text: 'am' },
          { kind: 'added', text: 'co' },
          { kind: 'context', text: 'p' },
          { kind: 'added', text: 'y' },
          { kind: 'context', text: '; B</h1>' }
        ],
        startIndex: 0
      }
    ])
  })

  it('keeps raw-text HTML elements in a character-level raw block', async () => {
    const blocks = await diffMarkdown(
      '<script>const value = "old"</script>\n',
      '<script>const value = "new"</script>\n',
      'raw-html-raw-text-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '<script>const value = "' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '"</script>' }
        ],
        startIndex: 0
      }
    ])
  })

  it.each([
    'script',
    'style',
    'textarea',
    'title',
    'xmp',
    'iframe',
    'noembed',
    'noframes',
    'plaintext',
    'template'
  ])('never injects rendered diff markers into the <%s> raw-text family', async (tagName) => {
    const blocks = await diffMarkdown(
      `<${tagName}>old</${tagName}>\n`,
      `<${tagName}>new</${tagName}>\n`,
      `raw-html-${tagName}-change`
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'text', changeKind: 'mixed' })
  })

  it('keeps multiline raw-text HTML in a character-level raw block', async () => {
    const blocks = await diffMarkdown(
      '<script>\nconst value = "old"\n</script>\n',
      '<script>\nconst value = "new"\n</script>\n',
      'raw-html-multiline-script-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '<script>\nconst value = "' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '"\n</script>' }
        ],
        startIndex: 0
      }
    ])
  })

  it('keeps one changed segment spanning HTML text nodes in a character-level raw block', () => {
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'removed',
          oldLineNumber: 1,
          segments: [
            { kind: 'context', text: '<p>a' },
            { kind: 'removed', text: 'b<em>c' },
            { kind: 'context', text: 'd</em></p>' }
          ]
        },
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [
            { kind: 'context', text: '<p>a' },
            { kind: 'added', text: 'X<em>Y' },
            { kind: 'context', text: 'd</em></p>' }
          ]
        }
      ]
    }

    const blocks = toDiffPresentationBlocks(result, 'markdown')

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '<p>a' },
          { kind: 'removed', text: 'b<em>c' },
          { kind: 'added', text: 'X<em>Y' },
          { kind: 'context', text: 'd</em></p>' }
        ],
        startIndex: 0
      }
    ])
  })

  it('keeps foreign-namespace HTML in a character-level raw block', async () => {
    const blocks = await diffMarkdown(
      '<svg><text>old</text></svg>\n',
      '<svg><text>new</text></svg>\n',
      'raw-html-foreign-namespace-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '<svg><text>' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '</text></svg>' }
        ],
        startIndex: 0
      }
    ])
  })

  it.each([
    {
      label: 'strong emphasis',
      before: 'This is **old**\n',
      after: 'This is **new**\n',
      content: `This is **${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')}**`
    },
    {
      label: 'strikethrough',
      before: 'This is ~~old~~\n',
      after: 'This is ~~new~~\n',
      content: `This is ~~${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')}~~`
    },
    {
      label: 'link label',
      before: 'See [old](https://same.example)\n',
      after: 'See [new](https://same.example)\n',
      content: `See [${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')}](https://same.example)`
    },
    {
      label: 'inline HTML in prose',
      before: 'Before <span>old</span>\n',
      after: 'Before <span>new</span>\n',
      content: `Before <span>${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')}</span>`
    },
    {
      label: 'standalone inline HTML',
      before: '<span>old</span>\n',
      after: '<span>new</span>\n',
      content: `<span>${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')}</span>`
    }
  ])('keeps stable $label rendered while marking only changed text', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `rendered-stable-${fixture.label.replaceAll(' ', '-')}`
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: fixture.content,
        startIndex: 0
      }
    ])
  })

  it('falls back when the HTML parser would discard inline diff markers', async () => {
    const blocks = await diffMarkdown(
      'Before <select><option>old</option></select>\n',
      'Before <select><option>new</option></select>\n',
      'raw-inline-html-special-content-model'
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'text', changeKind: 'mixed' })
    expect(blocks[0]).not.toHaveProperty('content')
  })

  it.each([
    {
      label: 'link destination',
      before: 'See [guide](https://old.example)\n',
      after: 'See [guide](https://new.example)\n'
    },
    { label: 'inline code', before: 'Run `old` now\n', after: 'Run `new` now\n' },
    { label: 'inline math', before: 'Value is $old$\n', after: 'Value is $new$\n' }
  ])('keeps a changed $label in a character-level raw block', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `raw-stable-markdown-${fixture.label.replaceAll(' ', '-')}`
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'text', changeKind: 'mixed' })
  })

  it('keeps a Setext heading rendered while marking its changed text inline', async () => {
    const blocks = await diffMarkdown(
      'Old title\n===\nStable paragraph\n',
      'New title\n===\nStable paragraph\n',
      'rendered-setext-heading'
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `${escapedMarkdownChange('removed', 'Old')}${escapedMarkdownChange('added', 'New')} title\n===\nStable paragraph`,
        startIndex: 0
      }
    ])
  })

  it('falls back a changed Setext marker to one character-level raw block', async () => {
    const blocks = await diffMarkdown(
      'Stable title\n===\n',
      'Stable title\n---\n',
      'setext-marker-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: 'Stable title\n' },
          { kind: 'removed', text: '===' },
          { kind: 'added', text: '---' }
        ],
        startIndex: 0
      }
    ])
  })

  it('falls back an entity replacement to its changed source characters', async () => {
    const blocks = await diffMarkdown('Copyright &copy;\n', 'Copyright &reg;\n', 'entity-change')

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: 'Copyright &' },
          { kind: 'removed', text: 'copy' },
          { kind: 'added', text: 'reg' },
          { kind: 'context', text: ';' }
        ],
        startIndex: 0
      }
    ])
  })

  it('shows a changed reference definition as one character-level raw block', async () => {
    const blocks = await diffMarkdown(
      '[guide]: https://old.example\n',
      '[guide]: https://new.example\n',
      'reference-definition-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '[guide]: https://' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '.example' }
        ],
        startIndex: 0
      }
    ])
  })

  it('falls back a reference-style link to its changed source characters', async () => {
    const blocks = await diffMarkdown(
      'See [guide][old]\n',
      'See [guide][new]\n',
      'reference-link-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: 'See [guide][' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: ']' }
        ],
        startIndex: 0
      }
    ])
  })

  it('marks only the changed list item text inside one rendered list', async () => {
    const blocks = await diffMarkdown(
      '- old one\n- stable item\n',
      '- new one\n- stable item\n',
      'list-item-change'
    )

    expectPresentation(blocks, [
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

    expectPresentation(blocks, [
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
    expectPresentation(
      await diffMarkdown(before, after, `standalone-list-${before.length}-${after.length}`),
      [
        {
          kind: 'markdown',
          changeKind: 'mixed',
          content: expected,
          startIndex: 0
        }
      ]
    )
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
    expectPresentation(
      await diffMarkdown(before, after, `standalone-table-${before.length}-${after.length}`),
      [
        {
          kind: 'markdown',
          changeKind: 'mixed',
          content: `| Name | Value |\n| --- | --- |\n${row}\n| A | stable |`,
          startIndex: 0
        }
      ]
    )
  })

  it('keeps inline Markdown rendered inside a standalone added list item', async () => {
    const blocks = await diffMarkdown(
      '- stable item\n',
      '- stable item\n- **important** [guide](https://example.com)\n',
      'standalone-complex-list-item'
    )

    expectPresentation(blocks, [
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

    expectPresentation(blocks, [
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

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `| Name | Value |\n| --- | --- |\n| A | stable |\n| ${escapedMarkdownChange('removed', 'B')} | ${markdownChangeMarker('removed')}[old](https://example.com) |`,
        startIndex: 0
      }
    ])
  })

  it.each([
    { label: 'LF list', eol: '\n', kind: 'list' as const },
    { label: 'CRLF list', eol: '\r\n', kind: 'list' as const },
    { label: 'LF table', eol: '\n', kind: 'table' as const },
    { label: 'CRLF table', eol: '\r\n', kind: 'table' as const }
  ])('preserves both exact source sides for a complex $label replacement', async (fixture) => {
    const before =
      fixture.kind === 'list'
        ? `- **old** [guide](https://old.example)${fixture.eol}`
        : `| Name | Value |${fixture.eol}| --- | --- |${fixture.eol}| A | **old** [guide](https://old.example) |${fixture.eol}`
    const after =
      fixture.kind === 'list'
        ? `- **new** [guide](https://new.example)${fixture.eol}`
        : `| Name | Value |${fixture.eol}| --- | --- |${fixture.eol}| A | **new** [guide](https://new.example) |${fixture.eol}`
    const blocks = await diffMarkdown(before, after, `complex-${fixture.label}-replacement`)
    const block = blocks.find(
      (
        candidate
      ): candidate is Extract<DiffRenderBlock, { kind: 'markdown'; changeKind: 'mixed' }> =>
        candidate.kind === 'markdown' && candidate.changeKind === 'mixed'
    )

    expect(block).toBeDefined()
    expectSourceReconstruction(block?.fallbackSegments ?? [], before, after)
  })

  it.each([
    {
      label: 'interleaved list replacement',
      before: '- old one\n- old two\n',
      after: '- new one\n- new two\n',
      content: `- ${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')} one\n- ${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')} two`
    },
    {
      label: 'GFM table without edge pipes',
      before: 'Name | Value\n--- | ---\nA | old\n\nAfter table\n',
      after: 'Name | Value\n--- | ---\nA | new\n\nAfter table\n',
      content: `Name | Value\n--- | ---\nA | ${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')}\n\nAfter table`
    },
    {
      label: 'indented list continuation',
      before: '- first item\n  old continuation\n  stable continuation\n- second item\n',
      after: '- first item\n  new continuation\n  stable continuation\n- second item\n',
      content: `- first item\n  ${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')} continuation\n  stable continuation\n- second item`
    },
    {
      label: 'loose multi-item list continuation',
      before:
        '- first item\n\n  old continuation\n\n- second item\n\n  stable continuation\n\nAfter list\n',
      after:
        '- first item\n\n  new continuation\n\n- second item\n\n  stable continuation\n\nAfter list\n',
      content: `- first item\n\n  ${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')} continuation\n\n- second item\n\n  stable continuation\n\nAfter list`
    }
  ])('keeps a complete $label in one rich block', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `container-${fixture.label.replaceAll(' ', '-')}`
    )
    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: fixture.content,
        startIndex: 0
      }
    ])
    const block = blocks[0]
    if (block?.kind !== 'markdown' || block.changeKind !== 'mixed') {
      throw new Error('expected one mixed Markdown block')
    }
    expectSourceReconstruction(block.fallbackSegments, fixture.before, fixture.after)
  })

  it('falls back a changed table delimiter row to exact source characters', async () => {
    const before = '| Name | Value |\n| --- | --- |\n| A | stable |\n'
    const after = '| Name | Value |\n| :--- | ---: |\n| A | stable |\n'
    const blocks = await diffMarkdown(before, after, 'table-delimiter-replacement')

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '| Name | Value |\n| ' },
          { kind: 'added', text: ':' },
          { kind: 'context', text: '--- | ---' },
          { kind: 'added', text: ':' },
          { kind: 'context', text: ' |\n| A | stable |' }
        ],
        startIndex: 0
      }
    ])
    const block = blocks[0]
    if (block?.kind !== 'text') throw new Error('expected one raw text block')
    expectSourceReconstruction(block.segments, before.trimEnd(), after.trimEnd())
  })

  it.each([
    {
      label: 'heading and paragraph',
      suffix: '# Stable heading\nStable paragraph\n',
      quoteTail: '',
      rendered: '# Stable heading\nStable paragraph',
      startIndex: 2
    },
    {
      label: 'HTML block',
      suffix: '<div>stable</div>\n',
      quoteTail: '',
      rendered: '<div>stable</div>',
      startIndex: 2
    },
    {
      label: 'CommonMark ordered-list interruption',
      suffix: '2. stable lazy continuation\n1. Stable list item\n',
      quoteTail: '\n2. stable lazy continuation',
      rendered: '1. Stable list item',
      startIndex: 3
    },
    {
      label: 'list block',
      suffix: '- Stable item\n  Stable continuation\n',
      quoteTail: '',
      rendered: '- Stable item\n  Stable continuation',
      startIndex: 2
    },
    {
      label: 'fenced block',
      suffix: '```ts\nconst stable = true\n```\n',
      quoteTail: '',
      rendered: '```ts\nconst stable = true\n```',
      startIndex: 2
    },
    {
      label: 'thematic break',
      suffix: '---\nStable paragraph\n',
      quoteTail: '',
      rendered: '---\nStable paragraph',
      startIndex: 2
    },
    {
      label: 'table block',
      separator: '\n',
      suffix: '| Name | Value |\n| --- | --- |\n| A | stable |\n',
      quoteTail: '',
      rendered: '\n| Name | Value |\n| --- | --- |\n| A | stable |',
      startIndex: 2
    }
  ])('stops a changed blockquote before an independent $label', async (fixture) => {
    const separator = fixture.separator ?? ''
    const blocks = await diffMarkdown(
      `> old quote\n${separator}${fixture.suffix}`,
      `> new quote\n${separator}${fixture.suffix}`,
      `blockquote-before-${fixture.label.replaceAll(' ', '-')}`
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '> ' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: ` quote${fixture.quoteTail}` }
        ],
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'context',
        content: fixture.rendered,
        startIndex: fixture.startIndex
      }
    ])
  })

  it.each([
    {
      label: 'changed lazy continuation',
      before: '> opening quote\nold lazy continuation\n> adjacent quote line\n\nAfter quote\n',
      after: '> opening quote\nnew lazy continuation\n> adjacent quote line\n\nAfter quote\n',
      segments: [
        { kind: 'context' as const, text: '> opening quote\n' },
        { kind: 'removed' as const, text: 'old' },
        { kind: 'added' as const, text: 'new' },
        { kind: 'context' as const, text: ' lazy continuation\n> adjacent quote line' }
      ]
    },
    {
      label: 'marked and lazy continuations',
      before: '> old opening\n> stable marked line\nstable lazy continuation\n\nAfter quote\n',
      after: '> new opening\n> stable marked line\nstable lazy continuation\n\nAfter quote\n',
      segments: [
        { kind: 'context' as const, text: '> ' },
        { kind: 'removed' as const, text: 'old' },
        { kind: 'added' as const, text: 'new' },
        {
          kind: 'context' as const,
          text: ' opening\n> stable marked line\nstable lazy continuation'
        }
      ]
    }
  ])('keeps one blockquote around $label', async (fixture) => {
    expectPresentation(
      await diffMarkdown(
        fixture.before,
        fixture.after,
        `blockquote-${fixture.label.replaceAll(' ', '-')}`
      ),
      [
        { kind: 'text', changeKind: 'mixed', segments: fixture.segments, startIndex: 0 },
        {
          kind: 'markdown',
          changeKind: 'context',
          content: '\nAfter quote',
          startIndex: 4
        }
      ]
    )
  })

  it('keeps an indented code block with internal blank lines in one raw fallback', async () => {
    const before =
      '    const first = true\n\n    const value = "old"\n\n    const stable = true\nAfter code\n'
    const after =
      '    const first = true\n\n    const value = "new"\n\n    const stable = true\nAfter code\n'
    const blocks = await diffMarkdown(before, after, 'indented-code-replacement')

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '    const first = true\n\n    const value = "' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '"\n\n    const stable = true' }
        ],
        startIndex: 0
      },
      { kind: 'markdown', changeKind: 'context', content: 'After code', startIndex: 6 }
    ])
  })

  it.each([
    {
      label: 'emphasis',
      before: 'This is plain\n',
      after: 'This is *plain*\n',
      segments: [
        { kind: 'context' as const, text: 'This is ' },
        { kind: 'added' as const, text: '*' },
        { kind: 'context' as const, text: 'plain' },
        { kind: 'added' as const, text: '*' }
      ]
    },
    {
      label: 'math',
      before: 'Value is plain\n',
      after: 'Value is $plain$\n',
      segments: [
        { kind: 'context' as const, text: 'Value is ' },
        { kind: 'added' as const, text: '$' },
        { kind: 'context' as const, text: 'plain' },
        { kind: 'added' as const, text: '$' }
      ]
    }
  ])(
    'falls back to changed source characters across $label boundaries',
    async ({ before, after, segments }) => {
      const blocks = await diffMarkdown(before, after, `markdown-${before.length}-${after.length}`)

      expectPresentation(blocks, [
        {
          kind: 'text',
          changeKind: 'mixed',
          segments,
          startIndex: 0
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

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'added',
        content: 'First soft line\nsecond soft line\nthird soft line',
        startIndex: 0
      }
    ])
  })

  it('falls back only the affected paragraph across inline Markdown syntax', async () => {
    const blocks = await diffMarkdown(
      'Opening line\nThis is plain\nclosing line\n',
      'Opening line\nThis is *plain*\nclosing line\n',
      'multiline-emphasis-boundary'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: 'Opening line\nThis is ' },
          { kind: 'added', text: '*' },
          { kind: 'context', text: 'plain' },
          { kind: 'added', text: '*' },
          { kind: 'context', text: '\nclosing line' }
        ],
        startIndex: 0
      }
    ])
  })

  it('falls back only the changed ATX heading to one character-level raw block', async () => {
    const blocks = await diffMarkdown(
      'Intro paragraph\n# Old heading\nOutro paragraph\n',
      'Intro paragraph\n## New heading\nOutro paragraph\n',
      'atx-prefix-boundary'
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'context',
        content: 'Intro paragraph',
        startIndex: 0
      },
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '#' },
          { kind: 'added', text: '#' },
          { kind: 'context', text: ' ' },
          { kind: 'removed', text: 'Old' },
          { kind: 'added', text: 'New' },
          { kind: 'context', text: ' heading' }
        ],
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

  it('falls back a changed ATX closing marker to its source characters', async () => {
    const blocks = await diffMarkdown(
      '# Stable heading #\n',
      '# Stable heading ##\n',
      'atx-closing-marker-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '# Stable heading #' },
          { kind: 'added', text: '#' }
        ],
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

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `Opening line\n${escapedMarkdownChange('added', 'inserted line')}\nclosing line`,
        startIndex: 0
      }
    ])
  })

  it('keeps an inserted paragraph separate from a similar modified paragraph', async () => {
    const blocks = await diffMarkdown(
      '## What Is This?\nOriginal paragraph old.\n',
      '## What Is This?? ?\nWonderful\nOriginal paragraph new.\n',
      'inserted-paragraph-before-modified-paragraph'
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `## What Is This?${escapedMarkdownChange('added', '? ?')}\n${escapedMarkdownChange('added', 'Wonderful')}\nOriginal paragraph ${escapedMarkdownChange('removed', 'old')}${escapedMarkdownChange('added', 'new')}.`,
        startIndex: 0
      }
    ])
  })

  it('keeps a formatted shortened paragraph rendered while marking only visible character changes', async () => {
    const removedTail =
      ' (e.g. via ccswitch / CC Switch), you may notice that your local agent mode sessions (Cowork) and xcode-mode sessions are isolated per account. Each provider login creates a different account ID under ~/Library/Application Support/Claude/, so the app only shows sessions belonging to the currently logged-in account. Your other sessions appear to vanish, but they are still on disk, just in a different directory'
    const before = [
      '### What Is This?',
      '',
      "If you switch between Claude's **official subscription** and **third-party API routing** (e.g. via ccswitch / CC Switch), you may notice that your **local agent mode sessions** (Cowork) and xcode-mode sessions are isolated per account. Each provider login creates a different account ID under ~/Library/Application Support/Claude/, so the app only shows sessions belonging to the **currently logged-in account**. Your other sessions appear to vanish, but they are still on disk, just in a different directory.",
      ''
    ].join('\n')
    const after = [
      '### What Is This?? ?',
      '',
      'Wonderful',
      '',
      'If you switch between **official subscription** and **third-party API routing**.',
      ''
    ].join('\n')

    const blocks = await diffMarkdown(before, after, 'rendered-real-world-shortened-paragraph')
    const mixedBlocks = blocks.filter((block) => block.changeKind === 'mixed')

    expect(mixedBlocks.length).toBeGreaterThan(0)
    expect(mixedBlocks.every((block) => block.kind === 'markdown')).toBe(true)

    const content = mixedBlocks
      .map((block) => (block.kind === 'markdown' ? block.content : ''))
      .join('\n\n')
    const changedText = (kind: 'added' | 'removed'): string =>
      Array.from(
        content.matchAll(
          new RegExp(`<managed-diff-${kind}>([\\s\\S]*?)</managed-diff-${kind}>`, 'gu')
        ),
        (match) => match[1].replace(/<[^>]+>/gu, '')
      ).join('')

    expect(content).toContain(`### What Is This?${escapedMarkdownChange('added', '? ?')}`)
    expect(content).not.toContain('**')
    expect(content).toContain('<strong>official subscription</strong>')
    expect(content).toContain('<strong>third-party API routing</strong>')
    expect(changedText('added')).toBe('? ?Wonderful')
    expect(changedText('removed')).toBe(`Claude's ${removedTail}`)
  })

  it.each([
    {
      label: 'before',
      before: 'Removed **same**\n',
      after: '**same**\n',
      content: `${escapedMarkdownChange('removed', 'Removed ')}**same**`
    },
    {
      label: 'after',
      before: '**same** removed\n',
      after: '**same**\n',
      content: `**same**${escapedMarkdownChange('removed', ' removed')}`
    }
  ])('keeps a deletion $label strong text outside the formatting node', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `rendered-deletion-${fixture.label}-strong`
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: fixture.content,
        startIndex: 0
      }
    ])
  })

  it('marks a changed combining sequence as one visible character', async () => {
    const blocks = await diffMarkdown(
      'Prefix **e\u0301** 👨‍👩‍👧‍👦 and **removed**\n',
      'Prefix e 👨‍👩‍👧‍👦 and\n',
      'rendered-grapheme-change'
    )

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `Prefix ${escapedMarkdownChange('removed', 'e\u0301')}${escapedMarkdownChange('added', 'e')} 👨‍👩‍👧‍👦 and${escapedMarkdownChange('removed', ' removed')}`,
        fallbackSegments: expect.any(Array),
        startIndex: 0
      }
    ])
  })

  it.each([
    {
      label: 'retained text changes formatting',
      before: '**same** old\n',
      after: 'same new\n'
    },
    {
      label: 'plain deletion would inherit after formatting',
      before: '**A** removed **B**\n',
      after: '**A B**\n'
    },
    {
      label: 'one grapheme crosses formatting nodes',
      before: 'x\n',
      after: 'e**\u0301**\n'
    }
  ])('falls back when $label', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `rendered-format-safety-${fixture.label}`
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'text', changeKind: 'mixed' })
  })

  it.each([
    { label: 'split', before: 'Hello world\n', after: 'Hello \nworld\n', kind: 'added' as const },
    { label: 'merge', before: 'Hello \nworld\n', after: 'Hello world\n', kind: 'removed' as const }
  ])('marks only the changed newline when paragraphs $label across lines', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `rendered-paragraph-line-${fixture.label}`
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: 'Hello ' },
          { kind: fixture.kind, text: '\n' },
          { kind: 'context', text: 'world' }
        ],
        startIndex: 0
      }
    ])
  })

  it.each(['prose', 'structured'] as const)(
    'marks only the changed newline in %s text split and merge blocks',
    async (presentationKind) => {
      for (const fixture of [
        {
          requestId: `${presentationKind}-line-split`,
          before: 'Hello world\n',
          after: 'Hello \nworld\n',
          kind: 'added' as const
        },
        {
          requestId: `${presentationKind}-line-merge`,
          before: 'Hello \nworld\n',
          after: 'Hello world\n',
          kind: 'removed' as const
        }
      ]) {
        const lines = await new ManagedTextDiffTaskRunner().run(fixture)
        expect(
          toDiffPresentationBlocks(
            { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
            presentationKind
          )
        ).toEqual([
          {
            kind: 'text',
            changeKind: 'mixed',
            segments: [
              { kind: 'context', text: 'Hello ' },
              { kind: fixture.kind, text: '\n' },
              { kind: 'context', text: 'world\n' }
            ],
            startIndex: 0
          }
        ])
      }
    }
  )

  it.each(['prose', 'structured'] as const)(
    'keeps cross-line text replacements character-precise in %s blocks',
    async (presentationKind) => {
      const lines = await new ManagedTextDiffTaskRunner().run({
        requestId: `${presentationKind}-line-split-with-text-replacements`,
        before: 'Hello old world old\n',
        after: 'Hello new\nworld new\n'
      })

      expect(
        toDiffPresentationBlocks(
          { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
          presentationKind
        )
      ).toEqual([
        {
          kind: 'text',
          changeKind: 'mixed',
          segments: [
            { kind: 'context', text: 'Hello ' },
            { kind: 'removed', text: 'old ' },
            { kind: 'added', text: 'ne' },
            { kind: 'context', text: 'w' },
            { kind: 'added', text: '\nw' },
            { kind: 'context', text: 'orld ' },
            { kind: 'removed', text: 'old' },
            { kind: 'added', text: 'new' },
            { kind: 'context', text: '\n' }
          ],
          startIndex: 0
        }
      ])
    }
  )

  it.each(['prose', 'structured'] as const)(
    'does not invent a shared newline in a multiline %s hunk ending at EOF',
    async (presentationKind) => {
      const before = 'old1\nkeep old\nremoved after\n'
      const after = 'keep new'
      const lines = await new ManagedTextDiffTaskRunner().run({
        requestId: `${presentationKind}-multiline-eof-without-newline`,
        before,
        after
      })
      const blocks = toDiffPresentationBlocks(
        { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
        presentationKind
      )
      const segments = blocks.flatMap((block) => (block.kind === 'text' ? block.segments : []))

      expect(blocks).toHaveLength(1)
      expect(
        segments
          .filter((segment) => segment.kind !== 'added')
          .map((segment) => segment.text)
          .join('')
      ).toBe(before)
      expect(
        segments
          .filter((segment) => segment.kind !== 'removed')
          .map((segment) => segment.text)
          .join('')
      ).toBe(after)
    }
  )

  it.each(['prose', 'structured'] as const)(
    'reconstructs both sides of a one-to-many %s line split',
    async (presentationKind) => {
      const before = 'StartMiddleEnd'
      const after = 'Start\ninserted Middle\nEnd'
      const lines = await new ManagedTextDiffTaskRunner().run({
        requestId: `${presentationKind}-one-to-many-line-split`,
        before,
        after
      })
      const blocks = toDiffPresentationBlocks(
        { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
        presentationKind
      )
      const segments = blocks.flatMap((block) => (block.kind === 'text' ? block.segments : []))

      expect(blocks).toHaveLength(1)
      expect(
        segments
          .filter((segment) => segment.kind !== 'added')
          .map((segment) => segment.text)
          .join('')
      ).toBe(before)
      expect(
        segments
          .filter((segment) => segment.kind !== 'removed')
          .map((segment) => segment.text)
          .join('')
      ).toBe(after)
    }
  )

  it.each(['prose', 'structured'] as const)(
    'reconstructs both sides when a matched line carries a cross-line anchor in %s',
    async (presentationKind) => {
      const before = 'Line one\nStartMiddleEnd'
      const after = 'New first\nMiddle\nEnd'
      const lines = await new ManagedTextDiffTaskRunner().run({
        requestId: `${presentationKind}-matched-line-cross-line-anchor`,
        before,
        after
      })
      const blocks = toDiffPresentationBlocks(
        { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
        presentationKind
      )
      const segments = blocks.flatMap((block) => (block.kind === 'text' ? block.segments : []))

      expect(blocks).toHaveLength(1)
      expect(
        segments
          .filter((segment) => segment.kind !== 'added')
          .map((segment) => segment.text)
          .join('')
      ).toBe(before)
      expect(
        segments
          .filter((segment) => segment.kind !== 'removed')
          .map((segment) => segment.text)
          .join('')
      ).toBe(after)
    }
  )

  it.each(['prose', 'structured'] as const)(
    'reconstructs both sides of a transitive cross-line %s edit',
    async (presentationKind) => {
      const before = 'Intro\nMiddleEnd'
      const after = 'Intro Middle\nInserted End\nDone'
      const lines = await new ManagedTextDiffTaskRunner().run({
        requestId: `${presentationKind}-transitive-cross-line-anchors`,
        before,
        after
      })
      const blocks = toDiffPresentationBlocks(
        { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
        presentationKind
      )
      const segments = blocks.flatMap((block) => (block.kind === 'text' ? block.segments : []))

      expect(blocks).toHaveLength(1)
      expect(
        segments
          .filter((segment) => segment.kind !== 'added')
          .map((segment) => segment.text)
          .join('')
      ).toBe(before)
      expect(
        segments
          .filter((segment) => segment.kind !== 'removed')
          .map((segment) => segment.text)
          .join('')
      ).toBe(after)
    }
  )

  it('keeps an inserted blank line as a visible single-column row', async () => {
    const blocks = await diffMarkdown(
      'Opening line\nclosing line\n',
      'Opening line\n\nclosing line\n',
      'inserted-blank-line'
    )

    expect(blocks).toContainEqual({
      kind: 'text',
      changeKind: 'added',
      segments: [{ kind: 'added', text: '\n' }],
      startIndex: 1
    })
  })

  it.each([
    { label: 'addition', before: '', after: '\n', kind: 'added' as const },
    { label: 'removal', before: '\n', after: '', kind: 'removed' as const }
  ])('preserves a pure blank-line $label as one exact newline', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `pure-blank-line-${fixture.label}`
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: fixture.kind,
        segments: [{ kind: fixture.kind, text: '\n' }],
        startIndex: 0
      }
    ])
  })

  it('shows a trailing-newline-only change as one exact raw character change', async () => {
    const blocks = await diffMarkdown('line', 'line\n', 'trailing-newline-change')

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: 'line' },
          { kind: 'added', text: '\n' }
        ],
        startIndex: 0
      }
    ])
  })

  it.each([
    { label: 'LF to CRLF', before: 'line\n', after: 'line\r\n', kind: 'added' as const },
    { label: 'CRLF to LF', before: 'line\r\n', after: 'line\n', kind: 'removed' as const }
  ])('keeps the shared newline visible during a trailing $label conversion', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `render-trailing-ending-conversion-${fixture.label}`
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: 'line' },
          { kind: fixture.kind, text: '\r' },
          { kind: 'context', text: '\n' }
        ],
        startIndex: 0
      }
    ])
  })

  it('does not duplicate a changed newline before an inserted continuation', async () => {
    const blocks = await diffMarkdown(
      '- a',
      '- a\n  continuation\n',
      'inserted-continuation-after-newline'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '- a' },
          { kind: 'added', text: '\n  continuation\n' }
        ],
        startIndex: 0
      }
    ])
  })

  it('does not duplicate a changed CRLF before an inserted continuation', async () => {
    const blocks = await diffMarkdown(
      '- a',
      '- a\r\n  continuation\r\n',
      'inserted-continuation-after-crlf'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '- a' },
          { kind: 'added', text: '\r\n  continuation\r\n' }
        ],
        startIndex: 0
      }
    ])
  })

  it('does not duplicate a removed newline before a removed continuation', async () => {
    const blocks = await diffMarkdown(
      '- a\n  continuation\n',
      '- a',
      'removed-continuation-after-newline'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '- a' },
          { kind: 'removed', text: '\n  continuation\n' }
        ],
        startIndex: 0
      }
    ])
  })

  it.each([
    { label: 'paragraph', prefix: 'plain' },
    { label: 'lazy blockquote', prefix: '> quote' }
  ])('keeps an inserted $label continuation in one exact mixed block', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.prefix,
      `${fixture.prefix}\ncontinuation\n`,
      `inserted-${fixture.label}-continuation`
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: fixture.prefix },
          { kind: 'added', text: '\ncontinuation\n' }
        ],
        startIndex: 0
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
    expectPresentation(blocks, [
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
    expectPresentation(blocks, [
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
    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'added',
        segments: [{ kind: 'added', text: content }],
        startIndex: 0
      }
    ])
    lexer.mockRestore()
  })

  it('keeps an oversized fenced replacement together without absorbing a stable heading', async () => {
    const stable = 'x'.repeat(2_100)
    const blocks = await diffMarkdown(
      `\`\`\`txt\n${stable}old\n\`\`\`\n# Stable heading\n`,
      `\`\`\`txt\n${stable}new\n\`\`\`\n# Stable heading\n`,
      'oversized-fenced-replacement'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: `\`\`\`txt\n${stable}` },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '\n```' }
        ],
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'context',
        content: '# Stable heading',
        startIndex: 4
      }
    ])
  })

  it.each([
    { label: 'marker type', beforeMarker: '```', afterMarker: '~~~' },
    { label: 'long info string', beforeMarker: '```', afterMarker: '```' }
  ])(
    'keeps a single-line oversized unclosed fence $label change character-precise',
    async (fixture) => {
      const stable = 'x'.repeat(2_100)
      const blocks = await diffMarkdown(
        `${fixture.beforeMarker}${stable}old`,
        `${fixture.afterMarker}${stable}new`,
        `single-line-oversized-fence-${fixture.label}`
      )
      const markerSegments =
        fixture.beforeMarker === fixture.afterMarker
          ? [{ kind: 'context' as const, text: `${fixture.beforeMarker}${stable}` }]
          : [
              { kind: 'removed' as const, text: fixture.beforeMarker },
              { kind: 'added' as const, text: fixture.afterMarker },
              { kind: 'context' as const, text: stable }
            ]

      expectPresentation(blocks, [
        {
          kind: 'text',
          changeKind: 'mixed',
          segments: [
            ...markerSegments,
            { kind: 'removed', text: 'old' },
            { kind: 'added', text: 'new' }
          ],
          startIndex: 0
        }
      ])
    }
  )

  it.each([
    {
      label: 'blockquote',
      opening: '> ```txt',
      contentPrefix: '> ',
      closing: '> ```'
    },
    {
      label: 'list item',
      opening: '- ```txt',
      contentPrefix: '  ',
      closing: '  ```'
    },
    {
      label: 'ordered list item',
      opening: '10. ```txt',
      contentPrefix: '    ',
      closing: '    ```'
    },
    {
      label: 'nested list item',
      opening: '- - ```txt',
      contentPrefix: '    ',
      closing: '    ```'
    },
    {
      label: 'list blockquote',
      opening: '- > ```txt',
      contentPrefix: '  > ',
      closing: '  > ```'
    }
  ])('keeps an oversized fence inside a $label container intact', async (fixture) => {
    const stable = 'x'.repeat(2_100)
    const blocks = await diffMarkdown(
      `${fixture.opening}\n${fixture.contentPrefix}${stable}old\n${fixture.closing}\n# Stable heading\n`,
      `${fixture.opening}\n${fixture.contentPrefix}${stable}new\n${fixture.closing}\n# Stable heading\n`,
      `oversized-${fixture.label}-fence`
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          {
            kind: 'context',
            text: `${fixture.opening}\n${fixture.contentPrefix}${stable}`
          },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: `\n${fixture.closing}` }
        ],
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'context',
        content: '# Stable heading',
        startIndex: 4
      }
    ])
  })

  it.each([
    { label: 'blockquote', opening: '> ```txt', contentPrefix: '> ' },
    { label: 'list item', opening: '- ```txt', contentPrefix: '  ' }
  ])('ends an unclosed oversized $label fence when its container ends', async (fixture) => {
    const stable = 'x'.repeat(2_100)
    const blocks = await diffMarkdown(
      `${fixture.opening}\n${fixture.contentPrefix}${stable}old\n# Stable heading\n`,
      `${fixture.opening}\n${fixture.contentPrefix}${stable}new\n# Stable heading\n`,
      `unclosed-oversized-${fixture.label}-fence`
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          {
            kind: 'context',
            text: `${fixture.opening}\n${fixture.contentPrefix}${stable}`
          },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' }
        ],
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'context',
        content: '# Stable heading',
        startIndex: 3
      }
    ])
  })

  it('does not close a top-level oversized fence with a blockquote fence marker', async () => {
    const stable = 'x'.repeat(2_100)
    const blocks = await diffMarkdown(
      `\`\`\`txt\n${stable}old\n> \`\`\`\n# Stable heading\n`,
      `\`\`\`txt\n${stable}new\n> \`\`\`\n# Stable heading\n`,
      'mismatched-blockquote-fence-closer'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: `\`\`\`txt\n${stable}` },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '\n> ```\n# Stable heading' }
        ],
        startIndex: 0
      }
    ])
  })

  it.each([
    { label: 'backtick', marker: '```' },
    { label: 'tilde', marker: '~~~' }
  ])('does not truncate a non-empty $label fence tail into a valid closer', async (fixture) => {
    const stable = 'x'.repeat(2_100)
    const invalidCloser = `${fixture.marker}${' '.repeat(2_100)}x`
    const blocks = await diffMarkdown(
      `${fixture.marker}txt\n${stable}old\n${invalidCloser}\n# Stable heading\n`,
      `${fixture.marker}txt\n${stable}new\n${invalidCloser}\n# Stable heading\n`,
      `oversized-${fixture.label}-invalid-closer-tail`
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: `${fixture.marker}txt\n${stable}` },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: `\n${invalidCloser}\n# Stable heading` }
        ],
        startIndex: 0
      }
    ])
  })

  it('does not treat a ten-digit ordered marker as a list fence container', async () => {
    const stable = 'x'.repeat(2_100)
    const blocks = await diffMarkdown(
      `1234567890. \`\`\`txt\n${stable}old\n# Stable heading\n`,
      `1234567890. \`\`\`txt\n${stable}new\n# Stable heading\n`,
      'invalid-ten-digit-list-fence'
    )

    expect(blocks.at(-1)).toEqual({
      kind: 'markdown',
      changeKind: 'context',
      content: '# Stable heading',
      startIndex: 3
    })
  })

  it('does not treat an oversized invalid backtick opener as a fenced block', async () => {
    const stable = 'x'.repeat(2_100)
    const blocks = await diffMarkdown(
      `\`\`\` foo\`bar\n${stable}old\n# Stable heading\n`,
      `\`\`\` foo\`bar\n${stable}new\n# Stable heading\n`,
      'invalid-oversized-backtick-opener'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: `\`\`\` foo\`bar\n${stable}` },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' }
        ],
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'context',
        content: '# Stable heading',
        startIndex: 3
      }
    ])
  })

  it('preserves an inserted trailing blank line in an oversized unclosed tilde fence', async () => {
    const stable = 'x'.repeat(2_100)
    const blocks = await diffMarkdown(
      `~~~\n${stable}old`,
      `~~~\n${stable}new\n\n`,
      'oversized-unclosed-tilde-blank-line'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: `~~~\n${stable}` },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new\n\n' }
        ],
        startIndex: 0
      }
    ])
  })

  it.each([
    {
      label: 'deleted',
      before: '~~~\nstable\n~~~\n# Heading\n',
      after: '~~~\nstable\n# Heading\n',
      changedKind: 'removed' as const
    },
    {
      label: 'inserted',
      before: '~~~\nstable\n# Heading\n',
      after: '~~~\nstable\n~~~\n# Heading\n',
      changedKind: 'added' as const
    }
  ])('keeps following content in the raw range when a tilde closer is $label', async (fixture) => {
    const blocks = await diffMarkdown(
      fixture.before,
      fixture.after,
      `${fixture.label}-tilde-closer`
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '~~~\nstable\n' },
          { kind: fixture.changedKind, text: '~~~\n' },
          { kind: 'context', text: '# Heading' }
        ],
        startIndex: 0
      }
    ])
  })

  it('keeps adjacent changed fenced and heading blocks as separate raw ranges', async () => {
    const blocks = await diffMarkdown(
      '```txt\nold\n```\n# Heading\n',
      '```txt\nnew\n```\n## Heading\n',
      'adjacent-fence-and-heading-changes'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '```txt\n' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '\n```' }
        ],
        startIndex: 0
      },
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '#' },
          { kind: 'added', text: '#' },
          { kind: 'context', text: ' Heading' }
        ],
        startIndex: 4
      }
    ])
  })

  it('marks only a line inserted inside a fenced block', async () => {
    const blocks = await diffMarkdown(
      '```ts\nconst stable = true\n```\n',
      '```ts\nconst stable = true\nconst added = 1\n```\n',
      'fenced-line-insertion'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '```ts\nconst stable = true\n' },
          { kind: 'added', text: 'const added = 1\n' },
          { kind: 'context', text: '```' }
        ],
        startIndex: 0
      }
    ])
  })

  it('marks an inserted blank line inside a changed fenced block as a newline', async () => {
    const blocks = await diffMarkdown(
      '```txt\nold\n```\n',
      '```txt\nnew\n\n```\n',
      'fenced-replacement-with-blank-line'
    )

    expectPresentation(blocks, [
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '```txt\n' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '\n' },
          { kind: 'added', text: '\n' },
          { kind: 'context', text: '```' }
        ],
        startIndex: 0
      }
    ])
  })

  it('collapses an oversized pair with no changed segments to one context block', () => {
    const content = `**${'x'.repeat(2_100)}**`
    const lexer = vi.spyOn(marked, 'lexer')
    const result: ManagedFileVersionDiffResult = {
      baseVersionId: 'v1',
      selectedVersionId: 'v2',
      lines: [
        {
          kind: 'removed',
          oldLineNumber: 1,
          segments: [{ kind: 'context', text: content }]
        },
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [{ kind: 'context', text: content }]
        }
      ]
    }

    expectPresentation(toDiffPresentationBlocks(result, 'markdown'), [
      {
        kind: 'text',
        changeKind: 'context',
        segments: [{ kind: 'context', text: content }],
        startIndex: 0
      }
    ])
    expect(lexer).not.toHaveBeenCalled()
    lexer.mockRestore()
  })

  it('keeps a long valid list rendered when its individual lines stay within budget', async () => {
    const content = Array.from({ length: 500 }, (_, index) => `- valid list item ${index}`).join(
      '\n'
    )

    const blocks = await diffMarkdown('', content, 'long-valid-list')

    expectPresentation(blocks, [
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
          kind: 'context',
          oldLineNumber: 1,
          newLineNumber: 1,
          segments: [{ kind: 'context', text: 'Opening line' }]
        },
        {
          kind: 'removed',
          oldLineNumber: 2,
          segments: [
            { kind: 'context', text: '- ' },
            { kind: 'removed', text: 'old' },
            { kind: 'context', text: ' item' }
          ]
        },
        {
          kind: 'added',
          newLineNumber: 2,
          segments: [
            { kind: 'context', text: '- ' },
            { kind: 'added', text: 'new' },
            { kind: 'context', text: ' item' }
          ]
        },
        {
          kind: 'context',
          oldLineNumber: 3,
          newLineNumber: 3,
          segments: [{ kind: 'context', text: 'Closing line' }]
        }
      ]
    }

    const blocks = toDiffPresentationBlocks(result, 'markdown')

    expectPresentation(blocks, [
      {
        kind: 'markdown',
        changeKind: 'context',
        content: 'Opening line',
        startIndex: 0
      },
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '- ' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: ' item' }
        ],
        startIndex: 1
      },
      {
        kind: 'markdown',
        changeKind: 'context',
        content: 'Closing line',
        startIndex: 3
      }
    ])
    lexer.mockRestore()
  })

  it('keeps a fenced block intact when the Markdown lexer throws', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'fenced-lexer-failure',
      before: '```txt\nold\n```\n# Stable heading\n',
      after: '```txt\nnew\n```\n# Stable heading\n'
    })
    const lexer = vi.spyOn(marked, 'lexer').mockImplementation(() => {
      throw new Error('synthetic lexer failure')
    })

    expect(
      toDiffPresentationBlocks({ baseVersionId: 'v1', selectedVersionId: 'v2', lines }, 'markdown')
    ).toEqual([
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '```txt\n' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '\n```' }
        ],
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'context',
        content: '# Stable heading',
        startIndex: 4
      }
    ])
    lexer.mockRestore()
  })

  it('keeps both sides of a changed fence intact when the Markdown lexer throws', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'changed-fence-lexer-failure',
      before: '```txt\nold\n```\n# Stable heading\n',
      after: '~~~txt\nnew\n~~~\n# Stable heading\n'
    })
    const lexer = vi.spyOn(marked, 'lexer').mockImplementation(() => {
      throw new Error('synthetic lexer failure')
    })

    expect(
      toDiffPresentationBlocks({ baseVersionId: 'v1', selectedVersionId: 'v2', lines }, 'markdown')
    ).toEqual([
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'removed', text: '```' },
          { kind: 'added', text: '~~~' },
          { kind: 'context', text: 'txt\n' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' },
          { kind: 'context', text: '\n' },
          { kind: 'removed', text: '```' },
          { kind: 'added', text: '~~~' }
        ],
        startIndex: 0
      },
      {
        kind: 'markdown',
        changeKind: 'context',
        content: '# Stable heading',
        startIndex: 6
      }
    ])
    lexer.mockRestore()
  })

  it.each([
    {
      label: 'deleted',
      before: '~~~\nstable\n~~~\n# Heading\n',
      after: '~~~\nstable\n# Heading\n',
      changedKind: 'removed' as const
    },
    {
      label: 'inserted',
      before: '~~~\nstable\n# Heading\n',
      after: '~~~\nstable\n~~~\n# Heading\n',
      changedKind: 'added' as const
    }
  ])(
    'keeps following content raw when a fence closer is $label and lexing fails',
    async (fixture) => {
      const lines = await new ManagedTextDiffTaskRunner().run({
        requestId: `${fixture.label}-closer-lexer-failure`,
        before: fixture.before,
        after: fixture.after
      })
      const lexer = vi.spyOn(marked, 'lexer').mockImplementation(() => {
        throw new Error('synthetic lexer failure')
      })

      expect(
        toDiffPresentationBlocks(
          { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
          'markdown'
        )
      ).toEqual([
        {
          kind: 'text',
          changeKind: 'mixed',
          segments: [
            { kind: 'context', text: '~~~\nstable\n' },
            { kind: fixture.changedKind, text: '~~~\n' },
            { kind: 'context', text: '# Heading' }
          ],
          startIndex: 0
        }
      ])
      lexer.mockRestore()
    }
  )

  it.each([
    {
      label: 'ends an unclosed blockquote fence at the container boundary',
      before: '> ```txt\n> old\n# Stable heading\n',
      after: '> ```txt\n> new\n# Stable heading\n',
      expected: [
        {
          kind: 'text' as const,
          changeKind: 'mixed' as const,
          segments: [
            { kind: 'context' as const, text: '> ```txt\n> ' },
            { kind: 'removed' as const, text: 'old' },
            { kind: 'added' as const, text: 'new' }
          ],
          startIndex: 0
        },
        {
          kind: 'markdown' as const,
          changeKind: 'context' as const,
          content: '# Stable heading',
          startIndex: 3
        }
      ]
    },
    {
      label: 'does not close a top-level fence with a blockquote marker',
      before: '```txt\nold\n> ```\n# Stable heading\n',
      after: '```txt\nnew\n> ```\n# Stable heading\n',
      expected: [
        {
          kind: 'text' as const,
          changeKind: 'mixed' as const,
          segments: [
            { kind: 'context' as const, text: '```txt\n' },
            { kind: 'removed' as const, text: 'old' },
            { kind: 'added' as const, text: 'new' },
            { kind: 'context' as const, text: '\n> ```\n# Stable heading' }
          ],
          startIndex: 0
        }
      ]
    },
    {
      label: 'keeps a nested list fence intact',
      before: '- - ```txt\n    old\n# Stable heading\n',
      after: '- - ```txt\n    new\n# Stable heading\n',
      expected: [
        {
          kind: 'text' as const,
          changeKind: 'mixed' as const,
          segments: [
            { kind: 'context' as const, text: '- - ```txt\n    ' },
            { kind: 'removed' as const, text: 'old' },
            { kind: 'added' as const, text: 'new' }
          ],
          startIndex: 0
        },
        {
          kind: 'markdown' as const,
          changeKind: 'context' as const,
          content: '# Stable heading',
          startIndex: 3
        }
      ]
    }
  ])('$label when the Markdown lexer throws', async (fixture) => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: `container-lexer-failure-${fixture.label}`,
      before: fixture.before,
      after: fixture.after
    })
    const lexer = vi.spyOn(marked, 'lexer').mockImplementation(() => {
      throw new Error('synthetic lexer failure')
    })

    expect(
      toDiffPresentationBlocks({ baseVersionId: 'v1', selectedVersionId: 'v2', lines }, 'markdown')
    ).toEqual(fixture.expected)
    lexer.mockRestore()
  })

  it('keeps an empty changed line visible when a raw fallback also contains a replacement', () => {
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
          segments: [
            { kind: 'context', text: '- ' },
            { kind: 'removed', text: 'old' }
          ]
        },
        {
          kind: 'added',
          newLineNumber: 1,
          segments: [
            { kind: 'context', text: '- ' },
            { kind: 'added', text: 'new' }
          ]
        },
        {
          kind: 'added',
          newLineNumber: 2,
          segments: [{ kind: 'added', text: '' }]
        }
      ]
    }

    expect(toDiffPresentationBlocks(result, 'markdown')).toEqual([
      {
        kind: 'text',
        changeKind: 'mixed',
        segments: [
          { kind: 'context', text: '- ' },
          { kind: 'removed', text: 'old' },
          { kind: 'added', text: 'new' }
        ],
        startIndex: 0
      },
      {
        kind: 'text',
        changeKind: 'added',
        segments: [{ kind: 'added', text: '' }],
        startIndex: 2
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

    expectPresentation(blocks, [
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

    expectPresentation(toDiffPresentationBlocks(result, 'markdown'), [
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
