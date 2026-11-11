import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'

type Unit = PdfTranslationLayout['units'][number]
type Entry = { item: PdfLayoutTextItem; index: number; key: string; owner: Unit }
type Row = { entries: Entry[]; baseline: number; left: number }
type RecordProof = { number: number; entries: Entry[]; wraps: number[]; font: number }
type PageProof = {
  page: PdfLayoutPage
  records: RecordProof[]
  heading?: Unit
  stop: boolean
  folio: boolean
}
type Box = { x: number; y: number; right: number; bottom: number }
const ordinal = (s: string): RegExpMatchArray | null => s.match(/^([1-9]\d{0,2})\.\s+\S/u)
const literalUrl = (s: string): boolean => /^https?:\/\/\S+$/u.test(s)
const sourceText = (es: Entry[]): string => es.map((e) => e.item.str).join(' ')
const box = (p: PdfLayoutPage, i: PdfLayoutTextItem): Box => ({
  x: i.transform[4],
  right: i.transform[4] + i.width,
  y: p.height - i.transform[5] - i.fontAscent! * i.height,
  bottom: p.height - i.transform[5] - i.fontDescent! * i.height
})
const union = (bs: Box[]): Box => ({
  x: Math.min(...bs.map((b) => b.x)),
  right: Math.max(...bs.map((b) => b.right)),
  y: Math.min(...bs.map((b) => b.y)),
  bottom: Math.max(...bs.map((b) => b.bottom))
})
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom

/** Return only complete, unchanged native owner tuples. A failed page is never
 * borrowed to continue a different independently bounded bibliography packet. */
export function nativeOrdinalReferencePackets(
  units: Unit[],
  pages: PdfLayoutPage[]
): ReadonlySet<string> {
  const accepted = new Set<string>(),
    owners = new Map<string, Unit>(),
    counts = new Map<string, number>(),
    cache = new Map<PdfLayoutPage, PageProof | undefined>()
  for (const u of units)
    for (const k of u.items) {
      owners.set(k, u)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  const eligible = (u: Unit): boolean =>
    !u.sourceOnly &&
    !u.preserve &&
    !literalUrl(u.source) &&
    u.risks.every((r) => r === 'possible-continuation' || r === 'ambiguous-line-hyphen')
  const add = (proofs: PageProof[]): void => {
    const records = proofs.flatMap((p) => p.records),
      wraps = records.flatMap((r) => r.wraps),
      font = records[0]?.font
    if (
      !font ||
      records.length < 3 ||
      records.filter((r) => r.wraps.length).length < 2 ||
      wraps.some((x) => Math.abs(x - wraps[0]) > font * 0.05)
    )
      return
    const keys = new Set(records.flatMap((r) => r.entries.map((e) => e.key))),
      packetOwners = new Set(records.flatMap((r) => r.entries.map((e) => e.owner)))
    if (keys.size > 4096 || [...packetOwners].some((u) => u.items.some((k) => !keys.has(k)))) return
    for (const u of packetOwners) if (eligible(u)) accepted.add(u.items.join('|'))
    for (const p of proofs)
      if (p.heading && eligible(p.heading)) accepted.add(p.heading.items.join('|'))
  }
  for (const page of pages) {
    const first = scan(page)
    if (!first) continue
    if (first.heading) {
      if (first.records[0].number === 1 && (first.stop || first.folio)) add([first])
      continue
    }
    const chain = [first]
    for (let n = page.page; !chain.at(-1)!.stop && n < Math.min(pages.length, page.page + 8); n++) {
      const prior = chain.at(-1)!,
        next = scan(pages[n])
      if (
        !prior.folio ||
        !next ||
        next.heading ||
        next.page.page !== prior.page.page + 1 ||
        next.records[0].number !== prior.records.at(-1)!.number + 1 ||
        Math.abs(next.records[0].font - first.records[0].font) > first.records[0].font * 0.02
      )
        break
      chain.push(next)
    }
    if (chain.at(-1)!.stop) add(chain)
  }
  return accepted

  function scan(p: PdfLayoutPage): PageProof | undefined {
    if (cache.has(p)) return cache.get(p)
    cache.set(p, undefined)
    const proof = p.nativeSectionFontEvidence
    if (
      !proof?.complete ||
      p.rotation !== 0 ||
      ![p.width, p.height].every((n) => Number.isFinite(n) && n > 0) ||
      p.items.length > 4096
    )
      return
    const entries: Entry[] = []
    for (const [index, item] of p.items.entries()) {
      if (!item.str.trim()) continue
      const key = `${p.page}:${index}`,
        owner = owners.get(key),
        font = proof.fonts[item.fontName!]
      if (
        !owner ||
        counts.get(key) !== 1 ||
        owner.originalStrings[owner.items.indexOf(key)] !== item.str ||
        !font?.nativeMetrics ||
        font.ascent !== item.fontAscent ||
        font.descent !== item.fontDescent ||
        font.vertical !== false ||
        item.fontVertical !== false ||
        item.dir !== 'ltr' ||
        item.transform.length !== 6 ||
        ![...item.transform, item.width, item.height, item.fontAscent, item.fontDescent].every(
          Number.isFinite
        ) ||
        item.width <= 0 ||
        item.height <= 0 ||
        item.transform[0] <= 0 ||
        item.transform[3] !== item.height ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        item.fontAscent! <= 0 ||
        item.fontAscent! > 1 ||
        item.fontDescent! < -1 ||
        item.fontDescent! > 0 ||
        // eslint-disable-next-line no-control-regex -- Reject embedded control characters in native PDF text.
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(item.str)
      )
        return
      const b = box(p, item)
      if (b.x < 0 || b.y < 0 || b.right > p.width || b.bottom > p.height) return
      entries.push({ item, index, key, owner })
    }
    const folios = entries.filter(
        (e) =>
          e.item.str === String(p.page) &&
          box(p, e.item).y > p.height * 0.9 &&
          Math.abs((box(p, e.item).x + box(p, e.item).right) / 2 - p.width / 2) <
            e.item.height * 2 &&
          e.owner.items.length === 1
      ),
      body = entries.filter((e) => !folios.includes(e))
    if (!body.length || folios.length > 1 || box(p, body[0].item).y > p.height * 0.16) return
    let heading: Unit | undefined
    if (/^(?:References|Bibliography) and Notes$/u.test(body[0].item.str)) {
      const title = body.shift()!
      if (
        title.owner.items.length !== 1 ||
        title.owner.source !== title.item.str ||
        title.owner.risks.length ||
        !body.length ||
        title.item.height < body[0].item.height * 1.15 ||
        title.item.height > body[0].item.height * 2 ||
        title.item.fontName === body[0].item.fontName ||
        !closed(p, [title])
      )
        return
      heading = title.owner
    }
    if (!ordinal(body[0].item.str)) return
    const font = body[0].item.height
    const stopIndex = body.findIndex(
      (e) =>
        /^(?:Acknowledgments|Acknowledgements)$/u.test(e.item.str) &&
        e.owner.items.length === 1 &&
        e.owner.source === e.item.str &&
        !e.owner.risks.length &&
        e.item.height > font * 1.15 &&
        e.item.fontName !== body[0].item.fontName
    )
    if (stopIndex >= 0) {
      const boundary = body[stopIndex],
        next = body[stopIndex + 1]
      if (
        !closed(p, [boundary]) ||
        !next ||
        next.owner.sourceOnly ||
        next.owner.preserve ||
        (next.owner.source.match(/\p{L}{2,}/gu)?.length ?? 0) < 12 ||
        next.item.transform[5] >= boundary.item.transform[5] - font ||
        !next.owner.items.every(
          (k) => k.startsWith(p.page + ':') && Number(k.split(':')[1]) > boundary.index
        )
      )
        return
    }
    const selected = stopIndex >= 0 ? body.slice(0, stopIndex) : body,
      rows: Row[] = []
    for (const e of selected) {
      let row = rows.at(-1)
      if (!row || closed(p, row.entries)) {
        row = { entries: [], baseline: e.item.transform[5], left: e.item.transform[4] }
        rows.push(row)
      }
      row.entries.push(e)
    }
    if (!rows.length || rows.some((r) => !closed(p, r.entries))) return
    for (const [n, row] of rows.entries()) {
      const anchor = row.entries.reduce((a, b) => (a.item.height >= b.item.height ? a : b)),
        baseline = anchor.item.transform[5]
      row.baseline = baseline
      if (n && rows[n - 1].baseline <= baseline + font * 0.5) return
      for (const [i, e] of row.entries.entries()) {
        if (i && e.item.transform[4] < row.entries[i - 1].item.transform[4] - font * 0.05) return
        if (Math.abs(e.item.height - font) <= font * 0.02) {
          if (Math.abs(e.item.transform[5] - baseline) > font * 0.02) return
        } else if (
          e.item.height < font * 0.4 ||
          e.item.height > font ||
          !/^[\p{N}\p{Sm}\p{Sk}\p{So}]+$/u.test(e.item.str) ||
          Math.abs(e.item.transform[5] - baseline) > font * 0.5
        )
          return
      }
    }
    const starts = rows.flatMap((r, n) => (ordinal(r.entries[0].item.str) ? [n] : []))
    if (!starts.length || starts[0] !== 0) return
    const records: RecordProof[] = []
    for (const [n, start] of starts.entries()) {
      const physical = rows.slice(start, starts[n + 1] ?? rows.length),
        es = physical.flatMap((r) => r.entries),
        number = Number(ordinal(es[0].item.str)![1]),
        keys = new Set(es.map((e) => e.key)),
        source = sourceText(es),
        text = source.replace(/^\d+\.\s+/u, ''),
        comma = text.indexOf(','),
        author = text.slice(0, comma),
        dated = /\b(?:18|19|20)\d{2}\b/u.test(text),
        publication =
          /(?:doi:\s*10\.|https?:\/\/)/iu.test(text) ||
          es.some(
            (e) =>
              e.item.fontName !== es[0].item.fontName &&
              Math.abs(e.item.height - font) < font * 0.02 &&
              (e.item.str.match(/\p{L}/gu)?.length ?? 0) >= 6 &&
              !/^et\s+al[.,]?$/iu.test(e.item.str.trim())
          ),
        domain = union(es.map((e) => box(p, e.item)))
      if (
        number !== (records.at(-1)?.number ?? number - 1) + 1 ||
        comma < 1 ||
        comma > 120 ||
        !/^[\p{Lu}\d][\p{L}\p{M}\p{Sk}\d .’'`´-]*$/u.test(author) ||
        /^(?:we|our|this|these|note|step|the (?:experiment|following|ordinary|analysis))\b/iu.test(
          text
        ) ||
        !dated ||
        !publication ||
        !/\.$/u.test(source) ||
        physical
          .slice(1)
          .some(
            (r, i) =>
              physical[i].baseline - r.baseline > font * 2.2 ||
              r.left < physical[0].left + font * 0.8 ||
              r.left > physical[0].left + font * 3
          ) ||
        entries.some((e) => !keys.has(e.key) && overlaps(box(p, e.item), domain)) ||
        [...new Set(es.map((e) => e.owner))].some((u) => u.items.some((k) => !keys.has(k)))
      )
        return
      records.push({ number, entries: es, wraps: physical.slice(1).map((r) => r.left), font })
    }
    const result = { page: p, records, heading, stop: stopIndex >= 0, folio: folios.length === 1 }
    cache.set(p, result)
    return result
  }
}

function closed(p: PdfLayoutPage, es: Entry[]): boolean {
  const last = es.at(-1)!
  if (last.item.hasEOL === true) return true
  const next = p.items.findIndex((i, n) => n > last.index && !!i.str.trim())
  return p.items
    .slice(last.index + 1, next < 0 ? undefined : next)
    .some((i) => !i.str.trim() && i.hasEOL === true)
}
