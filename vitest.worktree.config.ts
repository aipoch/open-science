// Local-only: the base config excludes `**/.claude/**`, which matches this whole worktree path and
// makes every run report "no tests found". Filter that one pattern out instead of rebuilding the list.
import baseConfig, { VITEST_EXCLUDE_PATTERNS } from './vitest.config'

const config = {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    exclude: VITEST_EXCLUDE_PATTERNS.filter((pattern) => !pattern.includes('.claude'))
  }
}

export default config
