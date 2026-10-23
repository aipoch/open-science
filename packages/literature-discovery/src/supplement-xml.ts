import { SaxesParser } from 'saxes'
import { normalizeSupplementDoi, type LiteratureSupplementRecord } from './supplement-contracts.js'

export function parseSupplementXml(
  xml: string,
  doi: string,
  pmcid: string
): { records: LiteratureSupplementRecord[]; truncated: boolean } {
  // Saxes does not fetch external DTDs. Internal entity declarations are unnecessary here.
  if (/<!ENTITY/iu.test(xml)) throw new Error('Unsupported XML entity declaration.')
  const parser = new SaxesParser({ xmlns: true })
  const path: string[] = []
  const identifiers: string[] = []
  const records: LiteratureSupplementRecord[] = []
  let truncated = false
  const seen = new Set<string>()
  let identifier: string | undefined
  let active: { depth: number; title: string; files: { name: string }[] } | undefined
  parser.on('opentag', (tag) => {
    path.push(tag.local)
    if (path.length > 128 || (path.length === 1 && tag.local !== 'article'))
      throw new Error('Invalid article XML.')
    if (path.includes('sub-article') || path.includes('response')) return
    const attribute = (name: string): string | undefined =>
      Object.values(tag.attributes).find((a) => a.local === name)?.value
    if (
      path.join('/') === 'article/front/article-meta/article-id' &&
      attribute('pub-id-type') === 'doi'
    )
      identifier = ''
    if (tag.local === 'supplementary-material' && !active)
      active = { depth: path.length, title: '', files: [] }
    if (active && ['media', 'supplementary-material'].includes(tag.local)) {
      const href = Object.values(tag.attributes).find(
        (a) => a.local === 'href' && a.uri === 'http://www.w3.org/1999/xlink'
      )?.value
      const name = href?.split(/[?#]/u)[0]?.split('/').pop()?.trim().slice(0, 2048)
      if (name && !active.files.some((file) => file.name === name)) {
        if (active.files.length >= 100) truncated = true
        else active.files.push({ name })
      }
    }
  })
  const onText = (text: string): void => {
    if (path.includes('sub-article') || path.includes('response')) return
    if (identifier !== undefined) identifier += text
    if (active) active.title = (active.title + text).slice(0, 2048)
  }
  parser.on('text', onText)
  parser.on('cdata', onText)
  parser.on('closetag', () => {
    if (path.join('/') === 'article/front/article-meta/article-id' && identifier !== undefined) {
      identifiers.push(identifier)
      identifier = undefined
    }
    if (active && path.length === active.depth) {
      const identity = active.files.length
        ? active.files
            .map((file) => file.name)
            .sort()
            .join('\n')
        : active.title.trim()
      if (seen.has(identity)) {
        active = undefined
        path.pop()
        return
      }
      seen.add(identity)
      if (records.length >= 50) truncated = true
      else
        records.push({
          id: `${pmcid}:${records.length + 1}`,
          title:
            active.title.replace(/\s+/gu, ' ').trim() ||
            active.files[0]?.name ||
            `${pmcid}:${records.length + 1}`,
          sourceUrl: `https://europepmc.org/articles/${pmcid}`,
          evidence: 'article-section',
          ...(active.files.length ? { files: active.files } : {})
        })
      active = undefined
    }
    path.pop()
  })
  parser.write(xml).close()
  if (!identifiers.length || identifiers.some((id) => normalizeSupplementDoi(id) !== doi))
    throw new Error('Article DOI mismatch.')
  return { records, truncated }
}
