import { describe, expect, it } from 'vitest'

import vitestConfig, { coverageThresholdsEnabled, VITEST_EXCLUDE_PATTERNS } from './vitest.config'

describe('Vitest discovery boundaries', () => {
  it.each(['**/.pnpm-store/**', '**/tmp/**', '**/.worktrees/**', '**/.worktree/**'])(
    'excludes %s from recursive test discovery',
    (pattern) => {
      expect(VITEST_EXCLUDE_PATTERNS).toContain(pattern)
    }
  )
})

it('defers coverage thresholds only for explicit shard collection', () => {
  expect(coverageThresholdsEnabled({})).toBe(true)
  expect(coverageThresholdsEnabled({ VITEST_DEFER_COVERAGE_THRESHOLDS: '1' })).toBe(false)
  expect(coverageThresholdsEnabled({ VITEST_DEFER_COVERAGE_THRESHOLDS: '0' })).toBe(true)
})

it('keeps a safe default timeout for schema-backed hooks', () => {
  expect(vitestConfig.test?.hookTimeout).toBe(30_000)
})
