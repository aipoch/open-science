import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'

type Unit = PdfTranslationLayout['units'][number]
type Box = { x: number; y: number; right: number; bottom: number }
type Entry = { item: PdfLayoutTextItem; index: number; key: string; owner: Unit }
type Row = { baseline: number; entries: Entry[] }
type RecordProof = { complete: boolean; owners: Unit[]; wraps: number[] }
const marker = (s: string): RegExpMatchArray | null => s.match(/^\[(\d{1,4})\]\s*/u)
const dated = (s: string): boolean => /\b(?:18|19|20)\d{2}\b/u.test(s)
const valid = (i: PdfLayoutTextItem): boolean =>
  i.dir === 'ltr' &&
  !!i.fontName &&
  i.fontVertical === false &&
  i.transform.length === 6 &&
  [...i.transform, i.width, i.height, i.fontAscent, i.fontDescent].every(Number.isFinite) &&
  i.width > 0 &&
  i.height > 0 &&
  i.transform[0] > 0 &&
  i.transform[3] === i.height &&
  i.transform[1] === 0 &&
  i.transform[2] === 0 &&
  i.fontAscent! > 0 &&
  i.fontAscent! <= 1 &&
  i.fontDescent! >= -1 &&
  i.fontDescent! <= 0
const box = (p: PdfLayoutPage, i: PdfLayoutTextItem): Box => ({
  x: i.transform[4],
  y: p.height - i.transform[5] - i.fontAscent! * i.height,
  right: i.transform[4] + i.width,
  bottom: p.height - i.transform[5] - i.fontDescent! * i.height
})
const union = (bs: Box[]): Box => ({
  x: Math.min(...bs.map((b) => b.x)),
  y: Math.min(...bs.map((b) => b.y)),
  right: Math.max(...bs.map((b) => b.right)),
  bottom: Math.max(...bs.map((b) => b.bottom))
})
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom
const text = (es: Entry[]): string =>
  es
    .map((e) => e.item.str)
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()

/** Superscript ordinals are a separate contract from bracketed bibliography
 * markers. Complete same-page entries and disjoint native column domains are
 * required; partial page-start/end entries and existing readonly types remain. */
export function nativeSuperscriptReferencePackets(
  units: Unit[],
  pages: PdfLayoutPage[]
): ReadonlySet<string> {
  const result = new Set<string>(),
    owners = new Map<string, Unit>(),
    repeated = new Set<string>()
  for (const owner of units)
    for (const key of owner.items) {
      if (owners.has(key)) repeated.add(key)
      owners.set(key, owner)
    }
  const author = (s: string): boolean =>
    /^(?:\p{Lu}\.(?:-\p{Lu}\.)?\s*){1,4}\p{Lu}[\p{L}\p{M}.'’–-]+(?:[ ,]|$)/u.test(s)
  const terminal = (s: string): boolean =>
    /\((?:[^()[\]]{1,80},\s*)?(?:18|19|20)\d{2}\)(?:\s+p\.\s+\d+)?\.$/u.test(s)
  for (const p of pages) {
    const evidence = p.nativeNumberedPacketEvidence
    if (!evidence?.complete || p.rotation !== 0 || p.items.length > 10000) continue
    const entries: Entry[] = p.items.flatMap((item, index) =>
      item.str.trim()
        ? [{ item, index, key: `${p.page}:${index}`, owner: owners.get(`${p.page}:${index}`)! }]
        : []
    )
    if (
      !entries.length ||
      entries.some((e) => {
        const font = evidence.fonts[e.item.fontName!]
        return (
          !e.owner ||
          repeated.has(e.key) ||
          !valid(e.item) ||
          !font?.nativeMetrics ||
          font.ascent !== e.item.fontAscent ||
          font.descent !== e.item.fontDescent ||
          e.owner.originalStrings[e.owner.items.indexOf(e.key)] !== e.item.str
        )
      })
    )
      continue
    const markers = entries.filter((e, at) => {
      const i = e.item,
        next = entries[at + 1]?.item
      const row: Entry[] = []
      if (next)
        for (const part of entries.slice(at + 1, at + 17)) {
          const prior = row.at(-1)?.item
          if (
            Math.abs(part.item.transform[5] - next.transform[5]) > next.height * 0.05 ||
            Math.abs(part.item.height - next.height) > next.height * 0.05 ||
            (prior &&
              (part.item.transform[4] < prior.transform[4] + prior.width - next.height * 0.2 ||
                part.item.transform[4] - prior.transform[4] - prior.width > next.height * 2))
          )
            break
          row.push(part)
        }
      return (
        /^\d{1,3}$/u.test(i.str) &&
        next &&
        author(text(row)) &&
        i.height > next.height * 0.7 &&
        i.height < next.height * 0.8 &&
        i.transform[5] > next.transform[5] &&
        i.transform[5] - next.transform[5] < next.height * 0.4 &&
        next.transform[4] >= i.transform[4] + i.width &&
        next.transform[4] - i.transform[4] - i.width < next.height * 0.1
      )
    })
    if (
      markers.length < 3 ||
      markers.length > 256 ||
      markers.some((e, at) => at > 0 && Number(e.item.str) !== Number(markers[at - 1].item.str) + 1)
    )
      continue
    if (
      entries.some(
        (e) =>
          e.index < markers[0].index &&
          /\b(?:reference|citation|bibliograph\w*)\s+examples?\b/iu.test(e.item.str)
      )
    )
      continue
    const records = markers.map((m, at) => {
      const end = markers[at + 1]?.index ?? Infinity,
        items = entries.filter((e) => e.index >= m.index && e.index < end),
        s = text(items.slice(1))
      return {
        items,
        complete: items.length <= 600 && s.length <= 4000 && author(s) && terminal(s)
      }
    })
    if (records.slice(0, -1).some((r) => !r.complete)) continue
    const closed = records.filter((r) => r.complete)
    if (closed.length < 3) continue
    const selected = closed.flatMap((r) => r.items),
      keys = new Set(selected.map((e) => e.key)),
      starts = [...new Set(markers.map((e) => e.item.transform[4] + e.item.width))].toSorted(
        (a, b) => a - b
      ),
      height = markers[0].item.height
    const columns: number[] = []
    for (const start of starts)
      if (!columns.some((x) => Math.abs(x - start) < height * 0.1)) columns.push(start)
    if (columns.length > 2) continue
    const boxes = columns.map((start, at) =>
      selected
        .filter(
          (e) =>
            e.item.transform[4] >= start - height * 2 &&
            (at === columns.length - 1 || e.item.transform[4] < columns[at + 1] - height * 2)
        )
        .map((e) => box(p, e.item))
    )
    if (boxes.some((bs) => !bs.length)) continue
    const domains = boxes.map(union)
    if (
      domains.some((b) => b.x < 0 || b.y < 0 || b.right > p.width || b.bottom > p.height) ||
      (domains.length === 2 && overlaps(domains[0], domains[1])) ||
      entries.some((e) => !keys.has(e.key) && domains.some((b) => overlaps(box(p, e.item), b))) ||
      evidence.rules.some((r) =>
        domains.some((b) =>
          overlaps(
            {
              x: r.left,
              right: r.right,
              y: p.height - r.baseline - r.halfHeight,
              bottom: p.height - r.baseline + r.halfHeight
            },
            b
          )
        )
      )
    )
      continue
    const selectedOwners = [...new Set(selected.map((e) => e.owner))]
    if (selectedOwners.some((owner) => owner.items.some((key) => !keys.has(key)))) continue
    for (const owner of selectedOwners)
      if (
        !owner.sourceOnly &&
        !owner.preserve &&
        owner.items.every((k) => keys.has(k)) &&
        owner.risks.every((r) => r === 'possible-continuation' || r === 'ambiguous-line-hyphen')
      )
        result.add(owner.items.join('|'))
  }
  return result
}

function bibliographyStyle(s: string): 'initials' | 'surname' | undefined {
  const body = s.replace(/^\[\d+\]\s*/u, ''),
    surname = /^\p{Lu}[\p{L}’'`´¨ˆ˝^.-]+\s+\p{Lu}(?:[ ,.]|$)/u.test(body),
    initials = /^\p{Lu}\.\s*\p{Lu}/u.test(body),
    corporate =
      /^(?:[A-Z]{3,}|[A-Z][\p{L}’'-]*(?:\s+[\p{L}’'()-]+){1,11}),/u.test(body) &&
      /https?:\/\//u.test(body)
  if (
    !dated(body) ||
    /\b(?:we|should|review|example|note|step|then|must)\b/iu.test(
      body.slice(0, body.search(/\b(?:18|19|20)\d{2}\b/u))
    )
  )
    return
  return initials || corporate ? 'initials' : surname ? 'surname' : undefined
}
function terminal(s: string, style: 'initials' | 'surname'): boolean {
  if (style === 'initials')
    return /(?:\((?:18|19|20)\d{2}\)\.?|\bin press\.|https?:\/\/\S+\.|\b(?:accessed|export of)\s+[\d-]+\.|\b(?:licen[cs]e|Ouverte)\s+[\d.]+\.)$/iu.test(
      s
    )
  const year = s.search(/\b(?:18|19|20)\d{2}\b/u)
  if (year < 0) return false
  const publication = s.slice(year + 4).trim()
  return (
    publication.split(/\s+/u).length >= 2 &&
    /(?:\d[\d–−.,-]*\.?|(?:University Press|Springer[^)]*)\))$/u.test(publication)
  )
}

/** Whole ordered native owners only. No initial-page metrics, heading guess or
 * incomplete record is borrowed to protect a later independent page packet. */
export function nativeClosedUnheadedReferencePackets(
  units: Unit[],
  pages: PdfLayoutPage[]
): ReadonlySet<string> {
  const accepted = new Set<string>(),
    counts = new Map<string, number>(),
    owners = new Map<string, Unit>()
  for (const u of units)
    for (const key of u.items) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      owners.set(key, u)
    }
  for (const page of pages) for (const signature of one(page)) accepted.add(signature)
  return accepted

  function one(p: PdfLayoutPage): string[] {
    const proof = p.nativeReferenceEvidence
    if (
      p.rotation !== 0 ||
      ![p.width, p.height].every((n) => Number.isFinite(n) && n > 0) ||
      !proof?.complete ||
      proof.rules.length
    )
      return []
    const entries: Entry[] = []
    for (const [index, item] of p.items.entries()) {
      if (!item.str.trim()) continue
      const key = `${p.page}:${index}`,
        owner = owners.get(key),
        font = proof.fonts[item.fontName!]
      if (
        !owner ||
        !valid(item) ||
        !font?.nativeMetrics ||
        font.ascent !== item.fontAscent ||
        font.descent !== item.fontDescent ||
        counts.get(key) !== 1 ||
        owner.originalStrings[owner.items.indexOf(key)] !== item.str
      )
        return []
      const b = box(p, item)
      if (b.x < 0 || b.y < 0 || b.right > p.width || b.bottom > p.height) return []
      entries.push({ item, index, key, owner })
    }
    const folios = entries.filter(
        (e) =>
          e.item.str === String(p.page) &&
          (box(p, e.item).y > p.height * 0.9 || box(p, e.item).bottom < p.height * 0.08)
      ),
      body = entries.filter((e) => !folios.includes(e)),
      starts = body.filter((e) => marker(e.item.str))
    if (starts.length < 3) return []
    const font = starts[0].item.height,
      columns: { x: number; starts: Entry[] }[] = []
    for (const e of [...starts].sort((a, b) => a.item.transform[4] - b.item.transform[4])) {
      let column = columns.find((c) => Math.abs(c.x - e.item.transform[4]) <= font * 1.5)
      if (!column) {
        column = { x: e.item.transform[4], starts: [] }
        columns.push(column)
      }
      column.starts.push(e)
    }
    if (columns.length > 2 || body.some((e) => Math.abs(e.item.height - font) > font * 0.02))
      return []
    const selected: Unit[] = []
    for (const [columnIndex, column] of columns.entries()) {
      const left = column.x - font * 1.5,
        right = columns[columnIndex + 1] ? columns[columnIndex + 1].x - font : p.width,
        es = body.filter((e) => e.item.transform[4] >= left && e.item.transform[4] < right),
        rows: Row[] = []
      for (const e of [...es].sort(
        (a, b) =>
          b.item.transform[5] - a.item.transform[5] || a.item.transform[4] - b.item.transform[4]
      )) {
        const previous = rows.at(-1)
        if (previous && Math.abs(previous.baseline - e.item.transform[5]) < font * 0.02)
          previous.entries.push(e)
        else rows.push({ baseline: e.item.transform[5], entries: [e] })
      }
      const starts = rows.flatMap((r, n) => (marker(r.entries[0].item.str) ? [n] : [])),
        numbers = starts.map((n) => Number(marker(rows[n].entries[0].item.str)![1]))
      if (numbers.some((n, i) => i > 0 && n !== numbers[i - 1] + 1)) continue
      if (columnIndex === 0 && starts[0] > 0) return []
      const records: RecordProof[] = []
      for (const [n, start] of starts.entries()) {
        const physical = rows.slice(start, starts[n + 1] ?? rows.length),
          all = physical.flatMap((r) => r.entries),
          keys = new Set(all.map((e) => e.key)),
          source = text(all),
          style = bibliographyStyle(source),
          bounds = union(all.map((e) => box(p, e.item))),
          packetOwners = [...new Set(all.map((e) => e.owner))]
        const complete =
          !!style &&
          !entries.some((e) => !keys.has(e.key) && overlaps(box(p, e.item), bounds)) &&
          all.every((e) => box(p, e.item).right <= right) &&
          physical.every(
            (r, i) =>
              closed(r) &&
              (!i ||
                (physical[i - 1].baseline - r.baseline <= font * 2.2 &&
                  r.entries[0].item.transform[4] >= column.x + font * 0.8))
          ) &&
          terminal(source, style) &&
          !physical
            .slice(0, -1)
            .some((_, i) =>
              terminal(text(physical.slice(0, i + 1).flatMap((r) => r.entries)), style)
            ) &&
          packetOwners.every((u) => u.items.every((k) => keys.has(k)))
        records.push({
          complete,
          owners: packetOwners,
          wraps: physical.slice(1).map((r) => r.entries[0].item.transform[4])
        })
      }
      const wraps = records.filter((r) => r.complete && r.wraps.length)
      if (
        wraps.length < 2 ||
        wraps.some((r) => r.wraps.some((x) => Math.abs(x - wraps[0].wraps[0]) > font * 0.05))
      )
        continue
      for (let n = 0; n < records.length;) {
        let end = n
        while (end < records.length && records[end].complete) end++
        if (end - n >= 3) selected.push(...records.slice(n, end).flatMap((r) => r.owners))
        n = end > n ? end : n + 1
      }
    }
    return [...new Set(selected.map((u) => u.items.join('|')))]

    function closed(row: Row): boolean {
      const es = [...row.entries].sort((a, b) => a.item.transform[4] - b.item.transform[4]),
        last = es.at(-1)!,
        next = p.items.findIndex((i, n) => n > last.index && !!i.str.trim()),
        emptyBreak = p.items
          .slice(last.index + 1, next < 0 ? undefined : next)
          .some((i) => !i.str.trim() && i.hasEOL === true)
      return (
        es.slice(0, -1).every((e) => e.item.hasEOL === false) &&
        (last.item.hasEOL === true || emptyBreak) &&
        es.every((e, n) => !n || e.index > es[n - 1].index)
      )
    }
  }
}
