/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'

// Repeated indexed records can contain attached numeric subscripts whose font
// boxes slightly overlap the next normal line. Their literal baselines and
// unique preceding stems prove ownership; an overlapping normal line cannot.
function scriptedRecordBounds(header, records, cuts, h) {
  if (cuts.length !== 4 || header.length !== 3 || records.length < 3) return
  const indices = []
  for (const record of records) {
    const normal = record.filter((i) => Math.abs(i.height - h) < h * 0.04)
    const scripts = record.filter((i) => Math.abs(i.height - h) >= h * 0.04)
    const lanes = cuts
      .slice(1)
      .map((x, n) => normal.filter((i) => i.rect[0] >= cuts[n] && i.rect[2] <= x))
    if (
      normal.length !== 5 ||
      scripts.length !== 4 ||
      lanes[0].length !== 1 ||
      lanes[1].length !== 2 ||
      lanes[2].length !== 2 ||
      !/^\d+$/.test(lanes[0][0].text.trim())
    )
      return
    indices.push(Number(lanes[0][0].text.trim()))
    if (normal.some((i) => Math.abs(i.baseline - normal[0].baseline) > h * 0.04)) return
    const stems = [...lanes[1], ...lanes[2]]
    if (stems.some((i) => !/^\p{L}+$/u.test(i.text.trim()))) return
    const owners = new Set()
    for (const script of scripts) {
      const offset = script.baseline - normal[0].baseline
      if (
        script.height < h * 0.55 ||
        script.height > h * 0.8 ||
        offset < h * 0.1 ||
        offset > h * 0.3 ||
        !/^\d+(?:\.\d+)?\(\d+\)$/.test(script.text.trim())
      )
        return
      const matches = stems.filter(
        (stem) =>
          Math.abs(stem.rect[2] - script.rect[0]) <= h * 0.04 &&
          cuts.slice(1).some((x, n) => stem.rect[0] >= cuts[n] && script.rect[2] <= x)
      )
      if (matches.length !== 1 || owners.has(matches[0])) return
      owners.add(matches[0])
    }
    if (owners.size !== 4) return
  }
  if (indices.some((v, n) => !Number.isSafeInteger(v) || (n && v !== indices[n - 1] + 1))) return
  const groups = [header, ...records]
  for (let n = 1; n < groups.length; n++) {
    const previous = groups[n - 1],
      current = groups[n]
    const normalPrevious = previous.filter((i) => Math.abs(i.height - h) < h * 0.04)
    const normalCurrent = current.filter((i) => Math.abs(i.height - h) < h * 0.04)
    if (
      Math.max(...normalPrevious.map((i) => i.rect[3])) >=
      Math.min(...normalCurrent.map((i) => i.rect[1]))
    )
      return
    const overlap =
      Math.max(...previous.map((i) => i.rect[3])) - Math.min(...current.map((i) => i.rect[1]))
    if (overlap > h * 0.02) return
    if (n === 1 && overlap > 0) return
  }
  return groups.map((row) => [
    Math.min(...row.map((i) => i.rect[1])),
    Math.max(...row.map((i) => i.rect[3]))
  ])
}

// An independently printed stub starts a record only when every value lane
// has a source item on the same baseline. Stub-free continuation lines retain
// the previous record; scripts must have a unique nearby normal baseline.
export function recoverNativeTextRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect
  const model = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length < 2 || model.length > 6) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
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
        Math.abs(r[0] - crop[0]) < h * 1.5 &&
        r[2] - r[0] >= (crop[2] - crop[0]) * 0.9 &&
        r[2] - r[0] <= (crop[2] - crop[0]) * 1.5
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 3 ||
    full.length > 16 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.05 || Math.abs(r[2] - full[0][2]) > 0.05)
  )
    return
  const opening = full[0],
    divider = full.find((r) => r[1] - opening[1] >= h * 0.6)
  const doubleStroke =
    full.length === 5 &&
    full[1][1] - opening[1] > 0 &&
    full[1][1] - opening[1] < h * 0.3 &&
    Math.abs(full.at(-1)[1] - full.at(-2)[1] - (full[1][1] - opening[1])) < 0.05
  const closing = doubleStroke ? full.at(-2) : full.at(-1)
  if (!divider || divider === closing) return
  if (doubleStroke && near.some((i) => i.baseline > closing[1] && i.baseline < full.at(-1)[1]))
    return
  const groupRules = full.filter((r) => r[1] > divider[1] && r[1] < closing[1])
  if (
    divider[1] - opening[1] < h * 0.6 ||
    divider[1] - opening[1] > h * 2.5 ||
    closing[1] - divider[1] < h * 3
  )
    return
  if (
    !captions.some(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < h * 8) ||
          (c.rect[1] >= closing[1] - h * 0.2 && c.rect[1] - closing[1] < h * 8))
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0] &&
      i.baseline > opening[1] &&
      i.baseline < closing[1]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        !Number.isFinite(i.baseline) ||
        i.rect.some((v) => !Number.isFinite(v)) ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1] ||
        i.height < h * 0.55 ||
        i.height > h * 1.04
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  const mainHeader = header.filter((i) => Math.abs(i.height - h) < h * 0.04)
  if (
    mainHeader.length < 2 ||
    mainHeader.length > 4 ||
    mainHeader.some((i) => Math.abs(i.baseline - mainHeader[0].baseline) > h * 0.04)
  )
    return
  mainHeader.sort((a, b) => a.rect[0] - b.rect[0])
  // A missing leading title is not proof that its body lanes disappear.
  if (mainHeader[0].rect[0] - opening[0] > h * 2) return
  const cuts = [opening[0]],
    rough = [
      opening[0],
      ...mainHeader.slice(1).map((i, n) => (mainHeader[n].rect[2] + i.rect[0]) / 2),
      opening[2]
    ]
  const physical = []
  for (const item of body
    .filter((i) => Math.abs(i.height - h) < h * 0.04)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = physical.at(-1)
    if (row && Math.abs(row[0].baseline - item.baseline) < h * 0.04) row.push(item)
    else physical.push([item])
  }
  if (physical.length < 3 || physical.length > 80) return
  for (const item of source.filter((i) => Math.abs(i.height - h) >= h * 0.04)) {
    const owners =
      item.baseline < divider[1]
        ? [header]
        : physical.filter((r) => Math.abs(r[0].baseline - item.baseline) < h * 0.45)
    if (owners.length !== 1) return
    if (owners[0] !== header) owners[0].push(item)
  }
  for (let n = 1; n < mainHeader.length; n++) {
    let a = mainHeader[n - 1].rect[2],
      b = mainHeader[n].rect[0]
    for (const row of physical) {
      const left = row.filter((i) => (i.rect[0] + i.rect[2]) / 2 < rough[n]),
        right = row.filter((i) => (i.rect[0] + i.rect[2]) / 2 >= rough[n])
      if (left.length) a = Math.max(a, ...left.map((i) => i.rect[2]))
      if (right.length) b = Math.min(b, ...right.map((i) => i.rect[0]))
    }
    if (b - a < h * 0.15) return
    cuts.push((a + b) / 2)
  }
  cuts.push(opening[2])
  const records = []
  for (const row of physical) {
    if (
      mainHeader.length !== model.length &&
      cuts
        .slice(1)
        .some(
          (x, n) =>
            n > 0 &&
            row.filter(
              (i) =>
                i.rect[0] >= cuts[n] &&
                i.rect[2] <= x &&
                /^[−+-]?\d+(?:\.\d+)?$/.test(i.text.trim())
            ).length > 1
        )
    )
      return
    const values = readSourceRow(row, cuts)
    if (
      !values ||
      row.some((i) => !cuts.slice(1).some((x, n) => i.rect[0] >= cuts[n] && i.rect[2] <= x))
    )
      return
    if (values[0].trim()) {
      if (values.some((s) => !s.trim())) return
      records.push([...row])
    } else {
      if (!records.length || row[0].baseline - records.at(-1).at(-1).baseline > h * 2) return
      records.at(-1).push(...row)
    }
  }
  if (
    records.length < 3 ||
    !readSourceRow(header, cuts)?.every((s) => s.trim()) ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  // Ruled prose faces may contain several physical lines of one record.
  // Parameter/value groups instead prove independent complete pairs on every
  // baseline, with at least two pairs in each native band and ink-free dividers.
  if (groupRules.length) {
    if (
      mainHeader.length !== 2 ||
      !/^(?:hyper)?parameters?$/i.test(mainHeader[0].text.trim()) ||
      !/^values?$/i.test(mainHeader[1].text.trim()) ||
      records.length !== physical.length ||
      physical.some((row) => {
        const values = readSourceRow(row, cuts)
        return !values || !/\p{L}/u.test(values[0]) || !/[\p{L}\d]/u.test(values[1])
      }) ||
      physical.filter((row) => /\d/.test(readSourceRow(row, cuts)[1])).length <
        Math.ceil(physical.length / 2) ||
      groupRules.some((rule) => body.some((i) => i.rect[1] <= rule[1] && i.rect[3] >= rule[1]))
    )
      return
    const bounds = [divider[1], ...groupRules.map((r) => r[1]), closing[1]]
    if (
      bounds
        .slice(1)
        .some(
          (bottom, n) =>
            physical.filter((row) => row[0].baseline > bounds[n] && row[0].baseline < bottom)
              .length < 2
        )
    )
      return
  }
  if (
    records.some(
      (r) =>
        new Set(
          r
            .filter((i) => Math.abs(i.height - h) < h * 0.04)
            .map((i) => Math.round(i.baseline / (h * 0.04)))
        ).size > 3
    )
  )
    return
  if (table.structure.objects.filter((o) => o.label === 'table row').length === records.length + 1)
    return
  if (
    full
      .filter((r) => r[1] > divider[1] && r[1] < closing[1])
      .some((r) => body.some((i) => i.rect[1] < r[1] && i.rect[3] > r[1]))
  )
    return
  const scriptBounds = scriptedRecordBounds(header, records, cuts, h)
  if (
    scriptBounds &&
    items.some(
      (i) =>
        i.text?.trim() &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        i.rect[1] < full.at(-1)[1] &&
        i.rect[3] > opening[1] &&
        !source.includes(i)
    )
  )
    return
  const edges = [Math.min(...header.map((i) => i.rect[1])), divider[1]]
  for (let n = 1; n < records.length; n++) {
    const a = Math.max(...records[n - 1].map((i) => i.rect[3])),
      b = Math.min(...records[n].map((i) => i.rect[1]))
    if (b - a < h * 0.04 && !scriptBounds) return
    edges.push((a + b) / 2)
  }
  edges.push(Math.max(...body.map((i) => i.rect[3])))
  const rect = [
    Math.min(crop[0], opening[0] - 0.5),
    Math.min(crop[1], opening[1] - 0.5),
    Math.max(crop[2], opening[2] + 0.5),
    Math.max(crop[3], closing[1] + 0.5)
  ]
  return {
    cropRect: rect,
    rows: scriptBounds
      ? scriptBounds.map(([top, bottom]) => [rect[0], top, rect[2], bottom])
      : edges.slice(1).map((y, n) => [rect[0], edges[n], rect[2], y]),
    columns: cuts
      .slice(1)
      .map((x, n) => [
        n ? cuts[n] : rect[0],
        rect[1],
        n === cuts.length - 2 ? rect[2] : x,
        rect[3]
      ]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
