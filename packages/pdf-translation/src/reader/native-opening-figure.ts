import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'
import {
  appendLayoutUnitText,
  nativeHorizontalSourceItem,
  nativeReferenceItems,
  sameUnrotatedPageSize
} from './layout-evidence.js'
import { terminal } from './layout-text.js'

type LayoutUnit = PdfTranslationLayout['units'][number]

const unprotectedProse = (unit: LayoutUnit): boolean =>
  !unit.sourceOnly && !unit.preserve && !unit.figure && !unit.referenceBoundary

const continuationCandidate = (unit: LayoutUnit): boolean =>
  unprotectedProse(unit) &&
  unit.risks.every((risk) => risk === 'possible-continuation' || risk === 'ambiguous-line-hyphen')

export function joinNativeSentenceBelowOpeningFigure(
  units: LayoutUnit[],
  pages: PdfLayoutPage[]
): void {
  for (let i = 0; i < units.length; i++) {
    const head = units[i]
    if (
      !/(?:\b(?:at|in|within|from) (?:the|several|multiple|different)|\b(?:demonstrate|measure|confirm|show|verify|establish) the [a-z]{3,18})$/u.test(
        head.source
      ) ||
      !continuationCandidate(head)
    )
      continue
    const end = head.fragments.at(-1)
    if (!end) continue
    const before = pages[end.page - 1],
      after = pages[end.page]
    if (
      !before ||
      !after ||
      !sameUnrotatedPageSize(before, after) ||
      head.fragments.some(
        (fragment) => fragment.page !== end.page || fragment.rect.x < before.width / 2
      ) ||
      end.rect.bottom < before.height * 0.9
    )
      continue
    const bridges = units.slice(i + 1, i + 9)
    const tailIndex = bridges.findIndex(
      (unit) =>
        continuationCandidate(unit) &&
        unit.fragments.length === 1 &&
        unit.fragments[0].page === after.page &&
        /^\p{Ll}[\p{Ll}-]{3,} (?:where |[\p{Ll}-]{3,}(?:[.,]| ))/u.test(unit.source)
    )
    if (tailIndex < 1) continue
    const tail = bridges[tailIndex]
    const captionIndex = bridges.findIndex((unit) =>
      /^Fig(?:ure)?\.? [1-9]\d*[.:] /u.test(unit.source)
    )
    if (captionIndex < 1 || captionIndex >= tailIndex) continue
    const prefix = bridges.slice(0, tailIndex)
    const title = prefix[captionIndex]
    const header = prefix.slice(0, captionIndex)
    const caption = prefix.slice(captionIndex + 1)
    const runningHeader = header.find((unit) => unit.source === 'Letter')
    if (
      title.fragments.length !== 1 ||
      !runningHeader ||
      header.some((unit) => unit.fragments[0].rect.bottom > after.height * 0.08) ||
      caption.some(
        (unit) => unit.preserve !== 'formula' && !/^[kMGT]?Hz[,.;]?$/u.test(unit.source)
      ) ||
      !terminal(
        caption.filter((unit) => unit.preserve === 'formula').at(-1)?.source ?? title.source
      ) ||
      prefix.some((unit) => unit.fragments.some((fragment) => fragment.page !== after.page))
    )
      continue
    const [start] = tail.fragments,
      last = nativeReferenceItems(head, pages).at(-1),
      [lead, next] = nativeReferenceItems(tail, pages),
      [captionLead] = nativeReferenceItems(title, pages)
    const captionMembers = [title, ...caption].flatMap((unit) => nativeReferenceItems(unit, pages))
    const finish = after.items.findLast((item) => captionMembers.includes(item))
    if (
      !last ||
      !finish ||
      ![last, lead, next, captionLead, finish].every(nativeHorizontalSourceItem)
    )
      continue
    const em = last.height,
      x = (item: PdfLayoutTextItem): number => item.transform[4],
      y = (item: PdfLayoutTextItem): number => item.transform[5],
      near = (a: number, b: number): boolean => Math.abs(a - b) < em * 0.13,
      pageHeader = before.items.find(
        (item) => item.str === 'Letter' && y(item) > before.height * 0.92
      ),
      [newHeader] = nativeReferenceItems(runningHeader, pages)
    if (
      !pageHeader ||
      !newHeader ||
      !near(y(pageHeader), y(newHeader)) ||
      pageHeader.fontName !== newHeader.fontName ||
      last.hasEOL ||
      !lead.hasEOL ||
      !finish.hasEOL ||
      ![lead, finish, next].every(
        (item) => item.fontName === last.fontName && near(item.height, em)
      ) ||
      !near(x(lead), x(next)) ||
      !near(x(lead), x(captionLead)) ||
      !near(x(lead), before.width - x(last) - last.width) ||
      !near(lead.width, x(last) + last.width - end.rect.x) ||
      start.rect.x > after.width * 0.15 ||
      y(finish) - y(lead) < em * 2.8 ||
      y(finish) - y(lead) > em * 3.8 ||
      y(lead) - y(next) < em ||
      y(lead) - y(next) > em * 1.4 ||
      before.items.slice(before.items.indexOf(last) + 1).some((item) => item.str.trim()) ||
      after.items
        .slice(after.items.indexOf(finish) + 1, after.items.indexOf(lead))
        .some((item) => item.str.trim())
    )
      continue
    appendLayoutUnitText(head, tail)
    units.splice(i + 1 + tailIndex, 1)
  }
}

// A tagged display can follow a sentence that resumes below an opening figure.
// Use the native caption, column margins and equation rail to prove the seam.
export function joinNativeDisplayLeadBelowOpeningFigure(
  units: LayoutUnit[],
  pages: PdfLayoutPage[]
): void {
  const prose = (unit: LayoutUnit): boolean => unprotectedProse(unit) && unit.fragments.length === 1
  const x = (item: PdfLayoutTextItem): number => item.transform[4],
    y = (item: PdfLayoutTextItem): number => item.transform[5],
    edge = (item: PdfLayoutTextItem): number => x(item) + item.width
  for (let at = 0; at + 3 < units.length; at++) {
    const head = units[at]
    const modifier = /\b(?:the|an?) (\p{Ll}{3,}-(?:dependent|induced|driven))$/u.exec(
      head.source
    )?.[1]
    if (!modifier || !prose(head)) continue
    const [bottom] = head.fragments,
      old = pages[bottom.page - 1],
      next = pages[bottom.page]
    if (
      !old ||
      !next ||
      !sameUnrotatedPageSize(old, next) ||
      bottom.rect.x < old.width * 0.5 ||
      bottom.rect.bottom < old.height * 0.9
    )
      continue
    const capAt = units.findIndex(
      (unit, index) =>
        index > at &&
        unit.fragments[0]?.page === next.page &&
        /^FIG\. [1-9]\d*\. /u.test(unit.source)
    )
    if (capAt <= at + 1) continue
    const [caption, tail] = units.slice(capAt, capAt + 2)
    if (
      !tail ||
      !prose(tail) ||
      !/^(?:\p{Ll}{3,} ){2,5}[\p{L}\p{N}]+ can be calculated as$/u.test(tail.source) ||
      !terminal(caption.source) ||
      caption.fragments.length !== 1 ||
      tail.fragments[0].page !== next.page
    )
      continue
    const [cap] = caption.fragments,
      [top] = tail.fragments
    if (
      top.rect.x > next.width * 0.15 ||
      top.rect.y > next.height * 0.55 ||
      units
        .slice(at + 1, capAt)
        .some((unit) =>
          unit.fragments.some(
            (fragment) =>
              !(
                (fragment.page === next.page && fragment.rect.bottom <= cap.rect.y) ||
                (fragment.page === old.page &&
                  fragment.rect.bottom < bottom.rect.y &&
                  unit.risks.includes('unsupported-orientation'))
              )
          )
        )
    )
      continue
    const displayStarts = capAt + 2
    let end = displayStarts
    while (
      units[end]?.sourceOnly &&
      units[end].preserve === 'formula' &&
      units[end].fragments.every(({ page }) => page === next.page)
    )
      end++
    const display = units
      .slice(displayStarts, end)
      .flatMap((unit) => nativeReferenceItems(unit, pages))
    const tag = display.at(-1)
    const last = nativeReferenceItems(head, pages).at(-1),
      capRuns = nativeReferenceItems(caption, pages),
      capEnd = capRuns.at(-1),
      tailRuns = nativeReferenceItems(tail, pages),
      [first] = tailRuns,
      leadEnd = tailRuns.at(-1),
      folio = next.items[0]
    if (
      !last ||
      !capEnd ||
      !leadEnd ||
      !tag ||
      !/^\([1-9]\d*\)$/u.test(tag.str) ||
      ![last, capRuns[0], capEnd, first, leadEnd, folio, tag].every(nativeHorizontalSourceItem)
    )
      continue
    const em = last.height,
      near = (a: number, b: number): boolean => Math.abs(a - b) < em * 0.12,
      capEndAt = next.items.indexOf(capEnd),
      leadAt = next.items.indexOf(first),
      leadEndAt = next.items.indexOf(leadEnd),
      tagAt = next.items.indexOf(tag)
    const protectedInk = new Set(display)
    if (
      old.items.at(-1) !== last ||
      !last.str.endsWith(modifier) ||
      folio.str !== String(next.page) ||
      !near(edge(folio), bottom.rect.right) ||
      first.fontName !== last.fontName ||
      leadEnd.fontName !== first.fontName ||
      !near(first.height, em) ||
      !near(y(first), y(leadEnd)) ||
      !leadEnd.hasEOL ||
      !near(x(first), x(capRuns[0])) ||
      !near(x(first), x(capEnd)) ||
      !near(cap.rect.right - cap.rect.x, bottom.rect.right - bottom.rect.x) ||
      capEnd.height >= em * 0.96 ||
      y(capEnd) - y(first) < em * 2.8 ||
      y(capEnd) - y(first) > em * 4 ||
      capEndAt >= leadAt ||
      leadAt > leadEndAt ||
      leadEndAt >= tagAt ||
      next.items.slice(capEndAt + 1, leadAt).some((item) => item.str.trim()) ||
      next.items
        .slice(leadEndAt + 1, tagAt)
        .some((item) => item.str.trim() && !protectedInk.has(item)) ||
      tag.fontName !== last.fontName ||
      y(first) - y(tag) < em * 1.8 ||
      y(first) - y(tag) > em * 3.6 ||
      !near(edge(tag), cap.rect.right)
    )
      continue

    appendLayoutUnitText(head, tail)
    head.risks = [...new Set([...head.risks, ...tail.risks])]
    units.splice(capAt + 1, 1)
  }
}

// A paragraph can continue below a figure while the centered footer and
// caption keep separate owners. Match the full-width native body rails.
export function joinNativeClauseBelowOpeningFigure(
  units: LayoutUnit[],
  pages: PdfLayoutPage[]
): void {
  for (let at = 0; at + 3 < units.length; at++) {
    const [head, folio, caption, tail] = units.slice(at, at + 4)
    if (
      !(
        (/, the$/u.test(head.source) && /^\p{Ll}{3,}(?: \p{Ll}{2,}){2}/u.test(tail.source)) ||
        (/\(for (?:example|instance),$/u.test(head.source) &&
          /^with .{12,180}\)/u.test(tail.source))
      ) ||
      !/^Figure [1-9]\d*[.:] /u.test(caption.source) ||
      !terminal(caption.source) ||
      !folio.sourceOnly ||
      folio.preserve !== 'literal' ||
      [head, tail].some(
        (unit) => unit.kind !== 'prose-candidate' || !continuationCandidate(unit)
      ) ||
      [head, folio, caption, tail].some((unit) => unit.fragments.length !== 1)
    )
      continue
    const [left, number, picture, right] = [head, folio, caption, tail].map(
        (unit) => unit.fragments[0]
      ),
      previous = pages[left.page - 1],
      next = pages[right.page - 1]
    if (
      !previous ||
      !next ||
      !sameUnrotatedPageSize(previous, next) ||
      number.page !== left.page ||
      right.page !== left.page + 1 ||
      picture.page !== right.page ||
      left.rect.bottom < previous.height * 0.9 ||
      right.rect.y > next.height * 0.5 ||
      left.rect.right - left.rect.x < previous.width * 0.67 ||
      folio.source !== String(left.page)
    )
      continue

    const oldRuns = nativeReferenceItems(head, pages),
      newRuns = nativeReferenceItems(tail, pages),
      captionRuns = nativeReferenceItems(caption, pages),
      [pageNumber] = nativeReferenceItems(folio, pages),
      end = oldRuns.at(-1),
      [lead] = newRuns,
      [label] = captionRuns,
      capEnd = captionRuns.at(-1)
    if (
      !end ||
      !capEnd ||
      ![end, lead, label, capEnd, pageNumber].every(nativeHorizontalSourceItem)
    )
      continue
    const em = end.height,
      x = (run: PdfLayoutTextItem): number => run.transform[4],
      y = (run: PdfLayoutTextItem): number => run.transform[5],
      near = (a: number, b: number): boolean => Math.abs(a - b) < em * 0.1,
      bounds = (runs: PdfLayoutTextItem[], base: number): number[] =>
        runs.filter((run) => near(y(run), base)).flatMap((run) => [x(run), x(run) + run.width]),
      row = (runs: PdfLayoutTextItem[], base: number): boolean => {
        const edges = bounds(runs, base)
        return (
          edges.length > 0 &&
          near(Math.min(...edges), left.rect.x) &&
          near(Math.max(...edges), left.rect.right)
        )
      },
      previousLine = oldRuns.findLast((run) => y(run) - y(end) > em),
      followingLine = newRuns.find((run) => y(lead) - y(run) > em),
      oldVisible = previous.items.filter((run) => run.str.trim()),
      newVisible = next.items.filter((run) => run.str.trim())
    if (
      !previousLine ||
      !followingLine ||
      oldVisible.at(-2) !== end ||
      oldVisible.at(-1) !== pageNumber ||
      captionRuns.some((run, n) => run !== newVisible[n]) ||
      newVisible[captionRuns.length] !== lead ||
      !end.hasEOL ||
      !capEnd.hasEOL ||
      [lead, label, pageNumber].some(
        (run) => run.fontName !== end.fontName || !near(run.height, em)
      ) ||
      !near(x(pageNumber) + pageNumber.width / 2, previous.width / 2) ||
      y(end) - y(pageNumber) < em * 2.5 ||
      y(end) - y(pageNumber) > em * 3 ||
      y(label) < next.height * 0.57 ||
      y(capEnd) - y(lead) < em * 2.5 ||
      y(capEnd) - y(lead) > em * 3.2 ||
      y(previousLine) - y(end) > em * 1.4 ||
      !near(y(previousLine) - y(end), y(lead) - y(followingLine)) ||
      ![y(end), y(previousLine)].every((base) => row(oldRuns, base)) ||
      ![y(lead), y(followingLine)].every((base) => row(newRuns, base))
    )
      continue
    appendLayoutUnitText(head, tail)
    head.risks = [...new Set([...head.risks, ...tail.risks])]
    units.splice(at + 3, 1)
  }
}

// A float can precede the first native body line without interrupting its reading order.
export function joinNativeBodyAcrossOpeningFloats(
  units: LayoutUnit[],
  layouts: PdfTranslationLayout['pages'],
  pages: PdfLayoutPage[],
  lexicon: ReadonlySet<string>
): void {
  const visible = (page: PdfLayoutPage): PdfLayoutTextItem[] =>
    page.items.filter((item) => item.str.trim())
  const x = (run: PdfLayoutTextItem): number => run.transform[4]
  const y = (run: PdfLayoutTextItem): number => run.transform[5]
  const edge = (run: PdfLayoutTextItem): number => x(run) + run.width
  for (let at = 0; at < units.length - 1; at++) {
    const head = units[at]
    const [closing] = head.fragments
    if (!closing || !continuationCandidate(head) || head.fragments.length !== 1) continue
    const previous = pages[closing.page - 1],
      next = pages[closing.page],
      oldLayout = layouts[closing.page - 1]
    if (
      !previous ||
      !next ||
      !oldLayout ||
      !sameUnrotatedPageSize(previous, next) ||
      closing.rect.x <= previous.width / 2 ||
      closing.rect.bottom <= previous.height * 0.86
    )
      continue

    const oldRuns = visible(previous)
    const newRuns = visible(next)
    const origin = nativeReferenceItems(head, pages)
    const first = origin[0]
    if (!nativeHorizontalSourceItem(first)) continue
    const em = first.height
    const close = (a: number, b: number): boolean => Math.abs(a - b) < em * 0.23
    const sameBody = (run: PdfLayoutTextItem): boolean =>
      nativeHorizontalSourceItem(run) && run.fontName === first.fontName && close(run.height, em)

    const hyphen = /\b([a-z]{4,})-$/u.exec(head.source)?.[1]
    let headEnd = at + 1
    let last = origin.at(-1)
    let folio: LayoutUnit | undefined
    if (hyphen) {
      folio = units[headEnd++]
      const [number] = folio ? nativeReferenceItems(folio, pages) : []
      if (
        !last?.hasEOL ||
        !last.str.endsWith(hyphen + '-') ||
        !folio?.sourceOnly ||
        folio.preserve !== 'literal' ||
        folio.source !== String(previous.page) ||
        !sameBody(number) ||
        oldRuns.at(-1) !== number ||
        oldRuns.at(-2) !== last ||
        !close(x(number) + number.width / 2, previous.width / 2) ||
        y(last) - y(number) < em * 2 ||
        y(last) - y(number) > em * 4
      )
        continue
    } else {
      if (origin.length !== 1 || !/^(?:Although|While)\b/u.test(head.source)) continue
      const rowStart = oldRuns.indexOf(first)
      const row = oldRuns.slice(rowStart)
      if (
        rowStart < 2 ||
        row.length < 4 ||
        row.length > 12 ||
        row.some(
          (run, index) =>
            !sameBody(run) ||
            !close(y(run), y(first)) ||
            !/^[a-z]+,?$/iu.test(run.str) ||
            (index > 0 &&
              (x(run) - edge(row[index - 1]) < em * 0.85 ||
                x(run) - edge(row[index - 1]) > em * 1.6)) ||
            !continuationCandidate(units[at + index] ?? head) ||
            units[at + index]?.fragments.length !== 1 ||
            units[at + index]?.items.length !== 1 ||
            nativeReferenceItems(units[at + index], pages)[0] !== run
        ) ||
        !/, (?:the|a|an)$/u.test(row.map(({ str }) => str).join(' ')) ||
        !sameBody(oldRuns[rowStart - 1]) ||
        !close(x(oldRuns[rowStart - 1]), x(first)) ||
        !close(edge(oldRuns[rowStart - 1]), edge(row.at(-1)!))
      )
        continue
      headEnd = at + row.length
      last = row.at(-1)
    }
    if (!last || !sameBody(last)) continue

    const caption = units[headEnd]
    if (
      !caption ||
      !/^Fig(?:ure)?\.?\s*\d+[.:]\s*/iu.test(caption.source) ||
      nativeReferenceItems(caption, pages)[0] !== newRuns[0]
    )
      continue
    const bodyAt = units.findIndex((unit, index) => {
      const [fragment] = unit.fragments
      if (
        index <= headEnd ||
        !fragment ||
        fragment.page !== next.page ||
        fragment.rect.right >= next.width / 2 ||
        fragment.rect.y >= next.height * 0.55 ||
        unit.kind !== 'prose-candidate' ||
        !continuationCandidate(unit)
      )
        return false
      const [lead, second] = nativeReferenceItems(unit, pages)
      return (
        sameBody(lead) &&
        sameBody(second) &&
        /^\p{Ll}{3,} \p{Ll}{2,}/u.test(lead.str) &&
        close(x(lead), x(second)) &&
        close(x(lead), next.width - edge(last!)) &&
        close(edge(lead), edge(second)) &&
        y(lead) - y(second) >= em &&
        y(lead) - y(second) <= em * 1.35
      )
    })
    if (bodyAt < 0) continue
    const body = units[bodyAt]
    const [lead] = nativeReferenceItems(body, pages)
    const floats = units.slice(headEnd, bodyAt)
    const opening = newRuns.slice(0, newRuns.indexOf(lead))
    const owned = new Set(floats.flatMap((unit) => nativeReferenceItems(unit, pages)))
    if (
      opening.length < 2 ||
      opening.length !== owned.size ||
      opening.some((run) => !owned.has(run) || y(run) <= y(lead)) ||
      floats.some((unit) => unit.fragments.some((fragment) => fragment.page !== next.page))
    )
      continue

    if (folio) {
      const suffix = /^([a-z]{3,}) /u.exec(lead.str)?.[1]
      const table = opening.findIndex((run) => /^Table [A-Z0-9]+:/iu.test(run.str))
      if (
        !hyphen ||
        !suffix ||
        !lexicon.has(hyphen + suffix) ||
        lexicon.has(hyphen + '-' + suffix) ||
        !lead.hasEOL ||
        table < 1 ||
        table > 5 ||
        !terminal(opening[table - 1].str) ||
        !terminal(opening[table].str) ||
        opening.slice(table + 1).filter((run) => /^\d+$/u.test(run.str)).length < 6 ||
        opening
          .slice(table + 1)
          .some(
            (run) =>
              !nativeHorizontalSourceItem(run) ||
              run.height >= em * 0.97 ||
              run.width > em * 9 ||
              x(run) < x(lead) - em * 0.23 ||
              edge(run) > edge(lead) + em * 0.23 ||
              y(run) <= y(lead) ||
              y(run) >= y(opening[table])
          )
      )
        continue
      head.source = head.source.slice(0, -1) + body.source
      head.items.push(...body.items)
      head.originalStrings.push(...body.originalStrings)
      head.fragments.push(...body.fragments)
    } else {
      const captionEnd = opening.at(-1)!
      if (
        !terminal(captionEnd.str) ||
        captionEnd.height >= em * 0.96 ||
        !close(x(captionEnd), x(lead)) ||
        y(captionEnd) - y(lead) < em * 1.35 ||
        y(captionEnd) - y(lead) > em * 2.2 ||
        opening.some(
          (run) =>
            !nativeHorizontalSourceItem(run) ||
            run.height >= em * 0.96 ||
            x(run) < x(lead) - em * 0.23 ||
            edge(run) > edge(lead) + em * 0.23
        )
      )
        continue
      const pieces = units.slice(at, headEnd)
      const blocks = pieces.map((unit) =>
        oldLayout.blocks.find(({ id }) => id === unit.fragments[0].id)
      )
      if (blocks.some((block) => !block || block.items.length !== 1 || block.lines.length !== 1))
        continue
      const [firstBlock] = blocks
      const row = firstBlock!
      const source = pieces.map((unit) => unit.source).join(' ')
      const items = pieces.flatMap((unit) => unit.items)
      const strings = pieces.flatMap((unit) => unit.originalStrings)
      const rect = { ...row.rect, right: edge(last) }
      row.source = source
      row.items = items
      row.originalStrings = strings
      row.rect = rect
      row.lines[0] = { ...rect, text: source, items }
      const removed = new Set(blocks.slice(1))
      oldLayout.blocks = oldLayout.blocks.filter((block) => !removed.has(block))
      head.kind = 'prose-candidate'
      head.source = source
      head.items = [...items]
      head.originalStrings = [...strings]
      head.fragments[0].rect = rect
      appendLayoutUnitText(head, body)
      units.splice(at + 1, pieces.length - 1)
    }
    head.risks = [...new Set([...head.risks, ...body.risks])]
    units.splice(units.indexOf(body), 1)
  }
}
