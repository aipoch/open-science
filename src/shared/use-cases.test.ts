import { expect, it } from 'vitest'
import { parseUseCases, useCaseCatalogContract } from './use-cases'

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

it('preserves published categories and introduction assets for in-app browsing', () => {
  expect(
    parseUseCases([
      {
        ...item,
        catalog: 'Science',
        catalog_name: 'science',
        introduction: { file_name: 'Research intro.md' }
      }
    ])[0]
  ).toMatchObject({
    category: 'Science',
    categoryKey: 'science',
    introductionUrl:
      'https://statics.aipoch.com/open-science/usecases/gold-vs-bitcoin/Research%20intro.md'
  })
  expect(() => parseUseCases([{ ...item, introduction: { file_name: '../private.md' } }])).toThrow()
})

it('carries optional YouTube metadata through the catalog contract', () => {
  const id = 'OThnK2w5mMg'
  for (const path of [
    'https://www.youtube.com/watch?v=' + id,
    'https://youtu.be/' + id + '?t=12',
    'https://m.youtube.com/shorts/' + id,
    'https://youtube.com/embed/' + id
  ]) {
    const cases = parseUseCases([
      { ...item, video: { type: 'youtube', file_path: path, file_name: 'Film' } }
    ])
    expect(useCaseCatalogContract.result.parse(cases)[0].video).toEqual({ id, title: 'Film' })
  }
  for (const video of [
    null,
    'invalid',
    { type: 'other', file_path: 'https://youtu.be/' + id },
    ...[
      'not a URL',
      'http://youtu.be/' + id,
      'https://other.example/' + id,
      'https://user@youtu.be/' + id,
      'https://youtu.be/short'
    ].map((file_path) => ({ type: 'youtube', file_path }))
  ]) {
    expect(parseUseCases([{ ...item, video }])[0]).not.toHaveProperty('video')
  }
})
