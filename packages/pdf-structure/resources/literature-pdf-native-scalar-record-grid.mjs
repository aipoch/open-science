/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { nativeWholeCellInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'

const scalar = '[+−-]?\\d+(?:,\\d{3})*(?:\\.\\d+)?'
const value = new RegExp(
  `^(?:(?:${scalar})(?:±${scalar})?(?:\\(${scalar}\\)|\\[${scalar},${scalar}\\])?|\\(${scalar}(?:,${scalar}){1,2}\\)|${scalar}/${scalar}|—)$`,
  'u'
)
const numeric = (i) => /^[\d+−.,()[\]±%/—-]+$/u.test(i.text.replace(/\s/gu, ''))
const box = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]
const text = (items) =>
  items
    .map((i) => i.text)
    .join('')
    .replace(/\s/gu, '')

function headerGutter(header, left, right, height) {
  let a = left,
    b = right
  const ordered = [...header].sort((x, y) => x.rect[0] - y.rect[0]),
    components = []
  for (const item of ordered) {
    const prior = components.at(-1)
    if (prior && item.rect[0] - Math.max(...prior.map((i) => i.rect[2])) <= height * 0.4)
      prior.push(item)
    else components.push([item])
  }
  for (const item of header) {
    if (item.rect[0] >= right || item.rect[2] <= left) continue
    if (item.rect[0] < left && item.rect[2] < right) a = Math.max(a, item.rect[2])
    else if (item.rect[0] > left && item.rect[2] > right) b = Math.min(b, item.rect[0])
    else if (item.rect[0] >= left && item.rect[2] <= right) {
      const group = components.find((g) => g.includes(item)),
        extent = box(group)
      if (extent[0] < left && extent[2] <= right) a = Math.max(a, item.rect[2])
      else if (extent[0] >= left && extent[2] > right) b = Math.min(b, item.rect[0])
      else return
    } else return
  }
  if (b - a < height * 0.1) return
  return (a + b) / 2
}

export function nativeMeasuredWordTokens(item, observations, height) {
  if (!/\s/u.test(item.text)) return [item]
  const matched = observations.filter(
    (r) => r.text === item.text && r.rect?.every((v, n) => Math.abs(v - item.rect[n]) < 0.02)
  )
  const characterCount = [...item.text].filter((s) => !/\s/u.test(s)).length
  if (
    matched.length !== 1 ||
    matched[0].glyphRuns?.length !== characterCount ||
    new Set(matched[0].glyphRuns).size !== 1
  )
    return [item]
  const gaps = matched[0].gaps
    .filter(
      (g) =>
        Number.isFinite(g.left) &&
        Number.isFinite(g.right) &&
        Number.isInteger(g.index) &&
        g.right - g.left >= height * 0.25
    )
    .sort((a, b) => a.index - b.index)
  if (
    !gaps.length ||
    gaps.some(
      (g, n) =>
        g.index <= 0 ||
        g.index >= characterCount ||
        g.left < item.rect[0] ||
        g.right > item.rect[2] ||
        g.right <= g.left ||
        (n > 0 && (g.index <= gaps[n - 1].index || g.left < gaps[n - 1].right))
    )
  )
    return [item]
  const chars = [...item.text],
    pieces = []
  let at = 0,
    count = 0
  for (let n = 0; n < chars.length; n++) {
    if (/\s/u.test(chars[n])) continue
    const gap = gaps.find((g) => g.index === count)
    if (gap) {
      pieces.push(chars.slice(at, n).join('').trim())
      at = n
    }
    count++
  }
  pieces.push(chars.slice(at).join('').trim())
  if (
    pieces.length !== gaps.length + 1 ||
    pieces.some((s) => !s) ||
    pieces.join('').replace(/\s/gu, '') !== item.text.replace(/\s/gu, '')
  )
    return [item]
  return pieces.map((s, n) => ({
    ...item,
    text: s,
    rect: [
      n ? gaps[n - 1].right : item.rect[0],
      item.rect[1],
      n < gaps.length ? gaps[n].left : item.rect[2],
      item.rect[3]
    ]
  }))
}

export function partitionNativeScalarFields(row, height, allowNumericStart = false) {
  let start = row.findIndex((i) => numeric(i) && /\d/u.test(i.text))
  if (
    start > 0 &&
    /^\(\d+\)$/u.test(row[start].text.replace(/\s/gu, '')) &&
    row.slice(0, start).some((i) => /\p{L}/u.test(i.text))
  )
    start++
  if (
    start > 0 &&
    /^[+−-]$/u.test(row[start - 1].text.trim()) &&
    row[start].rect[0] - row[start - 1].rect[2] < height * 0.22
  )
    start--
  if (
    start < (allowNumericStart ? 0 : 1) ||
    row
      .slice(0, start)
      .some(
        (i) =>
          numeric(i) &&
          /\d/u.test(i.text) &&
          !(allowNumericStart && /^\(\d+\)$/u.test(i.text.replace(/\s/gu, '')))
      )
  )
    return
  const prefix = row.slice(0, start),
    groups = []
  let at = start
  while (at < row.length) {
    if (!numeric(row[at])) return
    let last = -1
    for (let end = at; end < row.length; end++) {
      const item = row[end],
        prior = row[end - 1]
      if (!numeric(item)) break
      if (
        end > at &&
        item.rect[0] - prior.rect[2] > height * 0.22 &&
        !/^(?:±|\(|\[)/u.test(item.text.trim()) &&
        !/[±,[+−-]$/u.test(prior.text.trim())
      )
        break
      const candidate = text(row.slice(at, end + 1))
      if (value.test(candidate)) last = end
      if (candidate.length > 100) break
    }
    if (last < at) return
    groups.push(row.slice(at, last + 1))
    at = last + 1
  }
  if (groups.length < 2 || groups.length > 18) return
  return { prefix, groups }
}

// Three complete same-baseline records, a source header and matching native
// opening/divider/closing strokes prove logical lanes independently of model
// count columns. TJ gaps may divide a fused item only at measured whitespace.
// A plan is installed only when the model contradicts the complete source.
export function recoverNativeScalarRecordPlan(table, items, captions, rules, observations = []) {
  const crop = table.cropRect
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      i.horizontal !== false &&
      i.rect[0] < crop[2] &&
      i.rect[2] > crop[0] &&
      i.baseline > crop[1] &&
      i.baseline < crop[3]
  )
  if (!near.length) return
  const h = near.map((i) => i.height).sort((a, b) => a - b)[Math.floor(near.length / 2)]
  if (!(h > 0)) return
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] - h &&
        r[1] <= crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 3 ||
    full.length > 16 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const opening = full[0],
    divider = full.find((r) => r[1] - opening[1] > h * 0.5),
    closing = full.at(-1)
  if (
    !divider ||
    divider === closing ||
    divider[1] - opening[1] > h * 3 ||
    closing[1] - divider[1] < h * 2.2
  )
    return
  const adjacentCaptions = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[0] < opening[2] &&
      c.rect[2] > opening[0] &&
      ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 8) ||
        (c.rect[1] >= closing[1] - h * 0.2 && c.rect[1] - closing[1] < h * 8))
  )
  const captionDistance = (c) =>
    c.rect[3] <= opening[1] ? opening[1] - c.rect[3] : Math.max(0, c.rect[1] - closing[1])
  adjacentCaptions.sort((a, b) => captionDistance(a) - captionDistance(b))
  if (
    !adjacentCaptions.length ||
    (adjacentCaptions.length > 1 &&
      captionDistance(adjacentCaptions[1]) - captionDistance(adjacentCaptions[0]) < h)
  )
    return
  const original = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0] &&
      i.baseline > opening[1] &&
      i.baseline < closing[1]
  )
  if (
    original.some(
      (i) =>
        i.horizontal === false ||
        i.height < h * 0.55 ||
        i.height > h * 1.04 ||
        !Number.isFinite(i.baseline) ||
        i.rect.some((v) => !Number.isFinite(v)) ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] - h * 0.08 ||
        i.rect[3] > closing[1]
    )
  )
    return
  const replacement = new Map(
      original.map((i) => [i, nativeMeasuredWordTokens(i, observations, h)])
    ),
    source = original.flatMap((i) => replacement.get(i))
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  const headerMain = header.filter((i) => Math.abs(i.height - h) <= h * 0.04)
  if (
    !headerMain.length ||
    headerMain.some((i) => Math.abs(i.baseline - headerMain[0].baseline) > h * 0.04) ||
    header.some(
      (i) =>
        Math.abs(i.baseline - headerMain[0].baseline) > h * 0.45 ||
        (Math.abs(i.height - h) > h * 0.04 && i.height > h * 0.8)
    )
  )
    return
  const rows = []
  for (const item of body
    .filter((i) => Math.abs(i.height - h) <= h * 0.04)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = rows.at(-1)
    if (row && Math.abs(row[0].baseline - item.baseline) <= h * 0.04) row.push(item)
    else rows.push([item])
  }
  for (const item of body.filter((i) => Math.abs(i.height - h) > h * 0.04)) {
    const owners = rows.filter((r) => Math.abs(r[0].baseline - item.baseline) <= h * 0.3)
    if (owners.length !== 1) return
    owners[0].push(item)
  }
  for (const row of rows) row.sort((a, b) => a.rect[0] - b.rect[0])
  if (rows.length < 2 || rows.length > 80) return
  const parsed = rows.map((r) => partitionNativeScalarFields(r, h))
  if (parsed.some((p) => !p) || parsed.some((p) => p.groups.length !== parsed[0].groups.length))
    return
  if (
    rows.length === 2 &&
    (parsed[0].groups.length < 3 ||
      parsed.some((p) => p.groups.filter((g) => /±|\[/u.test(text(g))).length < 3))
  )
    return
  const count = parsed[0].groups.length,
    firstRight = Math.max(...parsed.flatMap((p) => p.prefix.map((i) => i.rect[2]))),
    firstLeft = Math.min(...parsed.map((p) => box(p.groups[0])[0]))
  if (firstLeft - firstRight < h * 0.15) return
  let firstA = firstRight,
    firstB = firstLeft
  for (const item of header) {
    if (item.rect[0] >= firstLeft || item.rect[2] <= firstRight) continue
    if (item.rect[0] < firstRight && item.rect[2] < firstLeft)
      firstA = Math.max(firstA, item.rect[2])
    else if (item.rect[0] > firstRight) firstB = Math.min(firstB, item.rect[0])
    else return
  }
  if (firstB - firstA < h * 0.1) return
  const first = (firstA + firstB) / 2
  const prefixHeader = header
      .filter((i) => i.rect[2] <= first)
      .sort((a, b) => a.rect[0] - b.rect[0]),
    stubHeads = []
  for (const item of prefixHeader) {
    const last = stubHeads.at(-1)
    if (last && item.rect[0] - last.at(-1).rect[2] < h * 0.75) last.push(item)
    else stubHeads.push([item])
  }
  if (
    stubHeads.length < 1 ||
    stubHeads.length > 3 ||
    stubHeads.some((g) => !/\p{L}/u.test(text(g)))
  )
    return
  const cuts = [crop[0]]
  for (let n = 1; n < stubHeads.length; n++) {
    let a = box(stubHeads[n - 1])[2],
      b = box(stubHeads[n])[0]
    for (const p of parsed) {
      const gaps = p.prefix
        .slice(1)
        .map((item, k) => [p.prefix[k].rect[2], item.rect[0]])
        .filter((g) => g[0] < b && g[1] > a)
      if (gaps.length !== 1) return
      a = Math.max(a, gaps[0][0])
      b = Math.min(b, gaps[0][1])
    }
    if (b - a < h * 0.1) return
    cuts.push((a + b) / 2)
  }
  cuts.push(first)
  for (let n = 1; n < count; n++) {
    const a = Math.max(...parsed.map((p) => box(p.groups[n - 1])[2])),
      b = Math.min(...parsed.map((p) => box(p.groups[n])[0]))
    const cut = headerGutter(header, a, b, h)
    if (cut === undefined) return
    cuts.push(cut)
  }
  cuts.push(crop[2])
  const ownedHeader = readSourceRow(header, cuts)
  if (
    !ownedHeader?.every((s) => s.trim()) ||
    header.some(
      (i) =>
        !cuts.slice(1).some((right, n) => i.rect[0] >= cuts[n] - 0.02 && i.rect[2] <= right + 0.02)
    )
  )
    return
  for (let n = 0; n < parsed.length; n++) {
    const p = parsed[n],
      owned = readSourceRow(rows[n], cuts)
    if (
      !owned ||
      owned.slice(0, stubHeads.length).some((s) => !s.trim()) ||
      owned.slice(stubHeads.length).some((s, k) => s.replace(/\s/gu, '') !== text(p.groups[k]))
    )
      return
  }
  const model = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  const modelCuts = [
    crop[0],
    ...model.slice(1).map((o, n) => crop[0] + (model[n].rect[2] + o.rect[0]) / 2),
    crop[2]
  ]

  // Do not erase an existing descriptor lane supported by every native record
  // and independent whole header items on both sides of that model boundary.
  const supportedDescriptorCut = modelCuts.slice(1, -1).some((cut) => {
    if (!(cut > crop[0] && cut < first)) return false
    const split = (row) =>
      row.some((i) => i.rect[2] <= cut) &&
      row.some((i) => i.rect[0] >= cut) &&
      row.every((i) => i.rect[2] <= cut || i.rect[0] >= cut)
    if (!split(prefixHeader) || !parsed.every((p) => split(p.prefix))) return false
    return !cuts
      .slice(1, -1)
      .some(
        (own) =>
          own < first &&
          prefixHeader.every(
            (i) => i.rect[2] <= own === i.rect[2] <= cut && i.rect[0] >= own === i.rect[0] >= cut
          )
      )
  })
  if (supportedDescriptorCut) return

  // A scalar followed by a bracketed interval is not necessarily one printed
  // leaf. Preserve an existing boundary when independent whole headings and
  // every complete native record support it on both sides. This only declines
  // the replacement plan; the original model/source still receives final review.
  const supportedValueCut = modelCuts.slice(1, -1).some((cut) => {
    if (!(cut > first && cut < crop[2])) return false
    const groups = [header, ...rows],
      split = (row) =>
        row.some((i) => i.rect[2] <= cut) &&
        row.some((i) => i.rect[0] >= cut) &&
        row.every((i) => i.rect[2] <= cut || i.rect[0] >= cut)
    if (!groups.every(split)) return false
    return !cuts
      .slice(1, -1)
      .some((own) =>
        groups.every((row) =>
          row.every(
            (i) => i.rect[2] <= own === i.rect[2] <= cut && i.rect[0] >= own === i.rect[0] >= cut
          )
        )
      )
  })
  if (supportedValueCut) {
    // Complete ordinary whole headings already admit the independent late
    // header/ambiguity review. Do not disable their native row recovery just
    // because scalar grouping temporarily combines a value and its interval.
    // Fragmented/scripted headings do not have this whole-source bijection.
    const nativeHeader = original
        .filter((i) => i.baseline < divider[1])
        .sort((a, b) => a.rect[0] - b.rect[0]),
      nativeBody = original.filter((i) => i.baseline > divider[1]),
      nativeRows = rows.map((row) =>
        nativeBody.filter((i) => Math.abs(i.baseline - row[0].baseline) <= h * 0.04)
      ),
      fits = (i, n) => i.rect[0] >= modelCuts[n] && i.rect[2] <= modelCuts[n + 1],
      domains = nativeHeader.map((heading, n) =>
        box([heading, ...nativeRows.flatMap((row) => row.filter((i) => fits(i, n)))])
      ),
      frame = [opening[0], opening[1], opening[2], closing[1]],
      ordinaryHeaderLeaves =
        modelCuts.length === nativeHeader.length + 1 &&
        modelCuts.every(Number.isFinite) &&
        modelCuts.slice(1).every((x, n) => x > modelCuts[n]) &&
        proveNativeUniqueWholeFonts(original, items) &&
        original.every((i) => Math.abs(i.height - h) <= h * 0.04) &&
        nativeHeader.every((i) => Math.abs(i.baseline - nativeHeader[0].baseline) <= h * 0.04) &&
        // Model cuts may pass through a long heading. Its whole native box and
        // the corresponding repeated body leaf must instead form disjoint
        // ordered domains; no heading is clipped to a quantized model boundary.
        domains.every((r) => r[0] >= frame[0] && r[2] <= frame[2]) &&
        domains.slice(1).every((r, n) => r[0] > domains[n][2]) &&
        nativeRows.flat().length === nativeBody.length &&
        new Set(nativeRows.flat()).size === nativeBody.length &&
        nativeRows.every(
          (row) =>
            modelCuts.slice(1).every((_, n) => row.some((i) => fits(i, n))) &&
            row.every((i) => modelCuts.slice(1).filter((_, n) => fits(i, n)).length === 1)
        ) &&
        items.every(
          (i) =>
            !i.text?.trim() ||
            (Array.isArray(i.rect) &&
              i.rect.length === 4 &&
              i.rect.every(Number.isFinite) &&
              i.rect[2] > i.rect[0] &&
              i.rect[3] > i.rect[1] &&
              (i.rect[0] >= frame[2] ||
                i.rect[2] <= frame[0] ||
                i.rect[1] >= frame[3] ||
                i.rect[3] <= frame[1] ||
                original.includes(i)))
        )
    if (!ordinaryHeaderLeaves) return
  }

  const modelRows = table.structure.objects.filter((o) => o.label === 'table row')
  if (
    model.length === cuts.length - 1 &&
    modelRows.length === rows.length + 1 &&
    [header, ...rows].every((row) =>
      row.every((i) =>
        modelCuts
          .slice(1)
          .some((right, n) => i.rect[0] >= modelCuts[n] - 0.02 && i.rect[2] <= right + 0.02)
      )
    )
  )
    return
  const edges = [box(header)[1], divider[1]]
  for (let n = 1; n < rows.length; n++) {
    const a = box(rows[n - 1])[3],
      b = box(rows[n])[1]
    if (b - a < h * 0.04) return
    const separators = full.filter((r) => r[1] >= a && r[1] <= b)
    if (separators.length > 1) return
    edges.push(separators.length ? separators[0][1] : (a + b) / 2)
  }
  edges.push(box(rows.at(-1))[3])
  if (!hasUniqueRecordTokens(source, [header, ...rows])) return
  const pageItems = items.flatMap((i) => replacement.get(i) ?? [i])
  return {
    pageItems,
    grid: {
      rows: edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y]),
      columns: cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]]),
      headerRows: [0],
      spans: [],
      completeSpans: true,
      ownedTokens: new Set(source),
      preservePhysicalRows: true,
      repair: 'native-body-records-recovered'
    }
  }
}

const withinScalarBox = (r, b) =>
  r[0] >= b[0] - 0.02 && r[1] >= b[1] - 0.02 && r[2] <= b[2] + 0.02 && r[3] <= b[3] + 0.02

function completeScalarLeafHeaders(header, columns, height) {
  if (header.some((i) => columns.filter((c) => withinScalarBox(i.rect, c)).length !== 1))
    return false
  return columns.every((column, n) => {
    const owned = header.filter((i) => withinScalarBox(i.rect, column)),
      main = owned.filter((i) => Math.abs(i.height - height) <= height * 0.04),
      scripts = owned.filter((i) => !main.includes(i))
    if (main.length !== 1 || !/\p{L}/u.test(main[0].text) || scripts.length > 1) return false
    return scripts.every(
      (i) =>
        n > 0 &&
        /^\d+$/u.test(i.text) &&
        i.height >= height * 0.55 &&
        i.height <= height * 0.8 &&
        i.baseline > main[0].baseline &&
        i.baseline - main[0].baseline <= height * 0.45 &&
        Math.abs(i.rect[0] - main[0].rect[2]) <= height * 0.22
    )
  })
}

function completeScalarGlyphSources(owned, rows, columns, evidence) {
  const ordered = [...owned].sort((a, b) => a.sourceItem.index - b.sourceItem.index),
    packet = nativeWholeCellInkPacket(evidence.page, evidence.tokens, evidence.context, {
      text: ordered.map((i) => i.text).join(''),
      sourceItems: ordered.map((i) => i.sourceItem),
      sourceRects: ordered.map((i) => i.rect.map((n) => n / 1.5))
    })
  if (!packet) return
  const byIndex = new Map(owned.map((i) => [i.sourceItem.index, i]))
  const frame = [columns[0][0], columns[0][1], columns.at(-1)[2], columns[0][3]].map((n) => n / 1.5)
  for (const record of packet.records) {
    const item = byIndex.get(record.index)
    if (item) {
      const row = rows.filter((r) => withinScalarBox(item.rect, r)),
        column = columns.filter((c) => withinScalarBox(item.rect, c))
      if (row.length !== 1 || column.length !== 1) return
      // Outer physical cells end at the verified frame, not at the last text
      // advance baseline: visible descenders must remain inside the rule.
      const cell = [
        column[0][0],
        row[0] === rows[0] ? columns[0][1] : row[0][1],
        column[0][2],
        row[0] === rows.at(-1) ? columns[0][3] : row[0][3]
      ].map((n) => n / 1.5)
      if (
        !record.advanceComplete ||
        typeof record.r.fontName !== 'string' ||
        !record.r.fontName ||
        !evidence.context.content?.styles?.[record.r.fontName] ||
        record.part.some(
          (p) =>
            p.g.fontName !== record.r.fontName ||
            (!p.g.rendererSkipped && !withinScalarBox(p.g.ink, cell))
        )
      )
        return
    } else if (
      record.part.some(
        (p) =>
          !p.g.rendererSkipped &&
          p.g.ink[0] < frame[2] &&
          p.g.ink[2] > frame[0] &&
          p.g.ink[1] < frame[3] &&
          p.g.ink[3] > frame[1]
      )
    )
      return
  }
  return packet
}

// Recover a missing frame from complete signed scalar records, not raw native
// start counts. Every sign keeps its own explicit font and consecutive origin;
// a separate sign/missing-value/uncertainty lane cannot opt into this family.
export function recoverNativeSignedScalarRecords(table, items, captions, rules, paint, evidence) {
  const frame = table.cropRect,
    valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  if (!valid(frame) || !(paint instanceof Map) || !evidence?.page || !evidence.context) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - frame[0]) < 0.02 &&
        Math.abs(r[2] - frame[2]) < 0.02 &&
        r[1] >= frame[1] &&
        r[1] <= frame[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    Math.abs(full[0][1] - frame[1]) > 0.02 ||
    Math.abs(full[2][1] - frame[3]) > 0.02 ||
    full.some((r) => {
      const p = paint.get(r.join(','))
      return (
        !valid(p) ||
        p[0] > r[0] ||
        p[2] < r[2] ||
        p[1] >= r[1] ||
        p[3] <= r[1] ||
        Math.abs((p[1] + p[3]) / 2 - r[1]) > 0.02
      )
    })
  )
    return
  const owned = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect?.[0] < frame[2] &&
      i.rect[2] > frame[0] &&
      i.rect[1] < frame[3] &&
      i.rect[3] > frame[1]
  )
  if (
    !proveNativeUniqueWholeFonts(owned, items) ||
    owned.some((i) => !withinScalarBox(i.rect, frame))
  )
    return
  const plan = recoverNativeScalarRecordPlan(
    { ...table, structure: { objects: [] } },
    items,
    captions,
    rules
  )
  if (!plan || plan.grid.rows.length < 4) return
  const rows = plan.grid.rows,
    columns = plan.grid.columns,
    header = owned.filter((i) => withinScalarBox(i.rect, rows[0])),
    body = owned.filter((i) => !header.includes(i)),
    height = body.map((i) => i.height).sort((a, b) => a - b)[Math.floor(body.length / 2)]
  if (!(height > 0) || columns.length < 3 || !completeScalarLeafHeaders(header, columns, height))
    return
  const consumed = []
  for (const row of rows.slice(1))
    for (let n = 0; n < columns.length; n++) {
      const cell = body.filter((i) =>
        withinScalarBox(i.rect, [columns[n][0], row[1], columns[n][2], row[3]])
      )
      if (
        !cell.length ||
        (n > 0 && !/^[+−-]?\d+(?:\.\d+)?$/u.test(text(cell.sort((a, b) => a.rect[0] - b.rect[0]))))
      )
        return
      consumed.push(...cell)
    }
  if (
    consumed.length !== body.length ||
    new Set(consumed).size !== body.length ||
    captions.some(
      (c) =>
        c.page === evidence.page.pageNumber &&
        c.rect[0] < frame[2] &&
        c.rect[2] > frame[0] &&
        c.rect[1] < frame[3] &&
        c.rect[3] > frame[1]
    )
  )
    return
  const signs = body.filter((i) => /^[+−-]$/u.test(i.text.trim()))
  if (!signs.length) return
  const packet = completeScalarGlyphSources(owned, rows, columns, evidence)
  if (!packet) return
  for (const sign of signs) {
    const next = body.find((i) => i.sourceItem.index === sign.sourceItem.index + 1),
      a = packet.records.find((r) => r.index === sign.sourceItem.index),
      b = packet.records.find((r) => r.index === sign.sourceItem.index + 1)
    if (
      !next ||
      !a ||
      !b ||
      !/^\d+(?:\.\d+)?$/u.test(next.text) ||
      b.r.sourceItem?.text !== next.text ||
      Math.abs(next.baseline - sign.baseline) > height * 0.04 ||
      next.rect[0] < sign.rect[2] - 0.02 ||
      next.rect[0] - sign.rect[2] > height * 0.22
    )
      return
    const matrices = [a.r.transform, b.r.transform]
    if (
      !matrices.every(
        (m) =>
          Array.isArray(m) &&
          m.length === 6 &&
          m.every(Number.isFinite) &&
          m[0] > 0 &&
          m[1] === 0 &&
          m[2] === 0 &&
          m[3] === m[0]
      ) ||
      Math.abs(matrices[0][0] - matrices[1][0]) > 1e-6 ||
      Math.abs(matrices[0][5] - matrices[1][5]) > 0.02
    )
      return
  }
  return {
    cuts: [...columns.map((c) => c[0]), columns.at(-1)[2]],
    groups: rows.map((r) => owned.filter((i) => withinScalarBox(i.rect, r))),
    consumed: owned
  }
}
