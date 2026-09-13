import type { TFunction } from 'i18next'

// Generated Skill documents retain the full API contract. Settings uses concise localized copy.
export function connectorDescription(
  connector: { id: string; description: string },
  t: TFunction
): string {
  return connector.id === 'literature'
    ? t('Literature and research data via OpenAlex, arXiv, Crossref and DataCite.')
    : connector.description
}

export function connectorToolDescription(id: string, fallback: string, t: TFunction): string {
  switch (id) {
    case 'rna/search_sequence':
      return t(
        'Search RNA/DNA against Rfam models. Cancelling stops polling; the service retains results for one week.'
      )
    case 'literature/crossref_get_work':
      return t('Retrieve publisher-deposited bibliographic metadata by DOI.')
    case 'literature/crossref_get_updates':
      return t(
        'Find deposited corrections and retractions. Missing updates do not establish reliability.'
      )
    case 'literature/datacite_search_records':
      return t('Find datasets and software by topic or related DOI.')
    case 'literature/datacite_get_record':
      return t('Retrieve dataset metadata, rights and publication relationships by DOI.')
    default:
      return fallback
  }
}
