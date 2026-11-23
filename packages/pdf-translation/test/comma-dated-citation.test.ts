import { expect, it } from 'vitest'
import { translatedPdfLinkFragment } from '../resources/link-labels.mjs'

const source = 'Please see Alder, Evans, Holt (2018) and then Alder, Evans, Holt (2018).'
const translation = '参阅 Alder、Evans、Holt（2018），再参阅 Alder、Evans、Holt（2018）。'

it('maps linked citation fragments by complete ordered names and year', () => {
  for (const [from, to] of [
    ['Alder, Evans,', 'Alder、Evans、'],
    ['Holt', 'Holt'],
    ['2018', '2018']
  ]) {
    expect(translatedPdfLinkFragment(source, translation, from, source.lastIndexOf(from))).toEqual({
      start: translation.lastIndexOf(to),
      text: to
    })
  }
})

it.each([
  ['missing repeat', '仅参阅 Alder、Evans、Holt（2018）。'],
  ['changed year', translation.replace('2018', '2019')],
  ['reordered authors', translation.replace('Alder、Evans', 'Evans、Alder')],
  ['unclosed reference', translation.replace('2018）', '2018)')]
])('rejects a linked fragment with %s', (_, target) => {
  const label = 'Alder, Evans,'
  expect(translatedPdfLinkFragment(source, target, label, source.indexOf(label))).toBeNull()
})

it('rejects an incomplete linked surname', () => {
  expect(translatedPdfLinkFragment(source, translation, 'lder', source.indexOf('lder'))).toBeNull()
})
