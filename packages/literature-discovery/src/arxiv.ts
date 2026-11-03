import { SaxesParser } from 'saxes'
import { metadataProposalSchema } from './metadata-merge.js'
import { normalizeIdentifier } from './identifiers.js'
import { LiteratureProviderError } from './provider-error.js'

/** Decode one bounded Atom response, requiring an unambiguous match to the requested identity. */
export function parseArxivRecord(
  xml: string,
  id: string
): {
  item: ReturnType<typeof metadataProposalSchema.parse>
  rawMetadata: Record<string, string[]>
} {
  const atom = 'http://www.w3.org/2005/Atom'
  const parser = new SaxesParser({ xmlns: true })
  const path: string[] = []
  const entries: Record<string, string[]>[] = []
  let entry: Record<string, string[]> | undefined
  let field: string | undefined
  let text = ''
  parser.on('doctype', () => {
    throw new Error('arXiv metadata must not contain a DTD.')
  })
  parser.on('opentag', (tag) => {
    if (path.length >= 16) throw new Error('arXiv metadata is nested too deeply.')
    path.push(
      tag.uri === atom
        ? tag.local
        : tag.uri === 'http://arxiv.org/schemas/atom' && tag.local === 'doi'
          ? 'arxiv:doi'
          : ''
    )
    if (path.join('/') === 'feed/entry') entry = {}
    if (!entry) return
    const location = path.join('/')
    if (
      [
        'feed/entry/id',
        'feed/entry/title',
        'feed/entry/summary',
        'feed/entry/published',
        'feed/entry/arxiv:doi',
        'feed/entry/author/name'
      ].includes(location)
    ) {
      field = location
      text = ''
    }
  })
  const append = (value: string): void => {
    if (field) text += value
  }
  parser.on('text', append)
  parser.on('cdata', append)
  parser.on('closetag', () => {
    if (entry && field === path.join('/')) {
      const key = path[path.length - 1]
      const values = (entry[key] ??= [])
      if (key !== 'name' && values.length)
        throw new Error('arXiv metadata contains repeated fields.')
      values.push(text.replace(/\s+/gu, ' ').trim())
      field = undefined
    }
    if (path.join('/') === 'feed/entry' && entry) {
      entries.push(entry)
      entry = undefined
    }
    path.pop()
  })
  parser.write(xml).close()
  const record = entries[0]
  const returnedId = record?.id?.[0]
  if (
    entries.length !== 1 ||
    !returnedId ||
    !/^https?:\/\/arxiv\.org\/abs\//u.test(returnedId) ||
    normalizeIdentifier('arxiv', returnedId) !== id ||
    !record.title?.[0]
  )
    throw new LiteratureProviderError(404)
  const rawDoi = record['arxiv:doi']?.[0] ?? ''
  const doi = normalizeIdentifier('doi', rawDoi)
  const hasExactDoi = /^10\.\d{4,9}\/\S+$/u.test(rawDoi)
  const published = record.published?.[0]?.slice(0, 10) ?? ''
  const item = metadataProposalSchema.parse({
    itemType: 'preprint',
    title: record.title[0],
    abstract: record.summary?.[0] ?? '',
    url: `https://arxiv.org/abs/${id}`,
    issuedText: published,
    ...(/^\d{4}-\d{2}-\d{2}$/u.test(published)
      ? { issuedYear: Number(published.slice(0, 4)) }
      : {}),
    identifiers: [
      { scheme: 'arxiv', value: id, isPrimary: true },
      ...(hasExactDoi ? [{ scheme: 'doi', value: doi, isPrimary: false }] : [])
    ],
    creators: (record.name ?? []).filter(Boolean).map((name) => ({
      nameMode: 'person',
      familyName: name,
      givenName: '',
      creatorType: 'author'
    }))
  })
  return { item, rawMetadata: record }
}
