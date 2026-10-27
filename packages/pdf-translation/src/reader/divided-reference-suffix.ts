import type { PdfLayoutPage, PdfLayoutTextItem } from './layout.js'

// A printed native divider can close an unheaded bibliography without relying
// on the preceding paragraph's wording or interpreting its hyphenated source.
// Keep all owners and risks verbatim; only a complete, unique suffix is returned.
export function nativeDividedReferenceSuffix<
  T extends { items: string[]; originalStrings: string[] }
>(
  units: T[],
  pages: PdfLayoutPage[],
  nativeContentsUpright: (item: PdfLayoutTextItem) => boolean
): T[] {
  if (
    !pages.length ||
    pages.some(
      (p, n) =>
        p.page !== n + 1 ||
        p.rotation !== 0 ||
        ![p.width, p.height].every((v) => Number.isFinite(v) && v > 0)
    )
  )
    return []
  const all = pages.flatMap((page) =>
      page.items.flatMap((item, index) =>
        item.str.trim() ? [{ page: page.page, item, index, key: page.page + ':' + index }] : []
      )
    ),
    starts = all.filter((e) => /^\[1\]\s+\p{Lu}\./u.test(e.item.str)),
    passes: T[][] = []
  for (const start of starts) {
    const result = one(start)
    if (result) passes.push(result)
  }
  return passes.length === 1 ? passes[0] : []
  function one(start: (typeof all)[number]): T[] | undefined {
    const page = pages.find((p) => p.page === start.page)!,
      h = start.item.height,
      raw = page.items
    if (!nativeContentsUpright(start.item) || page.rotation !== 0) return
    const evidence = page.nativeReferenceEvidence
    if (!evidence?.complete) return
    const preceding = raw.slice(0, start.index).filter((i) => i.str.trim())
    const following = raw.slice(start.index).filter((i) => i.str.trim())
    if (!preceding.length || !following.length) return
    const matching = evidence.rules.filter(
      (rule) =>
        rule.left < page.width / 2 - h &&
        rule.right > page.width / 2 + h &&
        preceding.every(
          (i) =>
            nativeContentsUpright(i) &&
            i.transform[5] + i.fontDescent! * i.height > rule.baseline + rule.halfHeight + h
        ) &&
        following.every(
          (i) =>
            nativeContentsUpright(i) &&
            i.transform[5] + i.fontAscent! * i.height < rule.baseline - rule.halfHeight - h
        )
    )
    if (matching.length !== 1) return
    const divider = matching[0]
    const header = (e: (typeof all)[number], p: PdfLayoutPage): boolean =>
      e.item.str === String(p.page) &&
      nativeContentsUpright(e.item) &&
      e.item.transform[5] > p.height * 0.945 &&
      e.item.height > h * 1.05 &&
      p.items.filter((i) => i.str.trim() && i.transform[5] > p.height * 0.945).length === 1 &&
      pages.filter(
        (q) =>
          Math.abs(q.page - p.page) === 1 &&
          q.items.some(
            (i) =>
              i.str === String(q.page) &&
              nativeContentsUpright(i) &&
              i.fontName === e.item.fontName &&
              Math.abs(i.height - e.item.height) < h * 0.01 &&
              Math.abs(i.transform[5] - e.item.transform[5]) < h * 0.01 &&
              Math.abs(i.transform[4] + i.width - e.item.transform[4] - e.item.width) < h * 0.05
          )
      ).length > 0
    const tail = all.slice(all.indexOf(start)),
      headers = tail.filter(
        (e) =>
          e.page !== start.page &&
          header(
            e,
            pages.find((p) => p.page === e.page)!
          )
      ),
      headerKeys = new Set(headers.map((e) => e.key)),
      packet = tail.filter((e) => !headerKeys.has(e.key))
    if (
      headers.length !== pages.at(-1)!.page - start.page ||
      packet.some(
        (e) =>
          !nativeContentsUpright(e.item) ||
          e.item.height < h * 0.6 ||
          e.item.height > h * 1.01 ||
          pages.find((p) => p.page === e.page)!.rotation !== 0
      )
    )
      return
    const fonts = new Map<string, number[]>()
    for (const e of packet) {
      const evidence = pages[e.page - 1].nativeReferenceEvidence
      if (!evidence?.complete) return
      const font = evidence.fonts[e.item.fontName!]
      if (
        !font ||
        font.nativeMetrics !== true ||
        font.vertical !== false ||
        font.ascent !== e.item.fontAscent ||
        font.descent !== e.item.fontDescent
      )
        return
    }
    for (const e of packet) {
      const metrics = [e.item.fontAscent!, e.item.fontDescent!],
        known = fonts.get(e.item.fontName!)
      if (known && known.some((v, n) => v !== metrics[n])) return
      fonts.set(e.item.fontName!, metrics)
    }
    const markers = packet.flatMap((e, index) =>
      /^\[\d{1,4}\]/u.test(e.item.str)
        ? [{ entry: e, index, number: Number(/^\[(\d+)\]/u.exec(e.item.str)![1]) }]
        : []
    )
    if (
      markers.length < 8 ||
      markers.some(
        (m, n) =>
          m.number !== n + 1 ||
          m.entry.item.fontName !== start.item.fontName ||
          Math.abs(m.entry.item.height - h) > h * 0.01
      ) ||
      markers[0].entry !== start
    )
      return
    type NativeRow = {
      page: number
      baseline: number
      record: number
      first: boolean
      entries: typeof all
    }
    const records = markers.map((m, n) =>
        packet.slice(m.index, markers[n + 1]?.index ?? packet.length)
      ),
      rows: NativeRow[] = [],
      publicationRoles: { kind: string; roleFonts?: string[] }[] = []
    for (let n = 0; n < records.length; n++) {
      const record = records[n],
        text = record.map((e) => e.item.str).join(' '),
        stack: string[] = []
      for (const ch of text) {
        if (ch === '(') stack.push(ch)
        if (ch === ')' && !stack.pop()) return
      }
      const publication = publicationStructureProof(record, start.item.fontName!)
      if (stack.length || !publication) return
      publicationRoles.push(publication)
      for (const e of record) {
        const row = rows.at(-1)
        if (row && row.page === e.page && Math.abs(row.baseline - e.item.transform[5]) < h * 0.45) {
          const last = row.entries.at(-1)!.item
          if (
            last.hasEOL === true ||
            e.item.transform[4] <= last.transform[4] ||
            e.item.transform[4] - last.transform[4] - last.width > h * 1.5
          )
            return
          row.entries.push(e)
        } else {
          if (Math.abs(e.item.height - h) > h * 0.01) return
          rows.push({
            page: e.page,
            baseline: e.item.transform[5],
            record: n,
            first: e === record[0],
            entries: [e]
          })
        }
      }
    }
    const numeric = new Set(
      publicationRoles.filter((r) => r.kind === 'journal-volume').flatMap((r) => r.roleFonts ?? [])
    )
    const titles = new Set(
      publicationRoles
        .filter((r) => r.kind === 'book-publication')
        .flatMap((r) => r.roleFonts ?? [])
    )
    if (numeric.size > 1 || titles.size > 1 || [...numeric].some((id) => titles.has(id))) return
    const left = rows.filter((r) => r.entries[0].item.transform[4] < page.width / 2),
      right = rows.filter((r) => r.entries[0].item.transform[4] > page.width / 2)
    if (!left.length || !right.length || left.length + right.length !== rows.length) return
    const lanes = [left, right]
    // The complete hanging lane is independently repeated across paragraph continuations.
    for (const lane of lanes) {
      const continuations = lane.filter((r) => !r.first).map((r) => r.entries[0].item.transform[4])
      if (continuations.length < 4) return
      const x = continuations[0]
      if (
        continuations.some((v) => Math.abs(v - x) > h * 0.05) ||
        lane
          .filter((r) => r.first)
          .some(
            (r) =>
              x - r.entries[0].item.transform[4] < h || x - r.entries[0].item.transform[4] > h * 3
          )
      )
        return
    }
    let previous: (NativeRow & { lane: number }) | undefined
    for (const row of rows) {
      const p = pages.find((p) => p.page === row.page)!,
        lane = row.entries[0].item.transform[4] < p.width / 2 ? 0 : 1,
        boxes = row.entries.map((e) => ({
          x: e.item.transform[4],
          right: e.item.transform[4] + e.item.width,
          y: e.item.transform[5] + e.item.fontDescent! * e.item.height,
          bottom: e.item.transform[5] + e.item.fontAscent! * e.item.height
        }))
      if (
        boxes.some((b) => b.x < 0 || b.y < 0 || b.right > p.width || b.bottom > p.height) ||
        (lane === 0 && Math.max(...boxes.map((b) => b.right)) > p.width / 2 - h * 0.5) ||
        (lane === 1 && Math.min(...boxes.map((b) => b.x)) < p.width / 2 + h * 0.5)
      )
        return
      if (previous) {
        if (row.page === previous.page && lane === previous.lane) {
          const gap = previous.baseline - row.baseline
          if (gap < h * 0.9 || gap > h * 1.7) return
        } else if (row.page === previous.page) {
          if (previous.lane !== 0 || lane !== 1) return
        } else if (
          row.page !== previous.page + 1 ||
          previous.lane !== 1 ||
          lane !== 0 ||
          row.baseline < p.height * 0.85 ||
          previous.baseline > p.height * 0.2
        )
          return
      }
      previous = { ...row, lane }
    }
    const keys = new Set(packet.map((e) => e.key)),
      owners = units.filter((u) => u.items.some((k) => keys.has(k)))
    if (
      owners.flatMap((u) => u.items).length !== keys.size ||
      new Set(owners.flatMap((u) => u.items)).size !== keys.size ||
      owners.some(
        (u) =>
          u.items.length !== u.originalStrings.length ||
          u.items.some((k, n) => {
            const [page, index] = k.split(':').map(Number)
            return (
              !keys.has(k) ||
              pages.find((p) => p.page === page)!.items[index]?.str !== u.originalStrings[n] ||
              (n &&
                (page < Number(u.items[n - 1].split(':')[0]) ||
                  (page === Number(u.items[n - 1].split(':')[0]) &&
                    index <= Number(u.items[n - 1].split(':')[1]))))
            )
          })
      ) ||
      [...keys].some((k) => units.filter((u) => u.items.includes(k)).length !== 1)
    )
      return
    if (
      packet.some(
        (e) =>
          e.page === start.page &&
          e.item.transform[5] + e.item.fontAscent! * e.item.height >=
            divider.baseline - divider.halfHeight - h
      )
    )
      return
    return owners
  }
}

type Publication = {
  kind: 'journal-volume' | 'journal-doi' | 'book-publication'
  roleFonts: string[]
}
type PublicationItem = { item: PdfLayoutTextItem }

// These roles describe native font identity, not inferred bold/italic styles.
// The full author list and publication grammar must close independently.
function publicationStructureProof(
  record: PublicationItem[],
  base: string
): Publication | undefined {
  const initial = String.raw`(?:\p{Lu}\.(?:-\p{L}\.)?\s*){1,4}`
  const surname = String.raw`\p{Lu}[\p{L}'’-]*(?:\s?[´¸]\s*[\p{L}'’-]+)*(?:-\s+\p{Ll}+)?(?:\s+\p{Lu}[\p{L}'’-]+)?`
  const author = new RegExp('^' + initial + surname + '(?=,| and )', 'u')
  const text = record.map((e) => e.item.str).join(' '),
    marker = /^\[\d{1,4}\]\s+/u.exec(text)
  if (!marker) return
  let remaining = text.slice(marker[0].length)
  while (true) {
    const hit = author.exec(remaining)
    if (!hit) return
    remaining = remaining.slice(hit[0].length)
    if (remaining.startsWith(' and ')) {
      remaining = remaining.slice(5)
      continue
    }
    if (!remaining.startsWith(',')) return
    remaining = remaining.slice(1).trimStart()
    if (remaining.startsWith('and ')) remaining = remaining.slice(4)
    if (!author.test(remaining)) break
  }
  const other = record.filter((e) => e.item.fontName !== base)
  const journal = (body: string): boolean => {
    const comma = body.lastIndexOf(',')
    if (comma < 0) return false
    const title = body.slice(0, comma).trim(),
      venue = body.slice(comma + 1).trim(),
      words = venue.split(/\s+/u)
    return (
      (title.match(/\p{L}{2,}/gu)?.length ?? 0) >= 2 &&
      (venue.match(/\p{L}+/gu)?.length ?? 0) >= 2 &&
      /\p{L}{3,}/u.test(venue) &&
      /^\p{Lu}/u.test(venue) &&
      words.every(
        (word, n) =>
          /^\p{Lu}[\p{L}.:–-]*$/u.test(word) ||
          /^(?:of|the|and|on|in|&)$/u.test(word) ||
          (n > 0 && words[n - 1].endsWith('-') && /^\p{Ll}+[.:]?$/u.test(word))
      )
    )
  }
  if (
    other.length &&
    other.every((e) => /^\d+$/u.test(e.item.str)) &&
    /\b\d+(?:\s*,\s*[A-Za-z]?\d+(?:[–-]\d+)?)?\s*\((?:18|19|20)\d{2}\)\.$/u.test(text)
  ) {
    const volume = other[0].item.str,
      at = remaining.lastIndexOf(' ' + volume + ' ')
    if (at >= 0 && journal(remaining.slice(0, at)))
      return { kind: 'journal-volume', roleFonts: [...new Set(other.map((e) => e.item.fontName!))] }
  }
  if (!other.length && /\b10\.\d{4,9}\/[^\s]+\s*\((?:18|19|20)\d{2}\)\.$/u.test(text)) {
    const at = remaining.search(/\b10\.\d{4,9}\//u)
    if (journal(remaining.slice(0, at))) return { kind: 'journal-doi', roleFonts: [] }
  }
  if (
    other.length &&
    new Set(other.map((e) => e.item.fontName)).size === 1 &&
    record
      .slice(record.indexOf(other[0]), record.lastIndexOf(other.at(-1)!) + 1)
      .every((e) => e.item.fontName === other[0].item.fontName) &&
    other.some((e) => /\p{L}{3,}/u.test(e.item.str)) &&
    /\([^()]*\p{L}[^()]*(?:18|19|20)\d{2}\)(?:\s+pp\.\s+\d+[–-]\d+)?\.$/u.test(text)
  )
    return { kind: 'book-publication', roleFonts: [...new Set(other.map((e) => e.item.fontName!))] }
}
