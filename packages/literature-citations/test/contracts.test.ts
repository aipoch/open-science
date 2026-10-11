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
