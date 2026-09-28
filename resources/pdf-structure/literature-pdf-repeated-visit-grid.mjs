/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  tableSourceItems,
  readSourceRow,
  groupSourceRowsWithScripts,
  hasUniqueRecordTokens,
  recoverRuledHeaderBands
} from './literature-pdf-source-records.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

// Repeated source visit cycles are row anchors. Section text may span the
// unused leading columns while time/interaction statistics stay in their own
// columns. A new section or an incomplete cycle cannot be silently swallowed.
export function recoverRepeatedVisitGrid(table, items, captions, rules) {
  const wrapped = recoverWrappedVisitCycles(table, items, captions, rules)
  if (wrapped) return wrapped
  const captioned = captions.some((c) => captionKind(c.lines[0]) === 'table')
  const [left, top, right, bottom] = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 5 || predicted.length > 30) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const visitOrder = (text) =>
    /^preoperatively$/i.test(text)
      ? 0
      : /^\d+ wk postoperatively$/i.test(text)
        ? parseInt(text) / 4
        : /^At \d+ mo(?: \([^()]+\))?$/i.test(text)
          ? parseInt(text.slice(3))
          : undefined
  const times = source.filter(
    (i) => (/^(?:t\d+|Pre|Post)$/i.test(i.text) || visitOrder(i.text) !== undefined) && col(i) <= 1
  )
  if (times.length < 3) return
  const stub = col(times[0]),
    first = times[0]
  if (times.some((i) => col(i) !== stub)) return
  const scheduled = times.every((i) => visitOrder(i.text) !== undefined)
  if (times.length < 8 && (!scheduled || !captions.some((c) => /continu/i.test(c.lines.join(' ')))))
    return
  const divider = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[2] - r[0] > (right - left) * 0.9 &&
        r[1] < first.rect[1] &&
        r[1] > top + height &&
        new Set(source.filter((i) => i.rect[3] < r[1] && /\p{L}/u.test(i.text)).map(col)).size >= 3
    )
    .sort((a, b) => a[1] - b[1])[0]
  if (!divider) return
  // Contiguous native header strokes expose leaf columns even when the model
  // duplicates a narrow count column. Later record gutters validate each cut.
  const segments = rules
    .filter((r) => r[1] === r[3] && Math.abs(r[1] - divider[1]) < 0.01)
    .sort((a, b) => a[0] - b[0])
  if (
    segments.length >= 5 &&
    segments.every((r, n) => !n || Math.abs(r[0] - segments[n - 1][2]) < 1)
  )
    cuts.splice(0, cuts.length, left, ...segments.slice(1).map((r) => r[0]), right)
  // Shaded section bands are painted as slightly overlapping column segments.
  // Several identical bands provide independent leaf-column boundaries when
  // the model duplicates a narrow count column.
  if (scheduled) {
    const bands = []
    for (const r of rules
      .filter((r) => r[1] === r[3] && r[1] > divider[1] && r[1] < bottom)
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
      const band = bands.at(-1)
      if (band && Math.abs(band[0][1] - r[1]) < 0.01) band.push(r)
      else bands.push([r])
    }
    const repeated = bands.find(
      (band) =>
        band.length >= 8 &&
        band.length <= 20 &&
        Math.abs(band[0][0] - left) < height &&
        Math.abs(band.at(-1)[2] - right) < height &&
        band.slice(1).every((r, n) => r[0] <= band[n][2] && band[n][2] - r[0] < height) &&
        bands.filter(
          (other) =>
            other.length === band.length &&
            other.every(
              (r, n) => Math.abs(r[0] - band[n][0]) < 1 && Math.abs(r[2] - band[n][2]) < 1
            )
        ).length >= 3
    )
    if (repeated)
      cuts.splice(
        0,
        cuts.length,
        left,
        ...repeated.slice(1).map((r, n) => (r[0] + repeated[n][2]) / 2),
        right
      )
  }
  const body = source.filter((i) => i.rect[1] > divider[1]),
    header = source.filter((i) => !body.includes(i))
  const groups = groupSourceRowsWithScripts(body, height, 0.35)
  if (!groups) return
  const record = (g) => g.some((i) => times.includes(i))
  const value = (s) =>
    /^(?:[<>≤≥−–+-]?(?:\d|\.\d)[\d.,;()%/±−–+*†‡\s-]*(?:to[−–+\d.,\s]*)?[)*†‡]*|[–—-]|N\/A[a-z]?)$/.test(
      s.replace(/\s/g, '')
    )
  const records = groups.filter(record)
  if (stub === 0) {
    const counts = records.map((g) => g.filter((i) => col(i) === 0 && !times.includes(i)))
    const end = Math.max(...times.map((i) => i.rect[2])),
      start = Math.min(...counts.flat().map((i) => i.rect[0]))
    if (
      counts.every((g) => g.length === 1 && /^\d+$/.test(g[0].text)) &&
      start - end > height * 0.5 &&
      header.some(
        (i) =>
          /^n$/i.test(i.text) &&
          Math.abs(
            (i.rect[0] + i.rect[2]) / 2 - (counts[0][0].rect[0] + counts[0][0].rect[2]) / 2
          ) < height
      )
    )
      cuts.splice(1, 0, (end + start) / 2)
  }
  // All numeric columns must retain the same native gutter across records.
  for (let c = stub + 1; c < cuts.length - 1; c++) {
    const boundarySource = [
      ...records.flat(),
      ...header.filter((i) => i.rect[0] >= cuts[col(i)] && i.rect[2] <= cuts[col(i) + 1])
    ]
    const a = boundarySource.filter((i) => col(i) === c - 1),
      b = boundarySource.filter((i) => col(i) === c)
    if (!a.length || !b.length) continue
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    cuts[c] = (end + start) / 2
  }
  const headings = recoverRuledHeaderBands(header, cuts, rules, top, divider[1])
  if (!headings) return
  if (!captioned && headings.rows.length < 2) return
  if (times.length < 8 && headings.rows.length < 3) return
  const rows = [...headings.rows],
    spans = [...headings.spans],
    owned = [header]
  const labels = times.map((i) => i.text.toLowerCase().replace(/ \([^()]+\)$/, ''))
  const cycle = [...new Set(labels)].sort((a, b) =>
    scheduled
      ? visitOrder(a) - visitOrder(b)
      : /^t\d+$/.test(a) && /^t\d+$/.test(b)
        ? +a.slice(1) - +b.slice(1)
        : a === 'pre'
          ? -1
          : 1
  )
  if (cycle.length < 2 || cycle.length > 8) return
  let position = cycle.indexOf(labels[0]),
    sectionCount = 0
  const visited = []
  // A wrapped confidence interval or degrees-of-freedom line belongs to the
  // preceding anchored record/section, never to a separate model row.
  const merged = []
  for (const g of groups) {
    const anchor = g.some((i) => times.includes(i)),
      label = g.some((i) => i.rect[0] < cuts[stub + 1] && /\p{L}/u.test(i.text))
    const priorSection = merged.at(-1)
    if (
      label &&
      !anchor &&
      priorSection &&
      !priorSection.some((i) => times.includes(i)) &&
      g.every((i) => i.rect[2] < cuts[stub + 1]) &&
      /^\(/.test(g[0].text) &&
      union(g)[1] - union(priorSection)[3] < height
    )
      priorSection.push(...g)
    else if (anchor || label) merged.push([...g])
    else {
      const prior = merged.at(-1)
      if (
        !prior ||
        union(g)[1] - union(prior)[3] > height * 1.6 ||
        !readSourceRow(g, cuts)
          ?.filter(Boolean)
          .every((s) => /^[\d.,();%±−–+*/<>≤≥\s-]+$/.test(s.replace(/to/g, '')))
      )
        return
      prior.push(...g)
    }
  }
  for (const g of merged) {
    const anchor = g.find((i) => times.includes(i)),
      rect = union(g)
    if (anchor) {
      const order = cycle.indexOf(anchor.text.toLowerCase().replace(/ \([^()]+\)$/, ''))
      if (
        scheduled
          ? order < position
          : anchor.text.toLowerCase() !== cycle[position % cycle.length].toLowerCase()
      )
        return
      if (scheduled) position = order
      const cells = readSourceRow(
        g.filter((i) => i.height >= height * 0.85),
        cuts,
        { multiline: true }
      )
      if (!cells) return
      const values = cells.slice(stub + 1)
      if (
        values.filter(value).length < (stub ? 3 : 4) ||
        values.some(
          (s, n) =>
            s &&
            !value(s) &&
            !(
              n === values.length - 1 &&
              (/^(?:NI|Small|Medium|Large|Trivial)$/.test(s) || /^(?:Group|Time)[=×]/.test(s))
            )
        )
      )
        return
      visited.push({ row: rows.length, anchor, items: g })
      position++
    } else {
      if (scheduled) position = 0
      else if (position % cycle.length) return
      const label = g.filter(
          (i) =>
            i.rect[0] < cuts[stub + 1] ||
            (!stub && /\p{L}/u.test(i.text) && !/^(?:N\/A|to(?:\s|[−–+\d]))/.test(i.text))
        ),
        extra = g.filter((i) => !label.includes(i))
      if (
        !label.length ||
        !label.some((i) => /\p{L}/u.test(i.text)) ||
        Math.min(...label.map((i) => i.rect[0])) > first.rect[0] + height
      )
        return
      const start = extra.length ? Math.min(...extra.map(col)) : cuts.length - 1
      if (
        start <= stub + 1 ||
        label.some((i) => i.rect[2] > cuts[start]) ||
        !readSourceRow(extra, cuts)?.filter(Boolean).every(value)
      )
        return
      spans.push({ row: rows.length, column: 0, rowSpan: 1, colSpan: start })
      sectionCount++
    }
    rows.push([left, rect[1], right, rect[3]])
    owned.push(g)
  }
  // The final page can continue an explicitly started numbered visit cycle.
  if (
    (sectionCount < 2 && !(scheduled && times.length < 8 && sectionCount === 0)) ||
    (!scheduled && !/^t\d+$/i.test(cycle[0]) && position % cycle.length) ||
    !hasUniqueRecordTokens(source, owned)
  )
    return
  if (stub)
    for (let n = 0; n < visited.length; n += 2) {
      const a = visited[n],
        b = visited[n + 1]
      if (!b || b.row !== a.row + 1) return
      const av = readSourceRow(a.items, cuts),
        bv = readSourceRow(b.items, cuts)
      if (!av[0] || bv[0]) return
      spans.push({ row: a.row, column: 0, rowSpan: 2, colSpan: 1 })
    }
  return {
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    headerRows: headings.rows.map((_, n) => n),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Repeated complete measurement rows anchor wrapped visit labels. A leading
// outcome owns a whole repeated cycle, including label lines that sit beside
// the next visit. No visit text or missing statistical value is invented.
function recoverWrappedVisitCycles(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 5 || columns.length > 10) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect),
    height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const groups = groupSourceRowsWithScripts(source, height, 0.3)
  if (!groups) return
  const scalar = (s) => /^(?:[<>≤≥−+-]?(?:\d|\.\d)[\d.,()%−–+/-]*|[—–-])$/.test(s)
  const record = (g) => {
    const v = readSourceRow(g, cuts)
    return v && /\p{L}/u.test(v[1]) && v.slice(2).every(scalar)
  }
  const first = groups.findIndex(record)
  if (first < 1 || first > 5) return
  const body = []
  for (const g of groups.slice(first)) {
    if (record(g)) body.push([...g])
    else {
      const v = readSourceRow(g, cuts),
        prior = body.at(-1)
      if (
        !v ||
        !prior ||
        !v.slice(0, 2).some(Boolean) ||
        v.slice(2).some(Boolean) ||
        g[0].baseline - prior[0].baseline > height * 1.7
      )
        return
      prior.push(...g)
    }
  }
  const values = body.map((g) => readSourceRow(g, cuts, { multiline: true }))
  if (body.length < 6 || values.some((v) => !v)) return
  const starts = values.flatMap((v, n) => (v[0] ? [n] : []))
  const length = starts[1]
  if (
    starts.length < 3 ||
    starts[0] !== 0 ||
    length < 2 ||
    length > 6 ||
    body.length !== starts.length * length ||
    starts.some((s, n) => s !== n * length)
  )
    return
  if (
    values.some((v, n) => v[1] !== values[n % length][1]) ||
    new Set(values.slice(0, length).map((v) => v[1])).size !== length
  )
    return
  const header = groups.slice(0, first).flat(),
    footer = joinHorizontalTableRules(rules).find(
      (r) =>
        r[0] <= left + 15 && r[2] >= right - 15 && r[1] > union(body.at(-1))[3] && r[1] <= bottom
    )
  if (
    !footer ||
    !header.some((i) => /^Time$/i.test(i.text) && i.rect[0] >= cuts[1] && i.rect[2] <= cuts[2])
  )
    return
  const divider = [left, (union(header)[3] + union(body[0])[1]) / 2, right]
  const headings = recoverRuledHeaderBands(header, cuts, rules, top, divider[1])
  if (!headings || !hasUniqueRecordTokens(source, [header, ...body])) return
  const bounds = body.map((g) => union(g.filter((i) => i.rect[0] >= cuts[1])))
  if (bounds.some((r, n) => n && r[1] <= bounds[n - 1][3])) return
  const spans = [
    ...headings.spans,
    ...starts.map((n) => ({
      row: headings.rows.length + n,
      column: 0,
      rowSpan: length,
      colSpan: 1
    }))
  ]
  const ys = [divider[1], ...bounds.slice(1).map((r, n) => (r[1] + bounds[n][3]) / 2), bottom]
  return {
    rows: [...headings.rows, ...body.map((_, n) => [left, ys[n], right, ys[n + 1]])],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    spans,
    headerRows: headings.rows.map((_, n) => n),
    completeSpans: true
  }
}
