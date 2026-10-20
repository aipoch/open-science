import { describe, expect, it } from 'vitest'
import {
  createLiteratureIdentifierUrl,
  literatureIdentifierInputSchema,
  normalizeLiteratureIdentifierValue
} from '../src/contracts.js'
describe('Literature identifier links', () => {
  it('normalizes resolvable identifiers and builds their canonical URLs', () => {
    expect(normalizeLiteratureIdentifierValue('doi', '10.1234/exampleCopyright')).toBe(
      '10.1234/example'
    )
    expect(createLiteratureIdentifierUrl('doi', '10.1234/exampleCopyright')).toBe(
      'https://doi.org/10.1234/example'
    )
    expect(createLiteratureIdentifierUrl('pmid', 'PMID: 32877581')).toBe(
      'https://pubmed.ncbi.nlm.nih.gov/32877581/'
    )
    expect(
      normalizeLiteratureIdentifierValue(
        'pmid',
        'https://pubmed.ncbi.nlm.nih.gov/12345678/?from=library'
      )
    ).toBe('12345678')
    expect(createLiteratureIdentifierUrl('pmcid', '7610567')).toBe(
      'https://pmc.ncbi.nlm.nih.gov/articles/PMC7610567/'
    )
    expect(
      normalizeLiteratureIdentifierValue(
        'pmcid',
        'https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/'
      )
    ).toBe('PMC1234567')
    expect(
      normalizeLiteratureIdentifierValue(
        'arxiv',
        'https://arxiv.org/pdf/2401.12345v2.pdf?download=1'
      )
    ).toBe('2401.12345')
    expect(createLiteratureIdentifierUrl('arxiv', 'arXiv:2401.12345v2')).toBe(
      'https://arxiv.org/abs/2401.12345'
    )
    expect(createLiteratureIdentifierUrl('issn', '0028-4793')).toBeUndefined()
  })

  it('canonicalizes identifier values at the input boundary', () => {
    expect(
      literatureIdentifierInputSchema.parse({
        scheme: 'doi',
        value: 'https://doi.org/10.1234/exampleCopyright',
        isPrimary: true
      })
    ).toEqual({ scheme: 'doi', value: '10.1234/example', isPrimary: true })
  })
})

describe('identifier suffix scanning', () => {
  it.each([
    ['10.1234/exampleCOPYRIGHT', '10.1234/example'],
    ['10.1234/exampleCopyright\tPublisher notice', '10.1234/example'],
    ['10.1234/Copyrighted', '10.1234/Copyrighted'],
    ['10.1234/aCopyrightx Copyright owner', '10.1234/aCopyrightx'],
    ['10.1234/aCopyright\nowner', '10.1234/a'],
    ['10.1234/aCopyright owner\nretained', '10.1234/aCopyright owner\nretained'],
    ['10.1234/aCopyright owner\nlastCopyright owner', '10.1234/aCopyright owner\nlast'],
    ['10.1234/aCopyright\r\nretained', '10.1234/aCopyright\r\nretained'],
    ['10.1234/aCopyright\u2028owner', '10.1234/a'],
    ['10.1234/aCopyright owner\u2029retained', '10.1234/aCopyright owner\u2029retained'],
    ['doi: 10.1234/a(b).,;:)}]', '10.1234/a(b'],
    ['10.1234/a)b', '10.1234/a)b']
  ])('preserves DOI suffix semantics for %j', (input, expected) => {
    expect(normalizeLiteratureIdentifierValue('doi', input)).toBe(expected)
  })

  it.each([
    ['https://arxiv.org/pdf/2401.12345v2.pdf?download=1#page=2', '2401.12345'],
    ['arxiv:2401.12345v2#page=2?download=1', '2401.12345'],
    ['2401.12345?keep\nrest#remove', '2401.12345?keep\nrest'],
    ['2401.12345#keep\u2028rest?remove', '2401.12345#keep\u2028rest'],
    ['2401.12345?keep\rrest', '2401.12345?keep\rrest'],
    ['2401.12345#keep\u2029rest', '2401.12345#keep\u2029rest']
  ])('preserves arXiv suffix semantics for %j', (input, expected) => {
    expect(normalizeLiteratureIdentifierValue('arxiv', input)).toBe(expected)
  })

  it('handles long punctuation and suffix near misses without repeated tail matching', () => {
    const punctuation = '10.1234/' + ')'.repeat(100_000)
    expect(normalizeLiteratureIdentifierValue('doi', punctuation)).toBe('10.1234/')
    expect(normalizeLiteratureIdentifierValue('doi', punctuation + 'x')).toBe(punctuation + 'x')
    const copyright = '10.1234/' + 'Copyright\t'.repeat(10_000) + '\nkeep'
    expect(normalizeLiteratureIdentifierValue('doi', copyright)).toBe(copyright)
    const fragments = '2401.12345' + '#'.repeat(100_000)
    expect(normalizeLiteratureIdentifierValue('arxiv', fragments)).toBe('2401.12345')
    expect(normalizeLiteratureIdentifierValue('arxiv', fragments + '\nkeep')).toBe(
      fragments + '\nkeep'
    )
  })
})
