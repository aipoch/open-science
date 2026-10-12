import { describe, expect, it } from 'vitest'
import { literatureItemInputSchema } from './literature-item'

describe('literature item snapshot contract', () => {
  const item = { itemType: 'journalArticle', title: 'A cited paper' }

  it('retains bibliographic defaults without adding optional host metadata', () => {
    const parsed = literatureItemInputSchema.parse(item)
    expect(parsed).toMatchObject({ ...item, creators: [], identifiers: [], typeFields: {} })
    expect(parsed).not.toHaveProperty('rating')
    expect(parsed).not.toHaveProperty('personalNote')
    expect(literatureItemInputSchema.parse(parsed)).toEqual(parsed)
  })

  it('preserves rating endpoints and normalized notes in persisted snapshots', () => {
    for (const rating of [0, 5]) {
      const parsed = literatureItemInputSchema.parse({ ...item, rating, personalNote: '  note  ' })
      expect(parsed).toMatchObject({ rating, personalNote: 'note' })
      expect(literatureItemInputSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed)
    }
    expect(
      literatureItemInputSchema.parse({ ...item, personalNote: 'a'.repeat(10_000) }).personalNote
    ).toHaveLength(10_000)
  })

  it.each([
    { reason: 'negative ratings', fields: { rating: -1 } },
    { reason: 'ratings above five', fields: { rating: 6 } },
    { reason: 'fractional ratings', fields: { rating: 1.5 } },
    { reason: 'oversized notes', fields: { personalNote: 'a'.repeat(10_001) } },
    { reason: 'unknown fields', fields: { unrecognizedField: true } },
    { reason: 'invalid item types', fields: { itemType: 'not-a-literature-type' } }
  ])('rejects $reason instead of silently changing snapshots', ({ fields }) => {
    expect(literatureItemInputSchema.safeParse({ ...item, ...fields }).success).toBe(false)
  })
})
