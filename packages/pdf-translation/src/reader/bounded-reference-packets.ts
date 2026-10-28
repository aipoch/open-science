import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'

type Unit = PdfTranslationLayout['units'][number]
type Entry = { key: string; index: number; item: PdfLayoutTextItem; owner?: Unit }
type Box = { x: number; y: number; right: number; bottom: number }
type Row = { baseline: number; entries: Entry[] }
const signature = (unit: Unit): string => unit.items.join('|')
const near = (a: number, b: number, font: number): boolean => Math.abs(a - b) <= font * 0.05
const citationStart = (text: string): boolean =>
  /^(?:\[[A-Za-z][A-Za-z0-9+-]{1,14}\]|[A-Z][A-Z ,.’'-]+,)/u.test(text)
const dated = (text: string): boolean => /\b(?:19|20)\d{2}[a-z]?\b/u.test(text)
const valid = (item: PdfLayoutTextItem): boolean =>
  !!item.fontName &&
  item.dir === 'ltr' &&
  item.fontVertical === false &&
  item.transform.length === 6 &&
  [...item.transform, item.width, item.height, item.fontAscent, item.fontDescent].every(
    Number.isFinite
  ) &&
  item.width > 0 &&
  item.height > 0 &&
  item.transform[0] > 0 &&
  item.transform[3] === item.height &&
  item.transform[1] === 0 &&
  item.transform[2] === 0 &&
  item.fontAscent! > 0 &&
  item.fontAscent! <= 1 &&
  item.fontDescent! >= -1 &&
  item.fontDescent! <= 0
const box = (page: PdfLayoutPage, item: PdfLayoutTextItem): Box => ({
  x: item.transform[4],
  right: item.transform[4] + item.width,
  y: page.height - item.transform[5] - item.fontAscent! * item.height,
  bottom: page.height - item.transform[5] - item.fontDescent! * item.height
})
const union = (boxes: Box[]): Box => ({
  x: Math.min(...boxes.map((b) => b.x)),
  y: Math.min(...boxes.map((b) => b.y)),
  right: Math.max(...boxes.map((b) => b.right)),
  bottom: Math.max(...boxes.map((b) => b.bottom))
})
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom
const rowText = (row: Row): string => row.entries.map((e) => e.item.str).join(' ')

/** Ordered native item tuples of complete bibliography owners. The caller may
 * protect only an unchanged whole tuple; this never splits or reconstructs text.
 * This independent headed-packet proof does not relax the older column guard.
 */
export function nativeBoundedReferencePackets(
  units: Unit[],
  pages: PdfLayoutPage[]
): ReadonlySet<string> {
  const result = new Set<string>(),
    counts = new Map<string, number>(),
    owners = new Map<string, Unit>(),
    entryCache = new Map<Unit, Entry[] | undefined>(),
    rowCache = new Map<PdfLayoutPage, Row[] | undefined>()
  for (const unit of units)
    for (const key of unit.items) {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      owners.set(key, unit)
    }
  function entries(unit: Unit): Entry[] | undefined {
    if (entryCache.has(unit)) return entryCache.get(unit)
    entryCache.set(unit, undefined)
    if (
      unit.fragments.length !== 1 ||
      !unit.items.length ||
      unit.items.length !== unit.originalStrings.length
    )
      return
    const page = pages[unit.fragments[0].page - 1]
    if (
      !page ||
      page.page !== unit.fragments[0].page ||
      page.rotation !== 0 ||
      ![page.width, page.height].every((n) => Number.isFinite(n) && n > 0)
    )
      return
    const native: Entry[] = []
    for (const [n, key] of unit.items.entries()) {
      const [number, index] = key.split(':').map(Number),
        item = page.items[index]
      if (
        number !== page.page ||
        !item ||
        !valid(item) ||
        item.str !== unit.originalStrings[n] ||
        counts.get(key) !== 1
      )
        return
      const bounds = box(page, item)
      if (bounds.x < 0 || bounds.y < 0 || bounds.right > page.width || bounds.bottom > page.height)
        return
      native.push({ key, index, item, owner: unit })
    }
    entryCache.set(unit, native)
    return native
  }
  function rows(page: PdfLayoutPage): Row[] | undefined {
    if (rowCache.has(page)) return rowCache.get(page)
    rowCache.set(page, undefined)
    const visible = page.items.flatMap((item, index) =>
      item.str.trim()
        ? [
            {
              item,
              index,
              key: `${page.page}:${index}`,
              owner: owners.get(`${page.page}:${index}`)
            }
          ]
        : []
    )
    if (page.rotation !== 0 || visible.some((e) => !valid(e.item))) return
    const grouped: Row[] = []
    for (const e of visible.sort(
      (a, b) =>
        b.item.transform[5] - a.item.transform[5] || a.item.transform[4] - b.item.transform[4]
    )) {
      const previous = grouped.at(-1)
      if (previous && Math.abs(previous.baseline - e.item.transform[5]) < e.item.height * 0.01)
        previous.entries.push(e)
      else grouped.push({ baseline: e.item.transform[5], entries: [e] })
    }
    rowCache.set(page, grouped)
    return grouped
  }
  function exclusive(packet: Unit[], page: PdfLayoutPage): Box | undefined {
    const all = packet.flatMap((unit) => entries(unit) ?? []),
      keys = new Set(all.map((e) => e.key))
    if (
      !all.length ||
      keys.size !== all.length ||
      all.length !== packet.reduce((n, u) => n + u.items.length, 0) ||
      packet.some((u) => u.fragments[0].page !== page.page)
    )
      return
    const domain = union(all.map((e) => box(page, e.item)))
    if (
      page.items.some(
        (item, index) =>
          item.str.trim() &&
          !keys.has(`${page.page}:${index}`) &&
          (!valid(item) || overlaps(box(page, item), domain))
      )
    )
      return
    return domain
  }
  function closedRow(row: Row, page: PdfLayoutPage): boolean {
    const last = row.entries.at(-1)!,
      next = page.items.findIndex((item, n) => n > last.index && !!item.str.trim()),
      emptyBreak = page.items
        .slice(last.index + 1, next < 0 ? undefined : next)
        .some((item) => !item.str.trim() && item.hasEOL === true)
    // PDF.js can retain EOL as an empty native item. Advance envelopes may
    // overlap for combining accents; all literal owners still belong to this
    // exclusive packet, and no glyph-ink or repaint claim is made here.
    return (
      row.entries.slice(0, -1).every((e) => e.item.hasEOL === false) &&
      (last.item.hasEOL === true || emptyBreak || next < 0) &&
      row.entries.every(
        (e, n) => n === 0 || e.item.transform[4] >= row.entries[n - 1].item.transform[4]
      )
    )
  }
  function reset(row: Row): boolean {
    const first = row.entries[0],
      owner = first.owner
    return (
      /^\[[A-Za-z][A-Za-z0-9+-]{1,14}\]/u.test(first.item.str) ||
      (!!owner &&
        citationStart(owner.source) &&
        dated(owner.source) &&
        owner.items[0] === first.key)
    )
  }
  const headings = units.filter(
    (u) => /^(?:References|REFERENCES|Bibliography|BIBLIOGRAPHY)$/u.test(u.source) && entries(u)
  )
  for (const unit of units) {
    if (unit.sourceOnly || unit.source.length > 140 || !unit.source.endsWith('.')) continue
    const native = entries(unit)
    if (!native) continue
    const page = pages[unit.fragments[0].page - 1],
      font = native[0].item.height,
      first = native[0].item,
      physical = rows(page)
    if (
      !physical ||
      native.some(
        (e) =>
          !near(e.item.height, font, font) || !near(e.item.transform[5], first.transform[5], font)
      )
    )
      continue
    const heading = headings.findLast(
      (h) =>
        h.fragments[0].page === page.page && h.fragments[0].rect.bottom < unit.fragments[0].rect.y
    )
    if (!heading) continue
    const title = entries(heading)!,
      titleBox = union(title.map((e) => box(page, e.item))),
      titleFont = Math.max(...title.map((e) => e.item.height))
    if (
      Math.abs((titleBox.x + titleBox.right) / 2 - page.width / 2) > titleFont * 1.5 ||
      titleFont < font * 1.1 ||
      titleFont > font * 1.7 ||
      unit.fragments[0].rect.right >= titleBox.x
    )
      continue
    const at = physical.findIndex((r) => r.entries.some((e) => e.key === native[0].key)),
      previous = physical[at - 1],
      next = physical[at + 1]
    if (!previous || !next || !reset(next)) continue
    const start = reset(previous)
      ? at - 1
      : physical[at - 2] && reset(physical[at - 2])
        ? at - 2
        : -1
    if (start < 0) continue
    const before = previous.entries.at(-1)!.item,
      gap = previous.baseline - first.transform[5],
      nextGap = first.transform[5] - next.baseline,
      indent = first.transform[4] - physical[start].entries[0].item.transform[4]
    if (
      first.fontName !== before.fontName ||
      native.some((e) => !previous.entries.some((p) => p.item.fontName === e.item.fontName)) ||
      gap <= font ||
      gap >= font * 1.5 ||
      !near(gap, nextGap, font) ||
      indent <= font * 0.7 ||
      indent >= font * 7 ||
      !dated(
        physical
          .slice(start, at + 1)
          .map(rowText)
          .join(' ')
      )
    )
      continue
    if (
      !near(first.transform[4], previous.entries[0].item.transform[4], font) &&
      !next.entries.some(
        (e) =>
          near(e.item.transform[4], first.transform[4], font) && near(e.item.height, font, font)
      )
    )
      continue
    const selectedRows = physical.slice(start, at + 2),
      packet = [...new Set(selectedRows.flatMap((r) => r.entries.map((e) => e.owner)))],
      startX = physical[start].entries[0].item.transform[4]
    if (packet.some((u) => !u) || selectedRows.some((r) => !closedRow(r, page))) continue
    const complete = packet as Unit[],
      domain = exclusive(complete, page)
    if (
      !domain ||
      domain.y <= titleBox.bottom ||
      domain.right - domain.x <= page.width * 0.5 ||
      complete.some((u) =>
        entries(u)!.some(
          (e) =>
            e.item.transform[5] > physical[start].baseline + font * 0.05 ||
            e.item.transform[5] < next.baseline - font * 0.05 ||
            e.item.height < font * 0.79 ||
            e.item.height > font * 1.02
        )
      ) ||
      selectedRows.some(
        (r) =>
          !near(r.entries[0].item.transform[4], startX, font) &&
          !near(r.entries[0].item.transform[4], first.transform[4], font)
      )
    )
      continue
    result.add(signature(unit))
  }

  // A detached author-year key has no independent translation meaning. Its
  // complete same-row publication and established native key column close it.
  for (const unit of units) {
    if (unit.sourceOnly || !/^\[[A-Za-z][A-Za-z0-9+-]{1,14}\]$/u.test(unit.source)) continue
    const native = entries(unit)
    if (!native || native.length !== 1) continue
    const page = pages[unit.fragments[0].page - 1],
      marker = native[0],
      font = marker.item.height,
      physical = rows(page)
    if (
      !physical ||
      !headings.some(
        (h) =>
          h.fragments[0].page === page.page && h.fragments[0].rect.bottom < unit.fragments[0].rect.y
      )
    )
      continue
    const starts = page.items.filter((i) => /^\[[A-Za-z][A-Za-z0-9+-]{1,14}\]/u.test(i.str))
    if (
      starts.length < 6 ||
      starts.some(
        (i) =>
          !valid(i) ||
          i.fontName !== marker.item.fontName ||
          !near(i.height, font, font) ||
          !near(i.transform[4], marker.item.transform[4], font)
      )
    )
      continue
    const at = physical.findIndex((r) => r.entries.some((e) => e.key === marker.key)),
      row = physical[at],
      previous = physical[at - 1]
    if (
      !row ||
      !previous ||
      row.entries[0].key !== marker.key ||
      !closedRow(row, page) ||
      !rowText(previous).endsWith('.') ||
      !rowText(row).endsWith('.') ||
      !dated(rowText(row)) ||
      row.entries.length < 2 ||
      row.entries[1].item.transform[4] <= marker.item.transform[4] + marker.item.width + font
    )
      continue
    const packet = [...new Set(row.entries.map((e) => e.owner))]
    if (packet.some((u) => !u)) continue
    const complete = packet as Unit[],
      domain = exclusive(complete, page)
    if (
      !domain ||
      domain.right - domain.x < page.width * 0.5 ||
      complete.some((u) =>
        entries(u)!.some(
          (e) => !near(e.item.height, font, font) || !near(e.item.transform[5], row.baseline, font)
        )
      )
    )
      continue
    result.add(signature(unit))
  }
  // A partial first bibliography column is followed by a complete numbered
  // right column. Prove both native lanes and the next page's numbered reset.
  for (const heading of headings) {
    const page = pages[heading.fragments[0].page - 1],
      nextPage = pages[page.page],
      middle = page.width / 2
    if (
      !nextPage ||
      nextPage.page !== page.page + 1 ||
      nextPage.rotation !== 0 ||
      nextPage.width !== page.width ||
      nextPage.height !== page.height ||
      !rows(page)
    )
      continue
    const markers = page.items.flatMap((item, index) =>
        /^\[\d{1,4}\]$/u.test(item.str)
          ? [{ item, index, number: Number(item.str.slice(1, -1)) }]
          : []
      ),
      left = markers.filter((e) => e.item.transform[4] < middle),
      right = markers.filter((e) => e.item.transform[4] > middle)
    if (
      left.length !== 3 ||
      right.length < 8 ||
      markers.length !== left.length + right.length ||
      markers.some((e, n) => e.number !== n + 1)
    )
      continue
    const font = left[0].item.height,
      title = entries(heading)!,
      titleBox = union(title.map((e) => box(page, e.item))),
      titleFont = Math.max(...title.map((e) => e.item.height)),
      next = nextPage.items.find((i) => /^\[\d{1,4}\]$/u.test(i.str))
    if (
      !next ||
      !valid(next) ||
      Number(next.str.slice(1, -1)) !== markers.at(-1)!.number + 1 ||
      next.fontName !== left[0].item.fontName ||
      !near(next.height, font, font) ||
      !near(next.transform[4] + next.width, left[0].item.transform[4] + left[0].item.width, font) ||
      titleFont < font * 1.1 ||
      titleFont > font * 1.7 ||
      titleBox.right >= middle ||
      box(page, right[0].item).bottom >= titleBox.y - font * 4
    )
      continue
    const leftOwners = units.filter(
        (u) =>
          u.fragments.length === 1 &&
          u.fragments[0].page === page.page &&
          u.fragments[0].rect.x < middle &&
          u.fragments[0].rect.y >= heading.fragments[0].rect.y
      ),
      rightOwners = units.filter(
        (u) =>
          u.fragments.length === 1 &&
          u.fragments[0].page === page.page &&
          u.fragments[0].rect.x > middle
      ),
      leftDomain = exclusive(leftOwners, page),
      rightDomain = exclusive(rightOwners, page)
    if (!leftDomain || !rightDomain || rightDomain.x - leftDomain.right < font * 0.9) continue
    const leftText = leftOwners.filter((u) => u !== heading).flatMap((u) => entries(u)!),
      rightText = rightOwners.flatMap((u) => entries(u)!),
      leftFonts = new Set(leftText.map((e) => e.item.fontName))
    if (
      !leftText.length ||
      !rightText.length ||
      [...leftText, ...rightText].some((e) => !near(e.item.height, font, font)) ||
      rightText.some((e) => !leftFonts.has(e.item.fontName)) ||
      markers.some(
        (e) =>
          !valid(e.item) ||
          e.item.fontName !== left[0].item.fontName ||
          !near(e.item.height, font, font)
      )
    )
      continue
    let complete = true
    for (const [lane, native] of [
      [left, leftText],
      [right, rightText]
    ] as const) {
      const keys = new Set(native.map((e) => e.key)),
        laneRows = rows(page)!.flatMap((r) => {
          const selected = r.entries.filter((e) => keys.has(e.key))
          return selected.length ? [{ baseline: r.baseline, entries: selected }] : []
        }),
        edge = lane[0].item.transform[4] + lane[0].item.width,
        firstRow = laneRows[0],
        body = firstRow?.entries.find((e) => e.item.transform[4] > edge + font * 0.25)
      if (
        !body ||
        body.item.transform[4] - edge > font * 3 ||
        laneRows.some((r) => !closedRow(r, page)) ||
        lane.some(
          (e, n) =>
            !near(e.item.transform[4] + e.item.width, edge, font) ||
            (n > 0 && e.item.transform[5] >= lane[n - 1].item.transform[5])
        )
      ) {
        complete = false
        break
      }
      const x = body.item.transform[4]
      if (
        laneRows.some((r) =>
          /^\[\d{1,4}\]$/u.test(r.entries[0].item.str)
            ? !near(r.entries[0].item.transform[4] + r.entries[0].item.width, edge, font)
            : !near(r.entries[0].item.transform[4], x, font)
        )
      ) {
        complete = false
        break
      }
    }
    if (!complete) continue
    for (const [n, marker] of right.entries()) {
      const record = page.items
          .slice(marker.index, right[n + 1]?.index)
          .filter((i) => i.str.trim() && i.transform[4] > middle),
        text = record.map((i) => i.str).join(' ')
      if (
        !record.length ||
        !dated(text) ||
        (text.match(/\p{L}{2,}/gu)?.length ?? 0) < 8 ||
        record.some((i) => !valid(i))
      ) {
        complete = false
        break
      }
    }
    if (complete) for (const unit of rightOwners) if (!unit.sourceOnly) result.add(signature(unit))
  }
  return result
}
