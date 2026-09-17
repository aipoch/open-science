import { expect, it } from 'vitest'
import { SESSION_DETAILS_TITLE_MAX_LENGTH } from '../../shared/session-persistence'
import { nextForkTitle } from './fork-session'

it.each([
  ['Study', [], 'Study(2)'],
  ['Study', ['Study(2)', 'Study(3)'], 'Study(4)'],
  ['Study(2)', [], 'Study(2)(2)'],
  ['文'.repeat(80), [], `${'文'.repeat(77)}(2)`],
  ['x'.repeat(1000), [], `${'x'.repeat(77)}(2)`],
  ['x'.repeat(76) + '😀tail', [], `${'x'.repeat(76)}(2)`],
  ['x'.repeat(76) + 'e\u0301tail', [], `${'x'.repeat(76)}(2)`],
  ['x'.repeat(76) + '👩‍🔬tail', [], `${'x'.repeat(76)}(2)`],
  ['x'.repeat(75) + '😀tail', [], `${'x'.repeat(75)}😀(2)`],
  ['x'.repeat(80), [`${'x'.repeat(77)}(2)`], `${'x'.repeat(77)}(3)`],
  [
    'x'.repeat(80),
    Array.from({ length: 8 }, (_, i) => `${'x'.repeat(77)}(${i + 2})`),
    `${'x'.repeat(76)}(10)`
  ]
] as const)(
  'allocates a bounded title without splitting characters (%s)',
  (source, existing, expected) => {
    const title = nextForkTitle(source, existing)
    expect(title).toBe(expected)
    expect(title.length).toBeLessThanOrEqual(SESSION_DETAILS_TITLE_MAX_LENGTH)
    expect(existing).not.toContain(title)
  }
)
