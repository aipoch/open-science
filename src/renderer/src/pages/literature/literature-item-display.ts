import type { LiteratureItemInput } from '../../../../shared/literature'
import { normalizeLiteratureIdentifierValue } from '../../../../shared/literature'

const creatorNames = (item: LiteratureItemInput): string[] =>
  item.creators.map((creator) =>
    creator.nameMode === 'organization'
      ? creator.literalName
      : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
  )

export const creatorLabel = (item: LiteratureItemInput): string =>
  creatorNames(item).slice(0, 3).join(', ')

export const fullCreatorLabel = (item: LiteratureItemInput): string => creatorNames(item).join(', ')

export const typeFieldText = (item: LiteratureItemInput, field: string): string => {
  const value = item.typeFields[field]
  return typeof value === 'string' ? value.trim() : ''
}

export const publicationSummary = (item: LiteratureItemInput): string => {
  const publication = typeFieldText(item, 'journalAbbreviation') || item.containerTitle
  const date = item.issuedText || item.issuedYear?.toString() || ''
  const volume = typeFieldText(item, 'volume')
  const issue = typeFieldText(item, 'issue')
  const pages = typeFieldText(item, 'pages')
  const doiIdentifier = item.identifiers.find((identifier) => identifier.scheme === 'doi')
  const doi = doiIdentifier
    ? normalizeLiteratureIdentifierValue(doiIdentifier.scheme, doiIdentifier.value)
    : undefined
  const volumeIssue = `${volume}${issue ? `(${issue})` : ''}`
  const volumeIssuePages = volumeIssue && pages ? `${volumeIssue}:${pages}` : volumeIssue || pages
  const citation = `${[publication, date].filter(Boolean).join('. ')}${
    volumeIssuePages ? `${publication || date ? ';' : ''}${volumeIssuePages}` : ''
  }`
  return [citation, doi ? `doi: ${doi}` : ''].filter(Boolean).join('. ')
}

export const getExternalLiteratureUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

const normalizedMetadataValue = (value: string): string =>
  value
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .replace(/[.\s]+$/gu, '')
    .toLocaleLowerCase()

export const metadataValuesMatch = (currentValue: string, candidateValue: string): boolean =>
  normalizedMetadataValue(currentValue) === normalizedMetadataValue(candidateValue)

export const itemDescription = (item: LiteratureItemInput): string =>
  [creatorLabel(item), item.issuedYear, item.containerTitle].filter(Boolean).join(' · ')

export const inboxProviderLabel = (provider: string): string => {
  const trimmedProvider = provider.trim()
  return trimmedProvider.toLocaleLowerCase() === 'pubmed' ? 'PubMed' : trimmedProvider
}
