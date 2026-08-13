// Throwaway. The base config excludes '**/.claude/**', which matches this whole worktree path, so a
// local run finds zero tests. Filter that one pattern out of the base list rather than rebuilding it.
import base from './vitest.config'

const config = base as { test?: { exclude?: string[] } }

if (config.test?.exclude) {
  config.test.exclude = config.test.exclude.filter(
    (pattern) => pattern !== '**/.claude/**' && pattern !== '**/.worktrees/**'
  )
}

export default base
