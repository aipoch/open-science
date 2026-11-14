import { describe, expect, it } from 'vitest'
import {
  collectLiteratureSourceCitationHrefs,
  createLiteratureSourceCitationHref,
  parseLiteratureSourceCitationHref,
  resolveLiteratureSourceCitationHref,
  type LiteratureSourceCitation
} from './literature-source-citation'

const citation: LiteratureSourceCitation = {
  itemId: 'item-1',
  title: 'An evidence paper',
  kind: 'pdf',
  quote: 'The intervention improved the primary outcome.',
  source: {
    attachmentId: 'attachment-1',
    versionId: 'version-1',
    checksum: 'a'.repeat(64),
    name: 'evidence.pdf'
  },
  pageStart: 7,
  pageEnd: 8
}
const rawHref = (value: unknown): string =>
  '#library-source=' + encodeURIComponent(JSON.stringify(value))

describe('Literature source citation links', () => {
  it('resolves short references only within their own message receipt and rejects collisions', () => {
    const snapshot = {
      ...citation,
      citationId: '0123456789abcdef',
      context: `Before. ${citation.quote} After.`
    }
    const receipt = createLiteratureSourceCitationHref(snapshot)
    const href = '#library-cite=0123456789abcdef'
    const restored = JSON.parse(JSON.stringify(collectLiteratureSourceCitationHrefs([receipt])))
    expect(resolveLiteratureSourceCitationHref(href, restored)).toEqual(snapshot)
    expect(resolveLiteratureSourceCitationHref(href, [])).toBeUndefined()
    expect(
      resolveLiteratureSourceCitationHref('#library-cite=fedcba9876543210', restored)
    ).toBeUndefined()
    expect(resolveLiteratureSourceCitationHref(href + '0', restored)).toBeUndefined()
    expect(resolveLiteratureSourceCitationHref(href + '?quote=altered', restored)).toBeUndefined()
    const collision = createLiteratureSourceCitationHref({ ...snapshot, itemId: 'other-item' })
    expect(resolveLiteratureSourceCitationHref(href, [receipt, collision])).toBeUndefined()
    expect(resolveLiteratureSourceCitationHref(href, [receipt, receipt])).toEqual(snapshot)
    expect(resolveLiteratureSourceCitationHref(receipt, restored)).toEqual(snapshot)
    expect(
      resolveLiteratureSourceCitationHref(receipt.replace('%7B', '%7b'), restored)
    ).toBeUndefined()
  })

  it('resolves later tool receipts after a message accumulates more than one receipt budget', () => {
    const batches = Array.from({ length: 2 }, (_, batch) =>
      collectLiteratureSourceCitationHrefs(
        Array.from({ length: 8 }, (_, index) =>
          createLiteratureSourceCitationHref({
            ...citation,
            itemId: `item-${batch}-${index}`,
            citationId: (batch * 8 + index).toString(16).padStart(16, '0'),
            quote: 'q'.repeat(600)
          })
        )
      )
    )
    const receipts = batches.flat()
    expect(receipts.join('').length).toBeGreaterThan(8_000)
    const last = parseLiteratureSourceCitationHref(receipts.at(-1)!)!
    expect(
      resolveLiteratureSourceCitationHref(`#library-cite=${last.citationId}`, receipts)
    ).toEqual(last)
  })

  it('keeps legacy exact-receipt authorization without short references', () => {
    const href = createLiteratureSourceCitationHref(citation)
    expect(resolveLiteratureSourceCitationHref(href, [href])).toEqual(citation)
    expect(resolveLiteratureSourceCitationHref(href, [])).toBeUndefined()
    expect(
      resolveLiteratureSourceCitationHref('#library-cite=0123456789abcdef', [href])
    ).toBeUndefined()
  })

  it('keeps only unique canonical citation hrefs in a tool receipt', () => {
    const href = createLiteratureSourceCitationHref(citation)
    expect(
      collectLiteratureSourceCitationHrefs([
        undefined,
        href,
        href,
        href.replace('%7B', '%7b'),
        '#library-source=%',
        'https://example.test/'
      ])
    ).toEqual([href])
    expect(collectLiteratureSourceCitationHrefs({ href })).toEqual([])
  })

  it('bounds tool receipt href count and total characters', () => {
    const hrefs = Array.from({ length: 25 }, (_, index) =>
      createLiteratureSourceCitationHref({
        itemId: `item-${index}`,
        title: '',
        kind: 'metadata',
        quote: ''
      })
    )
    expect(collectLiteratureSourceCitationHrefs(hrefs)).toHaveLength(20)
    const larger = Array.from({ length: 20 }, (_, index) =>
      createLiteratureSourceCitationHref({
        ...citation,
        itemId: `item-${index}`,
        quote: 'q'.repeat(600)
      })
    )
    const collected = collectLiteratureSourceCitationHrefs(larger)
    expect(collected.length).toBeGreaterThan(0)
    expect(collected.length).toBeLessThan(20)
    expect(collected.join('').length).toBeLessThanOrEqual(8_000)
    expect(
      collectLiteratureSourceCitationHrefs([
        createLiteratureSourceCitationHref({ ...citation, quote: '证'.repeat(1_600) })
      ])
    ).toEqual([])
  })

  it('round-trips bounded immutable PDF display evidence and Unicode', () => {
    const value = { ...citation, title: '证据 (study)', quote: '有效结果。' }
    expect(parseLiteratureSourceCitationHref(createLiteratureSourceCitationHref(value))).toEqual(
      value
    )
  })

  it('escapes punctuation that can break a Markdown link destination', () => {
    const value = {
      ...citation,
      quote: "Treatment (group A! improved patients' outcomes* without closing the bracket."
    }
    const href = createLiteratureSourceCitationHref(value)
    expect(href).not.toMatch(/[!'()*]/u)
    expect(parseLiteratureSourceCitationHref(href)).toEqual(value)
  })

  it('permits an empty metadata quote but requires abstract evidence', () => {
    const metadata = { itemId: 'item-1', title: '', kind: 'metadata' as const, quote: '' }
    expect(parseLiteratureSourceCitationHref(createLiteratureSourceCitationHref(metadata))).toEqual(
      metadata
    )
    expect(
      parseLiteratureSourceCitationHref(rawHref({ ...metadata, kind: 'abstract' }))
    ).toBeUndefined()
  })

  it.each([
    { ...citation, citationId: '0123456789abcdeF' },
    { ...citation, context: 'unrelated source' },
    { ...citation, context: citation.quote + 'c'.repeat(1_600) },
    { ...citation, quote: 'q'.repeat(1_601) },
    { ...citation, title: 't'.repeat(1_001) },
    { ...citation, itemId: 'i'.repeat(513) },
    { ...citation, itemId: ' item-1' },
    { ...citation, itemId: 'item/1' },
    { ...citation, itemId: 'item\u00001' },
    { ...citation, pageStart: 0 },
    { ...citation, pageEnd: 6 },
    { ...citation, pageEnd: 8.5 },
    { ...citation, source: undefined },
    { ...citation, source: { ...citation.source, checksum: 'invalid' } },
    { ...citation, source: { ...citation.source, checksum: 'A'.repeat(64) } },
    { ...citation, source: { ...citation.source, versionId: 'version/1' } },
    { ...citation, source: { ...citation.source, path: '/private/paper.pdf' } },
    { ...citation, unexpected: true },
    { ...citation, kind: 'metadata' },
    { ...citation, kind: 'unknown' }
  ])('rejects malformed or unbounded snapshots %#', (value) => {
    expect(parseLiteratureSourceCitationHref(rawHref(value))).toBeUndefined()
    expect(() => createLiteratureSourceCitationHref(value as LiteratureSourceCitation)).toThrow()
  })

  it.each([
    undefined,
    '',
    'https://example.test/#library-source={}',
    '#library-source=%',
    '#library-source=[]',
    '#library-source=' + 'a'.repeat(100_000)
  ])('ignores non-citation and malformed hrefs %#', (href) =>
    expect(parseLiteratureSourceCitationHref(href)).toBeUndefined()
  )
})
