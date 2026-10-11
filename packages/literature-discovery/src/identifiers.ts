import {
  normalizeLiteratureIdentifierValue,
  type LiteratureIdentifierScheme
} from '@aipoch/literature-citations/contracts'
const normalizeSpace = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
const normalizeIdentifier = (scheme: LiteratureIdentifierScheme, rawValue: string): string => {
  const value = normalizeSpace(rawValue)
  switch (scheme) {
    case 'doi':
      return normalizeLiteratureIdentifierValue(scheme, value).toLowerCase()
    case 'pmid':
      return normalizeLiteratureIdentifierValue(scheme, value)
    case 'pmcid':
      return normalizeLiteratureIdentifierValue(scheme, value)
    case 'arxiv':
      return normalizeLiteratureIdentifierValue(scheme, value).toLowerCase()
    case 'isbn':
    case 'issn':
      return value.replace(/[^0-9X]/giu, '').toUpperCase()
    case 'other':
      return value.toLowerCase()
  }
}

export { normalizeIdentifier }
