import { expect, it } from 'vitest'
import { formatSmartRule, parseSmartRule, smartRulePrompt } from './smart-collection-rule'
import { literatureCatalogCommandSchema } from './literature'

it('preserves literal headings, quotes and line breaks without a Markdown round-trip', () => {
  const fields = {
    description: 'Context',
    inclusion: '## Exclusion criteria\n"Quoted" criterion',
    exclusion: 'Reviews\n\\notes'
  }
  expect(parseSmartRule(formatSmartRule(fields))).toEqual(fields)
  expect(smartRulePrompt(formatSmartRule(fields))).toContain(fields.inclusion)
})

it('uses the same content limit and required inclusion across create, preview and edit', () => {
  const commands = [
    { kind: 'create-smart-collection', name: 'Trials', scope: { kind: 'library' } },
    { kind: 'preview-smart-collection', requestId: 'preview', scope: { kind: 'library' } },
    {
      kind: 'update-collection',
      collectionId: 'trials',
      expectedRevision: 1,
      name: 'Trials',
      smartScope: { kind: 'library' }
    }
  ]
  for (const command of commands) {
    for (const length of [1001, 2000]) {
      const description = formatSmartRule({
        description: '',
        inclusion: '"'.repeat(length),
        exclusion: ''
      })
      expect(literatureCatalogCommandSchema.safeParse({ ...command, description }).success).toBe(
        true
      )
    }
    for (const inclusion of ['', 'x'.repeat(2001)]) {
      const description = formatSmartRule({ description: '', inclusion, exclusion: '' })
      expect(literatureCatalogCommandSchema.safeParse({ ...command, description }).success).toBe(
        false
      )
    }
    expect(
      literatureCatalogCommandSchema.safeParse({ ...command, description: 'Free-form rule' })
        .success
    ).toBe(false)
  }
})

it('accepts a full length structured edit without resubmitting the unchanged scope', () => {
  expect(
    literatureCatalogCommandSchema.safeParse({
      kind: 'update-collection',
      collectionId: 'trials',
      expectedRevision: 1,
      name: 'Trials',
      description: formatSmartRule({ description: '', inclusion: 'x'.repeat(2000), exclusion: '' })
    }).success
  ).toBe(true)
})
