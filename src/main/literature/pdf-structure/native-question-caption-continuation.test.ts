import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { readPdfFixture } from './read-fixture'
const module = await import(
  pathToFileURL(
    resolve(
      process.env.PDF_QUESTION_CONTINUATION_MODULE ??
        'resources/pdf-structure/literature-pdf-native-question-continuation.mjs'
    )
  ).href
)
const fixture = (): ReturnType<typeof JSON.parse> =>
  readPdfFixture(
    resolve(
      'src/main/literature/pdf-structure/fixtures/source-grids/native-closed-mixed-question-caption-continuation.jsonl'
    )
  )
const recover = (x: ReturnType<typeof fixture>): ReturnType<typeof JSON.parse> =>
  module.recoverNativeQuestionContinuationCaption?.(
    x.table,
    x.items,
    x.rules,
    x.pageNumber,
    x.previousItems,
    x.previousRules,
    x.captions
  )
it('inherits exactly the original caption through native mixed-schema and consecutive-question proof', () => {
  const x = fixture(),
    before = JSON.stringify(x),
    caption = recover(x)
  expect(caption).toBe(x.captions[0])
  expect(JSON.stringify(x)).toBe(before)
})
it.each([
  'nonadjacent page',
  'local new caption',
  'competing previous caption',
  'missing previous caption',
  'missing quantitative closing',
  'missing qualitative closing',
  'missing current closing',
  'different leaf lanes',
  'nonsequential questions',
  'nonfirst previous question',
  'different font',
  'prose inside grid',
  'prose between schemas',
  'missing theme count'
])('rejects caption continuation with %s', (variant) => {
  const x = fixture()
  if (variant === 'nonadjacent page') x.pageNumber++
  if (variant === 'local new caption') x.captions.push({ ...x.captions[0], page: 2 })
  if (variant === 'competing previous caption')
    x.captions.push({ ...x.captions[0], lines: ['Table 2. Another set'] })
  if (variant === 'missing previous caption') x.captions = []
  if (variant === 'missing quantitative closing') x.previousRules.splice(8, 4)
  if (variant === 'missing qualitative closing') x.previousRules.splice(-3)
  if (variant === 'missing current closing') x.rules.splice(-3)
  if (variant === 'different leaf lanes')
    for (const r of x.rules) {
      if (r[0] > 139 && r[0] < 141) r[0] += 1
      if (r[2] > 139 && r[2] < 141) r[2] += 1
    }
  if (variant === 'nonsequential questions')
    x.items.find((i: { text: string }) => i.text.startsWith('3.')).text = '4. Describe another'
  if (variant === 'nonfirst previous question')
    x.previousItems.find((i: { text: string }) => i.text === '1. Please describe').text =
      '2. Please describe'
  if (variant === 'different font') for (const i of x.items) i.height *= 1.3
  if (variant === 'prose inside grid')
    x.items.push({
      text: 'Independent article paragraph.',
      horizontal: true,
      height: 8,
      baseline: 171,
      rect: [44, 163, 351, 171]
    })
  if (variant === 'prose between schemas')
    x.previousItems.push({
      text: 'Article prose.',
      horizontal: true,
      height: 8,
      baseline: 232,
      rect: [44, 224, 160, 232]
    })
  if (variant === 'missing theme count')
    x.items.find((i: { text: string }) => i.text === '(n=7)').text = 'ordinary prose'
  expect(recover(x)).toBeUndefined()
})
