import { describe, expect, it } from 'vitest'

import { selectFormattingPaths } from './check-changed-format.mjs'

describe('changed-file formatting selection', () => {
  it('separates Markdown from other Prettier-supported candidates', () => {
    const paths = ['README.md', 'docs/guide.mdx', 'src/main/index.ts', 'assets/icon.bin']

    expect(selectFormattingPaths(paths, 'markdown')).toEqual(['README.md', 'docs/guide.mdx'])
    expect(selectFormattingPaths(paths, 'non-markdown')).toEqual([
      'src/main/index.ts',
      'assets/icon.bin'
    ])
  })
})
