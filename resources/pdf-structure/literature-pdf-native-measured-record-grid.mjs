/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { hasUniqueRecordTokens, readSourceRow } from './literature-pdf-source-records.mjs'

const center = (i) => (i.rect[1] + i.rect[3]) / 2
const scalar = (s) => /^(?:[−–-]|[+−-]?\d+(?:\.\d+)?(?:[%×])?)$/u.test(s.replace(/\s/g, ''))

// Repeated full-width native group boundaries and complete measured baselines
// distinguish independent records even when the model joins them or omits rows.
// The first lane is printed only on the first baseline of each bounded group;
// no label meaning or missing value is used to infer an owner.
export function recoverNativeMeasuredRecordGrid(table, items, captions, rules) {
  const crop = table.cropRect
  const model = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (![4, 7].includes(model.length)) return
  const near = items.filter(
    (i) =>
      i.horizontal !== false &&
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 2 &&
      i.rect[2] < crop[2] + 2
  )
  const h = [...near.map((i) => i.height)].sort((a, b) => a - b)[Math.floor(near.length / 2)]
  if (!(h > 0)) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] >= crop[1] - h &&
        r[1] <= crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 4 ||
    full.length > 12 ||
    full.some(
      (r, n) =>
        n &&
        (r[1] <= full[n - 1][1] ||
          Math.abs(r[0] - full[0][0]) > 0.02 ||
          Math.abs(r[2] - full[0][2]) > 0.02)
    )
  )
    return
  const opening = full[0],
    divider = full[1],
    closing = full.at(-1)
  if (
    divider[1] - opening[1] < h ||
    divider[1] - opening[1] > 3 * h ||
    Math.abs(opening[1] - crop[1]) > h ||
    Math.abs(closing[1] - crop[3]) > h
  )
    return
  const title = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[0] < closing[2] &&
      c.rect[2] > opening[0] &&
      c.rect[3] <= opening[1] &&
      opening[1] - c.rect[3] < 2 * h
  )
  if (title.length !== 1) return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > opening[1] &&
      center(i) < closing[1] &&
      i.rect[0] < closing[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > closing[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  const proposed = [
    opening[0],
    ...model.slice(1).map((c, n) => crop[0] + (model[n].rect[2] + c.rect[0]) / 2),
    closing[2]
  ]
  const owners = proposed
    .slice(1)
    .map((x, n) =>
      source.filter(
        (i) => (i.rect[0] + i.rect[2]) / 2 >= proposed[n] && (i.rect[0] + i.rect[2]) / 2 < x
      )
    )
  if (owners.some((o) => !o.length) || !hasUniqueRecordTokens(source, owners)) return
  const cuts = [opening[0]]
  for (let n = 1; n < owners.length; n++) {
    const left = Math.max(...owners[n - 1].map((i) => i.rect[2])),
      right = Math.min(...owners[n].map((i) => i.rect[0]))
    if (right - left < 0.25 * h) return
    cuts.push((left + right) / 2)
  }
  cuts.push(closing[2])
  const header = source.filter((i) => i.baseline < divider[1])
  if (
    !readSourceRow(header, cuts)?.every((s) => /\p{L}/u.test(s)) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > 0.05 * h)
  )
    return
  const records = [],
    edges = [opening[1], divider[1]],
    spans = []
  for (let g = 1; g < full.length - 1; g++) {
    const group = source.filter((i) => i.baseline > full[g][1] && i.baseline < full[g + 1][1])
    const physical = []
    for (const i of [...group].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const row = physical.at(-1)
      if (row && Math.abs(row[0].baseline - i.baseline) < 0.05 * h) row.push(i)
      else physical.push([i])
    }
    if (physical.length < 2 || physical.length > 30) return
    const first = records.length + 1
    for (let n = 0; n < physical.length; n++) {
      const row = physical[n],
        text = readSourceRow(row, cuts),
        numericStart = model.length === 7 ? 2 : 1
      if (
        !text ||
        !text.slice(numericStart).every(scalar) ||
        (n === 0 ? !/\p{L}/u.test(text[0]) : text[0] !== '') ||
        (model.length === 7 && !/\p{L}/u.test(text[1])) ||
        row.some(
          (i) =>
            i.height !== header[0].height || (i.fontName !== header[0].fontName && !scalar(i.text))
        )
      )
        return
      if (
        n &&
        (row[0].baseline - physical[n - 1][0].baseline < 0.9 * h ||
          row[0].baseline - physical[n - 1][0].baseline > 1.8 * h)
      )
        return
      if (n) {
        const y =
          (Math.max(...physical[n - 1].map((i) => i.rect[3])) +
            Math.min(...row.map((i) => i.rect[1]))) /
          2
        if (
          Math.max(...physical[n - 1].map((i) => i.rect[3])) >=
          Math.min(...row.map((i) => i.rect[1]))
        )
          return
        edges.push(y)
      }
      records.push(row)
    }
    edges.push(full[g + 1][1])
    spans.push({ row: first, column: 0, rowSpan: physical.length, colSpan: 1 })
  }
  if (
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    edges.length !== records.length + 2 ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < closing[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    )
  )
    return
  const nativeCrop = [opening[0], opening[1], closing[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans,
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Native group dividers bound a single centered category and independently
// measured parameter/value baselines. Category placement alone never proves
// a group: all rows and both value lanes must be complete inside every band.
export function recoverNativeGroupedParameterGrid(table, items, captions, rules) {
  const crop = table.cropRect
  const model = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 3) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 2 &&
      i.rect[2] < crop[2] + 2
  )
  const h = [...near.map((i) => i.height)].sort((a, b) => a - b)[Math.floor(near.length / 2)]
  if (!(h > 0)) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 5 ||
    full.length > 12 ||
    full.some(
      (r, n) =>
        n &&
        (r[1] <= full[n - 1][1] ||
          Math.abs(r[0] - full[0][0]) > 0.02 ||
          Math.abs(r[2] - full[0][2]) > 0.02)
    )
  )
    return
  const opening = full[0],
    divider = full[1],
    closing = full.at(-1)
  if (
    divider[1] - opening[1] < h ||
    divider[1] - opening[1] > 3 * h ||
    Math.abs(opening[1] - crop[1]) > h ||
    Math.abs(closing[1] - crop[3]) > h
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < closing[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < 2 * h
    ).length !== 1
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > opening[1] &&
      center(i) < closing[1] &&
      i.rect[0] < closing[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > closing[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  const proposed = [
    opening[0],
    ...model.slice(1).map((c, n) => crop[0] + (model[n].rect[2] + c.rect[0]) / 2),
    closing[2]
  ]
  const lanes = proposed
    .slice(1)
    .map((x, n) =>
      source.filter(
        (i) => (i.rect[0] + i.rect[2]) / 2 >= proposed[n] && (i.rect[0] + i.rect[2]) / 2 < x
      )
    )
  if (lanes.some((l) => !l.length) || !hasUniqueRecordTokens(source, lanes)) return
  const cuts = [opening[0]]
  for (let n = 1; n < lanes.length; n++) {
    const left = Math.max(...lanes[n - 1].map((i) => i.rect[2])),
      right = Math.min(...lanes[n].map((i) => i.rect[0]))
    if (right - left < 0.25 * h) return
    cuts.push((left + right) / 2)
  }
  cuts.push(closing[2])
  const header = source.filter((i) => i.baseline < divider[1]),
    head = readSourceRow(header, cuts)
  if (
    !head ||
    head[0] ||
    !head.slice(1).every((s) => /\p{L}/u.test(s)) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > 0.05 * h)
  )
    return
  const records = [],
    groups = [],
    edges = [opening[1], divider[1]],
    spans = []
  let numeric = 0
  for (let g = 1; g < full.length - 1; g++) {
    const group = source.filter((i) => i.baseline > full[g][1] && i.baseline < full[g + 1][1]),
      stub = group.filter((i) => i.rect[2] <= cuts[1]),
      body = group.filter((i) => i.rect[0] >= cuts[1])
    if (
      stub.length !== 1 ||
      !/\p{L}/u.test(stub[0].text) ||
      !hasUniqueRecordTokens(group, [stub, body]) ||
      group.some((i) => i.rect[1] < full[g][1] || i.rect[3] > full[g + 1][1])
    )
      return
    const physical = []
    for (const i of [...body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const row = physical.at(-1)
      if (row && Math.abs(row[0].baseline - i.baseline) < 0.05 * h) row.push(i)
      else physical.push([i])
    }
    if (physical.length < 2 || physical.length > 16) return
    const first = records.length + 1
    for (let n = 0; n < physical.length; n++) {
      const row = physical[n],
        text = readSourceRow(row, cuts)
      if (
        !text ||
        text[0] ||
        !/\p{L}/u.test(text[1]) ||
        !text[2] ||
        row.some((i) => Math.abs(i.height - h) > 0.02 * h) ||
        row.some((i) => Math.abs(i.baseline - row[0].baseline) > 0.05 * h)
      )
        return
      if (/^[+−-]?\d[\d,.]*(?:e[+−-]?\d+|[A-Za-z])?$/u.test(text[2])) numeric++
      if (n) {
        const previous = physical[n - 1],
          gap = row[0].baseline - previous[0].baseline
        if (gap < 0.9 * h || gap > 1.8 * h) return
        const upper = Math.max(...previous.map((i) => i.rect[3])),
          lower = Math.min(...row.map((i) => i.rect[1]))
        if (upper >= lower) return
        edges.push((upper + lower) / 2)
      }
      records.push(row)
    }
    groups.push(stub)
    edges.push(full[g + 1][1])
    spans.push({ row: first, column: 0, rowSpan: physical.length, colSpan: 1 })
  }
  if (
    numeric < records.length * 0.65 ||
    !hasUniqueRecordTokens(source, [header, ...records, ...groups]) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < closing[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    )
  )
    return
  const nativeCrop = [opening[0], opening[1], closing[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans,
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// A three-lane formula glossary has a native full-width border for every
// record, plus several short fraction bars confined to its formula lane.
// Formula font boxes may cross a border; their centers still have one face.
export function recoverNativeRuledFormulaGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 3) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 2 &&
      i.rect[2] < crop[2] + 2
  )
  const h = [...near.map((i) => i.height)].sort((a, b) => a - b)[Math.floor(near.length / 2)]
  if (!(h > 0)) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 6 ||
    full.length > 20 ||
    full.some(
      (r, n) =>
        n &&
        (r[1] <= full[n - 1][1] ||
          Math.abs(r[0] - full[0][0]) > 0.02 ||
          Math.abs(r[2] - full[0][2]) > 0.02)
    )
  )
    return
  const opening = full[0],
    closing = full.at(-1)
  if (
    Math.abs(opening[1] - crop[1]) > h ||
    Math.abs(closing[1] - crop[3]) > h ||
    full.some((r, n) => n && (r[1] - full[n - 1][1] < 1.5 * h || r[1] - full[n - 1][1] > 4 * h))
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < closing[2] &&
        c.rect[2] > opening[0] &&
        ((c.rect[3] <= opening[1] && opening[1] - c.rect[3] < 2 * h) ||
          (c.rect[1] >= closing[1] && c.rect[1] - closing[1] < 2 * h))
    ).length !== 1
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > opening[1] &&
      center(i) < closing[1] &&
      i.rect[0] < closing[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > closing[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  const cuts = [
    opening[0],
    ...model.slice(1).map((c, n) => crop[0] + (model[n].rect[2] + c.rect[0]) / 2),
    closing[2]
  ]
  const faces = full
    .slice(1)
    .map((r, n) => source.filter((i) => center(i) > full[n][1] && center(i) < r[1]))
  const header = faces[0],
    head = readSourceRow(header, cuts)
  if (
    !head?.every((s) => /\p{L}/u.test(s)) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > 0.05 * h) ||
    !hasUniqueRecordTokens(source, faces)
  )
    return
  let fractions = 0
  for (let n = 1; n < faces.length; n++) {
    const face = faces[n],
      lanes = cuts
        .slice(1)
        .map((x, c) => face.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x))
    if (
      lanes.some((l) => !l.length) ||
      !hasUniqueRecordTokens(face, lanes) ||
      lanes[0].every((i) => !/[\p{L}\p{S}]/u.test(i.text)) ||
      lanes[1].length !== 1 ||
      !/\p{L}.*\p{L}/u.test(lanes[1][0].text) ||
      lanes[2].length < 3 ||
      face.some(
        (i) =>
          i.rect[1] < full[n][1] - i.height * 0.4 || i.rect[3] > full[n + 1][1] + i.height * 0.4
      )
    )
      return
    const short = rules.filter(
      (r) =>
        r[1] === r[3] &&
        r[0] >= cuts[2] &&
        r[2] <= cuts[3] &&
        r[2] - r[0] >= h * 0.4 &&
        r[2] - r[0] < h * 6 &&
        r[1] > full[n][1] &&
        r[1] < full[n + 1][1] &&
        lanes[2].some((i) => i.baseline < r[1]) &&
        lanes[2].some((i) => i.baseline > r[1])
    )
    if (short.length === 1) fractions++
  }
  if (
    fractions < 3 ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < closing[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    )
  )
    return
  const nativeCrop = [opening[0], opening[1], closing[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: full.slice(1).map((r, n) => [nativeCrop[0], full[n][1], nativeCrop[2], r[1]]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
