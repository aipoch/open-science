import { expect, it } from 'vitest'
import { readPdfTranslationCases } from '../fixtures/read-cases'
import {
  nativeMixedBulletOwners,
  nativeMixedBulletLiteralsMatch
} from '../../src/reader/native-mixed-bullet.js'
import { groupPdfTranslationPages, type PdfLayoutPage } from '../../src/reader/layout.js'

const fixture = readPdfTranslationCases<{ page: PdfLayoutPage }>('mixed-bullet-native.jsonl')[0]
function page(): PdfLayoutPage {
  return structuredClone(fixture.page)
}

it('proves the complete native typed tail and reconstructs it after serialization', () => {
  const input = page(),
    proof = nativeMixedBulletOwners(input.items)
  expect(proof).toHaveLength(1)
  expect(proof[0].proved).toBe(true)
  expect(proof[0].literals).toEqual(['[TOKEN]', 'red fox → red [TOKEN]'])
  expect(nativeMixedBulletOwners(JSON.parse(JSON.stringify(input.items)))).toEqual(proof)
  const owner = groupPdfTranslationPages({ pages: [input] }).units.find((u) =>
    u.items.includes('1:0')
  )!
  expect(owner.items).toContain(`1:${proof[0].tailIndices[0]}`)
  expect(owner.sourceOnly).toBeUndefined()
})

it.each([
  'rail',
  'pitch',
  'font',
  'rotation',
  'native-gap',
  'peer',
  'excluded',
  'zero-width',
  'nonfinite-height',
  'transform-length',
  'word-order',
  'no-code-type',
  'missing-arrow',
  'middle-font',
  'middle-size'
])('retains a candidate without granting ownership after loss of %s proof', (fault) => {
  const input = page(),
    tail = input.items[6]
  if (fault === 'rail') tail.transform[4] += 6
  if (fault === 'pitch') tail.transform[5] -= 5
  if (fault === 'font') tail.fontName = 'other'
  if (fault === 'rotation') tail.transform[1] = 1
  if (fault === 'native-gap') input.items.splice(6, 0, { ...tail, str: '', hasEOL: true })
  if (fault === 'peer') input.items.splice(8)
  if (fault === 'zero-width') tail.width = 0
  if (fault === 'nonfinite-height') tail.height = Number.NaN
  if (fault === 'transform-length') tail.transform.push(0)
  if (fault === 'word-order') input.items[4].transform[4] = input.items[3].transform[4] - 5
  if (fault === 'no-code-type') for (const item of input.items) item.fontFamily = 'serif'
  if (fault === 'missing-arrow') input.items[5].str = ':'
  if (fault === 'middle-font') input.items[3].fontName = 'other'
  if (fault === 'middle-size') input.items[3].transform[3] = 4
  const proofs = nativeMixedBulletOwners(input.items, {}, new Set(fault === 'excluded' ? [6] : []))
  expect(proofs.length).toBeGreaterThan(0)
  expect(proofs.every((proof) => !proof.proved)).toBe(true)
  const owner = groupPdfTranslationPages({ pages: [input] }).units.find((u) =>
    u.items.includes('1:0')
  )!
  if (fault !== 'excluded') expect(owner.items).not.toContain(`1:${fault === 'native-gap' ? 7 : 6}`)
})

it.each(['[TOKEN] 例如 red fox → red [TOKEN]', '[TOKEN] 例如 red  fox → red\n[TOKEN]'])(
  'accepts unchanged ordered literals in translated prose: %s',
  (text) => {
    expect(nativeMixedBulletLiteralsMatch(['[TOKEN]', 'red fox → red [TOKEN]'], text)).toBe(true)
  }
)
it.each([
  '[TOKEN] 例如 blue fox → red [TOKEN]',
  '[TOKEN] 例如 redfox → red [TOKEN]',
  'red fox → red [TOKEN] 然后 [TOKEN]',
  '[TOKEN] 例如 red fox → red',
  '[TOKEN] [TOKEN] 例如 red fox → red [TOKEN]'
])('rejects changed, missing, reordered or duplicated literals: %s', (text) => {
  expect(nativeMixedBulletLiteralsMatch(['[TOKEN]', 'red fox → red [TOKEN]'], text)).toBe(false)
})

it.each(['seed1', 'seed_value', '1seed', '_seed'])(
  'rejects a literal embedded in an identifier: %s',
  (text) => {
    expect(nativeMixedBulletLiteralsMatch(['seed'], text)).toBe(false)
  }
)
