import type { PdfLayoutPage, PdfLayoutTextItem } from './layout.js'

const familyFirst = /^\[\d{1,4}\]\s+\p{Lu}[\p{L}'’ -]+,\s+(?:\p{Lu}\.\s*){1,4}/u

// A printed native divider can close an unheaded bibliography without relying
// on the preceding paragraph's wording or interpreting its hyphenated source.
// Keep all owners and risks verbatim; only a complete, unique suffix is returned.
export function nativeDividedReferenceSuffix<
  T extends { items: string[]; originalStrings: string[] }
>(
  units: T[],
  pages: PdfLayoutPage[],
  nativeContentsUpright: (item: PdfLayoutTextItem) => boolean,
  pageCount?: number
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
    starts = all.filter(
      (e) =>
        /^\[1\]\s+\p{Lu}\./u.test(e.item.str) ||
        (e.page === pageCount && e.item.str.startsWith('[1] ') && familyFirst.test(e.item.str))
    ),
    passes: T[][] = []
  for (const start of starts) {
    const result = one(start) ?? beforeSupplement(start)
    if (result) passes.push(result)
  }
  return passes.length === 1 ? passes[0] : []
  function beforeSupplement(start: (typeof all)[number]): T[] | undefined {
    const opener = pages.find((page) => page.page > start.page && isSupplementOpener(page))
    return opener ? one(start, opener.page) : undefined
  }

  function one(start: (typeof all)[number], endPage?: number): T[] | undefined {
    const bounded = endPage !== undefined
    const page = pages.find((p) => p.page === start.page)!,
      h = start.item.height,
      raw = page.items
    const terminalFamilyNames = page.page === pageCount && familyFirst.test(start.item.str)
    if (!nativeContentsUpright(start.item) || page.rotation !== 0) return
    const evidence = page.nativeReferenceEvidence
    if (!evidence?.complete) return
    const preceding = raw.slice(0, start.index).filter((i) => i.str.trim())
    const following = raw.slice(start.index).filter((i) => i.str.trim())
    if (!preceding.length || !following.length) return
    const folio = preceding[0],
      previousFolio = pages[page.page - 2]?.items.find((item) => item.str.trim())
    const repeatedFolio = (): boolean =>
      pages.length === pageCount &&
      page.page === pageCount &&
      folio.str === String(page.page) &&
      folio.height >= h * 1.05 &&
      folio.transform[4] >= page.width * 0.85 &&
      folio.transform[5] >= page.height * 0.94 &&
      !!previousFolio &&
      previousFolio.str === String(page.page - 1) &&
      nativeContentsUpright(previousFolio) &&
      previousFolio.fontName === folio.fontName &&
      previousFolio.height === folio.height &&
      previousFolio.transform[5] === folio.transform[5] &&
      Math.abs(
        previousFolio.transform[4] + previousFolio.width - folio.transform[4] - folio.width
      ) <=
        h * 0.05
    if (terminalFamilyNames && (preceding.length !== 1 || !repeatedFolio())) return
    // A complete ordinary two-column body may end above the divider on the same page.
    const body = preceding.slice(1),
      bodySplit = body.findIndex((item) => item.transform[4] > page.width / 2)
    const terminalPreprints =
      !terminalFamilyNames &&
      !bounded &&
      repeatedFolio() &&
      bodySplit >= 2 &&
      body.length - bodySplit >= 2 &&
      /[.!?]$/.test(body.at(-1)!.str) &&
      body.every(
        (item, index) =>
          item.fontName === folio.fontName &&
          item.height === folio.height &&
          (index < bodySplit
            ? item.transform[4] + item.width < page.width / 2
            : item.transform[4] > page.width / 2)
      )
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
    const tail = all.slice(all.indexOf(start)).filter((entry) => !endPage || entry.page < endPage),
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
      headers.length !== (endPage ?? pages.length + 1) - start.page - 1 ||
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
      publicationRoles: Publication[] = [],
      confirmed = new Set<string>()
    let terminalPreprintCount = 0,
      usesTerminalPublicationFallback = false
    for (let n = 0; n < records.length; n++) {
      const record = records[n],
        text = record.map((e) => e.item.str).join(' '),
        stack: string[] = []
      for (const ch of text) {
        if (ch === '(') stack.push(ch)
        if (ch === ')' && !stack.pop()) return
      }
      const publication = terminalFamilyNames
        ? undefined
        : publicationStructureProof(record, start.item.fontName!)
      if (stack.length) return
      let typedPreprint = false
      if (!publication && !bounded && !terminalFamilyNames) {
        if (
          !terminalPreprints ||
          !/^\[\d{1,4}\]\s+(?:\p{Lu}\.(?:-\p{L}\.)?\s*){1,4}\p{Lu}[\p{L}'’-]+/u.test(text)
        )
          return
        typedPreprint =
          /(?:, |\b)arXiv:\d{4}\.\d{4,5}(?:v\d+)?\s+\[[a-z]+(?:-\s*[a-z]+)?(?:\.[A-Z]{2})?\]\.$/iu.test(
            text
          )
        const datedVolume =
          /\((?:18|19|20)\d{2}\)\.$/u.test(text) &&
          record.some(
            ({ item }) => item.fontName !== start.item.fontName && /^\d{1,4}$/u.test(item.str)
          )
        if ((!typedPreprint && !datedVolume) || (text.match(/\p{L}{2,}/gu)?.length ?? 0) < 8) return
        usesTerminalPublicationFallback = true
        if (typedPreprint) terminalPreprintCount++
      }
      if (terminalFamilyNames) {
        const quoted = /^([^“]+)“(\p{L}[^“”]+)”\s*([^“”]+)\.$/u.exec(text),
          alternate = record.filter(({ item }) => item.fontName !== start.item.fontName),
          publicationTail = quoted?.[3] ?? ''
        const dated =
          alternate.length === 1 &&
          /^\d{1,4}$/u.test(alternate[0].item.str) &&
          /\((?:18|19|20)\d{2}\)/u.test(publicationTail) &&
          /(?:\b\d{1,8}(?:[–-]\d{1,8})?|\((?:18|19|20)\d{2}\))$/u.test(publicationTail)
        const preprint =
          alternate.length === 0 &&
          /^\[arXiv:\d{4}\.\d{4,5}(?:v\d+)?(?:\s+\[[a-z-]+(?:\.[A-Z]{2})?\])?\]$/iu.test(
            publicationTail
          )
        if (
          !quoted ||
          !familyFirst.test(quoted[1]) ||
          (quoted[2].match(/\p{L}{2,}/gu)?.length ?? 0) < 2 ||
          (!dated && !preprint)
        )
          return
      }
      if (publication) {
        publicationRoles.push(publication)
        for (const entry of record) confirmed.add(entry.key)
      }
      for (const e of record) {
        const row = rows.at(-1)
        if (row && row.page === e.page && Math.abs(row.baseline - e.item.transform[5]) < h * 0.45) {
          const last = row.entries.at(-1)!.item
          const distance = e.item.transform[4] - last.transform[4]
          const overlapsAccent =
            bounded &&
            /^[´¸\p{M}]$/u.test(last.str) &&
            last.fontName === e.item.fontName &&
            Math.abs(last.height - e.item.height) < h * 0.01 &&
            Math.abs(last.transform[5] - e.item.transform[5]) > h * 0.15 &&
            distance > -h * 0.1
          if (
            last.hasEOL === true ||
            (distance <= 0 && !overlapsAccent) ||
            distance - last.width > h * (bounded ? 2.1 : typedPreprint ? 1.7 : 1.5)
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
    if (
      usesTerminalPublicationFallback &&
      (records.length < 12 || !terminalPreprintCount || publicationRoles.length < 2)
    )
      return
    if (bounded && (records.length < 12 || publicationRoles.length < records.length / 2)) return
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
        continuations.some((v) => Math.abs(v - x) > h * (bounded ? 0.1 : 0.05)) ||
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
              (n > 0 && outOfOrderWithinOwner(u, n, page, index))
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
    return bounded
      ? owners.filter((owner) => owner.items.every((key) => confirmed.has(key)))
      : owners

    function outOfOrderWithinOwner(owner: T, n: number, page: number, index: number): boolean {
      const [priorPage, priorIndex] = owner.items[n - 1].split(':').map(Number)
      if (page !== priorPage) return page < priorPage
      if (index > priorIndex) return false
      return (
        !bounded ||
        !rows.some(
          (row) =>
            row.page === page &&
            row.entries.some((entry) => entry.index === priorIndex) &&
            row.entries.some((entry) => entry.index === index)
        )
      )
    }
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

// A separately printed supplement opener can close a bibliography before the
// final file page. A generic page heading or a body mention grants no boundary.
function isSupplementOpener(page: PdfLayoutPage): boolean {
  if (page.rotation !== 0) return false
  const [folio, ...text] = page.items.filter((item) => item.str.trim())
  const first = text[0]
  if (
    folio?.str !== String(page.page) ||
    folio.transform[5] <= page.height * 0.94 ||
    !first ||
    first.height < folio.height * 1.1 ||
    first.transform[5] <= page.height * 0.89 ||
    first.transform[5] >= folio.transform[5] - folio.height
  )
    return false
  const row = text.filter(
    (item) =>
      item.transform[4] < page.width / 2 &&
      Math.abs(item.transform[5] - first.transform[5]) < first.height * 0.02
  )
  return (
    row.length <= 20 &&
    row.every(
      (item) =>
        item.fontName === first.fontName &&
        item.height === first.height &&
        item.dir === 'ltr' &&
        item.transform[1] === 0 &&
        item.transform[2] === 0
    ) &&
    /^Supplementary Material for\s+“?\p{Lu}/u.test(row.map((item) => item.str).join(' '))
  )
}
