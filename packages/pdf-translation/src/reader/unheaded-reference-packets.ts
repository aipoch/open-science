import {
  isRaisedReferenceOrdinal,
  isTightRaisedReferenceOrdinal,
  type NativeReferenceEvidence
} from './native-reference-evidence.js'
import type { PdfLayoutPage, PdfLayoutTextItem, PdfTranslationLayout } from './layout.js'
import {
  nativeReferenceRolePageFonts,
  nativeReferenceRoleFontsCurrent,
  nativeReferenceRoleRowClosed
} from './native-reference-evidence.js'

type Unit = PdfTranslationLayout['units'][number]
type Box = { x: number; y: number; right: number; bottom: number }
type Entry = { item: PdfLayoutTextItem; index: number; key: string; owner: Unit }
type Row = { baseline: number; entries: Entry[] }
type RecordProof = { complete: boolean; owners: Unit[]; wraps: number[] }
const ownedReferenceRoles = new WeakMap<object, { owners: Set<Unit>; current: () => boolean }>()
const ownedReferenceChecks = new WeakMap<readonly PdfLayoutPage[], (() => boolean)[]>()

/** A bounded logical range across native page/column transitions. No geometry
 * or text permission is inferred from these reference-only owners. */
export function nativeOwnedUnheadedReferenceRoles(
  units: Unit[],
  pages: PdfLayoutPage[]
): object | undefined {
  const owners = new Map<string, Unit>()
  for (const unit of units)
    for (const key of unit.items) {
      if (owners.has(key)) return
      owners.set(key, unit)
    }
  for (let at = 0; at < pages.length; at++) {
    const pair = pages.slice(at, at + 2),
      first = pair[0],
      second = pair[1],
      terminalPage = !second,
      standalone = first.items.findIndex((item) => item.str === '[1]'),
      begin =
        standalone >= 0
          ? standalone
          : first.items.findIndex((item) => /^\[1\] \p{Lu}\./u.test(item.str))
    if (
      begin < 0 ||
      (second && second.page !== first.page + 1) ||
      pair.some((p) => p.rotation !== 0 || p.items.length > 10000)
    )
      continue
    const embedded = standalone < 0
    const before = first.items.slice(0, begin).filter((item) => item.str.trim()),
      contact = before.at(-1),
      contactMarker = before.at(-2),
      start = first.items[begin],
      em = start.height
    const terminalRight = terminalPage && start.transform[4] > first.width / 2
    const contribution = before.at(-3),
      contributionMarker = before.at(-4)
    // A raised dagger can introduce the address after a separate contribution note.
    const raisedContribution =
      !terminalPage &&
      contactMarker?.str === '†' &&
      !!contact &&
      !!contribution &&
      !!contributionMarker &&
      /^[*∗]$/u.test(contributionMarker.str) &&
      /^(?:These|Both) authors contributed equally(?: to this work)?\.$/u.test(contribution.str) &&
      valid(contribution) &&
      valid(contributionMarker) &&
      contribution.fontName === contact.fontName &&
      Math.abs(contribution.height - em) < em * 0.02 &&
      nativeReferenceRoleRowClosed(first, [first.items.indexOf(contribution)]) &&
      Math.abs(contribution.transform[4] - contact.transform[4]) < em * 0.05 &&
      Math.abs(contributionMarker.transform[4] - contactMarker.transform[4]) < em * 0.07 &&
      contributionMarker.transform[4] + contributionMarker.width <= contribution.transform[4] &&
      contribution.transform[5] - contact.transform[5] > em &&
      contribution.transform[5] - contact.transform[5] < em * 1.5 &&
      contributionMarker.fontName === contactMarker.fontName &&
      contributionMarker.height === contactMarker.height &&
      Math.abs(
        contributionMarker.transform[5] -
          contribution.transform[5] -
          (contactMarker.transform[5] - contact.transform[5])
      ) <
        em * 0.02
    // A typeset corresponding-author address may sit immediately above a
    // terminal bibliography, below the last full-sized paragraph.
    const afterContact =
      embedded &&
      !pages[at + 2] &&
      !!contact &&
      !!contactMarker &&
      /^(?:Electronic address: )?[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/u.test(contact.str) &&
      (/^[∗*]$/u.test(contactMarker.str) || raisedContribution) &&
      valid(contact) &&
      valid(contactMarker) &&
      nativeReferenceRoleRowClosed(first, [first.items.indexOf(contact)]) &&
      contact.fontName === start.fontName &&
      Math.abs(contact.height - em) <= em * 0.02 &&
      contact.transform[4] > start.transform[4] &&
      (terminalPage
        ? terminalRight || start.transform[4] < first.width / 2
        : start.transform[4] > first.width / 2) &&
      contact.transform[5] - start.transform[5] >= em &&
      contact.transform[5] - start.transform[5] <= em * 1.5 &&
      contactMarker.height < em * 0.9 &&
      contactMarker.transform[4] > start.transform[4] &&
      contactMarker.transform[4] + contactMarker.width <= contact.transform[4] &&
      contactMarker.transform[5] > contact.transform[5] &&
      contactMarker.transform[5] - contact.transform[5] < em * 0.6
    const prior = before.at(afterContact ? (raisedContribution ? -5 : -3) : -1)
    if (
      (terminalPage && !afterContact) ||
      !prior ||
      !/[.!?]$/u.test(prior.str) ||
      before.some((item) =>
        /\b(?:reference|citation|bibliograph\w*)\s+examples?\b/iu.test(item.str)
      )
    )
      continue
    const expectedSize = first.items[begin].height
    const entries = pair.flatMap((page, n) =>
      page.items.flatMap((item, index) => {
        const f = page.nativeFolioFontEvidence,
          witness = f?.complete ? f.fonts[item.fontName!] : undefined,
          firstNonempty = page.items.findIndex((item) => item.str.trim()),
          middle = item.transform[4] + item.width / 2,
          folio =
            index === firstNonempty &&
            item.str === String(page.page) &&
            page.height - item.transform[5] < page.height * 0.08 &&
            item.height > expectedSize * 1.05 &&
            item.width > 0 &&
            item.width < item.height * 3 &&
            (middle > page.width * 0.85 ||
              middle < page.width * 0.15 ||
              Math.abs(middle - page.width / 2) < item.height) &&
            witness?.nativeMetrics === true &&
            witness.ascent === item.fontAscent &&
            witness.descent === item.fontDescent &&
            page.items.every(
              (other, i) =>
                i === index ||
                !other.str.trim() ||
                page.height - other.transform[5] - other.height >
                  page.height - item.transform[5] + item.height
            )
        return item.str.trim() && (n ? !folio : index >= begin)
          ? [
              {
                item,
                index,
                key: `${page.page}:${index}`,
                owner: owners.get(`${page.page}:${index}`)!,
                page
              }
            ]
          : []
      })
    )
    const font = entries[0]?.item.height
    if (
      !(font > 0) ||
      prior.height <= font ||
      entries.length > 10000 ||
      entries.some(
        (e) => !e.owner || !valid(e.item) || Math.abs(e.item.height - font) > font * 0.02
      )
    )
      continue
    const starts = entries.flatMap((e, index) => {
      if (afterContact) return marker(e.item.str) ? [index] : []
      return (embedded ? /^\[\d{1,4}\] \p{Lu}\./u : /^\[\d{1,4}\]$/u).test(e.item.str)
        ? [index]
        : []
    })
    if (
      starts.length < (embedded ? 5 : 3) ||
      starts.length > 256 ||
      starts.some((index, n) => Number(marker(entries[index].item.str)![1]) !== n + 1)
    )
      continue
    const columns: number[] = []
    for (const index of embedded
      ? [...starts].sort((a, b) => entries[a].item.transform[4] - entries[b].item.transform[4])
      : starts) {
      const body = entries[index + (embedded ? 0 : 1)]
      if (
        !body ||
        body.page !== entries[index].page ||
        Math.abs(body.item.transform[5] - entries[index].item.transform[5]) > font * 0.02
      )
        continue
      if (
        !columns.some((x) => Math.abs(x - body.item.transform[4]) < font * (embedded ? 0.75 : 0.05))
      )
        columns.push(body.item.transform[4])
    }
    columns.sort((a, b) => a - b)
    if (
      terminalRight
        ? columns.length !== 1 || columns[0] <= first.width / 2
        : columns.length !== 2 || columns[1] - columns[0] < font * 10
    )
      continue
    const column = (e: (typeof entries)[number]): number =>
      !terminalRight && e.item.transform[4] >= columns[1] - font * 3 ? 1 : 0
    const nativeRows: (typeof entries)[] = [],
      lane = new Map<(typeof entries)[number], number>()
    for (const e of entries) {
      const previous = nativeRows.at(-1),
        head = previous?.[0]
      if (
        head &&
        head.page === e.page &&
        Math.abs(head.item.transform[5] - e.item.transform[5]) < font * 0.02
      )
        previous!.push(e)
      else nativeRows.push([e])
    }
    for (const row of nativeRows) for (const e of row) lane.set(e, column(row[0]))
    // A final-page bibliography can start with a single line at the foot of
    // the left column and continue at the top of the right column.
    if (
      terminalPage &&
      !terminalRight &&
      (nativeRows.length < 3 ||
        nativeRows.filter((row) => column(row[0]) === 0).length !== 1 ||
        column(nativeRows[0][0]) !== 0 ||
        nativeRows[1][0].item.transform[5] < first.height * 0.85 ||
        starts[1] <= nativeRows[0].length)
    )
      continue
    if (
      terminalRight &&
      (prior.transform[4] <= first.width / 2 ||
        prior.transform[5] - contact!.transform[5] <= font ||
        nativeRows.some((row, n) => {
          const gap =
            n > 0 ? nativeRows[n - 1][0].item.transform[5] - row[0].item.transform[5] : font
          return (
            row[0].item.transform[4] < columns[0] - font * 0.05 ||
            gap < font * 0.8 ||
            gap > font * 2.2
          )
        }))
    )
      continue
    const records = starts.map((index, n) => entries.slice(index, starts[n + 1] ?? entries.length))
    const hangingX: number[] = []
    const complete = records.every((record) => {
      const s = embedded
          ? text(record).replace(/(?<=[\p{L}])([´`¨]) (?=\p{Ll})/gu, '$1')
          : text(record),
        last = record.at(-1)!.item.str.trim(),
        tail = last === '.' ? (record.at(-2)?.item.str.trim() ?? '') : last,
        rows: (typeof record)[] = []
      const author = embedded
        ? /^\[\d{1,4}\] (?:\p{Lu}\.(?:-\p{Lu}\.)?\s*){1,5}\p{Lu}[\p{L}\p{M}’'`´¨ˆ˝^.-]+(?:,|\s+and\s+|\s*&\s*)/u
        : /^\[\d{1,4}\]\s*(?:\p{Lu}\.\s*){1,4}\p{Lu}[\p{L}\p{M}’'`´¨ˆ˝^.-]+(?:,|\s+and\s+|\s*&\s*)/u
      const internalReference =
        afterContact &&
        /^\[\d{1,4}\] (?:The )?detailed derivation can be found in the supplement(?:al|ary) material\s*\.$/iu.test(
          s
        )
      const citationAuthors =
        /^\[\d{1,4}\] (?:(?:\p{Lu}\.(?:-\p{Lu}\.)?\s*){1,5}(?:[\p{L}’'-]+ ){1,3}\p{Lu}[\p{L}.’'-]+|\p{Lu}[\p{L}.’'-]+\s+(?:\p{Lu}\.\s*){1,5}|(?:\p{Lu}[\p{L}.’'-]+ ){1,2}\p{Lu}[\p{L}.’'-]+)(?:,| and )/u
      const terminalEtAl =
        terminalRight && /^\[\d{1,4}\] (?:\p{Lu}\.\s*){1,5}\p{Lu}[\p{L}’'-]+ et al\., /u.test(s)
      const terminalArchive = terminalEtAl && /, [a-z]+-[a-z]+\/\d{7}\.$/u.test(s)
      const terminalEdition =
        terminalRight && /\((?:[^()]+, )?(?:18|19|20)\d{2}\), \d{1,2}(?:st|nd|rd|th) ed\.$/u.test(s)
      const credited =
        author.test(s) ||
        terminalEtAl ||
        (afterContact && citationAuthors.test(s) && /(?:18|19|20)\d{2}\)/u.test(s))
      if (
        record.length > 600 ||
        s.length > 4000 ||
        !(/\.$/u.test(last) || (terminalPage && /\((?:18|19|20)\d{2}\);$/u.test(last))) ||
        (!internalReference &&
          (!credited ||
            (!dated(tail) &&
              !terminalArchive &&
              !terminalEdition &&
              !(
                terminalPage &&
                dated(s) &&
                /(?:pp\. \d+[–-]\d+|[a-z]+- [a-z]+\/\d{7}|to appear in [^;]+)\.$/u.test(s)
              ))))
      )
        return false
      for (const e of record) {
        const previous = rows.at(-1),
          head = previous?.[0]
        if (e.item.transform[4] < 0 || e.item.transform[4] + e.item.width > e.page.width)
          return false
        // A native line can overflow its column; only its first Source selects
        // the lane. A real lane transition begins a different closed line.
        if (
          head &&
          head.page === e.page &&
          Math.abs(head.item.transform[5] - e.item.transform[5]) < font * 0.02
        )
          previous!.push(e)
        else rows.push([e])
      }
      if (rows[0][0] !== record[0]) return false
      return rows.every((row, n) => {
        const head = row[0],
          col = column(head),
          previous = rows[n - 1]?.[0]
        if (
          !nativeReferenceRoleRowClosed(
            head.page,
            row.map((e) => e.index)
          )
        )
          return false
        if (n) {
          const x = head.item.transform[4]
          if (embedded) {
            const indent = x - columns[col]
            if (
              indent < font * 1.5 ||
              indent > font * 2.5 ||
              Math.abs(x - (hangingX[col] ?? x)) >= font * 0.05
            )
              return false
            hangingX[col] = x
          } else if (Math.abs(x - columns[col]) > font * 0.05) return false
        }
        if (
          !n &&
          !embedded &&
          (record[1].item.transform[4] - head.item.transform[4] < font * 0.8 ||
            record[1].item.transform[4] - head.item.transform[4] > font * 3)
        )
          return false
        if (!previous) return true
        if (previous.page === head.page && column(previous) === col)
          return (
            previous.item.transform[5] - head.item.transform[5] >= font * 0.8 &&
            previous.item.transform[5] - head.item.transform[5] <= font * 2.2
          )
        const preceding = rows[n - 1].at(-1)!
        return (
          entries
            .filter((e) => e.page === preceding.page && lane.get(e) === column(rows[n - 1][0]))
            .at(-1) === preceding &&
          entries.find((e) => e.page === head.page && lane.get(e) === col) === head &&
          (previous.page === head.page
            ? column(previous) === 0 && col === 1
            : previous.page.page + 1 === head.page.page && col === 0)
        )
      })
    })
    if (
      !complete ||
      (embedded && hangingX.filter(Number.isFinite).length !== (terminalPage ? 1 : 2))
    )
      continue
    const following = pages[at + 2],
      next = following?.items.find((item) => item.str.trim() && item.str !== String(following.page))
    if (
      following &&
      (!next || !/^(?:Appendix\s+[A-Z]|(?:\d+(?:\.\d+)*|[IVX]+)[.:]\s+\p{Lu})/u.test(next.str))
    )
      continue
    const keys = new Set(entries.map((e) => e.key)),
      selectedOwners = new Set(entries.map((e) => e.owner))
    if (
      [...selectedOwners].some(
        (unit) =>
          unit.items.some((key) => !keys.has(key)) ||
          unit.items.some(
            (key, n) => unit.originalStrings[n] !== entries.find((e) => e.key === key)?.item.str
          )
      )
    )
      continue
    const domains = terminalPage
      ? columns.map((_, index) => ({
          page: first,
          bounds: union(entries.filter((e) => lane.get(e) === index).map((e) => box(first, e.item)))
        }))
      : pair.map((page) => ({
          page,
          bounds: union(entries.filter((e) => e.page === page).map((e) => box(page, e.item)))
        }))
    if (
      domains.some(({ page, bounds }) =>
        page.items.some((item, index) => {
          if (!item.str.trim() || keys.has(`${page.page}:${index}`)) return false
          if (![...item.transform, item.width, item.height].every(Number.isFinite)) return true
          const advance = {
            x: item.transform[4],
            y: page.height - item.transform[5] - item.height,
            right: item.transform[4] + item.width,
            bottom: page.height - item.transform[5]
          }
          return overlaps(advance, bounds)
        })
      )
    )
      continue
    const witnesses = pair.map((page) =>
      nativeReferenceRolePageFonts(page, [
        ...(afterContact && page === first
          ? [
              prior,
              ...(raisedContribution ? [contributionMarker!, contribution!] : []),
              contactMarker!,
              contact!
            ].map((item) => page.items.indexOf(item))
          : []),
        ...entries.filter((e) => e.page === page).map((e) => e.index)
      ])
    )
    if (witnesses.some((w) => !w)) continue
    const pageRefs = [...pages],
      boundarySnapshot = JSON.stringify(following),
      followingItems = following?.items,
      nextItem = next,
      snapshots = [...selectedOwners].map((unit) => ({
        unit,
        items: unit.items,
        originals: unit.originalStrings,
        fragments: unit.fragments,
        value: JSON.stringify([
          unit.id,
          unit.kind,
          unit.risks,
          unit.referenceBoundary,
          unit.source,
          unit.items,
          unit.originalStrings,
          unit.fragments
        ])
      })),
      current = (): boolean =>
        pages.length === pageRefs.length &&
        pages.every((page, n) => page === pageRefs[n]) &&
        witnesses.every((w) => nativeReferenceRoleFontsCurrent(w!)) &&
        snapshots.every(
          (s) =>
            units.includes(s.unit) &&
            s.unit.items === s.items &&
            s.unit.originalStrings === s.originals &&
            s.unit.fragments === s.fragments &&
            JSON.stringify([
              s.unit.id,
              s.unit.kind,
              s.unit.risks,
              s.unit.referenceBoundary,
              s.unit.source,
              s.unit.items,
              s.unit.originalStrings,
              s.unit.fragments
            ]) === s.value
        ) &&
        pages[at + 2] === following &&
        following?.items === followingItems &&
        (!following || following.items.includes(nextItem!)) &&
        JSON.stringify(following) === boundarySnapshot
    if (!current()) continue
    const proof = Object.freeze({})
    ownedReferenceRoles.set(proof, {
      owners: new Set([...selectedOwners].filter((unit) => !unit.sourceOnly && !unit.preserve)),
      current
    })
    ownedReferenceChecks.set(pages, [...(ownedReferenceChecks.get(pages) ?? []), current])
    return proof
  }
}

export function hasNativeOwnedReferenceRole(proof: object | undefined, unit: Unit): boolean {
  try {
    const data = proof && ownedReferenceRoles.get(proof)
    return !!data && data.owners.has(unit) && data.current()
  } catch {
    return false
  }
}

export function nativeOwnedReferenceRolesCurrent(pages: readonly PdfLayoutPage[]): boolean {
  try {
    return ownedReferenceChecks.get(pages)?.every((check) => check()) ?? true
  } catch {
    return false
  }
}
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

// A final right column can hold a complete superscript bibliography while a graphic
// in the other column prevents the whole-page native rule proof. This is a
// source role only; never use it to admit a replacement crop or erase paint.
// A complete native page may instead have one prose note in the same ordinal run.
function terminalRightSuperscriptRoles(
  p: PdfLayoutPage,
  entries: Entry[],
  author: (text: string) => boolean,
  terminal: (text: string) => boolean,
  requireEmbeddedNote: boolean
): { selected: Entry[]; note?: Entry[] } | undefined {
  const raised = isTightRaisedReferenceOrdinal
  const starts = entries.flatMap(({ item }, i) =>
    item.str === '1' && item.transform[4] > p.width / 2 && raised(item, entries[i + 1]?.item)
      ? [i]
      : []
  )
  if (starts.length !== 1) return
  const at = starts[0],
    prior = entries[at - 1]?.item,
    first = entries[at + 1].item,
    start = entries[at].item,
    font = first.height,
    left = first.transform[4],
    selected = entries.slice(at)
  if (
    !prior ||
    !valid(prior) ||
    !/[.!?]\s*$/u.test(prior.str) ||
    prior.transform[4] <= p.width / 2 ||
    prior.height < font * 1.05 ||
    prior.transform[5] - start.transform[5] < font ||
    prior.transform[5] - start.transform[5] > font * 6 ||
    entries
      .slice(0, at)
      .some(({ item }) =>
        /\b(?:reference|citation|bibliograph\w*)\s+examples?\b/iu.test(item.str)
      ) ||
    selected.some(({ item }) => !valid(item) || item.transform[4] <= p.width / 2)
  )
    return
  const markers = selected.flatMap(({ item }, index) =>
    raised(item, selected[index + 1]?.item) ? [index] : []
  )
  if (
    markers.length < 5 ||
    markers.length > 256 ||
    markers[0] !== 0 ||
    markers.some((index, i) => Number(selected[index].item.str) !== i + 1)
  )
    return
  const closedRow = (row: Entry[]): boolean =>
    nativeReferenceRoleRowClosed(
      p,
      row.map((e) => e.index)
    )
  let previousBaseline: number | undefined, note: Entry[] | undefined
  for (const [i, index] of markers.entries()) {
    const record = selected.slice(index + 1, markers[i + 1] ?? Infinity),
      marker = selected[index]
    if (!record.length || record.length > 600) return
    const rows: Entry[][] = []
    for (const entry of record) {
      const previous = rows.at(-1)
      if (
        previous &&
        Math.abs(entry.item.transform[5] - previous[0].item.transform[5]) <= font * 0.02
      )
        previous.push(entry)
      else rows.push([entry])
    }
    if (
      rows.some(
        (row, n) =>
          Math.abs(row[0].item.transform[4] - left) > font * 0.03 ||
          !closedRow(n ? row : [marker, ...row]) ||
          row.some(
            (e, j) =>
              Math.abs(e.item.height - font) > font * 0.02 ||
              (j > 0 && e.item.transform[4] < row[j - 1].item.transform[4])
          ) ||
          (n > 0 &&
            (rows[n - 1][0].item.transform[5] - row[0].item.transform[5] < font * 0.8 ||
              rows[n - 1][0].item.transform[5] - row[0].item.transform[5] > font * 1.5))
      )
    )
      return
    const baseline = rows[0][0].item.transform[5]
    if (
      previousBaseline !== undefined &&
      (previousBaseline - baseline < font * 0.8 || previousBaseline - baseline > font * 1.5)
    )
      return
    previousBaseline = rows.at(-1)![0].item.transform[5]
    const head = rows[0]
      .map(({ item }, j, row) => {
        const previous = row[j - 1]?.item
        const join =
          previous && item.transform[4] - previous.transform[4] - previous.width > font * 0.1
            ? ' '
            : ''
        return join + item.str
      })
      .join('')
      .replace(requireEmbeddedNote ? /[¯´¨]/gu : /[¯´]/gu, '')
      .trim()
    const body = text(record),
      hasAuthor = author(head)
    if (
      hasAuthor &&
      (terminal(body) || (requireEmbeddedNote && /, (?:18|19|20)\d{2}, unpublished\.$/u.test(body)))
    )
      continue
    if (
      !requireEmbeddedNote ||
      note ||
      i < 3 ||
      i >= markers.length - 3 ||
      hasAuthor ||
      body.length > 4000 ||
      dated(body) ||
      !/^\p{Lu}[^.!?]*\s\p{Ll}/u.test(body) ||
      !/[.!?]$/u.test(body)
    )
      return
    note = [marker, ...record]
  }
  if (requireEmbeddedNote && !note) return
  const keys = new Set(selected.map((e) => e.key)),
    bounds = union(selected.map((e) => box(p, e.item)))
  if (
    bounds.x <= p.width / 2 ||
    bounds.y < 0 ||
    bounds.right > p.width ||
    bounds.bottom > p.height ||
    entries.some((e) => !keys.has(e.key) && valid(e.item) && overlaps(box(p, e.item), bounds))
  )
    return
  const witness = nativeReferenceRolePageFonts(
    p,
    selected.map((e) => e.index)
  )
  if (witness && nativeReferenceRoleFontsCurrent(witness)) return { selected, note }
}

/** Superscript ordinals are a separate contract from bracketed bibliography
 * markers. Complete same-page entries and disjoint native column domains are
 * required; partial page-start/end entries and existing readonly types remain. */
export function nativeSuperscriptReferencePackets(
  units: Unit[],
  pages: PdfLayoutPage[],
  pageCount: number | undefined
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
    if (p.rotation !== 0 || p.items.length > 10000) continue
    const entries: Entry[] = p.items.flatMap((item, index) =>
      item.str.trim()
        ? [{ item, index, key: `${p.page}:${index}`, owner: owners.get(`${p.page}:${index}`)! }]
        : []
    )
    const terminalRight =
      p === pages.at(-1) && p.page === pageCount
        ? terminalRightSuperscriptRoles(p, entries, author, terminal, !!evidence?.complete)
        : undefined
    if (terminalRight) {
      const { selected, note } = terminalRight,
        keys = new Set(selected.map((e) => e.key)),
        noteOwners = new Set(note?.map((e) => e.owner)),
        selectedOwners = new Set(selected.map((e) => e.owner))
      if (
        selected.every(
          (e) =>
            e.owner &&
            !repeated.has(e.key) &&
            e.owner.originalStrings[e.owner.items.indexOf(e.key)] === e.item.str
        ) &&
        [...selectedOwners].every((owner) => owner.items.every((key) => keys.has(key)))
      )
        for (const owner of selectedOwners)
          if (
            !owner.sourceOnly &&
            !owner.preserve &&
            !noteOwners.has(owner) &&
            owner.risks.every((r) => r === 'possible-continuation' || r === 'ambiguous-line-hyphen')
          )
            result.add(owner.items.join('|'))
    }
    if (!evidence?.complete) continue
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
    const centeredRule = evidence.rules.length === 1 ? evidence.rules[0] : undefined
    const separated =
      centeredRule !== undefined &&
      centeredRule.right - centeredRule.left > p.width * 0.3 &&
      centeredRule.right - centeredRule.left < p.width * 0.5 &&
      entries.filter(({ item }, at) => isRaisedReferenceOrdinal(item, entries[at + 1]?.item))
        .length >= 4
    const fullAuthor = (s: string): boolean =>
      author(s) || /^\p{Lu}[\p{L}\p{M}-]+(?: \p{Lu}[\p{L}\p{M}.'’–-]+){1,4}(?:,| and |$)/u.test(s)
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
      if (separated)
        return (
          i.transform[5] < centeredRule.baseline - i.height &&
          isRaisedReferenceOrdinal(i, next) &&
          fullAuthor(text(row))
        )
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
      markers.length < (separated ? 5 : 3) ||
      (separated &&
        (markers[0].item.str !== '1' ||
          centeredRule.baseline - markers[0].item.transform[5] > markers[0].item.height * 6 ||
          entries.some(
            (e) =>
              e.index < markers[0].index &&
              e.item.transform[5] - e.item.height < centeredRule.baseline
          ))) ||
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
        complete:
          items.length <= 600 &&
          s.length <= 4000 &&
          (separated ? fullAuthor(s) : author(s)) &&
          terminal(s)
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
    if (columns.length > 2 || (separated && columns.length !== 2)) continue
    if (
      separated &&
      closed.some(({ items: record }) =>
        record
          .slice(1)
          .some(
            ({ item }) =>
              Math.abs(item.height - record[1].item.height) > record[1].item.height * 0.02
          )
      )
    )
      continue
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
      (separated &&
        ((centeredRule.left + centeredRule.right) / 2 < domains[0].right ||
          (centeredRule.left + centeredRule.right) / 2 > domains[1].x)) ||
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

const invertedBibliographyAuthor = /^\p{Lu}[\p{L}’'.-]+,\s+\p{Lu}\./u

function bibliographyStyle(
  s: string,
  afterAcknowledgment: boolean
): 'initials' | 'surname' | undefined {
  const body = s.replace(/^\[\d+\]\s*/u, ''),
    surname = /^\p{Lu}[\p{L}’'`´¨ˆ˝^.-]+\s+\p{Lu}(?:[ ,.]|$)/u.test(body),
    initials =
      /^\p{Lu}\.\s*\p{Lu}/u.test(body) ||
      (afterAcknowledgment &&
        (invertedBibliographyAuthor.test(body) ||
          /^\p{Lu}\.(?:-\p{Lu}\.)?\s+(?:(?:d[aeiou]|del|van|von|ten|der|den|ter)\s+){0,2}\p{Lu}/u.test(
            body
          ))),
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

// A terminal bibliography can share a page with a separate acknowledgments
// heading. The first right-column rows can close the last left-column record.
function closedTerminalBibliography(
  page: PdfLayoutPage,
  entries: Entry[],
  boundary: Pick<Entry, 'item' | 'index'>,
  rule?: Extract<NativeReferenceEvidence, { complete: true }>['rules'][number]
): string[] {
  if (entries.length < 2 || entries.length > 2048) return []
  const em = entries[0].item.height,
    middle = page.width / 2,
    top = entries[0].item.transform[5],
    isLeft = (item: PdfLayoutTextItem): boolean => item.transform[4] < middle
  if (rule) {
    const folio = boundary.item,
      size = rule.right - rule.left
    if (
      page.height - folio.transform[5] > page.height * 0.08 ||
      folio.transform[4] <= page.width * 0.85 ||
      folio.transform[5] - rule.baseline < em ||
      rule.baseline - top < em * 2 ||
      rule.baseline - top > em * 5 ||
      size < page.width * 0.3 ||
      size > page.width * 0.5 ||
      Math.abs((rule.left + rule.right) / 2 - middle) > em * 0.5
    )
      return []
  } else {
    const heading = boundary.item
    if (
      !valid(heading) ||
      heading.transform[4] <= middle ||
      heading.transform[5] - top < em * 4 ||
      top >= page.height * 0.35 ||
      page.items
        .slice(0, boundary.index)
        .some((item) => item.str.trim() && (!valid(item) || item.transform[5] <= top + em * 3)) ||
      !nativeReferenceRoleRowClosed(page, [boundary.index])
    )
      return []
  }
  const rows: Row[] = []
  for (const entry of entries) {
    const { item } = entry,
      baseline = item.transform[5],
      previous = rows.at(-1),
      last = previous?.entries.at(-1)?.item
    if (
      Math.abs(item.height - em) > em * 0.02 ||
      (isLeft(item) && item.transform[4] + item.width > middle)
    )
      return []
    if (
      previous &&
      last &&
      last.transform[4] < middle === item.transform[4] < middle &&
      Math.abs(previous.baseline - baseline) < em * 0.02
    ) {
      // An overprinted accent may overlap the next lowercase glyph.
      const joinAccent =
        !rule &&
        item.transform[4] > last.transform[4] &&
        last.fontName === item.fontName &&
        /\p{L}[`¨]$/u.test(last.str) &&
        /^\p{Ll}/u.test(item.str) &&
        item.transform[4] >= last.transform[4] + last.width - em * 0.65
      if (!joinAccent && item.transform[4] < last.transform[4] + last.width - em * 0.05) return []
      previous.entries.push(entry)
    } else rows.push({ baseline, entries: [entry] })
  }
  if (!marker(rows[0].entries[0].item.str) || rows.length > 256) return []
  const turn = rows.findIndex(({ entries }) => !isLeft(entries[0].item))
  if (turn < 1 || Math.abs(rows[turn].baseline - top) > em * 0.02) return []
  const lanes = [rows.slice(0, turn), rows.slice(turn)],
    x = (row: Row): number => row.entries[0].item.transform[4],
    number = (row: Row): number => Number(marker(row.entries[0].item.str)?.[1] ?? 0),
    citationTail = rule
      ? /\b\d{1,3}(?:\([A-Za-z0-9]+\))?:[A-Za-z]?\d+(?:[-–][A-Za-z]?\d+)?, \d{4}\.$/u
      : /\d{1,4} *, \d{1,9}(?:[-–]\d+)? \((?:18|19|20)\d{2}\)\.$/u,
    end = rule ? /(?:^|,)\s*(?:18|19|20)\d{2}\.$/u : citationTail,
    pitch = rows[0].baseline - rows[1].baseline,
    firstRight = lanes[1].findIndex((row) => number(row)),
    carry = lanes[1].slice(0, firstRight)
  if (
    pitch < em ||
    pitch > em * 1.5 ||
    firstRight < 1 ||
    firstRight > (rule ? 1 : 2) ||
    !citationTail.test(text(carry.flatMap((row) => row.entries))) ||
    carry.slice(0, -1).some((row) => end.test(text(row.entries)))
  )
    return []
  let expected = 1
  for (const [lane, series] of lanes.entries()) {
    const leftColumn = lane === 0
    // The first right-column rows close the pending left-column record.
    const localRows = leftColumn ? series : series.slice(firstRight)
    const starts = series.flatMap((row, i) => (number(row) ? [i] : [])),
      margin = Math.min(...starts.map((i) => x(series[i]))),
      wraps = series.filter((row) => !number(row)),
      inset = wraps[0] && x(wraps[0])
    if (
      starts.length < 4 ||
      wraps.length < 2 ||
      inset < margin + em ||
      inset > margin + em * 3 ||
      wraps.some((row) => Math.abs(x(row) - inset) > em * 0.05) ||
      series.some(
        (row, i) =>
          x(row) >= middle !== (lane === 1) ||
          (i > 0 && Math.abs(series[i - 1].baseline - row.baseline - pitch) > em * 0.05)
      ) ||
      !starts.every(
        (i, n) => x(series[i]) <= margin + em * 0.6 && number(series[i]) === expected + n
      ) ||
      (rule && !localRows.some((row) => citationTail.test(text(row.entries))))
    )
      return []
    expected += starts.length
    for (const [at, start] of starts.entries()) {
      const record = series.slice(start, starts[at + 1]),
        value = text(record.flatMap((row) => row.entries)),
        crossesColumn = leftColumn && at === starts.length - 1,
        completeValue =
          crossesColumn && !rule
            ? text([...record, ...carry].flatMap((row) => row.entries))
            : value,
        credited = rule
          ? /^\[\d{1,4}\] \p{Lu}[\p{L}\p{M} .,’'&-]{2,120}[.,] /u.test(value)
          : /^\[\d{1,4}\] (?:\p{Lu}\.(?:-\p{Lu}\.)? *){1,5}\p{Lu}[\p{L}\p{M}.’'-]+(?:, | and )/u.test(
              completeValue
            )
      if (
        !credited ||
        (crossesColumn ? (rule && !value.endsWith(',')) || end.test(value) : !end.test(value)) ||
        record.slice(0, -1).some((row) => end.test(text(row.entries)))
      )
        return []
    }
  }
  if (
    rows.some(
      (row) =>
        !nativeReferenceRoleRowClosed(
          page,
          row.entries.map((e) => e.index)
        )
    )
  )
    return []
  const witness = nativeReferenceRolePageFonts(page, [
    boundary.index,
    ...entries.map((e) => e.index)
  ])
  if (!witness || !nativeReferenceRoleFontsCurrent(witness)) return []
  const keys = new Set(entries.map((entry) => entry.key)),
    owners = [...new Set(entries.map((entry) => entry.owner))]
  return owners.every((owner) => owner.items.every((key) => keys.has(key)))
    ? owners.map((owner) => owner.items.join('|'))
    : []
}

// A smaller, consecutively numbered bibliography can occupy both columns
// between the last body lines and a full-size acknowledgments block.
function bibliographyBeforeAcknowledgments(
  page: PdfLayoutPage,
  owns: (index: number) => Unit | undefined
): string[] {
  if (page.rotation) return []
  const items = page.items
  const start = items.findIndex((item) => marker(item.str)?.[1] === '1')
  const end = items.findIndex(
    (item, index) => index > start && /^Acknowledg(?:e)?ments$/iu.test(item.str)
  )
  if (start < 1 || end <= start) return []

  const first = items[start],
    acknowledgment = items[end],
    em = first.height,
    middle = page.width / 2,
    preceding = items.slice(0, start).findLast((item) => item.str.trim()),
    following = items.slice(end + 1).find((item) => item.str.trim())
  if (
    !valid(first) ||
    !valid(acknowledgment) ||
    !preceding ||
    !valid(preceding) ||
    !following ||
    !valid(following) ||
    acknowledgment.transform[4] <= middle ||
    following.transform[4] <= acknowledgment.transform[4] + acknowledgment.width ||
    following.transform[5] !== acknowledgment.transform[5] ||
    !/^\p{Lu}\p{Ll}+ \p{Ll}{2,} /u.test(following.str) ||
    Math.abs(following.height - acknowledgment.height) > em * 0.02 ||
    preceding.height < em * 1.05 ||
    first.transform[4] >= middle ||
    !/[.!?]$/u.test(preceding.str) ||
    preceding.transform[4] <= middle ||
    preceding.transform[5] - first.transform[5] < em * 3 ||
    acknowledgment.height < em * 1.05
  )
    return []

  const rows: Row[] = []
  for (let index = start; index < end; index++) {
    const item = items[index]
    if (!item.str.trim()) continue
    const key = `${page.page}:${index}`,
      owner = owns(index),
      x = item.transform[4],
      baseline = item.transform[5],
      previous = rows.at(-1),
      last = previous?.entries.at(-1)?.item
    if (
      !owner ||
      !valid(item) ||
      owner.originalStrings[owner.items.indexOf(key)] !== item.str ||
      Math.abs(item.height - em) > em * 0.02 ||
      item.transform[5] > first.transform[5] + em * 0.02 ||
      x < 0 ||
      x + item.width > (x < middle ? middle : page.width) ||
      baseline <= 0
    )
      return []
    const entry = { index, item, key, owner }
    if (
      previous &&
      last &&
      last.transform[4] < middle === x < middle &&
      Math.abs(previous.baseline - baseline) < em * 0.03
    ) {
      // An accent and its base can share the same native row.
      if (x < last.transform[4]) return []
      previous.entries.push(entry)
    } else rows.push({ baseline, entries: [entry] })
    if (rows.length > 240) return []
  }

  const x = (row: Row): number => row.entries[0].item.transform[4],
    turn = rows.findIndex((row) => x(row) > middle),
    pitch = rows[0]?.baseline - rows[1]?.baseline,
    number = (row: Row): number => Number(marker(row.entries[0].item.str)?.[1] ?? 0)
  if (
    turn < 2 ||
    Math.abs(rows[turn].baseline - first.transform[5]) > em * 0.02 ||
    pitch < em ||
    pitch > em * 1.5 ||
    rows.at(-1)!.baseline <= acknowledgment.transform[5] ||
    rows.at(-1)!.baseline - acknowledgment.transform[5] > pitch * 2
  )
    return []

  const left = rows.slice(0, turn),
    rightRows = rows.slice(turn),
    firstRight = rightRows.findIndex(number),
    rightTopTail = rightRows.slice(0, firstRight),
    wrap = (column: Row[]): number | undefined =>
      column.find((row) => !number(row))?.entries[0].item.transform[4],
    finalYear =
      /(?:\([^()]*\b(?:18|19|20)\d{2}\)|,\s*(?:18|19|20)\d{2}|https?:\/\/\S+)(?: and references therein)?\s*\.$/iu
  if (firstRight < 0 || rightTopTail.length > 3) return []
  let expected = 1
  for (const column of [left, rightRows]) {
    const wrappedX = wrap(column),
      starts = column.flatMap((row, index) => (number(row) ? [index] : []))
    if (
      wrappedX === undefined ||
      starts.length < 4 ||
      column.some(
        (row, index) =>
          x(row) < middle !== (column === left) ||
          (index > 0 && Math.abs(column[index - 1].baseline - row.baseline - pitch) > em * 0.05) ||
          (number(row)
            ? row.entries[0].item.fontName !== first.fontName ||
              wrappedX - x(row) < em ||
              wrappedX - x(row) > em * 3
            : Math.abs(x(row) - wrappedX) > em * 0.05)
      )
    )
      return []
    for (const [index, head] of starts.entries()) {
      if (number(column[head]) !== expected++) return []
      const continuation = column.slice(head, starts[index + 1])
      if (column === left && index === starts.length - 1 && rightTopTail.length) {
        if (finalYear.test(text(continuation.at(-1)!.entries))) return []
        continuation.push(...rightTopTail)
      }
      const value = text(continuation.flatMap((row) => row.entries)).replace(/¨ +(?=\p{Ll})/gu, '¨')
      if (
        !/^\[\d+\]\s+\p{Lu}[\p{L}\p{M}’'¨.-]+(?: [IVX]{1,5})?,\s+\p{Lu}\./u.test(value) &&
        !/^\[\d+\]\s+\p{Lu}\.\s+\p{Lu}\.\s+\p{Lu}/u.test(value)
      )
        return []
      if (
        !finalYear.test(value) ||
        continuation.slice(0, -1).some((row) => finalYear.test(text(row.entries)))
      )
        return []
    }
  }
  const entries = rows.flatMap((row) => row.entries)
  if (
    !rows.every((row) =>
      nativeReferenceRoleRowClosed(
        page,
        row.entries.map(({ index }) => index)
      )
    )
  )
    return []
  const fonts = nativeReferenceRolePageFonts(
    page,
    entries.map(({ index }) => index)
  )
  if (!fonts || !nativeReferenceRoleFontsCurrent(fonts)) return []
  const keys = new Set(entries.map(({ key }) => key)),
    owners = [...new Set(entries.map(({ owner }) => owner))]
  return owners.every((owner) => owner.items.every((key) => keys.has(key)))
    ? owners.map((owner) => owner.items.join('|'))
    : []
}

// A run of journal citations and numbered prose notes can share the same
// bibliography. Only independently closed citation records are source-only.
function nativeMixedBibliographyAfterContact(
  pages: PdfLayoutPage[],
  owns: (page: PdfLayoutPage, index: number) => Unit | undefined
): string[] {
  type Part = { page: PdfLayoutPage; item: PdfLayoutTextItem; index: number }
  const items = (page: PdfLayoutPage): Part[] =>
    page.items.flatMap((item, index) => (item.str.trim() ? [{ page, item, index }] : []))
  const bibliographyPages = pages.slice(-3)
  if (
    bibliographyPages.length !== 3 ||
    bibliographyPages.some((page) => page.rotation) ||
    bibliographyPages.reduce((count, page) => count + page.items.length, 0) > 10000
  )
    return []
  const [first, ...continuations] = bibliographyPages,
    firstItems = items(first),
    begin = firstItems.findIndex(({ item }) => marker(item.str)?.[1] === '1'),
    start = firstItems[begin]
  if (!start || begin < 5) return []
  const em = start.item.height,
    x = (part: Part): number => part.item.transform[4],
    y = (part: Part): number => part.item.transform[5],
    same = (n: number): boolean => Math.abs(n) < em * 0.04,
    [asterisk, email, dagger, address] = firstItems.slice(begin - 4, begin),
    contact = (part: Part): boolean => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/iu.test(part.item.str)
  if (
    !valid(start.item) ||
    ![asterisk, email, dagger, address].every(({ item }) => valid(item)) ||
    !/^[∗*]$/u.test(asterisk.item.str) ||
    dagger.item.str !== '†' ||
    !contact(email) ||
    !contact(address) ||
    !same(x(email) - x(address)) ||
    !same(email.item.height - em) ||
    !same(address.item.height - em) ||
    !same(y(email) - y(address) - (y(address) - y(start))) ||
    y(address) - y(start) < em ||
    y(address) - y(start) > em * 1.5 ||
    x(email) <= x(start) ||
    x(start) < first.width / 2 ||
    y(start) > first.height * 0.25 ||
    !firstItems.slice(0, begin - 4).some(({ item }) => /^Acknowledg(?:e)?ments$/iu.test(item.str))
  )
    return []

  const all = firstItems.slice(begin)
  for (const page of continuations) {
    const [folio, ...body] = items(page)
    if (
      !folio ||
      !body.length ||
      folio.item.str !== String(page.page) ||
      y(folio) < page.height * 0.92 ||
      x(folio) < page.width * 0.85 ||
      !marker(body[0].item.str) ||
      x(body[0]) > page.width * 0.2 ||
      y(body[0]) < page.height * 0.8
    )
      return []
    all.push(...body)
  }

  const column = (part: Part): number => (x(part) < part.page.width / 2 ? 0 : 1),
    startRail = [all.find((part) => column(part) === 0), start]
  const starts = all.flatMap((part, index) => {
    const head = startRail[column(part)]
    return head &&
      Math.abs(x(part) - x(head)) < em * 0.75 &&
      same(part.item.height - em) &&
      part.item.fontName === start.item.fontName &&
      marker(part.item.str)
      ? [index]
      : []
  })
  if (
    starts[0] !== 0 ||
    starts.length < 8 ||
    starts.length > 256 ||
    starts.some((at, index) => Number(marker(all[at].item.str)![1]) !== index + 1)
  )
    return []

  const credited =
    /^\[\d{1,4}\]\s+(?:\p{Lu}\.(?:-\p{Lu}\.)?\s*){1,5}(?:(?:d[aeiou]|del|van|von|ten|der|den|ter)\s+){0,2}\p{Lu}[\p{L}\p{M}’'\x60´¨ˆ˜¸˝^.-]+(?:\s+\p{Lu}[\p{L}\p{M}’'\x60´¨ˆ˜¸˝^.-]+){0,2}(?:,|\s+and\s+|\s+et al\.,)/u
  const publicationEnd =
    /(?:\((?:1[6-9]|20)\d{2}\)|\([^()]{2,105}, (?:1[6-9]|20)\d{2}\)|\((?:[^()]{2,105}, )?(?:1[6-9]|20)\d{2}\) pp\. \d+[–-]\d+|\((?:1[6-9]|20)\d{2}\), [a-z]+:\d{4}\.\d{4,5})\s*\.$/iu
  const selected = new Set<string>(),
    recordOwners = new Set<Unit>()
  let closed = 0
  for (const [index, at] of starts.entries()) {
    const record = all.slice(at, starts[index + 1]),
      value = record
        .map(({ item }) => item.str)
        .join(' ')
        .replace(/\s+/gu, ' ')
        .replace(/(?<=\p{L})([´`¨ˆ˜¸˝^]) (?=\p{Ll})/gu, '$1')
        .trim()
    if (
      !credited.test(value) ||
      !publicationEnd.test(value) ||
      record.length > 100 ||
      record.some(({ item }) => !valid(item) || !same(item.height - em))
    )
      continue
    const rows: Part[][] = []
    for (const part of record) {
      const previous = rows.at(-1)
      if (previous && part.page === previous[0].page && same(y(part) - y(previous[0])))
        previous.push(part)
      else rows.push([part])
    }
    if (
      !rows.every((row, n) => {
        const [head] = row,
          previous = rows[n - 1]?.[0],
          rail = startRail[column(head)]
        return (
          nativeReferenceRoleRowClosed(
            head.page,
            row.map((part) => part.index)
          ) &&
          (!previous ||
            (!!rail &&
              head.page === previous.page &&
              x(head) - x(rail) > em &&
              x(head) - x(rail) < em * 3 &&
              (column(head) === column(previous)
                ? Math.abs(y(previous) - y(head) - em * 1.15) < em * 0.08
                : column(previous) === 0 && y(head) - y(previous) > em)))
        )
      })
    )
      continue
    closed++
    for (const part of record) {
      const owner = owns(part.page, part.index),
        key = `${part.page.page}:${part.index}`
      if (!owner || owner.originalStrings[owner.items.indexOf(key)] !== part.item.str) return []
      selected.add(key)
      recordOwners.add(owner)
    }
  }

  const signatures = [...recordOwners]
    .filter((owner) => owner.items.every((key) => selected.has(key)))
    .map((owner) => owner.items.join('|'))
  if (closed < starts.length * 0.75) return []
  for (const page of bibliographyPages) {
    const indices = all
      .filter((part) => part.page === page && selected.has(`${page.page}:${part.index}`))
      .map((part) => part.index)
    const witness = nativeReferenceRolePageFonts(page, indices)
    if (!witness || !nativeReferenceRoleFontsCurrent(witness)) return []
  }
  return signatures
}

// A centered rule can separate a closed two-column bibliography from the
// final acknowledgments even when the bibliographic band starts high on the page.
function centeredBibliographyDivider(p: PdfLayoutPage, first: PdfLayoutTextItem): boolean {
  const proof = p.nativeReferenceEvidence
  if (!proof?.complete || proof.rules.length !== 1) return false
  const [rule] = proof.rules
  const size = rule.right - rule.left
  const gap = rule.baseline - first.transform[5]
  return (
    rule.operators.length >= 2 &&
    size > p.width * 0.3 &&
    size < p.width * 0.5 &&
    Math.abs((rule.left + rule.right) / 2 - p.width / 2) < first.height * 0.3 &&
    first.transform[4] < p.width / 2 &&
    gap > first.height * 2.5 &&
    gap < first.height * 4.3
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
  for (const page of pages) {
    for (const signature of one(page)) accepted.add(signature)
    if (page !== pages.at(-1)) continue
    for (const signature of bibliographyBeforeAcknowledgments(page, (index) => {
      const key = `${page.page}:${index}`
      return counts.get(key) === 1 ? owners.get(key) : undefined
    }))
      accepted.add(signature)
    const first = page.items.find((item) => item.str.trim()),
      prior = pages.at(-2),
      closing = prior?.items.filter((item) => item.str.trim()).slice(-7),
      afterAcknowledgments =
        prior?.page === page.page - 1 &&
        first?.str === String(page.page) &&
        valid(first) &&
        page.height - first.transform[5] < page.height * 0.08 &&
        (first.transform[4] < page.width * 0.2 || first.transform[4] > page.width * 0.8) &&
        /[.!?]$/u.test(closing?.at(-1)?.str ?? '') &&
        closing
          ?.slice(0, -1)
          .some((item) => /^Acknowledg(?:e)?ments$/iu.test(item.str) && valid(item))
    // A closed acknowledgments section can precede a separate reference page.
    if (afterAcknowledgments)
      for (const signature of one(page, undefined, false, true)) accepted.add(signature)
    // On a mixed final page, prove the complete lower band independently.
    const start = page.items.findIndex(
      (item) =>
        /^\[1\] \p{Lu}\./u.test(item.str) &&
        (item.transform[5] < page.height * 0.35 || centeredBibliographyDivider(page, item))
    )
    if (start >= 0) for (const signature of one(page, start)) accepted.add(signature)
    // The acknowledgments can end directly above a one-column reference packet.
    const rightStart = page.items.findIndex(
      (item) =>
        /^\[1\] \p{Lu}\./u.test(item.str) &&
        item.transform[4] > page.width / 2 &&
        item.transform[5] < page.height * 0.6
    )
    if (rightStart >= 0)
      for (const signature of one(page, rightStart, false, false, true)) accepted.add(signature)
    // A short acknowledgment may occupy the top of the final page.
    const acknowledgedStart = page.items.findIndex(
      (item) => item.str.startsWith('[1] ') && invertedBibliographyAuthor.test(item.str.slice(4))
    )
    if (acknowledgedStart >= 0)
      for (const signature of one(page, acknowledgedStart, true)) accepted.add(signature)
  }
  for (const signature of nativeMixedBibliographyAfterContact(pages, (page, index) => {
    const key = `${page.page}:${index}`
    return counts.get(key) === 1 ? owners.get(key) : undefined
  }))
    accepted.add(signature)
  return accepted

  function one(
    p: PdfLayoutPage,
    terminalStart?: number,
    afterAcknowledgment = false,
    wholeFinalPage = false,
    terminalRight = false
  ): string[] {
    const terminalBand = terminalStart !== undefined
    const dividedBand = terminalBand && centeredBibliographyDivider(p, p.items[terminalStart])
    const proof = p.nativeReferenceEvidence,
      divider =
        p === pages.at(-1) &&
        !terminalBand &&
        !wholeFinalPage &&
        proof?.complete &&
        proof.rules.length === 1
          ? proof.rules[0]
          : undefined
    if (
      p.rotation !== 0 ||
      ![p.width, p.height].every((n) => Number.isFinite(n) && n > 0) ||
      (!terminalBand &&
        !wholeFinalPage &&
        (!proof?.complete || (proof.rules.length > 0 && !divider)))
    )
      return []
    const entries: Entry[] = []
    for (const [index, item] of p.items.entries()) {
      if (!item.str.trim() || index < (terminalStart ?? 0)) continue
      const key = `${p.page}:${index}`,
        owner = owners.get(key),
        font = proof?.complete ? proof.fonts[item.fontName!] : undefined
      if (
        !owner ||
        !valid(item) ||
        (!terminalBand &&
          !wholeFinalPage &&
          (!font?.nativeMetrics ||
            font.ascent !== item.fontAscent ||
            font.descent !== item.fontDescent)) ||
        counts.get(key) !== 1 ||
        owner.originalStrings[owner.items.indexOf(key)] !== item.str
      )
        return []
      const b = box(p, item)
      if (b.x < 0 || b.y < 0 || b.right > p.width || b.bottom > p.height) return []
      entries.push({ item, index, key, owner })
    }
    if (wholeFinalPage) {
      const witness = nativeReferenceRolePageFonts(
        p,
        entries.map((entry) => entry.index)
      )
      if (!witness || !nativeReferenceRoleFontsCurrent(witness)) return []
    }
    const folios = entries.filter(
        (e) =>
          e.item.str === String(p.page) &&
          (box(p, e.item).y > p.height * 0.9 || box(p, e.item).bottom < p.height * 0.08)
      ),
      body = entries.filter((e) => !folios.includes(e)),
      starts = body.filter((e) => marker(e.item.str))
    if (divider)
      return folios.length === 1 && entries[0] === folios[0] && body[0] === starts[0]
        ? closedTerminalBibliography(p, body, folios[0], divider)
        : []
    if (terminalBand && !afterAcknowledgment && !terminalRight && body[0] === starts[0]) {
      const index = p.items.findLastIndex((item, i) => i < terminalStart && !!item.str.trim())
      const heading = p.items[index]
      if (heading && /^Acknowledg(?:e)?ments?$/iu.test(heading.str)) {
        const signatures = closedTerminalBibliography(p, body, { index, item: heading })
        if (signatures.length) return signatures
      }
    }
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
    if (
      wholeFinalPage &&
      (folios.length !== 1 ||
        folios[0] !== entries[0] ||
        body[0] !== starts[0] ||
        columns.length !== 2 ||
        columns[0].x >= p.width / 2 ||
        columns[1].x <= p.width / 2 ||
        starts.length < 8 ||
        starts.some((entry, n) => Number(marker(entry.item.str)![1]) !== n + 1) ||
        columns.some(
          ({ starts: startsInColumn }) =>
            startsInColumn.length < 3 ||
            Math.abs(
              Math.max(...startsInColumn.map(({ item }) => item.transform[5])) -
                starts[0].item.transform[5]
            ) >
              font * 0.02
        ))
    )
      return []
    if (terminalBand) {
      const baseline = starts[0].item.transform[5],
        preceding = p.items
          .slice(0, terminalStart)
          .filter((item) => item.str.trim() && (!terminalRight || item.transform[4] > p.width / 2))
      const preamble = afterAcknowledgment
        ? preceding.filter((item) => item.transform[5] === preceding.at(-1)?.transform[5])
        : preceding
      if (
        afterAcknowledgment &&
        (!/\b(?:is|are|was|were) supported by\b/iu.test(
          preamble.map((item) => item.str).join(' ')
        ) ||
          !nativeReferenceRoleRowClosed(
            p,
            preamble.map((item) => p.items.indexOf(item))
          ))
      )
        return []
      if (
        (terminalRight
          ? columns.length !== 1 ||
            body.some(({ item }) => item.transform[4] <= p.width / 2) ||
            !preceding.some((item) => valid(item) && /^Acknowledg(?:e)?ments\./iu.test(item.str))
          : columns.length !== 2 || columns[0].x >= p.width / 2 || columns[1].x <= p.width / 2) ||
        starts.length < 6 ||
        starts.some((entry, n) => Number(marker(entry.item.str)![1]) !== n + 1) ||
        columns.some(
          ({ x, starts }) =>
            starts.length < 2 ||
            Math.abs(Math.max(...starts.map(({ item }) => item.transform[5])) - baseline) >
              font * 0.02 ||
            !preamble.some(
              (item) =>
                valid(item) &&
                item.height > font * 1.05 &&
                Math.abs(item.transform[4] - x) <
                  font * (afterAcknowledgment || terminalRight || dividedBand ? 0.75 : 0.1) &&
                item.width > p.width * 0.2
            )
        ) ||
        !/[.!?]$/u.test(preceding.at(-1)?.str ?? '') ||
        preceding.some(
          (item) => !Number.isFinite(item.transform[5]) || item.transform[5] <= baseline + font * 3
        ) ||
        preceding.some((item) =>
          /\b(?:reference|citation|bibliograph\w*)\s+examples?\b/iu.test(item.str)
        )
      )
        return []
      const witness = nativeReferenceRolePageFonts(
        p,
        entries.map((e) => e.index)
      )
      if (!witness || !nativeReferenceRoleFontsCurrent(witness)) return []
    }
    const preprint = /\[(?:arXiv:\d{4}\.\d{4,5} \[[a-z.-]+\]|[a-z.-]+\/\d{7})\]\.$/u
    const closesRecord = (source: string, style: 'initials' | 'surname'): boolean =>
      wholeFinalPage
        ? /(?:\b\d{1,3} *, \d{1,9}(?:[-–]\d+|\([A-Z]\))? |\b(?:Thesis|Institute|Press) [^()]{1,60} |\b[A-Z]\d{4,7} )\((?:18|19|20)\d{2}\)\.$|\b[a-z]+(?:-[a-z]+)?\/\d{7}\]?\.$/u.test(
            source
          )
        : (terminalRight && preprint.test(source)) ||
          terminal(source, style) ||
          (dividedBand && /, (?:18|19|20)\d{2}, pp\. \d+[–-]\d+\.$/u.test(source)) ||
          (terminalBand &&
            /(?:,\s*(?:18|19|20)\d{2}|\((?:18|19|20)\d{2}\) ISBN [\d-]{10,17}(?:,\s*[\d-]{10,17})?)\.$/u.test(
              source
            ))
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
      if (numbers.some((n, i) => i > 0 && n !== numbers[i - 1] + 1)) {
        if (terminalBand || wholeFinalPage) return []
        continue
      }
      if ((terminalBand || wholeFinalPage || columnIndex === 0) && starts[0] > 0) return []
      const records: RecordProof[] = []
      for (const [n, start] of starts.entries()) {
        const physical = rows.slice(start, starts[n + 1] ?? rows.length),
          all = physical.flatMap((r) => r.entries),
          keys = new Set(all.map((e) => e.key)),
          source = text(all),
          style = wholeFinalPage
            ? /^\[\d+\] \p{Lu}[\p{L} .,'’-]{4,120},/u.test(source)
              ? 'initials'
              : undefined
            : terminalRight
              ? /^\[\d+\] (?:\p{Lu}\.\s*){1,5}\p{Lu}[\p{L}’'-]+(?:,|\s+et al\.(?:\s+\[[\p{L}\d -]+\])?\s*,)/u.test(
                  source
                )
                ? 'initials'
                : undefined
              : bibliographyStyle(source, afterAcknowledgment),
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
          closesRecord(source, style) &&
          !physical
            .slice(0, -1)
            .some((_, i) =>
              closesRecord(text(physical.slice(0, i + 1).flatMap((r) => r.entries)), style)
            ) &&
          packetOwners.every((u) => u.items.every((k) => keys.has(k)))
        records.push({
          complete,
          owners: packetOwners,
          wraps: physical.slice(1).map((r) => r.entries[0].item.transform[4])
        })
      }
      const wraps = records.filter((r) => r.complete && r.wraps.length)
      const requiredWraps = dividedBand ? 1 : 2
      if (
        (terminalBand || wholeFinalPage) &&
        (wraps.length < requiredWraps || !records.every((r) => r.complete))
      )
        return []
      if (
        wraps.length < requiredWraps ||
        wraps.some((r) => r.wraps.some((x) => Math.abs(x - wraps[0].wraps[0]) > font * 0.05))
      ) {
        if (wholeFinalPage) return []
        continue
      }
      for (let n = 0; n < records.length;) {
        let end = n
        while (end < records.length && records[end].complete) end++
        if (end - n >= (terminalBand ? 2 : 3))
          selected.push(...records.slice(n, end).flatMap((r) => r.owners))
        n = end > n ? end : n + 1
      }
    }
    if (wholeFinalPage) {
      const selectedOwners = new Set(selected)
      if (body.some((entry) => !selectedOwners.has(entry.owner))) return []
    }
    return [...new Set(selected.map((unit) => unit.items.join('|')))]

    function closed(row: Row): boolean {
      const es = [...row.entries].sort((a, b) => a.item.transform[4] - b.item.transform[4]),
        last = es.at(-1)!,
        next = p.items.findIndex((i, n) => n > last.index && !!i.str.trim()),
        emptyBreak = p.items
          .slice(last.index + 1, next < 0 ? undefined : next)
          .some((i) => !i.str.trim() && i.hasEOL === true)
      if (terminalBand || wholeFinalPage)
        return nativeReferenceRoleRowClosed(
          p,
          es.map((e) => e.index)
        )
      return (
        es.slice(0, -1).every((e) => e.item.hasEOL === false) &&
        (last.item.hasEOL === true || emptyBreak) &&
        es.every((e, n) => !n || e.index > es[n - 1].index)
      )
    }
  }
}
