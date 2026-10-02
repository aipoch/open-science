/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'
const center = (i) => (i.rect[1] + i.rect[3]) / 2

// A separate bracketed-reference lane and complete measured anchors witness
// wrapped records. Empty optional measurements remain empty; no field is filled.
export function recoverNativeCitedMeasurementGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 7) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 2 &&
      i.rect[2] < crop[2] + 2
  )
  const h = Math.max(...near.map((i) => i.height))
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
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full
  if (
    divider[1] - opening[1] < h ||
    divider[1] - opening[1] > 4 * h ||
    Math.abs(closing[1] - crop[3]) > h
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < 3 * h
    ).length !== 1
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > opening[1] &&
      center(i) < closing[1] &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        (i.rect[1] < opening[1] &&
          !(i.baseline < divider[1] && i.rect[1] >= opening[1] - h * 0.2)) ||
        i.rect[3] > closing[1]
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1]),
    ref = header.filter((i) => /^Ref\.$/i.test(i.text.trim()))
  if (ref.length !== 1 || ref[0].rect[0] < crop[0] + (crop[2] - crop[0]) * 0.85) return
  const proposed = [
    opening[0],
    ...model.slice(1).map((c, n) => crop[0] + (model[n].rect[2] + c.rect[0]) / 2),
    ref[0].rect[0] - h * 0.5,
    opening[2]
  ]
  if (proposed.some((x, n) => n && x <= proposed[n - 1])) return
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
    if (right - left < h * 0.25) return
    cuts.push((left + right) / 2)
  }
  cuts.push(opening[2])
  if (!readSourceRow(header, cuts, { multiline: true })?.every((s) => /\p{L}/u.test(s))) return
  const anchors = lanes[0].filter((i) => body.includes(i)).sort((a, b) => a.baseline - b.baseline)
  if (
    anchors.length < 6 ||
    anchors.length > 30 ||
    anchors.some(
      (i) => !/^[a-z0-9]+-\d+$/i.test(i.text.trim()) || Math.abs(i.height - h) > h * 0.02
    ) ||
    anchors.some((i, n) => n && i.baseline - anchors[n - 1].baseline < h * 1.5)
  )
    return
  const records = anchors.map(() => [])
  for (const i of body) {
    const ranked = anchors
      .map((a, n) => ({ n, gap: Math.abs(i.baseline - a.baseline) }))
      .sort((a, b) => a.gap - b.gap)
    if (
      ranked[0].gap > h * 1.3 ||
      ranked[1].gap - ranked[0].gap < h * 0.05 ||
      i.height < h * 0.65 ||
      i.height > h * 1.02
    )
      return
    records[ranked[0].n].push(i)
  }
  for (let n = 0; n < records.length; n++) {
    const row = records[n],
      a = anchors[n],
      fields = cuts
        .slice(1)
        .map((x, k) => row.filter((i) => i.rect[0] >= cuts[k] && i.rect[2] <= x))
    if (
      !hasUniqueRecordTokens(
        row,
        fields.filter((f) => f.length)
      ) ||
      fields[0].length !== 1 ||
      !fields[1].length ||
      !fields[2].length ||
      !fields[6].length ||
      fields[7].length !== 1 ||
      !/^\[\d{1,4}\]$/.test(fields[7][0].text)
    )
      return
    if (
      [4, 5, 7].some(
        (k) =>
          fields[k].length !== 1 ||
          Math.abs(fields[k][0].baseline - a.baseline) > h * 0.05 ||
          Math.abs(fields[k][0].height - h) > h * 0.02
      ) ||
      [4, 5].some((k) => !/^(?:[+-]|\u2212)?\d+(?:\.\d+)?$/.test(fields[k][0].text)) ||
      fields[3].some(
        (i) => !/^\d+(?:\.\d+)?$/.test(i.text) || Math.abs(i.baseline - a.baseline) > h * 0.05
      )
    )
      return
    if (
      n &&
      Math.min(...row.map((i) => i.rect[1])) <= Math.max(...records[n - 1].map((i) => i.rect[3]))
    )
      return
  }
  if (
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    )
  )
    return
  const top = Math.min(opening[1], ...header.map((i) => i.rect[1])),
    edges = [
      top,
      divider[1],
      ...records
        .slice(1)
        .map(
          (row, n) =>
            (Math.max(...records[n].map((i) => i.rect[3])) +
              Math.min(...row.map((i) => i.rect[1]))) /
            2
        ),
      closing[1]
    ]
  if (
    items.some(
      (i) =>
        !source.includes(i) &&
        i.text?.trim() &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        center(i) >= top &&
        center(i) < opening[1]
    )
  )
    return
  const nativeCrop = [opening[0], top, opening[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Repeated native vertical segments prove five technical lanes and each
// physical row, including a narrow fixed-parameter lane omitted by the model.
export function recoverNativeSegmentedScientificGrid(table, items, captions, rules) {
  const crop = table.cropRect
  if (![4, 5].includes(table.structure.objects.filter((o) => o.label === 'table column').length))
    return
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
  const horizontal = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h
    )
    .sort((a, b) => a[1] - b[1])
  const vertical = rules.filter(
    (r) => r[0] === r[2] && r[0] > crop[0] && r[0] < crop[2] && r[1] > crop[1] && r[3] < crop[3]
  )
  const xs = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
  if (xs.length !== 4 || horizontal.length < 3 || horizontal.length > 4) return
  const bands = vertical.filter((r) => r[0] === xs[0]).sort((a, b) => a[1] - b[1])
  if (bands.length < 4 || bands.length > 14) return
  if (
    xs.some((x) => {
      const segments = vertical.filter((r) => r[0] === x).sort((a, b) => a[1] - b[1])
      return (
        segments.length !== bands.length ||
        segments.some(
          (r, n) => Math.abs(r[1] - bands[n][1]) > 0.02 || Math.abs(r[3] - bands[n][3]) > 0.02
        )
      )
    })
  )
    return
  const opening = horizontal.find(
    (r) => r[1] < bands[0][1] && bands[0][1] - r[1] < h * 0.08 && r[1] > bands[0][1] - h * 0.08
  )
  const divider = horizontal.find((r) => r[1] > bands[0][3] && r[1] < bands[1][1])
  const closing = horizontal.find(
    (r) => r[1] > bands.at(-1)[3] && r[1] - bands.at(-1)[3] < h * 0.08
  )
  if (
    !opening ||
    !divider ||
    !closing ||
    horizontal.some(
      (r) =>
        Math.abs(r[0] - opening[0]) > 0.02 ||
        Math.abs(r[2] - opening[2]) > 0.02 ||
        (r !== opening &&
          r !== divider &&
          r !== closing &&
          !(r[1] < opening[1] && opening[1] - r[1] < h * 0.3))
    )
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
        c.rect[2] > opening[0] &&
        c.rect[3] <= opening[1] &&
        opening[1] - c.rect[3] < h * 2
    ).length !== 1
  )
    return
  if (
    bands.some(
      (r, n) =>
        r[3] - r[1] < h ||
        r[3] - r[1] > h * 2.5 ||
        (n && r[1] - bands[n - 1][3] < -0.02) ||
        (n && r[1] - bands[n - 1][3] > h * 0.1)
    )
  )
    return
  const edges = [opening[1], divider[1], ...bands.slice(1, -1).map((r) => r[3]), closing[1]],
    cuts = [opening[0], ...xs, opening[2]]
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > opening[1] &&
      center(i) < closing[1] &&
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        i.rect[1] < opening[1] ||
        i.rect[3] > closing[1]
    )
  )
    return
  const faces = edges
    .slice(1)
    .map((y, n) => source.filter((i) => center(i) > edges[n] && center(i) < y))
  if (
    !hasUniqueRecordTokens(source, faces) ||
    !readSourceRow(faces[0], cuts, { multiline: true })?.every((s) => /\p{L}/u.test(s))
  )
    return
  for (const face of faces.slice(1)) {
    const text = readSourceRow(face, cuts, { multiline: true }),
      main = face.filter((i) => i.height >= h * 0.95)
    if (
      !text ||
      !/\d.*\p{L}/u.test(text[0]) ||
      !text.slice(1).every((s) => /^(?:[−–-]|[<>≤≥+−\d.×±-]+)$/u.test(s)) ||
      !main.length ||
      main.some((i) => Math.abs(i.baseline - main[0].baseline) > h * 0.05) ||
      face.some(
        (i) =>
          i.height < h * 0.95 &&
          (i.height < h * 0.55 ||
            i.height > h * 0.8 ||
            main[0].baseline - i.baseline < h * 0.15 ||
            main[0].baseline - i.baseline > h * 0.65)
      )
    )
      return
  }
  const nativeCrop = [opening[0], opening[1], opening[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Two independent integer lanes anchor a wrapped narrative record. Its
// continuation is bounded by the next complete stub/count/count baseline,
// not by a model row or a sentence-ending guess.
export function recoverNativeWrappedCountNarrativeGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 4) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 4 &&
      i.rect[2] < crop[2] + 4
  )
  const h = Math.max(...near.map((i) => i.height))
  if (!(h > 0)) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < 3 * h
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full
  if (divider[1] - opening[1] < h || divider[1] - opening[1] > 3 * h) return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
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
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        (i.rect[1] < opening[1] &&
          !(i.baseline < divider[1] && i.rect[1] >= opening[1] - h * 0.2)) ||
        i.rect[3] > closing[1]
    )
  )
    return
  const proposed = [
    opening[0],
    ...model.slice(1).map((c, n) => crop[0] + (model[n].rect[2] + c.rect[0]) / 2),
    opening[2]
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
    if (right - left < h * 0.25) return
    cuts.push((left + right) / 2)
  }
  cuts.push(opening[2])
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  if (!readSourceRow(header, cuts, { multiline: true })?.every((s) => /\p{L}/u.test(s))) return
  const counts = body.filter((i) => i.rect[0] >= cuts[1] && i.rect[2] <= cuts[2]),
    ends = body.filter((i) => i.rect[0] >= cuts[3])
  if (
    counts.length < 3 ||
    counts.length > 30 ||
    ends.length !== counts.length ||
    [...counts, ...ends].some((i) => !/^\d+$/.test(i.text) || Math.abs(i.height - h) > h * 0.02)
  )
    return
  const anchors = [...counts].sort((a, b) => a.baseline - b.baseline),
    records = []
  for (let n = 0; n < anchors.length; n++) {
    const a = anchors[n],
      end = ends.filter((i) => Math.abs(i.baseline - a.baseline) < h * 0.05)
    const stub = body.filter(
      (i) => i.rect[2] <= cuts[1] && Math.abs(i.baseline - a.baseline) < h * 0.05
    )
    if (
      end.length !== 1 ||
      !stub.length ||
      !stub.some((i) => /\p{L}/u.test(i.text)) ||
      stub.some((i) => Math.abs(i.height - h) > h * 0.02)
    )
      return
    const start = n ? (anchors[n - 1].baseline + a.baseline) / 2 : divider[1]
    const next = anchors[n + 1]
    const narrative = body.filter(
      (i) =>
        i.rect[0] >= cuts[2] &&
        i.rect[2] <= cuts[3] &&
        i.baseline >= a.baseline - h * 0.05 &&
        (!next || i.baseline < next.baseline - h * 0.05)
    )
    if (
      !narrative.length ||
      !narrative.some((i) => /\p{L}/u.test(i.text)) ||
      narrative.some((i) => Math.abs(i.height - h) > h * 0.02)
    )
      return
    const lines = []
    for (const i of [...narrative].sort((a, b) => a.baseline - b.baseline)) {
      if (!lines.some((y) => Math.abs(y - i.baseline) < h * 0.05)) lines.push(i.baseline)
    }
    if (
      Math.abs(lines[0] - a.baseline) > h * 0.05 ||
      lines.some((y, n) => n && (y - lines[n - 1] < h * 0.9 || y - lines[n - 1] > h * 1.6))
    )
      return
    const record = [...stub, a, end[0], ...narrative]
    if (
      n &&
      Math.min(...record.map((i) => i.rect[1])) < Math.max(...records[n - 1].map((i) => i.rect[3]))
    )
      return
    if (Math.min(...record.map((i) => i.rect[1])) < start - h) return
    records.push(record)
  }
  if (
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    )
  )
    return
  const top = Math.min(opening[1], ...header.map((i) => i.rect[1]))
  if (
    items.some(
      (i) =>
        !source.includes(i) &&
        i.text?.trim() &&
        i.rect[2] > opening[0] &&
        i.rect[0] < opening[2] &&
        center(i) >= top &&
        center(i) < opening[1]
    )
  )
    return
  const edges = [
      top,
      divider[1],
      ...records
        .slice(1)
        .map(
          (record, n) =>
            (Math.max(...records[n].map((i) => i.rect[3])) +
              Math.min(...record.map((i) => i.rect[1]))) /
            2
        ),
      closing[1]
    ],
    nativeCrop = [opening[0], top, opening[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// A captioned symbol/definition table has repeated complete short symbolic
// stubs. Main-font stub baselines identify records; smaller adjoining formula
// glyphs stay with their uniquely nearest record, without decoding meanings.
export function recoverNativeSymbolDefinitionGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 2) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] >= crop[0] - 2 &&
      i.rect[2] < crop[2] + 2
  )
  const h = Math.max(...near.map((i) => i.height))
  if (!(h > 0)) return
  const full = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > crop[1] - h &&
        r[1] < crop[3] + h &&
        Math.abs(r[0] - crop[0]) < h &&
        r[2] >= crop[2] - h &&
        r[2] - crop[2] < (crop[2] - crop[0]) * 0.12
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return
  const [opening, divider, closing] = full
  if (
    divider[1] - opening[1] < h ||
    divider[1] - opening[1] > 2 * h ||
    Math.abs(closing[1] - crop[3]) > h
  )
    return
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[0] < opening[2] &&
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
      i.rect[0] < opening[2] &&
      i.rect[2] > opening[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        i.rect[0] < opening[0] ||
        i.rect[2] > opening[2] ||
        (i.rect[1] < opening[1] &&
          !(i.baseline < divider[1] && i.rect[1] > opening[1] - h * 0.2)) ||
        i.rect[3] > closing[1]
    )
  )
    return
  const proposed = crop[0] + (model[0].rect[2] + model[1].rect[0]) / 2
  const left = source.filter((i) => (i.rect[0] + i.rect[2]) / 2 < proposed),
    right = source.filter((i) => !left.includes(i))
  if (!left.length || !right.length || !hasUniqueRecordTokens(source, [left, right])) return
  const l = Math.max(...left.map((i) => i.rect[2])),
    r = Math.min(...right.map((i) => i.rect[0]))
  if (r - l < h * 0.5) return
  const cuts = [opening[0], (l + r) / 2, opening[2]],
    header = source.filter((i) => i.baseline < divider[1]),
    head = readSourceRow(header, cuts)
  if (
    !head ||
    !/^Symbol$/i.test(head[0]) ||
    !/^(?:Meaning|Definition)$/i.test(head[1]) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.05)
  )
    return
  const body = source.filter((i) => !header.includes(i)),
    stubs = left.filter((i) => body.includes(i) && i.height >= h * 0.95)
  const anchors = []
  for (const i of stubs.sort((a, b) => a.baseline - b.baseline)) {
    if (!anchors.some((y) => Math.abs(y - i.baseline) < h * 0.05)) anchors.push(i.baseline)
  }
  if (
    anchors.length < 8 ||
    anchors.length > 40 ||
    anchors.some((y, n) => n && (y - anchors[n - 1] < h * 1.1 || y - anchors[n - 1] > h * 1.5))
  )
    return
  const records = anchors.map(() => [])
  for (const i of body) {
    const ranked = anchors
      .map((y, n) => ({ n, gap: Math.abs(i.baseline - y) }))
      .sort((a, b) => a.gap - b.gap)
    if (
      ranked[0].gap > h * 0.65 ||
      ranked[1].gap - ranked[0].gap < h * 0.05 ||
      i.height < h * 0.65 ||
      i.height > h * 1.02 ||
      (i.height >= h * 0.95 && ranked[0].gap > h * 0.05)
    )
      return
    records[ranked[0].n].push(i)
  }
  if (
    records.some((row) => {
      const a = row.filter((i) => i.rect[2] <= cuts[1]),
        b = row.filter((i) => i.rect[0] >= cuts[1])
      return (
        !a.length ||
        !b.length ||
        a.map((i) => i.text).join('').length > 35 ||
        !b.some((i) => /\p{L}/u.test(i.text)) ||
        !hasUniqueRecordTokens(row, [a, b])
      )
    }) ||
    records.filter((row) => row.some((i) => i.height < h * 0.8)).length < 3 ||
    !hasUniqueRecordTokens(source, [header, ...records]) ||
    rules.some(
      (r) =>
        r[0] === r[2] &&
        r[0] > opening[0] &&
        r[0] < opening[2] &&
        r[1] < closing[1] &&
        r[3] > opening[1]
    )
  )
    return
  for (const row of records)
    for (const lane of [
      row.filter((i) => i.rect[2] <= cuts[1]),
      row.filter((i) => i.rect[0] >= cuts[1])
    ]) {
      const witnessed = new Set(lane.filter((i) => i.height >= h * 0.95))
      for (const i of [...lane]
        .filter((i) => i.height < h * 0.95)
        .sort((a, b) => a.rect[0] - b.rect[0])) {
        const anchor = [...witnessed].some(
          (a) =>
            i.rect[0] - a.rect[2] >= -i.height * 0.05 &&
            i.rect[0] - a.rect[2] < h * 0.6 &&
            ((a.height >= h * 0.95 && Math.abs(i.baseline - a.baseline) > h * 0.08) ||
              (Math.abs(a.height - i.height) < h * 0.02 &&
                Math.abs(i.baseline - a.baseline) < h * 0.05))
        )
        if (!anchor) return
        witnessed.add(i)
      }
    }
  const top = Math.min(opening[1], ...header.map((i) => i.rect[1])),
    edges = [
      top,
      divider[1],
      ...records
        .slice(1)
        .map((row, n) => (Math.max(...records[n].map(center)) + Math.min(...row.map(center))) / 2),
      closing[1]
    ]
  if (
    records.some((row, n) =>
      row.some((i) => center(i) <= edges[n + 1] || center(i) >= edges[n + 2])
    )
  )
    return
  const nativeCrop = [opening[0], top, opening[2], closing[1]]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], nativeCrop[1], x, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    nativeSymbolicRecords: true,
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// This recovers the body of an already predicted small configuration table.
// A header divider and repeated native stub-divider faces witness every row;
// three complete text fields are required on each independent baseline.
export function recoverNativeConfigurationGrid(table, items, captions, rules) {
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (model.length !== 3 || !table.structure.objects.some((o) => o.label === 'table')) return
  const near = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > crop[1] &&
      center(i) < crop[3] &&
      i.rect[0] > crop[0] - 2 &&
      i.rect[2] < crop[2] + 20
  )
  const h = Math.max(...near.map((i) => i.height))
  if (!(h > 0)) return
  const horizontal = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[1] > crop[1] &&
      r[1] < crop[3] &&
      Math.abs(r[0] - crop[0]) < h &&
      Math.abs(r[2] - crop[2]) < h
  )
  const vertical = rules
    .filter(
      (r) => r[0] === r[2] && r[0] > crop[0] && r[0] < crop[2] && r[1] > crop[1] && r[3] < crop[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    horizontal.length !== 1 ||
    vertical.length < 4 ||
    vertical.length > 9 ||
    vertical.some((r) => Math.abs(r[0] - vertical[0][0]) > 0.02)
  )
    return
  const divider = horizontal[0],
    x = vertical[0][0]
  if (
    Math.abs(vertical[0][3] - divider[1]) > h * 0.08 ||
    Math.abs(vertical[1][1] - divider[1]) > h * 0.08 ||
    vertical.some(
      (r, n) =>
        r[3] - r[1] < h ||
        r[3] - r[1] > h * 2 ||
        (n && (r[1] - vertical[n - 1][3] < -0.02 || r[1] - vertical[n - 1][3] > h * 0.1))
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.text?.trim() &&
      center(i) > vertical[0][1] &&
      center(i) < vertical.at(-1)[3] &&
      i.rect[0] < divider[2] &&
      i.rect[2] > divider[0]
  )
  if (
    source.some(
      (i) =>
        i.horizontal === false ||
        Math.abs(i.height - h) > h * 0.02 ||
        i.rect[0] < divider[0] ||
        i.rect[2] > divider[2] ||
        i.rect[1] < vertical[0][1] - h * 0.3 ||
        i.rect[3] > vertical.at(-1)[3]
    )
  )
    return
  const header = source.filter((i) => i.baseline < divider[1]),
    body = source.filter((i) => i.baseline > divider[1])
  const cut = crop[0] + (model[1].rect[2] + model[2].rect[0]) / 2,
    left = source.filter((i) => i.rect[0] >= x && (i.rect[0] + i.rect[2]) / 2 < cut),
    right = source.filter((i) => (i.rect[0] + i.rect[2]) / 2 >= cut)
  if (!left.length || !right.length) return
  const a = Math.max(...left.map((i) => i.rect[2])),
    b = Math.min(...right.map((i) => i.rect[0]))
  if (b - a < h * 0.25) return
  const cuts = [divider[0], x, (a + b) / 2, divider[2]],
    head = readSourceRow(header, cuts)?.map((s) => s.replace(/\s+/g, ''))
  if (
    !head ||
    !/^Configuration$/i.test(head[0]) ||
    !/^Local\p{L}+$/iu.test(head[1]) ||
    !/^Global\p{L}+$/iu.test(head[2]) ||
    head[1].slice(5).toLowerCase() !== head[2].slice(6).toLowerCase() ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.05)
  )
    return
  const records = []
  for (const i of [...body].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = records.at(-1)
    if (row && Math.abs(row[0].baseline - i.baseline) < h * 0.05) row.push(i)
    else records.push([i])
  }
  if (
    records.length !== vertical.length - 1 ||
    records.some((row, n) => {
      const text = readSourceRow(row, cuts)
      return (
        !text?.every((s) => /\p{L}/u.test(s)) ||
        row.some((i) => center(i) <= vertical[n + 1][1] || center(i) >= vertical[n + 1][3]) ||
        (n &&
          Math.abs(
            row[0].baseline -
              records[n - 1][0].baseline -
              (records[1][0].baseline - records[0][0].baseline)
          ) >
            h * 0.05)
      )
    }) ||
    !hasUniqueRecordTokens(source, [header, ...records])
  )
    return
  const nativeCrop = [
    Math.min(crop[0], divider[0]),
    Math.min(crop[1], ...header.map((i) => i.rect[1])),
    Math.max(crop[2], divider[2]),
    vertical.at(-1)[3]
  ]
  if (
    items.some(
      (i) =>
        i.text?.trim() &&
        !source.includes(i) &&
        center(i) > nativeCrop[1] &&
        center(i) < nativeCrop[3] &&
        i.rect[0] < nativeCrop[2] &&
        i.rect[2] > nativeCrop[0]
    )
  )
    return
  const edges = [
    nativeCrop[1],
    divider[1],
    ...vertical.slice(1, -1).map((r) => r[3]),
    nativeCrop[3]
  ]
  return {
    cropRect: nativeCrop,
    rows: edges.slice(1).map((y, n) => [nativeCrop[0], edges[n], nativeCrop[2], y]),
    columns: cuts.slice(1).map((p, n) => [cuts[n], nativeCrop[1], p, nativeCrop[3]]),
    spans: [],
    headerRows: [0],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}
