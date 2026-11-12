/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import { hasUniqueRecordTokens, readSourceRow } from './literature-pdf-source-records.mjs'
import {
  proveOrdinaryNativeTablePrograms,
  fitOrdinaryNativeTableSourcePaint
} from './literature-pdf-native-bounded-text-record-grid.mjs'

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
const same = (a, b) => a.length === b.length && a.every((v, n) => Math.abs(v - b[n]) < 0.02)
const intersects = (r, f) => r[0] <= f[2] && r[2] >= f[0] && r[1] <= f[3] && r[3] >= f[1]

// Complete repeated records establish the leaf rows. Independently printed
// full-width fences establish an outer stub; shorter fences may establish a
// second, nested stub. Stub text, its quantity and the detector's spans never
// decide the beginning or length of either scope.
export function recoverNativeHorizontalStubScopes(table, items, captions, rules, context) {
  const crop = table?.cropRect,
    page = Number(/^page-(\d+)-/.exec(table?.id ?? '')?.[1])
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    table.readingRotation ||
    !crop?.every(Number.isFinite) ||
    !Array.isArray(items) ||
    !Array.isArray(rules) ||
    !Array.isArray(context?.sourceContent?.items) ||
    typeof context.viewport?.convertToViewportPoint !== 'function'
  )
    return
  if (
    context.sourceContent.items.some(
      (i) =>
        typeof i.str === 'string' &&
        i.str.trim() &&
        (!Array.isArray(i.transform) ||
          i.transform.length !== 6 ||
          !i.transform.every(Number.isFinite) ||
          !(i.width > 0) ||
          !(i.height > 0))
    )
  )
    return
  const valid = (i) =>
    i.horizontal === true &&
    i.rect?.length === 4 &&
    i.rect.every(Number.isFinite) &&
    i.rect[2] > i.rect[0] &&
    i.rect[3] > i.rect[1] &&
    Number.isFinite(i.baseline) &&
    Number.isFinite(i.height) &&
    i.height > 0
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect?.[0] < crop[2] &&
      i.rect?.[2] > crop[0] &&
      i.rect?.[1] < crop[3] &&
      i.rect?.[3] > crop[1]
  )
  const em = median(near.map((i) => i.height))
  if (!(em > 0) || near.some((i) => !valid(i))) return
  const horizontal = joinHorizontalTableRules(rules)
  const full = horizontal
    .filter(
      (r) =>
        r[1] >= crop[1] - em &&
        r[1] <= crop[3] + em &&
        Math.abs(r[0] - crop[0]) < em &&
        Math.abs(r[2] - crop[2]) < em
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 4 ||
    full.length > 10 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02) ||
    full[1][1] - full[0][1] > em * 3
  )
    return
  const [opening, divider] = full,
    closing = full.at(-1),
    frame = [opening[0], opening[1], opening[2], closing[1]],
    source = items.filter(
      (i) =>
        i.text?.trim() &&
        i.rect?.[0] < frame[2] &&
        i.rect?.[2] > frame[0] &&
        i.rect?.[1] < frame[3] &&
        i.rect?.[3] > frame[1]
    )
  if (
    !source.length ||
    source.some(
      (i) =>
        !valid(i) ||
        i.height > em + 0.02 ||
        i.height < em * 0.55 ||
        i.rect[0] < frame[0] ||
        i.rect[2] > frame[2] ||
        i.rect[1] < frame[1] ||
        i.rect[3] > frame[3]
    ) ||
    !proveNativeUniqueWholeFonts(source, items)
  )
    return
  const original = context.sourceContent.items
    .filter((i) => 'str' in i && i.str.trim())
    .map((i) => tableTextToken(i, context.viewport, 0))
    .filter(
      (i) =>
        i.rect[0] < frame[2] && i.rect[2] > frame[0] && i.rect[1] < frame[3] && i.rect[3] > frame[1]
    )
  if (
    original.length !== source.length ||
    original.some(
      (i) =>
        source.filter(
          (s) =>
            s.sourceItem?.index === i.sourceItem?.index && s.text === i.text && same(s.rect, i.rect)
        ).length !== 1
    ) ||
    near.some((i) => !source.includes(i))
  )
    return
  const header = source.filter((i) => i.rect[3] < divider[1]),
    body = source.filter((i) => i.rect[1] > divider[1])
  if (!header.length || header.length + body.length !== source.length) return
  const projections = []
  for (const i of [...source].sort((a, b) => a.rect[0] - b.rect[0])) {
    const prior = projections.at(-1)
    if (prior && i.rect[0] - prior[1] < em * 0.6) prior[1] = Math.max(prior[1], i.rect[2])
    else projections.push([i.rect[0], i.rect[2]])
  }
  const count = projections.length
  if (count < 4 || count > 20) return
  const cuts = [
    frame[0],
    ...projections.slice(1).map((r, n) => (projections[n][1] + r[0]) / 2),
    frame[2]
  ]
  const lane = (i) => cuts.slice(1).findIndex((x, c) => i.rect[0] >= cuts[c] && i.rect[2] <= x)
  if (source.some((i) => lane(i) < 0)) return
  const heads = cuts.slice(1).map((_, c) => header.filter((i) => lane(i) === c))
  const headBaseline = median(
    header.filter((i) => Math.abs(i.height - em) < 0.02).map((i) => i.baseline)
  )
  if (
    !Number.isFinite(headBaseline) ||
    heads.some((group) => {
      const main = group.filter((i) => Math.abs(i.height - em) < 0.02),
        scripts = group.filter((i) => Math.abs(i.height - em) >= 0.02)
      if (
        !main.length ||
        !main.some((i) => /\p{L}/u.test(i.text)) ||
        main.some((i) => Math.abs(i.baseline - headBaseline) > 0.02)
      )
        return true
      // A native subscript face can itself consist of several adjacent fonts.
      const chains = []
      for (const s of scripts.sort((a, b) => a.rect[0] - b.rect[0])) {
        const prior = chains.at(-1)
        if (
          prior &&
          Math.abs(prior.at(-1).rect[2] - s.rect[0]) < 0.02 &&
          Math.abs(prior[0].baseline - s.baseline) < 0.02 &&
          Math.abs(prior[0].height - s.height) < 0.02
        )
          prior.push(s)
        else chains.push([s])
      }
      return chains.some(
        (chain) => main.filter((m) => isAdjacentTableScript(chain[0], m)).length !== 1
      )
    })
  )
    return
  const partial = horizontal.filter(
    (r) => r[1] > divider[1] && r[1] < closing[1] && !full.includes(r)
  )
  const stubCount = partial.length ? 2 : 1
  if (
    count - stubCount < 3 ||
    (partial.length &&
      (partial.length < 2 ||
        partial.some(
          (r) =>
            Math.abs(r[0] - partial[0][0]) > 0.02 ||
            Math.abs(r[2] - partial[0][2]) > 0.02 ||
            r[2] > frame[2] ||
            frame[2] - r[2] > em ||
            r[0] <= frame[0]
        )))
  )
    return
  const fields = body.filter((i) => lane(i) >= stubCount),
    rows = []
  for (const i of [...fields].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    if (Math.abs(i.height - em) >= 0.02) continue
    const prior = rows.at(-1)
    if (prior && Math.abs(prior[0].baseline - i.baseline) < 0.02) prior.push(i)
    else rows.push([i])
  }
  if (rows.length < 4 || rows.length > 255 || (rows.length + 1) * count > 2048) return
  const assigned = new Set(rows.flat())
  for (const s of fields.filter((i) => !assigned.has(i))) {
    const owners = rows.filter(
      (r) => r.filter((i) => lane(i) === lane(s) && isAdjacentTableScript(s, i)).length === 1
    )
    if (owners.length !== 1) return
    owners[0].push(s)
  }
  const metric = /^[+−-]?\d+(?:\.\d+)?%?$/u,
    signatures = []
  for (const row of rows) {
    const cells = cuts.slice(1).map((_, c) => row.filter((i) => lane(i) === c)),
      label = cells[stubCount],
      values = cells.slice(stubCount + 1)
    if (
      !label.length ||
      !label.some((i) => /\p{L}/u.test(i.text)) ||
      values.some((v) => v.length !== 1 || !metric.test(v[0].text))
    )
      return
    const ordered = label.slice().sort((a, b) => a.rect[0] - b.rect[0])
    if (ordered.some((i, n) => n && i.rect[0] - ordered[n - 1].rect[2] > em * 0.6)) return
    const signature = readSourceRow(row, cuts)?.[stubCount]
    if (!signature) return
    signatures.push(signature)
  }
  const bounds = rows.map((r) => [
    Math.min(...r.map((i) => i.rect[1])),
    Math.max(...r.map((i) => i.rect[3]))
  ])
  if (bounds.some((r, n) => n && r[0] <= bounds[n - 1][1])) return
  const spans = [],
    records = rows.map((r) => [...r]),
    rowBounds = [frame[1], divider[1]]
  const outer = []
  for (let b = 1; b < full.length - 1; b++) {
    const top = full[b][1],
      bottom = full[b + 1][1],
      indices = rows
        .map((r, n) => ({ r, n }))
        .filter(({ n }) => bounds[n][0] > top && bounds[n][1] < bottom)
        .map(({ n }) => n),
      stubs = body.filter((i) => lane(i) === 0 && i.rect[1] > top && i.rect[3] < bottom)
    if (
      indices.length < 2 ||
      indices.length > 12 ||
      stubs.length !== 1 ||
      indices.some((n, k) => k && n !== indices[k - 1] + 1)
    )
      return
    outer.push(indices)
    records[indices[0]].push(stubs[0])
    spans.push({ row: indices[0] + 1, column: 0, rowSpan: indices.length, colSpan: 1 })
    for (const n of indices)
      rowBounds.push(n === indices.at(-1) ? bottom : (bounds[n][1] + bounds[n + 1][0]) / 2)
    if (stubCount === 2) {
      const fences = [full[b], ...partial.filter((r) => r[1] > top && r[1] < bottom), full[b + 1]]
      if (fences.length < 3) return
      for (let k = 0; k < fences.length - 1; k++) {
        const start = fences[k][1],
          end = fences[k + 1][1],
          inner = indices.filter((n) => bounds[n][0] > start && bounds[n][1] < end),
          labels = body.filter((i) => lane(i) === 1 && i.rect[1] > start && i.rect[3] < end)
        if (
          inner.length !== 2 ||
          labels.length !== 1 ||
          Math.abs(
            labels[0].baseline -
              inner.reduce((sum, n) => sum + rows[n][0].baseline, 0) / inner.length
          ) > 0.02
        )
          return
        records[inner[0]].push(labels[0])
        spans.push({ row: inner[0] + 1, column: 1, rowSpan: inner.length, colSpan: 1 })
        if (k < fences.length - 2) rowBounds[inner.at(-1) + 2] = end
      }
    }
  }
  if (
    outer.flat().length !== rows.length ||
    new Set(outer.flat()).size !== rows.length ||
    outer.some(
      (indices) =>
        indices.length !== outer[0].length ||
        indices.some((n, k) => signatures[n] !== signatures[outer[0][k]])
    ) ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  if (stubCount === 2) {
    const leftDomain = body.filter((i) => lane(i) === 0),
      rightDomain = body.filter((i) => lane(i) > 0)
    if (
      partial.some(
        (r) =>
          leftDomain.some((i) => i.rect[2] >= r[0]) ||
          rightDomain.some((i) => i.rect[0] <= r[0] || (i.rect[0] + i.rect[2]) / 2 >= r[2])
      )
    )
      return
  }
  const titles = captions.filter(
    (c) =>
      c.page === page &&
      captionKind(c.lines?.[0]) === 'table' &&
      c.rect?.every(Number.isFinite) &&
      c.rect[0] < frame[2] &&
      c.rect[2] > frame[0] &&
      ((c.rect[3] < frame[1] && frame[1] - c.rect[3] < em * 4) ||
        (c.rect[1] > frame[3] && c.rect[1] - frame[3] < em * 4))
  )
  if (titles.length !== 1) return
  const caption = titles[0],
    titleFonts = context.sourceContent.items
      .filter((i) => 'str' in i && i.str.trim())
      .map((i) => tableTextToken(i, context.viewport, 0))
      .filter(
        (i) =>
          i.rect[0] < caption.rect[2] &&
          i.rect[2] > caption.rect[0] &&
          i.rect[1] < caption.rect[3] &&
          i.rect[3] > caption.rect[1]
      )
  if (
    !titleFonts.length ||
    titleFonts.some((i) =>
      i.rect.some((v, n) => (n < 2 ? v < caption.rect[n] - 0.02 : v > caption.rect[n] + 0.02))
    ) ||
    titleFonts
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '') !== caption.lines.join('').replace(/\s/gu, '') ||
    !proveOrdinaryNativeTablePrograms([...source, ...titleFonts], context, page)
  )
    return
  const paint = new Map(),
    native = collectTableRules(context.operators, context.viewport, paint),
    expected = [...full, ...partial],
    local = native.filter((r) => intersects(r, frame))
  if (
    local.length !== expected.length ||
    expected.some((r) => local.filter((n) => same(n, r) && paint.has(n.join(','))).length !== 1) ||
    rules.some((r) => intersects(r, frame) && !expected.some((e) => same(e, r)))
  )
    return
  const painted = local.map((r) => paint.get(r.join(','))),
    cropRect = crop.map((v, n) =>
      n < 2 ? Math.min(v, ...painted.map((r) => r[n])) : Math.max(v, ...painted.map((r) => r[n]))
    )
  if (!fitOrdinaryNativeTableSourcePaint(source, context, cropRect)) return
  if (
    rowBounds.length !== rows.length + 2 ||
    rowBounds.some((y, n) => !Number.isFinite(y) || (n && y <= rowBounds[n - 1]))
  )
    return
  cuts[0] = cropRect[0]
  cuts[cuts.length - 1] = cropRect[2]
  rowBounds[0] = cropRect[1]
  rowBounds[rowBounds.length - 1] = cropRect[3]
  return {
    cropRect,
    rows: rowBounds.slice(1).map((y, n) => [cuts[0], rowBounds[n], cuts.at(-1), y]),
    columns: cuts.slice(1).map((x, c) => [cuts[c], cropRect[1], x, cropRect[3]]),
    spans,
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}
