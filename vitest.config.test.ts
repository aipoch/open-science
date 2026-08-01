import { describe, expect, it } from 'vitest'

import { VITEST_EXCLUDE_PATTERNS } from './vitest.config'

describe('Vitest discovery boundaries', () => {
  it.each(['**/.pnpm-store/**', '**/tmp/**', '**/.worktrees/**', '**/.worktree/**'])(
    'excludes %s from recursive test discovery',
    (pattern) => {
      expect(VITEST_EXCLUDE_PATTERNS).toContain(pattern)
    }
  )
})
