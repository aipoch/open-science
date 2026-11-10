import { literatureIssuedYear } from '@aipoch/literature-citations/contracts'
import type { LiteratureItemView } from '../contracts.js'

const columns = [
  'item_id',
  'title',
  'authors',
  'year',
  'item_type',
  'publication',
  'volume',
  'issue',
  'pages',
  'doi',
  'pmid',
  'pmcid',
  'arxiv_id',
  'url',
  'abstract',
  'language'
] as const

// Match screening CSV's spreadsheet conventions: BOM at the file boundary, CRLF,
// quoted fields and formula neutralization. Bibliographic text is untrusted input.
function cell(value: string | number | undefined): string {
  let text = value === undefined ? '' : String(value)
  // eslint-disable-next-line no-control-regex -- Catch formulas after leading whitespace/control characters.
  if (/^[\s\u0000-\u001f]*[=+@＝＋＠－-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`
  return `"${text.replace(/\r\n|\r|\n/g, '\r\n').replaceAll('"', '""')}"`
}

/** Only bibliographic metadata; no screening decisions, attachments or personal notes. */
export function referenceCsv(items: readonly LiteratureItemView[], includeHeader: boolean): string {
  const rows: (string | number | undefined)[][] = includeHeader ? [[...columns]] : []
  for (const { id, item } of items) {
    const identifier = (scheme: string): string =>
      item.identifiers
        .filter((entry) => entry.scheme === scheme)
        .map((entry) => entry.value)
        .join('; ')
    const field = (key: string): string | number | undefined => {
      const value = item.typeFields[key]
      return typeof value === 'string' || typeof value === 'number' ? value : undefined
    }
    rows.push([
      id,
      item.title,
      item.creators
        .filter((creator) => creator.creatorType.toLowerCase() === 'author')
        .map((creator) =>
          creator.nameMode === 'organization'
            ? creator.literalName
            : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
        )
        .join('; '),
      item.issuedYear ?? literatureIssuedYear(item.issuedText),
      item.itemType,
      item.containerTitle,
      field('volume'),
      field('issue'),
      field('pages'),
      identifier('doi'),
      identifier('pmid'),
      identifier('pmcid'),
      identifier('arxiv'),
      item.url,
      item.abstract,
      item.language
    ])
  }
  return rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}
