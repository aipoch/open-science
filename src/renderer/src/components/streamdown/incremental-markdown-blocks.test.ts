import { describe, expect, it, vi } from 'vitest'
import { Lexer } from 'marked'
import { parseMarkdownIntoBlocks } from 'streamdown'

import { createIncrementalMarkdownBlocks } from './incremental-markdown-blocks'

describe('incremental Markdown block semantics', () => {
  const samples = [
    'Plain paragraph.\n\nAnother paragraph.\n\nFinal paragraph.',
    'Title\n=====\n\ntext\n\nheading\n---\n\ntext',
    '- one\n\n- two\n\n  continued\n\n  - nested\n\nend',
    '> quote\n>\n> another paragraph\n\n> continuation\n\nend',
    '| A | B |\n| - | - |\n| 1 | 2 |\n\nend',
    '```markdown\nhello\n\nworld\n```\n\ntext\n\n~~~\nmore\n~~~',
    '<section>\n\nparagraph\n\n<div>nested</div>\n\n</section>\n\nend',
    '$$\na + b\n\n= c\n$$\n\nend',
    'A [reference][ref].\n\nAnother block.\n\n[ref]: https://example.com\n\nend',
    'A footnote[^a].\n\nAnother block.\n\n[^a]: definition\n\n    continuation',
    '[^a]: early definition\n\nSome text.\n\nReference[^a].',
    'Tabs\r\n\r\n    indented\r\n\r\nend',
    '<artifact-image artifact_ref="image-1"></artifact-image>\n\nend'
  ]

  it.each(samples)('matches full segmentation at every appended character: %s', (sample) => {
    const split = createIncrementalMarkdownBlocks()
    const content = 'Stable paragraph one.\n\nStable paragraph two.\n\n' + sample
    for (let length = 1; length <= content.length; length++) {
      const text = content.slice(0, length)
      expect(split(text), `at character ${length}`).toEqual(parseMarkdownIntoBlocks(text))
    }
    for (const replacement of ['Replacement branch.\n\nNew text.', '', content]) {
      expect(split(replacement)).toEqual(parseMarkdownIntoBlocks(replacement))
    }
  })

  it('preserves parser boundaries across combinations of block constructs', () => {
    for (const first of samples) {
      for (const second of samples) {
        const split = createIncrementalMarkdownBlocks()
        const content = `Prefix.\n\n${first}\n\n${second}\n\nTail.`
        for (let length = 7; length < content.length; length += 7) {
          const text = content.slice(0, length)
          expect(split(text), JSON.stringify({ first, second, length })).toEqual(
            parseMarkdownIntoBlocks(text)
          )
        }
        expect(split(content)).toEqual(parseMarkdownIntoBlocks(content))
      }
    }
  })
})

describe('Markdown segmentation work', () => {
  it.each([
    [
      'paragraph',
      'Scientific prose with **emphasis** and [links](https://example.com). '.repeat(200)
    ],
    ['list', '- **First** item\n- Second with `code`\n\n  Continued paragraph.\n'.repeat(100)],
    ['table', '| Name | Value |\n| --- | --- |\n' + '| **Sample** | `42` |\n'.repeat(100)]
  ])('does not tokenize unused inline content when splitting a growing %s', (_name, content) => {
    const snapshots = Array.from({ length: Math.ceil(content.length / 100) }, (_, index) =>
      content.slice(0, Math.min((index + 1) * 100, content.length))
    )
    const expected = snapshots.map(parseMarkdownIntoBlocks)
    const inline = vi.spyOn(Lexer.prototype, 'inlineTokens')
    try {
      const split = createIncrementalMarkdownBlocks()
      for (const [index, snapshot] of snapshots.entries()) {
        expect(split(snapshot)).toEqual(expected[index])
      }
      expect(inline.mock.calls.length).toBe(0)
    } finally {
      inline.mockRestore()
    }
  })
})

// Captured from unpatched Streamdown 2.5.0; keep an oracle independent of the patched lexer.
describe('Streamdown segmentation compatibility', () => {
  it.each([
    {
      input: '- one\n\n- two\n\n  continued\n\n  - nested\n\nend',
      blocks: ['- one\n\n- two\n\n  continued\n\n  - nested', '\n\n', 'end']
    },
    {
      input: '| A | B |\n| - | - |\n| 1 | 2 |\n\nend',
      blocks: ['| A | B |\n| - | - |\n| 1 | 2 |\n\n', 'end']
    },
    {
      input: '```markdown\nhello\n\nworld\n```\n\ntext\n\n~~~\nmore\n~~~',
      blocks: ['```markdown\nhello\n\nworld\n```', '\n\n', 'text', '\n\n', '~~~\nmore\n~~~']
    },
    {
      input: '<section>\n\nparagraph\n\n<div>nested</div>\n\n</section>\n\nend',
      blocks: ['<section>\n\nparagraph\n\n<div>nested</div>\n\n</section>\n\n', 'end']
    },
    {
      input: '$$\na + b\n\n= c\n$$\n\nend',
      blocks: ['$$\na + b\n\n= c\n$$', '\n\n', 'end']
    },
    {
      input: 'A [reference][ref].\n\nAnother block.\n\n[ref]: https://example.com\n\nend',
      blocks: [
        'A [reference][ref].',
        '\n\n',
        'Another block.',
        '\n\n',
        '[ref]: https://example.com\n\n',
        'end'
      ]
    },
    {
      input: 'A footnote[^a].\n\nAnother block.\n\n[^a]: definition\n\n    continuation',
      blocks: ['A footnote[^a].\n\nAnother block.\n\n[^a]: definition\n\n    continuation']
    },
    {
      input: 'Tabs\r\n\r\n    indented\r\n\r\nend',
      blocks: ['Tabs', '\n\n', '    indented\n\n', 'end']
    },
    {
      input: 'Before\r\rAfter\r',
      blocks: ['Before', '\n\n', 'After\n']
    },
    {
      input: '- [x] done **bold**\n- [ ] todo\n  - nested\n',
      blocks: ['- [x] done **bold**\n- [ ] todo\n  - nested\n']
    },
    {
      input: '[same]: /first\n\n[same]: /second\n\n[same]\n',
      blocks: ['[same]: /first\n\n', '[same]\n']
    }
  ])('preserves upstream block boundaries for $input', ({ input, blocks }) => {
    expect(parseMarkdownIntoBlocks(input)).toEqual(blocks)
    expect(createIncrementalMarkdownBlocks()(input)).toEqual(blocks)
  })
})
