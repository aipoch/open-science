import { expect, it } from 'vitest'
import { translatedPdfLinkFragment } from '../resources/link-labels.mjs'

const year = '2018a'
const source = 'See (Alder Holt et al. 2018a). Another comparison uses (Alder Holt et al. 2018a).'
const translation = '可参阅（Alder Holt 等人 2018a）。另一个比较使用（Alder Holt 等人 2018a）。'

it('keeps each linked year with its closed citation occurrence', () => {
  const text = '2018a 是一个编号。' + translation
  for (const offset of [source.indexOf(year), source.lastIndexOf(year)]) {
    expect(translatedPdfLinkFragment(source, text, year, offset)).toEqual({
      start:
        offset === source.indexOf(year) ? text.indexOf(year, year.length) : text.lastIndexOf(year),
      text: year
    })
  }
})

it.each([
  ['different author', translation.replace('Alder', 'Evans')],
  ['different year suffix', translation.replace('2018a', '2018b')],
  ['missing repeat', '（Alder Holt 等人 2018a）'],
  ['mixed closing bracket', translation.replace('2018a）', '2018a)')]
])('retains the original link when its closed citation has a %s', (_, target) => {
  expect(translatedPdfLinkFragment(source, target, year, source.indexOf(year))).toBeNull()
})
