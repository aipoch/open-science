import { normalizeLiteratureDoiKeyV1, normalizeLiteratureDoiValueV1 } from '../src/doi.js'
import { describe, expect, it } from 'vitest'
import {
  createLiteratureIdentifierUrl,
  literatureIdentifierInputSchema,
  normalizeLiteratureIdentifierValue,
  normalizeLiteratureIdentifierKey,
  preferredLiteratureIdentifier
} from '../src/contracts.js'
describe('Literature identifier links', () => {
  it('normalizes resolvable identifiers and builds their canonical URLs', () => {
    expect(normalizeLiteratureIdentifierValue('doi', '10.1234/exampleCopyright')).toBe(
      '10.1234/exampleCopyright'
    )
    expect(createLiteratureIdentifierUrl('doi', '10.1234/exampleCopyright')).toBe(
      'https://doi.org/10.1234/exampleCopyright'
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
    ).toEqual({ scheme: 'doi', value: '10.1234/exampleCopyright', isPrimary: true })
  })
})

describe('identifier suffix scanning', () => {
  it.each([
    ['10.1234/exampleCOPYRIGHT', '10.1234/exampleCOPYRIGHT'],
    ['10.1234/exampleCopyright\tPublisher notice', '10.1234/exampleCopyright\tPublisher notice'],
    ['10.1234/Copyrighted', '10.1234/Copyrighted'],
    ['10.1234/aCopyrightx Copyright owner', '10.1234/aCopyrightx Copyright owner'],
    ['10.1234/aCopyright\nowner', '10.1234/aCopyright\nowner'],
    ['10.1234/aCopyright owner\nretained', '10.1234/aCopyright owner\nretained'],
    [
      '10.1234/aCopyright owner\nlastCopyright owner',
      '10.1234/aCopyright owner\nlastCopyright owner'
    ],
    ['10.1234/aCopyright\r\nretained', '10.1234/aCopyright\r\nretained'],
    ['10.1234/aCopyright\u2028owner', '10.1234/aCopyright\u2028owner'],
    ['10.1234/aCopyright owner\u2029retained', '10.1234/aCopyright owner\u2029retained'],
    ['doi: 10.1234/a(b).,;:)}]', '10.1234/a(b).,;:)}]'],
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
    expect(normalizeLiteratureIdentifierValue('doi', punctuation)).toBe(punctuation)
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

describe('opaque DOI identity', () => {
  it.each(['.', ',', ';', ':', ')', '}', ']', 'Copyright'])(
    'preserves the opaque DOI suffix %s in bare and explicitly prefixed identifiers',
    (suffix) => {
      const doi = `10.1234/example${suffix}`
      expect(normalizeLiteratureIdentifierValue('doi', doi)).toBe(doi)
      expect(normalizeLiteratureIdentifierValue('doi', `doi: ${doi}`)).toBe(doi)
      expect(normalizeLiteratureIdentifierValue('doi', '10.1234/example')).not.toBe(doi)
    }
  )

  it.each([
    ['https://doi.org/10.1234/part%23one?download=1#citation', '10.1234/part#one'],
    ['http://dx.doi.org/10.1234/part%3Fone#citation', '10.1234/part?one'],
    ['https://doi.org/10.1234/part%2523one', '10.1234/part%23one'],
    ['https://doi.org/10.1234/part%ZZ?download=1', '10.1234/part%ZZ'],
    ['https://doi.org/10.1234/part/../one', '10.1234/part/../one']
  ])('unwraps resolver URLs exactly once without normalizing opaque paths: %s', (input, doi) => {
    const parsed = literatureIdentifierInputSchema.parse({ scheme: 'doi', value: input })
    expect(parsed.value).toBe(doi)
    expect(literatureIdentifierInputSchema.parse(parsed)).toEqual(parsed)
  })

  it.each(['10.1234/part#one', '10.1234/part?one', '10.1234/part%23one'])(
    'round-trips a DOI through a navigable resolver URL: %s',
    (doi) => {
      const url = createLiteratureIdentifierUrl('doi', doi)!
      const navigated = new URL(url).href
      expect(normalizeLiteratureIdentifierValue('doi', navigated)).toBe(doi)
      expect(normalizeLiteratureIdentifierValue('doi', doi)).toBe(doi)
    }
  )

  it.each(['10.1234/part/../one', '10.1234/part/./one', '10.1234/part/..'])(
    'preserves opaque path segments after navigating a generated DOI URL: %s',
    (doi) => {
      const url = createLiteratureIdentifierUrl('doi', doi)!
      const parsed = literatureIdentifierInputSchema.parse({
        scheme: 'doi',
        value: new URL(url).href
      })
      expect(parsed.value).toBe(doi)
      expect(literatureIdentifierInputSchema.parse(parsed)).toEqual(parsed)
      expect(url).toBe(`https://doi.org/10.1234/${encodeURIComponent(doi.slice(8))}`)
    }
  )

  it.each([
    ['10.1234/\u0130', '10.1234/j'],
    ['10.1234/\u212a', '10.1234/z']
  ])('orders DOI keys without folding non-ASCII characters: %s', (first, second) => {
    expect(
      preferredLiteratureIdentifier(
        [
          { scheme: 'doi', value: first, isPrimary: false },
          { scheme: 'doi', value: second, isPrimary: false }
        ],
        'doi'
      )?.value
    ).toBe(second)
  })

  it('keeps ASCII DOI comparison and other-scheme key ordering unchanged', () => {
    expect(
      preferredLiteratureIdentifier(
        [
          { scheme: 'doi', value: '10.1234/A', isPrimary: false },
          { scheme: 'doi', value: '10.1234/b', isPrimary: false }
        ],
        'doi'
      )?.value
    ).toBe('10.1234/A')
    expect(
      preferredLiteratureIdentifier(
        [
          { scheme: 'other', value: '\u212a', isPrimary: false },
          { scheme: 'other', value: 'z', isPrimary: false }
        ],
        'other'
      )?.value
    ).toBe('\u212a')
  })

  it.each([
    ['10.1234/\u00c1', '10.1234/\u00e1'],
    ['10.1234/\uff21', '10.1234/A'],
    ['10.1234/\u0130', '10.1234/i\u0307'],
    ['10.1234/\u212a', '10.1234/K']
  ])('keeps distinct Unicode DOI keys distinct: %s and %s', (first, second) => {
    expect(normalizeLiteratureIdentifierKey('doi', first)).toBe(first)
    expect(normalizeLiteratureDoiKeyV1(first)).not.toBe(normalizeLiteratureDoiKeyV1(second))
    expect(normalizeLiteratureIdentifierKey('doi', first)).toBe(normalizeLiteratureDoiKeyV1(first))
  })

  it('shares versioned ASCII DOI keys and preserves the value separately', () => {
    const value = 'https://doi.org/10.1234/ExAmPlE%2523?download=1'
    expect(normalizeLiteratureDoiValueV1(value)).toBe('10.1234/ExAmPlE%23')
    expect(normalizeLiteratureDoiKeyV1(value)).toBe('10.1234/example%23')
    expect(normalizeLiteratureIdentifierKey('doi', value)).toBe('10.1234/example%23')
    expect(normalizeLiteratureIdentifierKey('doi', 'doi:10.1234/EXAMPLE%23')).toBe(
      '10.1234/example%23'
    )
    expect(normalizeLiteratureIdentifierKey('other', '\u00c1')).toBe('\u00e1')
  })

  it.each(['.', '..'])(
    'preserves a pure dot DOI suffix %s without generating an identity-changing link',
    (suffix) => {
      const doi = `10.1234/${suffix}`
      const parsed = literatureIdentifierInputSchema.parse({ scheme: 'doi', value: doi })
      expect(parsed.value).toBe(doi)
      expect(literatureIdentifierInputSchema.parse(parsed)).toEqual(parsed)
      expect(createLiteratureIdentifierUrl('doi', doi)).toBeUndefined()
    }
  )
})
