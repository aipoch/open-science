import { describe, expect, it, vi } from 'vitest'

import { changedFormattingPaths, selectFormattingPaths } from './check-changed-format.mjs'

describe('changed-file formatting selection', () => {
  it('separates Markdown from other Prettier-supported candidates', () => {
    const paths = ['README.md', 'docs/guide.mdx', 'src/main/index.ts', 'assets/icon.bin']

    expect(selectFormattingPaths(paths, 'markdown')).toEqual(['README.md', 'docs/guide.mdx'])
    expect(selectFormattingPaths(paths, 'non-markdown')).toEqual([
      'src/main/index.ts',
      'assets/icon.bin'
    ])
  })

  it('formats the merge-base diff and skips files missing from the work tree', () => {
    const base = 'b'.repeat(40)
    const head = 'c'.repeat(40)
    const mergeBase = 'a'.repeat(40)
    const execute = vi.fn((command, arguments_) => {
      expect(command).toBe('git')
      if (arguments_[0] === 'merge-base') return `${mergeBase}\n`
      return Buffer.from(
        ['README.md', 'src/main/index.ts', 'src/main/session-artifact-file-resolver.ts'].join(
          '\0'
        ) + '\0'
      )
    })
    const exists = (path: string): boolean => path !== 'src/main/session-artifact-file-resolver.ts'

    expect(changedFormattingPaths(base, head, 'non-markdown', { execute, exists })).toEqual([
      'src/main/index.ts'
    ])
    expect(execute).toHaveBeenNthCalledWith(1, 'git', ['merge-base', base, head], {
      encoding: 'utf8'
    })
    expect(execute).toHaveBeenNthCalledWith(2, 'git', [
      'diff',
      '--name-only',
      '--diff-filter=ACMR',
      '-z',
      mergeBase,
      head
    ])
  })
})
