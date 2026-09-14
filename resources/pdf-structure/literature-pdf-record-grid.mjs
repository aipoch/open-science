/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Treatment schedules have two columns, with full-width regimen/cycle notes.
// Recover only when repeated dose lines establish one clear gutter; retain the
// source spelling of units and numbers, including uncertain OCR characters.
export function recoverTreatmentScheduleGrid(table, items, captions) {
  if (!captions.some((c) => /^Table\s/i.test(c.lines[0]))) return undefined
  const [left, top, right, bottom] = table.cropRect
  const groups = []
  for (const item of [...items].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    if (!item.horizontal) return undefined
    const group = groups.find(
      (g) => Math.abs(g[0].baseline - item.baseline) < Math.max(g[0].height, item.height) * 0.35
    )
    if (group) group.push(item)
    else groups.push([item])
  }
  const lines = groups.map((g) => {
    g.sort((a, b) => a.rect[0] - b.rect[0])
    return {
      items: g,
      text: g.map((i) => i.text).join(' '),
      rect: [
        left,
        Math.min(...g.map((i) => i.rect[1])),
        right,
        Math.max(...g.map((i) => i.rect[3]))
      ]
    }
  })
  const regimen = (l) => /^[A-Z][A-Z /+-]* regimen$/.test(l.text)
  if (lines.filter(regimen).length < 2 || !regimen(lines[0])) return undefined
  const doseLines = lines.filter(
    (l) =>
      /^[A-Za-z0-9-]+$/.test(l.items[0].text) &&
      l.items.length > 1 &&
      /^[\dI]/.test(l.items[1].text) &&
      /\bm\s*g\b/.test(l.text) &&
      /\b(?:orally|intravenously)\b/.test(l.text)
  )
  if (doseLines.length < 4) return undefined
  const endStub = Math.max(...doseLines.map((l) => l.items[0].rect[2]))
  const startDose = Math.min(...doseLines.map((l) => l.items[1].rect[0]))
  if (
    startDose <= endStub ||
    endStub < left + (right - left) * 0.15 ||
    startDose > left + (right - left) * 0.6
  )
    return undefined
  const cut = (endStub + startDose) / 2
  if (doseLines.some((l) => l.items.slice(1).some((i) => i.rect[0] < cut))) return undefined
  const records = []
  let inNote = false
  for (const line of lines) {
    const previous = records.at(-1)
    if (regimen(line)) {
      inNote = false
      records.push({ ...line, section: true, origin: 'source-text' })
    } else if (doseLines.includes(line)) {
      inNote = false
      records.push({ ...line, numericRecord: true, origin: 'source-text' })
    } else if (/^Duration of cycle\s+\d/.test(line.text)) {
      inNote = true
      records.push({ ...line, section: true, scheduleNote: true, origin: 'source-text' })
    } else if (
      previous &&
      line.rect[1] - previous.rect[3] <= line.items[0].height &&
      (inNote || (previous.numericRecord && line.items.every((i) => i.rect[0] > cut)))
    ) {
      previous.rect[3] = line.rect[3]
    } else return undefined
  }
  if (records.filter((r) => r.section && !regimen(r)).length < 2) return undefined
  return {
    columns: [{ rect: [left, top, cut, bottom] }, { rect: [cut, top, right, bottom] }],
    records,
    start: top
  }
}

// Graded adverse-event counts have a stub and repeated treatment headings.
// Reconstruct only complete count rows; missing source values remain unresolved.
export function recoverGradedCountGrid(table, items, captions) {
  if (!captions.some((c) => /^Table\s/i.test(c.lines[0]))) return undefined
  const [left, top, right, bottom] = table.cropRect
  const grades = items.filter((i) => /^Degree(?:\s+[1-4])?$/.test(i.text.trim()))
  if (grades.length < 6) return undefined
  const first = Math.min(...grades.map((i) => i.rect[1]))
  const headings = items
    .filter((i) => i.text.trim() === 'regimen' && i.baseline < first)
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (headings.length !== 2 || Math.abs(headings[0].baseline - headings[1].baseline) > 2)
    return undefined
  const start = Math.max(...headings.map((i) => i.baseline)) + 1
  const cut = (headings[0].rect[2] + headings[1].rect[0]) / 2
  const stubEnd = (Math.max(...grades.map((i) => i.rect[2])) + headings[0].rect[0]) / 2
  const column = (i) =>
    (i.rect[0] + i.rect[2]) / 2 < stubEnd ? 0 : (i.rect[0] + i.rect[2]) / 2 < cut ? 1 : 2
  const body = items.filter((i) => i.horizontal && i.baseline > start)
  const groups = []
  for (const i of body.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const g = groups.find(
      (g) => Math.abs(g[0].baseline - i.baseline) < Math.max(g[0].height, i.height) * 0.4
    )
    if (g) g.push(i)
    else groups.push([i])
  }
  const records = []
  let counts = 0
  for (const g of groups) {
    const cells = [0, 1, 2].map((c) =>
      g
        .filter((i) => column(i) === c)
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join(' ')
        .trim()
    )
    const numericRecord = Boolean(
      cells[0] && cells.slice(1).every((s) => /^(?:\d[\d ]*|[-–—])$/.test(s))
    )
    const section = Boolean(
      /^[A-Za-z][A-Za-z .-]*$/.test(cells[0]) && cells.slice(1).every((s) => !s)
    )
    if (!numericRecord && !section) return undefined
    if (numericRecord) counts++
    records.push({
      rect: [
        left,
        Math.min(...g.map((i) => i.rect[1])),
        right,
        Math.max(...g.map((i) => i.rect[3]))
      ],
      numericRecord,
      section,
      origin: 'source-text'
    })
  }
  if (counts < 8 || records.filter((r) => r.section).length < 2) return undefined
  const bounds = [left, stubEnd, cut, right]
  if (items.some((i) => i.rect[0] < bounds[column(i)] || i.rect[2] > bounds[column(i) + 1]))
    return undefined
  return {
    columns: bounds.slice(1).map((x, c) => ({ rect: [bounds[c], top, x, bottom] })),
    records,
    start,
    header: { rect: [left, top, right, start], origin: 'source-text' }
  }
}

// Repeated estimate/interval headings provide stable anchors for dense tables.
// Accept only complete records inside the ruled body, with no token crossing a
// recovered gutter; an ambiguous record leaves the model result untouched.
export function recoverRepeatedIntervalGrid(table, items, captions, rules) {
  if (!captions.some((c) => /^Table\s/i.test(c.lines[0]))) return undefined
  const [left, top, right, bottom] = table.cropRect
  const interval = items.find((i) => i.horizontal && i.text.trim() === '95% CI')
  if (!interval) return undefined
  const header = items
    .filter(
      (i) =>
        i.horizontal &&
        /^(?:HR|Ratio|95% CI)$/.test(i.text.trim()) &&
        Math.abs(i.baseline - interval.baseline) <= 2
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    header.length < 8 ||
    header.length % 2 ||
    header.some((i, c) =>
      c % 2 ? i.text.trim() !== '95% CI' : !/^(?:HR|Ratio)$/.test(i.text.trim())
    ) ||
    Math.max(...header.map((i) => i.baseline)) - Math.min(...header.map((i) => i.baseline)) > 2
  )
    return undefined
  const fullRules = rules.filter(
    (r) => r[1] === r[3] && Math.min(right, r[2]) - Math.max(left, r[0]) > (right - left) * 0.9
  )
  const start = fullRules
    .filter((r) => r[1] >= header[0].baseline && r[1] - header[0].baseline < header[0].height * 2)
    .sort((a, b) => a[1] - b[1])[0]?.[1]
  const end = fullRules
    .filter((r) => r[1] > start && r[1] <= bottom + 2)
    .sort((a, b) => b[1] - a[1])[0]?.[1]
  if (start === undefined || end === undefined) return undefined
  const centers = header.map((i) => (i.rect[0] + i.rect[2]) / 2)
  const body = items.filter((i) => i.horizontal && i.baseline > start && i.baseline < end)
  const parts = [[], ...header.map((i) => [i])]
  const columnOf = (i) => {
    const x = (i.rect[0] + i.rect[2]) / 2
    if (x < centers[0] - (centers[1] - centers[0]) / 2) return 0
    return (
      centers.reduce(
        (best, center, c) => (Math.abs(center - x) < Math.abs(centers[best] - x) ? c : best),
        0
      ) + 1
    )
  }
  for (const i of body) parts[columnOf(i)].push(i)
  if (!parts[0].length) return undefined
  const cuts = parts
    .slice(1)
    .map(
      (part, c) =>
        (Math.max(...parts[c].map((i) => i.rect[2])) + Math.min(...part.map((i) => i.rect[0]))) / 2
    )
  if (
    parts.some((part, c) =>
      part.some((i) => (c && i.rect[0] < cuts[c - 1]) || (c < cuts.length && i.rect[2] > cuts[c]))
    )
  )
    return undefined
  const groups = []
  for (const item of body.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = groups.find(
      (g) => Math.abs(g[0].baseline - item.baseline) < Math.max(g[0].height, item.height) * 0.35
    )
    if (group) group.push(item)
    else groups.push([item])
  }
  // Raised section-note markers belong to the adjacent stub, not a new row.
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index]
    if (!group.every((i) => columnOf(i) === 0 && /^[a-z*†‡]$/.test(i.text))) continue
    const owners = groups.filter(
      (other, j) =>
        Math.abs(index - j) === 1 &&
        group.every((i) =>
          other.some(
            (anchor) =>
              columnOf(anchor) === 0 &&
              i.height < anchor.height * 0.8 &&
              anchor.baseline - i.baseline > anchor.height * 0.08 &&
              anchor.baseline - i.baseline < anchor.height * 0.5 &&
              i.rect[0] - anchor.rect[2] >= -anchor.height * 0.1 &&
              i.rect[0] - anchor.rect[2] <= anchor.height * 0.35
          )
        )
    )
    if (owners.length !== 1) continue
    owners[0].push(...group)
    groups.splice(index, 1)
  }
  let count = 0
  const records = groups.map((group) => {
    const cells = parts.map((_, c) =>
      group
        .filter((i) => columnOf(i) === c)
        .map((i) => i.text)
        .join(' ')
        .trim()
    )
    const numeric =
      cells[0] &&
      cells
        .slice(1)
        .every((text, c) =>
          c % 2 ? /^\d+(?:\.\d+)?,\s*\d+(?:\.\d+)?$/.test(text) : /^\d+(?:\.\d+)?$/.test(text)
        )
    const section = cells[0] && cells.slice(1).every((text) => !text)
    if (numeric) count++
    return {
      rect: [
        left,
        Math.min(...group.map((i) => i.rect[1])),
        right,
        Math.max(...group.map((i) => i.rect[3]))
      ],
      numericRecord: !!numeric,
      section: !!section,
      origin: 'source-text'
    }
  })
  if (count < 6 || records.some((r) => !r.numericRecord && !r.section)) return undefined
  const bounds = [left, ...cuts, right]
  return {
    columns: parts.map((_, c) => ({ rect: [bounds[c], top, bounds[c + 1], bottom] })),
    records,
    start
  }
}

// Review tables can contain one study spanning several named groups. Their ruled
// header and group/count column provide stronger boundaries than individual model
// row predictions. Keep this recovery limited to that explicit source structure.
export function recoverRecordGrid(table, items, captions, rules) {
  if (!captions.some((c) => /^Table\s/i.test(c.lines[0]))) return undefined
  const [left, top, right, bottom] = table.cropRect
  const horizontal = rules
    .filter(
      ([x0, y0, x1, y1]) =>
        Math.abs(y1 - y0) < 1 && x1 - x0 > (right - left) * 0.85 && y0 >= top - 2 && y0 < top + 90
    )
    .sort((a, b) => a[1] - b[1])
  if (horizontal.length < 2) return undefined
  const headerTop = horizontal[0][1],
    headerBottom = horizontal[1][1]
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= headerTop &&
      i.baseline <= bottom
  )
  const header = source.filter((i) => i.baseline < headerBottom)
  const clusters = []
  for (const item of header.sort((a, b) => a.rect[0] - b.rect[0])) {
    const cluster = clusters.find(
      (c) => Math.min(c.right, item.rect[2]) > Math.max(c.left, item.rect[0])
    )
    if (cluster) {
      cluster.items.push(item)
      cluster.left = Math.min(cluster.left, item.rect[0])
      cluster.right = Math.max(cluster.right, item.rect[2])
    } else clusters.push({ left: item.rect[0], right: item.rect[2], items: [item] })
  }
  clusters.sort((a, b) => a.left - b.left)
  const labels = clusters.map((c) =>
    c.items
      .sort((a, b) => a.baseline - b.baseline)
      .map((i) => i.text)
      .join(' ')
  )
  if (
    clusters.length < 6 ||
    clusters.length > 10 ||
    !/^Sequencing type \(Basis\)$/i.test(labels[0]) ||
    !/^Group name \(N\)$/i.test(labels[1]) ||
    !/^\(Refs?\.\)$/i.test(labels.at(-1))
  )
    return undefined
  let cuts = clusters.slice(1).map((c, i) => (clusters[i].right + c.left) / 2)
  const columnOf = (item) => {
    const center = (item.rect[0] + item.rect[2]) / 2
    const index = cuts.findIndex((cut) => center < cut)
    return index < 0 ? cuts.length : index
  }
  const body = source.filter((i) => i.rect[1] >= headerBottom)
  const anchors = []
  for (const item of body) {
    let anchor = anchors.find((a) => Math.abs(a.x - item.rect[0]) < 1)
    if (!anchor) anchors.push((anchor = { x: item.rect[0], votes: new Map() }))
    const c = columnOf(item)
    anchor.votes.set(c, (anchor.votes.get(c) ?? 0) + 1)
  }
  const bodyColumn = (item) =>
    [...anchors.find((a) => Math.abs(a.x - item.rect[0]) < 1).votes].sort(
      (a, b) => b[1] - a[1]
    )[0][0]
  // Refine each gutter against whole source tokens, including empty body columns
  // whose only evidence is the header. Reject crossing text instead of guessing.
  const parts = clusters.map((cluster, c) => [
    ...cluster.items,
    ...body.filter((i) => bodyColumn(i) === c)
  ])
  cuts = parts
    .slice(1)
    .map(
      (part, c) =>
        (Math.max(...parts[c].map((i) => i.rect[2])) + Math.min(...part.map((i) => i.rect[0]))) / 2
    )
  if (
    parts.some((part, c) =>
      part.some((i) => (c && i.rect[0] < cuts[c - 1]) || (c < cuts.length && i.rect[2] > cuts[c]))
    )
  )
    return undefined
  const lines = []
  for (const item of body
    .filter((i) => columnOf(i) === 1)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    let line = lines.at(-1)
    if (!line || Math.abs(line.baseline - item.baseline) > item.height * 0.35) {
      line = { baseline: item.baseline, top: item.rect[1], height: item.height, items: [] }
      lines.push(line)
    }
    line.items.push(item)
  }
  const records = []
  for (const line of lines) {
    const previous = records.at(-1)
    const previousText = previous?.lines
      .at(-1)
      .items.map((i) => i.text)
      .join(' ')
    const gap = previous ? line.baseline - previous.lines.at(-1).baseline : Infinity
    if (!previous || /\(\d+\)\s*$/.test(previousText) || gap > line.height * 1.6) {
      records.push({ top: line.top, lines: [line] })
    } else previous.lines.push(line)
  }
  if (records.length < 2) return undefined
  const bounds = [left, ...cuts, right]
  const end = Math.max(...body.map((i) => i.baseline)) + 0.5
  const rows = [
    [left, headerTop, right, headerBottom],
    ...records.map((r, i) => [
      left,
      r.top - 0.5,
      right,
      records[i + 1] ? records[i + 1].top - 0.5 : end
    ])
  ]
  const columns = clusters.map((_, c) => [bounds[c], headerTop, bounds[c + 1], end])
  const spans = []
  // Study labels wrap independently of the group rows. A gap between their
  // source lines starts another study; extend the label only to that study's end.
  const studies = []
  for (const item of body
    .filter((i) => columnOf(i) === 0)
    .sort((a, b) => a.baseline - b.baseline)) {
    const previous = studies.at(-1)
    if (!previous || item.baseline - previous.at(-1).baseline > item.height * 1.6)
      studies.push([item])
    else previous.push(item)
  }
  const rowAt = (y) =>
    Math.max(
      1,
      rows.findIndex((r) => y >= r[1] && y < r[3])
    )
  const studyRows = studies.map((s) => rowAt(s[0].baseline))
  for (const [i, row] of studyRows.entries()) {
    const stop = studyRows[i + 1] ?? rows.length
    if (stop - row > 1) spans.push({ column: 0, row, rowSpan: stop - row })
  }
  const citations = [
    ...new Set(body.filter((i) => columnOf(i) === columns.length - 1).map((i) => rowAt(i.baseline)))
  ]
  for (const [i, row] of citations.entries()) {
    const stop = Math.min(
      citations[i + 1] ?? rows.length,
      studyRows.find((r) => r > row) ?? rows.length
    )
    if (stop - row > 1) spans.push({ column: columns.length - 1, row, rowSpan: stop - row })
  }
  return { rows, columns, spans }
}

// Centered value columns can be duplicated by the model. Repeated complete
// numeric rows and enclosing rules provide independent column evidence.
export function recoverCenteredValueGrid(table, items, captions, rules) {
  if (!captions.some((c) => /^Table\s/i.test(c.lines[0]))) return undefined
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    !predicted.some(
      (o, i) =>
        i &&
        predicted[i - 1].rect[2] - o.rect[0] >
          Math.min(o.rect[2] - o.rect[0], predicted[i - 1].rect[2] - predicted[i - 1].rect[0]) *
            0.25
    )
  )
    return undefined
  const horizontal = rules
    .filter(
      (r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom && r[2] - r[0] >= (right - left) * 0.9
    )
    .sort((a, b) => a[1] - b[1])
  if (horizontal.length !== 3) return undefined
  const groups = []
  for (const item of [...items].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    if (!item.horizontal) return undefined
    const group = groups.find((g) => Math.abs(g[0].baseline - item.baseline) <= item.height * 0.3)
    if (group) group.push(item)
    else groups.push([item])
  }
  const center = (i) => (i.rect[0] + i.rect[2]) / 2
  const number = (i) => /^(?:[–−-]|\d+(?:\.\d+)?(?:\s*±\s*\d+(?:\.\d+)?)?)$/.test(i.text.trim())
  const complete = groups.filter(
    (g) =>
      g[0].rect[1] > horizontal[1][1] && g.length === 4 && !number(g[0]) && g.slice(1).every(number)
  )
  if (complete.length < 6) return undefined
  const centers = complete[0].slice(1).map(center)
  if (
    centers.some((x, i) => i && x - centers[i - 1] < 30) ||
    complete.some((g) =>
      g.slice(1).some((item, c) => Math.abs(center(item) - centers[c]) > item.height * 0.5)
    )
  )
    return undefined
  const stubEnd = Math.max(...complete.map((g) => g[0].rect[2])),
    valueStart = Math.min(...complete.map((g) => g[1].rect[0]))
  if (valueStart - stubEnd < 12) return undefined
  const cuts = [
    left,
    (stubEnd + valueStart) / 2,
    ...centers.slice(1).map((x, i) => (x + centers[i]) / 2),
    right
  ]
  const header = items.filter((i) => i.rect[1] > horizontal[0][1] && i.rect[3] < horizontal[1][1])
  if (
    !header.length ||
    centers.some(
      (x) => !header.some((i) => /\p{L}/u.test(i.text) && Math.abs(center(i) - x) < i.height)
    )
  )
    return undefined
  const body = groups.filter((g) => g[0].rect[1] > horizontal[1][1])
  const records = [],
    spans = []
  for (const group of body) {
    const rect = [
      left,
      Math.min(...group.map((i) => i.rect[1])),
      right,
      Math.max(...group.map((i) => i.rect[3]))
    ]
    const values = group.filter((i) => i.rect[0] > cuts[1]),
      stub = group.filter((i) => i.rect[2] <= cuts[1])
    if (!stub.length || group.length !== values.length + stub.length) return undefined
    let pair = -1
    if (values.length === 1) {
      if (!/^[\d(]/.test(values[0].text)) return undefined
      pair = centers
        .slice(1)
        .findIndex(
          (x, i) => Math.abs(center(values[0]) - (x + centers[i]) / 2) < values[0].height * 0.6
        )
      if (pair < 0) return undefined
    } else if (values.length && (values.length !== 3 || !values.every(number))) return undefined
    const previous = records.at(-1)
    if (
      pair >= 0 &&
      previous?.section &&
      /^\(/.test(stub[0].text) &&
      rect[1] - previous.rect[3] < stub[0].height
    ) {
      previous.rect[3] = rect[3]
      previous.section = false
      previous.numericRecord = true
      spans.push({ row: records.length, column: pair + 1, colSpan: 2 })
    } else {
      records.push({
        rect,
        origin: 'source-text',
        section: !values.length,
        numericRecord: !!values.length
      })
      if (pair >= 0) spans.push({ row: records.length, column: pair + 1, colSpan: 2 })
    }
  }
  return {
    columns: cuts.slice(1).map((x, c) => ({ rect: [cuts[c], top, x, bottom] })),
    header: { rect: [left, horizontal[0][1], right, horizontal[1][1]], origin: 'source-header' },
    records,
    spans,
    start: top
  }
}

// A probability sweep supplies its own columns and repeated record blocks even
// when scanned OCR boxes overlap vertically. Require complete numeric records.
export function recoverThresholdSweepGrid(table, pageItems) {
  const [left, top, right, bottom] = table.cropRect
  const models = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (models.length < 8) return undefined
  const centers = models.map((c) => left + (c.rect[0] + c.rect[2]) / 2)
  const xs = [left, ...centers.slice(1).map((x, i) => (x + centers[i]) / 2), right]
  const columnOf = (i) =>
    xs.findIndex(
      (x, c) =>
        c < xs.length - 1 &&
        (i.rect[0] + i.rect[2]) / 2 >= x &&
        (i.rect[0] + i.rect[2]) / 2 < xs[c + 1]
    )
  const items = pageItems.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= top &&
      i.rect[3] <= bottom
  )
  const values = items.filter((i) => columnOf(i) >= 3 && /^(?:0\.\d|1\.0)$/.test(i.text))
  if (values.length !== models.length - 3) return undefined
  values.sort((a, b) => columnOf(a) - columnOf(b))
  if (
    values.some(
      (v, c) =>
        columnOf(v) !== c + 3 ||
        Math.abs(Number(v.text) - c / (values.length - 1)) > 0.0001 ||
        Math.abs(v.baseline - values[0].baseline) > v.height * 0.25
    )
  )
    return undefined
  const parent = items.filter(
    (i) => columnOf(i) >= 3 && i.baseline < values[0].baseline - i.height * 0.5
  )
  if (
    parent.length < 1 ||
    !parent.every((i) => /^[A-Za-z ]+$/.test(i.text)) ||
    parent.map((i) => i.text).join(' ').length < 10
  )
    return undefined
  const body = items.filter((i) => i.baseline > values[0].baseline + values[0].height * 0.5)
  const groups = []
  for (const item of body.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const group = groups.find((g) => Math.abs(g[0].baseline - item.baseline) < item.height * 0.25)
    if (group) group.push(item)
    else groups.push([item])
  }
  groups.forEach((g) => g.sort((a, b) => a.rect[0] - b.rect[0]))
  const section = (g) => /^Threshold\s+P\s*=\s*0\.\d+$/.test(g.map((i) => i.text).join(' '))
  const sections = groups.flatMap((g, r) => (section(g) ? [r] : []))
  if (sections.length < 2 || sections[0] !== 0) return undefined
  const spans = [
    { row: 0, column: 3, rowSpan: 1, colSpan: values.length },
    ...[0, 1, 2].map((column) => ({ row: 0, column, rowSpan: 2, colSpan: 1 }))
  ]
  let pattern
  for (const [index, start] of sections.entries()) {
    const end = sections[index + 1] ?? groups.length,
      records = groups.slice(start + 1, end)
    if (records.length < 6 || records.length % 3) return undefined
    spans.push({ row: start + 2, column: 3, rowSpan: 1, colSpan: values.length })
    for (let r = 0; r < records.length; r++) {
      const g = records[r]
      if (
        values.some(
          (_, c) => g.filter((i) => columnOf(i) === c + 3 && /^\d+$/.test(i.text)).length !== 1
        )
      )
        return undefined
      const label = g
        .filter((i) => columnOf(i) === 2)
        .map((i) => i.text)
        .join(' ')
      if (!label || !/[A-Za-z]/.test(label)) return undefined
      if (r < 3 && !pattern) continue
      if (pattern && label !== pattern[r % 3]) return undefined
    }
    const current = records.slice(0, 3).map((g) =>
      g
        .filter((i) => columnOf(i) === 2)
        .map((i) => i.text)
        .join(' ')
    )
    if (new Set(current).size !== 3) return undefined
    pattern ??= current
    for (let r = 0; r < records.length; r += 3) {
      for (let c = 0; c < 2; c++) {
        if (
          records[r].filter((i) => columnOf(i) === c && /^\d+$/.test(i.text)).length !== 1 ||
          records.slice(r + 1, r + 3).some((g) => g.some((i) => columnOf(i) === c))
        )
          return undefined
        spans.push({ row: start + 3 + r, column: c, rowSpan: 3, colSpan: 1 })
      }
      if (
        records.slice(r, r + 3).some(
          (g, j) =>
            g
              .filter((i) => columnOf(i) === 2)
              .map((i) => i.text)
              .join(' ') !== pattern[j]
        )
      )
        return undefined
    }
  }
  const mid = (g) => g.reduce((sum, i) => sum + (i.rect[1] + i.rect[3]) / 2, 0) / g.length
  const ys = [mid(parent), mid(values), ...groups.map(mid)]
  if (ys.some((y, i) => i && y <= ys[i - 1])) return undefined
  const cuts = [
    Math.min(
      ...items
        .filter((i) => i.baseline <= values[0].baseline + i.height * 0.25)
        .map((i) => i.rect[1])
    ),
    ...ys.slice(1).map((y, i) => (y + ys[i]) / 2),
    bottom
  ]
  return {
    columns: xs.slice(1).map((x, c) => [xs[c], top, x, bottom]),
    rows: cuts.slice(1).map((y, r) => [left, cuts[r], right, y]),
    spans,
    completeSpans: true
  }
}

// Repeated-measures tables have independent time/value rows but share the
// outcome and effect statistics. Use their ruled frame and repeated time labels
// instead of splitting a shared statistic at each printed baseline.
export function recoverFollowupGrid(table, items, captions, rules) {
  if (!captions.some((c) => /^Table\s/i.test(c.lines[0]))) return undefined
  const [left, top, right, bottom] = table.cropRect
  const frame = rules
    .filter(
      (r) =>
        Math.abs(r[1] - r[3]) < 0.1 &&
        r[2] - r[0] > (right - left) * 0.9 &&
        r[1] >= top &&
        r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length !== 3) return undefined
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= frame[0][1] &&
      i.baseline <= frame[2][1]
  )
  const header = source.filter((i) => i.baseline < frame[1][1])
  const first = header.find((i) => i.text === 'Outcome')
  if (!first) return undefined
  const leads = header
    .filter((i) => Math.abs(i.baseline - first.baseline) < first.height * 0.3)
    .sort((a, b) => a.rect[0] - b.rect[0])
  const clusters = []
  for (const item of leads) {
    if (!clusters.length || item.rect[0] - clusters.at(-1).at(-1).rect[2] > first.height * 1.5)
      clusters.push([])
    clusters.at(-1).push(item)
  }
  if (
    clusters.length !== 7 ||
    clusters[1].map((i) => i.text).join(' ') !== 'Time' ||
    !header.some((i) => /effect/.test(i.text))
  )
    return undefined
  let cuts = clusters.slice(1).map((g, c) => (g[0].rect[0] + clusters[c].at(-1).rect[2]) / 2)
  const col = (i) => {
    const n = cuts.findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    return n < 0 ? 7 - 1 : n
  }
  const body = source.filter((i) => i.rect[1] >= frame[1][1])
  const times = body.filter((i) => col(i) === 1).sort((a, b) => a.baseline - b.baseline)
  if (
    times.length < 3 ||
    !times.every((i) => /^(?:Baseline|Post[- ]clinic|\d+ months?)$/i.test(i.text.trim()))
  )
    return undefined
  const boundaries = [
    frame[1][1],
    ...times.slice(1).map((i, n) => (times[n].baseline + i.rect[1]) / 2),
    frame[2][1]
  ]
  const rows = [
    [left, frame[0][1], right, frame[1][1]],
    ...times.map((_, n) => [left, boundaries[n], right, boundaries[n + 1]])
  ]
  const rowAt = (i) =>
    rows.findIndex((r) => (i.rect[1] + i.rect[3]) / 2 >= r[1] && (i.rect[1] + i.rect[3]) / 2 < r[3])
  for (let r = 1; r < rows.length; r++)
    for (const c of [2, 3]) {
      const text = body
        .filter((i) => col(i) === c && rowAt(i) === r)
        .map((i) => i.text)
        .join(' ')
      if (!/^[\d.]+\s*±\s*[\d.]+$/.test(text)) return undefined
    }
  const starts = times.map((i, n) => (/^Baseline$/i.test(i.text) ? n + 1 : 0)).filter(Boolean)
  if (starts[0] !== 1) return undefined
  const spans = []
  for (const [n, start] of starts.entries()) {
    const end = starts[n + 1] ?? rows.length
    for (const c of [0, 4, 5, 6]) {
      const content = body.filter((i) => col(i) === c && rowAt(i) >= start && rowAt(i) < end)
      if (!content.length || (c > 0 && content.some((i) => rowAt(i) !== start))) return undefined
      if (end - start > 1) spans.push({ row: start, column: c, rowSpan: end - start, colSpan: 1 })
    }
  }
  const parts = clusters.map((_, c) => source.filter((i) => col(i) === c))
  cuts = parts
    .slice(1)
    .map(
      (part, c) =>
        (Math.max(...parts[c].map((i) => i.rect[2])) + Math.min(...part.map((i) => i.rect[0]))) / 2
    )
  const bounds = [left, ...cuts, right]
  if (source.some((i) => i.rect[0] < bounds[col(i)] - 0.5 || i.rect[2] > bounds[col(i) + 1] + 0.5))
    return undefined
  return {
    rows,
    columns: bounds.slice(1).map((x, c) => [bounds[c], frame[0][1], x, frame[2][1]]),
    spans,
    completeSpans: true
  }
}

// In repeated baseline/follow-up summaries, sample-size columns are centered
// against multiline statistics. Their shared baselines establish the records.
export function recoverLongitudinalSummaryGrid(table, items, captions, rules) {
  if (!captions.some((c) => /^Table\s/i.test(c.lines[0]))) return undefined
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 12) return undefined
  const cuts = predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2)
  const bounds = [left, ...cuts, right]
  const col = (i) => {
    const n = cuts.findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    return n < 0 ? 11 : n
  }
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= top &&
      i.baseline <= bottom
  )
  const nHeaders = source
    .filter((i) => i.text.trim() === 'n')
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  if (
    nHeaders.length !== 4 ||
    nHeaders.map(col).join(',') !== '1,3,6,8' ||
    nHeaders.some((i) => Math.abs(i.baseline - nHeaders[0].baseline) > i.height * 0.3)
  )
    return undefined
  const lines = rules
    .filter(
      (r) =>
        Math.abs(r[1] - r[3]) < 0.1 &&
        r[2] - r[0] > (right - left) * 0.9 &&
        r[1] >= top &&
        r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  const before = lines.filter((r) => r[1] < nHeaders[0].rect[1]),
    after = lines.filter((r) => r[1] > nHeaders[0].baseline)
  if (before.length !== 2 || after.length < 2) return undefined
  const header = source.filter((i) => i.rect[1] >= before[1][1] && i.baseline < after[0][1])
  const labels = predicted.map((_, c) =>
    header
      .filter((i) => col(i) === c)
      .sort((a, b) => a.baseline - b.baseline)
      .map((i) => i.text)
      .join(' ')
      .replace(/[-\s]/g, '')
      .toLowerCase()
  )
  if (
    labels.slice(1, 6).join(',') !== 'n,baseline,n,postintervention,change' ||
    labels.slice(6, 11).join(',') !== 'n,baseline,n,postintervention,change'
  )
    return undefined
  const body = source.filter((i) => i.rect[1] >= after[0][1] && i.baseline <= after.at(-1)[1])
  const anchors = body.filter((i) => col(i) === 1).sort((a, b) => a.baseline - b.baseline)
  if (anchors.length < 4 || anchors.some((i) => !/^\d+$/.test(i.text))) return undefined
  const ys = [
    after[0][1],
    ...anchors.slice(1).map((i, n) => (i.rect[1] + anchors[n].baseline) / 2),
    after.at(-1)[1]
  ]
  const rows = [
    [left, before[0][1], right, before[1][1]],
    [left, before[1][1], right, after[0][1]],
    ...anchors.map((_, n) => [left, ys[n], right, ys[n + 1]])
  ]
  const rowAt = (i) =>
    rows.findIndex((r) => (i.rect[1] + i.rect[3]) / 2 >= r[1] && (i.rect[1] + i.rect[3]) / 2 < r[3])
  for (let r = 2; r < rows.length; r++)
    for (let c = 0; c < 12; c++) {
      const part = body.filter((i) => col(i) === c && rowAt(i) === r)
      if (!part.length || part.some((i) => i.rect[1] < rows[r][1] || i.rect[3] > rows[r][3]))
        return undefined
      if (c > 0 && !/^[\d.,()–−+%\s-]+$/.test(part.map((i) => i.text).join(' '))) return undefined
    }
  const parent = source.filter((i) => i.rect[1] >= before[0][1] && i.baseline < before[1][1])
  const spans = [
    { row: 0, column: 1, rowSpan: 1, colSpan: 5 },
    { row: 0, column: 6, rowSpan: 1, colSpan: 5 }
  ]
  if (
    parent.filter((i) => i.rect[0] >= bounds[1] && i.rect[2] <= bounds[6]).length !== 1 ||
    parent.filter((i) => i.rect[0] >= bounds[6] && i.rect[2] <= bounds[11]).length !== 1
  )
    return undefined
  return {
    rows,
    columns: bounds.slice(1).map((x, c) => [bounds[c], before[0][1], x, after.at(-1)[1]]),
    spans,
    completeSpans: true
  }
}

// Questionnaire tables separate verbal scale endpoints from the counts below.
// Ruled question groups own both lines; the five numeric columns stay distinct.
export function recoverResponseScaleGrid(table, items, captions, rules) {
  if (!captions.some((c) => /^Table\s/i.test(c.lines[0]))) return undefined
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 6) return undefined
  const cuts = predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2)
  const bounds = [left, ...cuts, right],
    col = (i) => {
      const n = cuts.findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
      return n < 0 ? 5 : n
    }
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= top &&
      i.baseline <= bottom
  )
  const frame = rules
    .filter(
      (r) => r[1] === r[3] && r[2] - r[0] > (right - left) * 0.9 && r[1] >= top && r[1] <= bottom
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length < 4) return undefined
  const header = source.filter((i) => i.baseline < frame[1][1])
  if (
    header.length !== 2 ||
    header
      .map((i) => i.text.trim())
      .sort()
      .join(',') !== 'Question,Responses'
  )
    return undefined
  const rows = [[left, frame[0][1], right, frame[1][1]]],
    spans = [{ row: 0, column: 1, rowSpan: 1, colSpan: 5 }]
  for (let n = 1; n < frame.length - 1; n++) {
    const block = source.filter((i) => i.rect[1] >= frame[n][1] && i.baseline < frame[n + 1][1])
    const counts = block
      .filter((i) => col(i) > 0 && /^\d+$/.test(i.text))
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      counts.length !== 5 ||
      counts.some(
        (i, c) => col(i) !== c + 1 || Math.abs(i.baseline - counts[0].baseline) > i.height * 0.2
      )
    )
      return undefined
    const words = block.filter((i) => !counts.includes(i)),
      question = words.filter((i) => col(i) === 0)
    if (
      !question.length ||
      words.some((i) => i.rect[3] >= counts[0].rect[1] || (col(i) > 0 && ![1, 5].includes(col(i))))
    )
      return undefined
    const split = (Math.max(...words.map((i) => i.rect[3])) + counts[0].rect[1]) / 2
    spans.push({ row: rows.length, column: 0, rowSpan: 2, colSpan: 1 })
    rows.push([left, frame[n][1], right, split], [left, split, right, frame[n + 1][1]])
  }
  return {
    rows,
    columns: bounds.slice(1).map((x, c) => [bounds[c], frame[0][1], x, frame.at(-1)[1]]),
    spans,
    completeSpans: true
  }
}

// A baseline comparison has two complete count/summary columns and an optional
// P value on each record or section heading. Physical baselines establish rows;
// label-only continuation lines belong to the preceding record, not the next.
export function recoverBaselineComparisonGrid(table, items, captions) {
  if (
    !captions.some((c) => /^Table\s/i.test(c.lines[0])) ||
    table.structure.objects.filter((o) => o.label === 'table column').length !== 4
  )
    return undefined
  const [left, top, right, bottom] = table.cropRect
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= left &&
      i.rect[2] <= right &&
      i.rect[1] >= top &&
      i.baseline <= bottom &&
      !/^\(continues\)$/i.test(i.text.trim())
  )
  const variable = source.find((i) => i.text === 'Variable')
  const p = source.find(
    (i) => i.text === 'P' && variable && Math.abs(i.baseline - variable.baseline) < 2
  )
  const headers = source
    .filter(
      (i) =>
        /^Group\s*\(n\s*=\s*\d+\)$/.test(i.text) &&
        variable &&
        Math.abs(i.baseline - variable.baseline) < 2
    )
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (!p || headers.length !== 2) return undefined
  const count = (i) => /^\d+(?:\.\d+)?\s*\([\d.]+\)$/.test(i.text.trim())
  const body = source.filter((i) => i.rect[1] > variable.baseline)
  if (body.filter((i) => /\bn\s*\(%\)/.test(i.text)).length < 3) return undefined
  const groups = []
  for (const i of body.sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const g = groups.at(-1)
    if (g && Math.abs(g[0].baseline - i.baseline) < i.height * 0.3) g.push(i)
    else groups.push([i])
  }
  const paired = groups.filter((g) => g.filter(count).length === 2)
  if (paired.length < 8) return undefined
  const pairs = paired.map((g) => g.filter(count).sort((a, b) => a.rect[0] - b.rect[0]))
  const stubEnd = Math.max(...body.filter((i) => /\p{L}/u.test(i.text)).map((i) => i.rect[2]))
  const xs = [
    left,
    (stubEnd + Math.min(...pairs.map((g) => g[0].rect[0]))) / 2,
    (Math.max(...pairs.map((g) => g[0].rect[2])) + Math.min(...pairs.map((g) => g[1].rect[0]))) / 2,
    (Math.max(...pairs.map((g) => g[1].rect[2])) + p.rect[0]) / 2,
    right
  ]
  if (
    xs.some((x, n) => n && x <= xs[n - 1]) ||
    stubEnd >= Math.min(...pairs.map((g) => g[0].rect[0]))
  )
    return undefined
  const col = (i) => xs.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const start = Math.min(...source.map((i) => i.rect[1]))
  const rows = [[left, start, right, variable.baseline + 2]]
  for (const g of groups) {
    const parts = xs.slice(1).map((_, c) => g.filter((i) => col(i) === c))
    const label = parts[0].map((i) => i.text).join(' ')
    if (
      !label ||
      !/\p{L}/u.test(label) ||
      !(
        [1, 2].every((c) => parts[c].length === 0) ||
        [1, 2].every((c) => parts[c].length === 1 && count(parts[c][0]))
      ) ||
      parts[3].some((i) => !/^[<>≤≥]?\s*0?\.\d+$/.test(i.text))
    )
      return undefined
    const y = Math.min(...g.map((i) => i.rect[1])),
      end = Math.max(...g.map((i) => i.rect[3]))
    if (
      g.every((i) => col(i) === 0) &&
      /^[a-z]/.test(label) &&
      rows.length > 1 &&
      y - rows.at(-1)[3] < g[0].height
    )
      rows.at(-1)[3] = end
    else rows.push([left, y, right, end])
  }
  return {
    rows,
    columns: xs.slice(1).map((x, c) => [xs[c], start, x, rows.at(-1)[3]]),
    spans: [],
    completeSpans: true
  }
}
