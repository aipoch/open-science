import { describe, expect, it } from 'vitest'

import { ManagedTextDiffTaskRunner } from '../../../../main/managed-file-versions/diff-task'
import { toDiffPresentationBlocks } from './managed-version-diff-presentation'

const markdownContents = (
  blocks: ReturnType<typeof toDiffPresentationBlocks>
): Array<{ kind: 'added' | 'removed'; content: string }> =>
  blocks.flatMap((block) =>
    block.kind === 'markdown' && (block.changeKind === 'added' || block.changeKind === 'removed')
      ? [
          {
            kind: block.changeKind,
            content: block.content
          }
        ]
      : []
  )

const markdownChange = (kind: 'added' | 'removed', content: string): string => {
  const tag = `managed-diff-${kind}`
  return `<${tag}>${content}</${tag}>`
}

describe('PreviewFileSurface real diff DTO Markdown grouping', () => {
  it('groups an interleaved multi-line list replacement into complete before and after blocks', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'list-replacement',
      before: '- old one\n- old two\n',
      after: '- new one\n- new two\n'
    })

    expect(lines.map((line) => line.kind)).toEqual(['removed', 'added', 'removed', 'added'])
    expect(
      toDiffPresentationBlocks({ baseVersionId: 'v1', selectedVersionId: 'v2', lines }, 'markdown')
    ).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `- ${markdownChange('removed', 'old')}${markdownChange('added', 'new')} one\n- ${markdownChange('removed', 'old')}${markdownChange('added', 'new')} two`,
        startIndex: 0
      }
    ])
  })

  it('keeps the complete table around a changed row for both sides', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'table-replacement',
      before: '| Name | Value |\n| --- | --- |\n| A | old |\n',
      after: '| Name | Value |\n| --- | --- |\n| A | new |\n'
    })

    expect(
      toDiffPresentationBlocks({ baseVersionId: 'v1', selectedVersionId: 'v2', lines }, 'markdown')
    ).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `| Name | Value |\n| --- | --- |\n| A | ${markdownChange('removed', 'old')}${markdownChange('added', 'new')} |`,
        startIndex: 0
      }
    ])
  })

  it('keeps a complete GFM table without optional edge pipes', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'table-without-edge-pipes',
      before: 'Name | Value\n--- | ---\nA | old\n\nAfter table\n',
      after: 'Name | Value\n--- | ---\nA | new\n\nAfter table\n'
    })

    expect(
      toDiffPresentationBlocks({ baseVersionId: 'v1', selectedVersionId: 'v2', lines }, 'markdown')
    ).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `Name | Value\n--- | ---\nA | ${markdownChange('removed', 'old')}${markdownChange('added', 'new')}\n\nAfter table`,
        startIndex: 0
      }
    ])
  })

  it('keeps a complete Setext heading when its title changes', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'setext-heading-replacement',
      before: 'Old title\n===\nAfter heading\n',
      after: 'New title\n===\nAfter heading\n'
    })

    expect(
      toDiffPresentationBlocks({ baseVersionId: 'v1', selectedVersionId: 'v2', lines }, 'markdown')
    ).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `${markdownChange('removed', 'Old')}${markdownChange('added', 'New')} title\n===\nAfter heading`,
        startIndex: 0
      }
    ])
  })

  it('keeps both complete fenced blocks when only an inner line is replaced', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'fence-replacement',
      before: '```ts\nconst value = "old"\nconst stable = true\n```\n',
      after: '```ts\nconst value = "new"\nconst stable = true\n```\n'
    })

    expect(
      markdownContents(
        toDiffPresentationBlocks(
          { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
          'markdown'
        )
      )
    ).toEqual([
      {
        kind: 'removed',
        content: '```ts\nconst value = "old"\nconst stable = true\n```'
      },
      {
        kind: 'added',
        content: '```ts\nconst value = "new"\nconst stable = true\n```'
      }
    ])
  })

  it('keeps a complete multi-line list block when only an indented continuation changes', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'list-continuation-replacement',
      before: '- first item\n  old continuation\n  stable continuation\n- second item\n',
      after: '- first item\n  new continuation\n  stable continuation\n- second item\n'
    })

    expect(
      toDiffPresentationBlocks({ baseVersionId: 'v1', selectedVersionId: 'v2', lines }, 'markdown')
    ).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `- first item\n  ${markdownChange('removed', 'old')}${markdownChange('added', 'new')} continuation\n  stable continuation\n- second item`,
        startIndex: 0
      }
    ])
  })

  it('keeps a complete loose multi-item list around a changed continuation', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'loose-list-continuation-replacement',
      before:
        '- first item\n\n  old continuation\n\n- second item\n\n  stable continuation\n\nAfter list\n',
      after:
        '- first item\n\n  new continuation\n\n- second item\n\n  stable continuation\n\nAfter list\n'
    })

    expect(
      toDiffPresentationBlocks({ baseVersionId: 'v1', selectedVersionId: 'v2', lines }, 'markdown')
    ).toEqual([
      {
        kind: 'markdown',
        changeKind: 'mixed',
        content: `- first item\n\n  ${markdownChange('removed', 'old')}${markdownChange('added', 'new')} continuation\n\n- second item\n\n  stable continuation\n\nAfter list`,
        startIndex: 0
      }
    ])
  })

  it('keeps a complete blockquote around a changed lazy continuation', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'blockquote-lazy-replacement',
      before: '> opening quote\nold lazy continuation\n> adjacent quote line\n\nAfter quote\n',
      after: '> opening quote\nnew lazy continuation\n> adjacent quote line\n\nAfter quote\n'
    })

    expect(
      markdownContents(
        toDiffPresentationBlocks(
          { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
          'markdown'
        )
      )
    ).toEqual([
      {
        kind: 'removed',
        content: '> opening quote\nold lazy continuation\n> adjacent quote line'
      },
      {
        kind: 'added',
        content: '> opening quote\nnew lazy continuation\n> adjacent quote line'
      }
    ])
  })

  it('stops a changed blockquote before an independent heading and paragraph', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'blockquote-before-heading',
      before: '> old quote\n# Stable heading\nStable paragraph\n',
      after: '> new quote\n# Stable heading\nStable paragraph\n'
    })

    expect(
      markdownContents(
        toDiffPresentationBlocks(
          { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
          'markdown'
        )
      )
    ).toEqual([
      { kind: 'removed', content: '> old quote' },
      { kind: 'added', content: '> new quote' }
    ])
  })

  it('stops a changed blockquote before an independent HTML block', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'blockquote-before-html',
      before: '> old quote\n<div>stable</div>\n',
      after: '> new quote\n<div>stable</div>\n'
    })

    expect(
      markdownContents(
        toDiffPresentationBlocks(
          { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
          'markdown'
        )
      )
    ).toEqual([
      { kind: 'removed', content: '> old quote' },
      { kind: 'added', content: '> new quote' }
    ])
  })

  it('uses CommonMark ordered-list interruption rules for blockquote lazy continuation', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'blockquote-before-ordered-list',
      before: '> old quote\n2. stable lazy continuation\n1. Stable list item\n',
      after: '> new quote\n2. stable lazy continuation\n1. Stable list item\n'
    })

    expect(
      markdownContents(
        toDiffPresentationBlocks(
          { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
          'markdown'
        )
      )
    ).toEqual([
      { kind: 'removed', content: '> old quote\n2. stable lazy continuation' },
      { kind: 'added', content: '> new quote\n2. stable lazy continuation' }
    ])
  })

  it.each([
    {
      name: 'list',
      suffix: '- Stable item\n  Stable continuation\n'
    },
    {
      name: 'fenced code',
      suffix: '```ts\nconst stable = true\n```\n'
    },
    {
      name: 'thematic break',
      suffix: '---\nStable paragraph\n'
    },
    {
      name: 'table',
      suffix: '| Name | Value |\n| --- | --- |\n| A | stable |\n',
      separator: '\n'
    }
  ])(
    'stops a changed blockquote before a $name block',
    async ({ name, suffix, separator = '' }) => {
      const lines = await new ManagedTextDiffTaskRunner().run({
        requestId: `blockquote-before-${name.replaceAll(' ', '-')}`,
        before: `> old quote\n${separator}${suffix}`,
        after: `> new quote\n${separator}${suffix}`
      })

      expect(
        markdownContents(
          toDiffPresentationBlocks(
            { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
            'markdown'
          )
        )
      ).toEqual([
        { kind: 'removed', content: '> old quote' },
        { kind: 'added', content: '> new quote' }
      ])
    }
  )

  it('keeps adjacent marked quote lines and a legal paragraph lazy continuation', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'blockquote-marked-and-lazy-continuation',
      before: '> old opening\n> stable marked line\nstable lazy continuation\n\nAfter quote\n',
      after: '> new opening\n> stable marked line\nstable lazy continuation\n\nAfter quote\n'
    })

    expect(
      markdownContents(
        toDiffPresentationBlocks(
          { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
          'markdown'
        )
      )
    ).toEqual([
      {
        kind: 'removed',
        content: '> old opening\n> stable marked line\nstable lazy continuation'
      },
      {
        kind: 'added',
        content: '> new opening\n> stable marked line\nstable lazy continuation'
      }
    ])
  })

  it('keeps a complete indented code block with internal blank lines', async () => {
    const lines = await new ManagedTextDiffTaskRunner().run({
      requestId: 'indented-code-replacement',
      before:
        '    const first = true\n\n    const value = "old"\n\n    const stable = true\nAfter code\n',
      after:
        '    const first = true\n\n    const value = "new"\n\n    const stable = true\nAfter code\n'
    })

    expect(
      markdownContents(
        toDiffPresentationBlocks(
          { baseVersionId: 'v1', selectedVersionId: 'v2', lines },
          'markdown'
        )
      )
    ).toEqual([
      {
        kind: 'removed',
        content: '    const first = true\n\n    const value = "old"\n\n    const stable = true'
      },
      {
        kind: 'added',
        content: '    const first = true\n\n    const value = "new"\n\n    const stable = true'
      }
    ])
  })
})
