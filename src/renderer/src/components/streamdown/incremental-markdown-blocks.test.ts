import { describe, expect, it } from 'vitest'
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
