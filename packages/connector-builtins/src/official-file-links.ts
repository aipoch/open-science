// Extract literal file links from official download pages. This is deliberately not an
// HTML renderer: scripts, forms and authentication challenges are never executed.
export function officialFileLinks(
  html: string,
  page: string,
  accept: (url: URL) => boolean
): { filename: string; url: string }[] {
  if (
    /<title[^>]*>[^<]*(?:checking your browser|access denied|just a moment|captcha)/i.test(html)
  ) {
    throw new Error(
      'The official download page requires browser verification. Use its documented access route.'
    )
  }
  const clean = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const files = new Map<string, { filename: string; url: string }>()
  for (const anchor of clean.matchAll(/<a\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi)) {
    // Tokenize complete attributes so data-href and href text inside another attribute
    // cannot masquerade as the anchor's actual href. HTML keeps the first duplicate.
    const attribute = [
      ...anchor[1].matchAll(
        /(?:^|\s)([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
      )
    ].find((item) => item[1].toLowerCase() === 'href')
    if (!attribute || !(attribute[2] ?? attribute[3] ?? attribute[4])) continue
    const href = (attribute[2] ?? attribute[3] ?? attribute[4]).replace(/&amp;/gi, '&')
    let url: URL
    try {
      url = new URL(href, page)
    } catch {
      continue
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.search ||
      !accept(url)
    )
      continue
    const filename = url.pathname.replace(/\/$/, '').split('/').pop() ?? ''
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/.test(filename)) continue
    files.set(url.href, { filename, url: url.href })
  }
  if (!files.size)
    throw new Error(
      'No supported official file links were found. This is not evidence that the dataset is empty.'
    )
  return [...files.values()]
}

export const provenance = (
  source: string,
  sourceUrl: string
): { source: string; source_url: string; retrieved_at: string } => ({
  source,
  source_url: sourceUrl,
  retrieved_at: new Date().toISOString()
})

export const objectInput = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
