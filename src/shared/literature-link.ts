import { normalizeLiteratureIdentifierKey } from '@aipoch/literature-citations/contracts'

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

/** Convert supported user input to a bounded identifier; never fetch a user-supplied URL. */
export function parseLiteratureLink(input: string): string | undefined {
  let value = input.trim()
  if (!value || value.length > 2048 || hasControlCharacter(value)) return undefined
  if (/^https?:\/\//iu.test(value)) {
    const rawPath = /^https?:\/\/[^/?#]*(\/[^?#]*)?/iu.exec(value)?.[1] ?? ''
    let url: URL
    try {
      url = new URL(value)
      if (url.username || url.password || url.port) return undefined
      value = decodeURIComponent(url.pathname.slice(1))
      // URL parsing collapses dot segments and backslashes; they may belong to a DOI suffix.
      if (value !== decodeURIComponent(rawPath.slice(1))) return undefined
    } catch {
      return undefined
    }
    const host = url.hostname.toLowerCase()
    if (host === 'doi.org' || host === 'dx.doi.org') {
      // Query strings and fragments belong to the browser URL, not the DOI.
    } else if (host === 'arxiv.org' || host === 'www.arxiv.org') {
      const match = /^(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/u.exec(value)
      if (!match) return undefined
      value = `arxiv:${match[1]}`
    } else return undefined
  }
  value = value.replace(/^doi:\s*/iu, '')
  if (hasControlCharacter(value)) return undefined
  if (/^10\.\d{4,9}\/\S+$/u.test(value)) {
    // The catalog folds ASCII case only; Unicode case can identify a different DOI.
    const doi = normalizeLiteratureIdentifierKey('doi', value)
    return doi.normalize('NFKC') === doi ? doi : undefined
  }
  const arxiv =
    /^arxiv:((?:\d{2}(?:0[1-9]|1[0-2])\.\d{4,5}|[a-z][a-z.-]*\/(?:\d{2}(?:0[1-9]|1[0-2]))\d{3})(?:v[1-9]\d*)?)$/iu.exec(
      value
    )
  return arxiv ? `arxiv:${arxiv[1].replace(/v\d+$/iu, '').toLowerCase()}` : undefined
}
