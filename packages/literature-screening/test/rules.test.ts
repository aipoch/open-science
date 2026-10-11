import { expect, it } from 'vitest'
import {
  formatSmartRule,
  parseSmartRule,
  smartRulePrompt,
  serializedSmartRuleSchema
} from '../src/rules.js'
it('preserves literal headings, quotes and line breaks without a Markdown round-trip', () => {
  const fields = {
    description: 'Context',
    inclusion: '## Exclusion criteria\n"Quoted" criterion',
    exclusion: 'Reviews\n\\notes'
  }
  expect(parseSmartRule(formatSmartRule(fields))).toEqual(fields)
  expect(smartRulePrompt(formatSmartRule(fields))).toContain(fields.inclusion)
})

it.each(['', 'x'.repeat(2001)])('rejects invalid inclusion length', (inclusion) => {
  expect(
    serializedSmartRuleSchema.safeParse(
      formatSmartRule({ description: '', inclusion, exclusion: '' })
    ).success
  ).toBe(false)
})
it('preserves the existing persisted JSON representation and model-facing prompt', () => {
  const serialized = '{"description":"Context","inclusion":"Trials","exclusion":"Reviews"}'
  expect(formatSmartRule(parseSmartRule(serialized)!)).toBe(serialized)
  expect(smartRulePrompt(serialized)).toBe(
    'Background:\nContext\n\nInclusion criteria (all must be met):\nTrials\n\nExclusion criteria (none may apply):\nReviews'
  )
})
