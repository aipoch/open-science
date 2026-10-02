/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { hasUniqueRecordTokens, readSourceRow } from './literature-pdf-source-records.mjs'

const finiteItem = (i) =>
  i.horizontal !== false &&
  Number.isFinite(i.baseline) &&
  Number.isFinite(i.height) &&
  i.height > 0 &&
  i.rect?.length === 4 &&
  i.rect.every(Number.isFinite) &&
  i.rect[2] > i.rect[0] &&
  i.rect[3] > i.rect[1]
const pageNumber = (table) => Number(/^page-(\d+)-/.exec(table.id ?? '')?.[1])
const eq = (a, b) => Math.abs(a - b) < 0.05
const terminalInk = (f, items, p, height) =>
  items
    .filter(
      (i) =>
        i.text?.trim() && i.rect[0] < f.opening[2] && i.rect[2] > f.opening[0] && i.rect[3] > f.end
    )
    .every(
      (i) =>
        finiteItem(i) &&
        i.text.trim() === String(p) &&
        i.rect[1] > height * 0.94 &&
        Math.abs((i.rect[0] + i.rect[2]) / 2 - (f.opening[0] + f.opening[2]) / 2) < f.em * 0.5
    )

function frame(table, items, rules) {
  const crop = table.cropRect
  if (!crop?.every(Number.isFinite)) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.baseline > crop[1] &&
      i.baseline < crop[3]
  )
  if (!near.length || near.some((i) => !finiteItem(i))) return
  const heights = near.map((i) => i.height).sort((a, b) => a - b)
  const em = heights[Math.floor(heights.length / 2)]
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r.every(Number.isFinite) &&
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        r[2] - r[0] >= (crop[2] - crop[0]) * 0.85 &&
        r[2] - r[0] <= (crop[2] - crop[0]) * 1.6
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 2 ||
    full.length > 3 ||
    full.some((r) => !eq(r[0], full[0][0]) || !eq(r[2], full[0][2]))
  )
    return
  const [opening, divider, closing] = full
  if (divider[1] - opening[1] < em * 0.6 || divider[1] - opening[1] > em * 2.5) return
  if (closing && closing[1] - divider[1] < em * 3) return
  const end = closing?.[1] ?? crop[3]
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0] &&
      i.rect[1] < end &&
      i.rect[3] > opening[1]
  )
  if (
    source.some(
      (i) =>
        !finiteItem(i) ||
        i.rect[0] < opening[0] - 0.01 ||
        i.rect[2] > opening[2] + 0.01 ||
        i.rect[1] < opening[1] ||
        i.rect[3] > end ||
        Math.abs(i.height - em) > em * 0.04
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1])
  if (
    header.length < 2 ||
    header.length > 3 ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > em * 0.04)
  )
    return
  header.sort((a, b) => a.rect[0] - b.rect[0])
  const body = source.filter((i) => i.baseline > divider[1])
  if (!body.length || header.length + body.length !== source.length) return
  // Flush source header starts only propose lanes. Every complete source
  // envelope must subsequently fit a positive empty gutter between them.
  const rough = [opening[0], ...header.slice(1).map((i) => i.rect[0] - em * 0.01), opening[2]]
  const cuts = [opening[0]]
  for (let n = 1; n < header.length; n++) {
    const left = source.filter(
      (i) =>
        (i.rect[0] + i.rect[2]) / 2 < rough[n] &&
        (n === 1 || (i.rect[0] + i.rect[2]) / 2 >= rough[n - 1])
    )
    const right = source.filter(
      (i) =>
        (i.rect[0] + i.rect[2]) / 2 >= rough[n] &&
        (n === header.length - 1 || (i.rect[0] + i.rect[2]) / 2 < rough[n + 1])
    )
    const a = Math.max(...left.map((i) => i.rect[2])),
      b = Math.min(...right.map((i) => i.rect[0]))
    if (b - a < em * 0.3) return
    cuts.push((a + b) / 2)
  }
  cuts.push(opening[2])
  if (
    source.some(
      (i) =>
        cuts.slice(1).filter((x, n) => i.rect[0] >= cuts[n] - 0.01 && i.rect[2] <= x + 0.01)
          .length !== 1
    )
  )
    return
  const physical = []
  for (const i of body.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const last = physical.at(-1)
    if (last && Math.abs(last[0].baseline - i.baseline) < em * 0.04) last.push(i)
    else physical.push([i])
  }
  if (physical.length < 3 || physical.length > 80) return
  const gaps = physical.slice(1).map((r, n) => r[0].baseline - physical[n][0].baseline)
  if (
    gaps.some((g) => g < em || g > em * 1.6) ||
    gaps.some((g) => Math.abs(g - gaps[0]) > em * 0.05)
  )
    return
  if (
    rules.some(
      (r) =>
        r[1] === r[3] &&
        r[2] - r[0] > em * 4 &&
        r[0] > opening[0] + em &&
        r[2] < opening[2] - em &&
        r[1] > divider[1] &&
        r[1] < end
    )
  )
    return
  return {
    crop,
    em,
    opening,
    divider,
    closing,
    end,
    source,
    header,
    body,
    cuts,
    physical,
    leading: gaps[0]
  }
}

function formalCaptions(captions, f, p) {
  return captions.filter(
    (c) =>
      c.page === p &&
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect[0] < f.opening[2] &&
      c.rect[2] > f.opening[0] &&
      c.rect[3] <= f.opening[1] &&
      f.opening[1] - c.rect[3] < f.em * 3
  )
}

function pairedRecords(f) {
  if (f.header.length !== 2) return
  const records = []
  for (const row of f.physical) {
    const values = readSourceRow(row, f.cuts)
    if (!values) return
    if (values.every((v) => v.trim())) {
      if (row.length !== 2) return
      records.push([...row])
    } else if (values[0].trim() && !values[1].trim()) {
      if (
        !records.length ||
        records.at(-1).length !== 2 ||
        row.length !== 1 ||
        Math.abs(row[0].rect[0] - records.at(-1)[0].rect[0]) > f.em * 0.02 ||
        f.cuts[1] - records.at(-1)[0].rect[2] > f.em * 1.2 ||
        row[0].rect[2] - row[0].rect[0] >=
          (records.at(-1)[0].rect[2] - records.at(-1)[0].rect[0]) * 0.5
      )
        return
      records.at(-1).push(...row)
    } else return
  }
  if (records.length < 3 || !hasUniqueRecordTokens(f.source, [f.header, ...records])) return
  return records
}

function grid(f, records) {
  const crop = [
    Math.min(f.crop[0], f.opening[0] - 0.5),
    f.crop[1],
    Math.max(f.crop[2], f.opening[2] + 0.5),
    f.crop[3]
  ]
  const edges = [crop[1], f.divider[1]]
  for (let n = 1; n < records.length; n++) {
    const a = Math.max(...records[n - 1].map((i) => i.rect[3])),
      b = Math.min(...records[n].map((i) => i.rect[1]))
    if (b - a < f.em * 0.04) return
    edges.push((a + b) / 2)
  }
  edges.push(crop[3])
  return {
    cropRect: crop,
    rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
    columns: f.cuts
      .slice(1)
      .map((x, n) => [
        n ? f.cuts[n] : crop[0],
        crop[1],
        n === f.cuts.length - 2 ? crop[2] : x,
        crop[3]
      ]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(f.source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

export function getNativePairedTextContextDirection(table, tokens, captions, rules, pageHeight) {
  if (!(pageHeight > 0) || !Number.isFinite(pageHeight)) return
  const f = frame(table, tokens, rules)
  if (!f || !pairedRecords(f)) return
  const p = pageNumber(table)
  if (!Number.isInteger(p) || p < 1) return
  const caption = formalCaptions(captions, f, p)
  if (
    !f.closing &&
    caption.length === 1 &&
    terminalInk(f, tokens, p, pageHeight) &&
    Math.max(...f.body.map((i) => i.rect[3])) > pageHeight * 0.85 &&
    f.crop[3] < pageHeight &&
    pageHeight - f.crop[3] < f.em * 9
  )
    return 1
  if (
    f.closing &&
    !caption.length &&
    f.opening[1] < pageHeight * 0.15 &&
    f.closing[1] < pageHeight * 0.4
  )
    return -1
}

export function recoverNativePairedTextRecordGrid(table, tokens, captions, rules, adjacent) {
  if (
    !adjacent?.tokens?.length ||
    !adjacent.rules?.length ||
    !Number.isFinite(adjacent.currentHeight) ||
    !(adjacent.currentHeight > 0)
  )
    return
  const f = frame(table, tokens, rules)
  if (!f) return
  const p = pageNumber(table),
    next = !f.closing
  if (
    getNativePairedTextContextDirection(table, tokens, captions, rules, adjacent.currentHeight) !==
    (next ? 1 : -1)
  )
    return
  if (
    adjacent.pageNumber !== p + (next ? 1 : -1) ||
    !Number.isFinite(adjacent.height) ||
    !(adjacent.height > 0)
  )
    return
  const matchingRules = joinHorizontalTableRules(adjacent.rules)
    .filter((r) => eq(r[0], f.opening[0]) && eq(r[2], f.opening[2]))
    .sort((a, b) => a[1] - b[1])
  const candidates = []
  for (let n = 0; n < matchingRules.length - 1; n++) {
    const opening = matchingRules[n],
      divider = matchingRules[n + 1]
    if (divider[1] - opening[1] < f.em * 0.6 || divider[1] - opening[1] > f.em * 2.5) continue
    const closing = next ? matchingRules[n + 2] : undefined
    const end = closing?.[1] ?? adjacent.height * 0.94
    const candidate = frame(
      {
        cropRect: [opening[0], opening[1], opening[2], end],
        id: `page-${adjacent.pageNumber}-native-proof`
      },
      adjacent.tokens,
      adjacent.rules
    )
    if (
      !candidate ||
      !!candidate.closing !== next ||
      candidate.header.length !== 2 ||
      candidate.header.some(
        (i, k) =>
          i.text !== f.header[k].text ||
          !eq(i.rect[0], f.header[k].rect[0]) ||
          Math.abs(i.height - f.em) > f.em * 0.02
      ) ||
      Math.abs(candidate.leading - f.leading) > f.em * 0.05 ||
      !pairedRecords(candidate) ||
      (!candidate.closing &&
        !terminalInk(candidate, adjacent.tokens, adjacent.pageNumber, adjacent.height))
    )
      continue
    const prior = next ? f : candidate,
      current = next ? candidate : f
    if (
      formalCaptions(
        next ? captions : (adjacent.captions ?? []),
        prior,
        next ? p : adjacent.pageNumber
      ).length !== 1 ||
      formalCaptions(
        next ? (adjacent.captions ?? []) : captions,
        current,
        next ? adjacent.pageNumber : p
      ).length ||
      current.opening[1] > (next ? adjacent.height : adjacent.currentHeight) * 0.15
    )
      continue
    if (
      prior.closing ||
      Math.max(...prior.body.map((i) => i.rect[3])) <
        (next ? adjacent.currentHeight : adjacent.height) * 0.85
    )
      continue
    candidates.push(candidate)
  }
  if (candidates.length !== 1) return
  const recovered = grid(f, pairedRecords(f))
  if (recovered && !next)
    recovered.continuationCaption = formalCaptions(
      adjacent.captions ?? [],
      candidates[0],
      adjacent.pageNumber
    )[0]
  return recovered
}

export function recoverNativePairedTextCaption(table, tokens, captions, rules, adjacent) {
  return recoverNativePairedTextRecordGrid(table, tokens, captions, rules, adjacent)
    ?.continuationCaption
}

export function recoverNativeOrdinalWrappedRecordGrid(table, tokens, captions, rules) {
  const f = frame(table, tokens, rules)
  if (
    !f?.closing ||
    f.header.length !== 3 ||
    formalCaptions(captions, f, pageNumber(table)).length !== 1
  )
    return
  const records = [],
    anchors = []
  let sharedTail = false
  for (const row of f.physical) {
    const values = readSourceRow(row, f.cuts)
    if (!values) return
    if (values[0].trim()) {
      if (
        !/^\d+$/.test(values[0]) ||
        values.some((v) => !v.trim()) ||
        row.filter((i) => i.rect[2] < f.cuts[1]).length !== 1
      )
        return
      anchors.push(Number(values[0]))
      records.push([...row])
    } else {
      if (!records.length || values.slice(1).every((v) => !v.trim())) return
      for (const i of row) {
        const column = f.cuts.slice(1).findIndex((x, n) => i.rect[0] >= f.cuts[n] && i.rect[2] <= x)
        if (
          column < 1 ||
          !records
            .at(-1)
            .some(
              (a) =>
                a.rect[0] >= f.cuts[column] &&
                a.rect[2] <= f.cuts[column + 1] &&
                Math.abs(a.rect[0] - i.rect[0]) < f.em * 0.02
            )
        )
          return
      }
      sharedTail ||= values.slice(1).every((v) => v.trim())
      records.at(-1).push(...row)
    }
  }
  if (
    records.length < 4 ||
    !sharedTail ||
    anchors.some((v, n) => n && v !== anchors[n - 1] + 1) ||
    !hasUniqueRecordTokens(f.source, [f.header, ...records])
  )
    return
  return grid(f, records)
}
