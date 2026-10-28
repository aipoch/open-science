import { expect, it } from 'vitest'
import { parseUseCases } from './use-cases'

const item = {
  name: 'gold-vs-bitcoin',
  title: 'Gold vs Bitcoin',
  cover: { file_name: 'Gold & Bitcoin.png' },
  case: { file_name: 'Gold.science', bytes: 3, sha256: 'a'.repeat(64) }
}

it('uses published slugs and encoded resource names instead of source paths or titles', () => {
  expect(parseUseCases([{ ...item, path: '/private/source' }])[0]).toEqual({
    slug: 'gold-vs-bitcoin',
    title: 'Gold vs Bitcoin',
    imageUrl:
      'https://statics.aipoch.com/open-science/usecases/gold-vs-bitcoin/Gold%20%26%20Bitcoin.png',
    packageUrl: 'https://statics.aipoch.com/open-science/usecases/gold-vs-bitcoin/Gold.science',
    sizeBytes: 3,
    sha256: 'a'.repeat(64)
  })
})

it('rejects traversal, duplicate identities and invalid archive metadata', () => {
  for (const value of [
    [{ ...item, name: '../escape' }],
    [item, item],
    [{ ...item, cover: { file_name: '../cover.png' } }],
    [{ ...item, case: { ...item.case, bytes: -1 } }],
    [{ ...item, case: { ...item.case, sha256: 'bad' } }]
  ])
    expect(() => parseUseCases(value)).toThrow()
})
