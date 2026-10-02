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
  const paired = recoverNativePairedVisitStatistics(table, items, captions, rules)
  if (paired) return paired
  const effects = recoverTimeEffectVisitCycles(table, items, captions, rules)
  if (effects) return effects
  const summaries = recoverSummaryCycles(table, items, captions, rules)
  if (summaries) return summaries
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

// Three explicitly indexed visits and a sparse within-cohort probability row
// repeat per outcome. Their source sequence proves both the missing time-effect
// records and the two statistics printed once beside each complete visit set.
function recoverTimeEffectVisitCycles(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length !== 7) return
  const [left, top, right, bottom] = table.cropRect,
    cuts = [
      left,
      ...predicted.slice(1).map((c, n) => left + (predicted[n].rect[2] + c.rect[0]) / 2),
      right
    ]
  const source = tableSourceItems(items, table.cropRect),
    h = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  if (!(h > 0)) return
  const groups = groupSourceRowsWithScripts(source, h, 0.35)
  if (!groups) return
  const compact = (s) => s.replace(/\s/g, ''),
    values = groups.map((g) => readSourceRow(g, cuts)),
    times = values.map((v) => v && /^T[123]$/i.test(compact(v[0])))
  const first = times.findIndex(Boolean)
  if (first < 2) return
  const header = groups.slice(0, first - 1).flat(),
    body = groups.slice(first - 1),
    heads = readSourceRow(header, cuts, { multiline: true })
  if (
    !heads ||
    !/dependent\s*variable/i.test(heads[0]) ||
    !heads.slice(1, 3).every((s) => /mean\s*\(SD\)/i.test(s)) ||
    !/mean\s*difference\s*\(CI\)/i.test(heads[3]) ||
    !/intervention\s*effect/i.test(heads[4]) ||
    !/interaction\s*effect/i.test(heads[5]) ||
    !/BIC\s*\(AIC\)/i.test(heads[6])
  )
    return
  if (body.length < 15 || body.length % 5) return
  const closing = joinHorizontalTableRules(rules).filter(
    (r) =>
      Math.abs(r[0] - left) < h &&
      Math.abs(r[2] - right) < h &&
      r[1] >= union(body.at(-1))[3] &&
      r[1] - union(body.at(-1))[3] < h &&
      r[1] <= bottom
  )
  if (closing.length !== 1) return
  const number = (s) => /^[<>˂≤≥−–+-]?(?:\d|\.\d)[\d.,()%–−+\s/-]*$/.test(compact(s)),
    measured = (s) => /^\d+(?:\.\d+)?\([\d.,]+\)$/.test(compact(s))
  const spans = [],
    bounds = [],
    owned = [...header]
  for (let n = 0; n < body.length; n += 5) {
    const cycle = body.slice(n, n + 5),
      v = cycle.map((g) => readSourceRow(g, cuts))
    if (
      v.some((s) => !s) ||
      !/^\p{L}[\p{L}\s-]*$/u.test(v[0][0]) ||
      v[0].slice(1).some(Boolean) ||
      !/^p[- ]?value\s*for\s*time\s*effect$/i.test(v[4][0]) ||
      !v[4].slice(1, 3).every(number) ||
      v[4].slice(3).some(Boolean)
    )
      return
    for (let t = 1; t <= 3; t++)
      if (
        compact(v[t][0]).toUpperCase() !== 'T' + t ||
        !v[t].slice(1, 3).every(measured) ||
        !number(v[t][3]) ||
        !number(v[t][4]) ||
        v[t].slice(5).some((s) => (t === 1 ? !number(s) : !!s))
      )
        return
    const label = cycle[0][0],
      stub = cycle[1].filter((i) => i.rect[0] < cuts[1])[0]
    if (
      !stub ||
      stub.rect[0] - label.rect[0] < h * 0.5 ||
      stub.rect[0] - label.rect[0] > h * 1.5 ||
      cycle.some((g, t) => t && g[0].baseline - cycle[t - 1][0].baseline < h * 1.5) ||
      cycle.some((g, t) => t && g[0].baseline - cycle[t - 1][0].baseline > h * 2.2)
    )
      return
    const row = 1 + n
    spans.push(
      { row, column: 0, rowSpan: 1, colSpan: 7 },
      { row: row + 1, column: 5, rowSpan: 3, colSpan: 1 },
      { row: row + 1, column: 6, rowSpan: 3, colSpan: 1 }
    )
    bounds.push(...cycle.map(union))
    owned.push(...cycle.flat())
  }
  if (!hasUniqueRecordTokens(source, [owned])) return
  const firstTop = (union(header)[3] + bounds[0][1]) / 2,
    rows = [
      [left, top, right, firstTop],
      ...bounds.map((r, n) => [
        left,
        n ? (bounds[n - 1][3] + r[1]) / 2 : firstTop,
        right,
        n + 1 < bounds.length ? (r[3] + bounds[n + 1][1]) / 2 : closing[0][1]
      ])
    ]
  if (body.some((g, n) => g.some((i) => i.rect[1] < rows[n + 1][1] || i.rect[3] > rows[n + 1][3])))
    return
  return {
    cropRect: [...table.cropRect],
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

// Repeated baseline/visit/change/test cycles independently establish row
// boundaries when the detector merges or drops whole statistical records.
// Require complete cycles, complete paired measurements, a native header rule
// and unique ownership of every source token; an incomplete cycle stays on
// the ordinary path rather than inventing a missing visit or value.
function recoverSummaryCycles(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (columns.length < 5 || columns.length > 6) return
  const cuts = [
    left,
    ...columns.slice(1).map((c, n) => left + (columns[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, table.cropRect)
  const heights = source.map((i) => i.height).sort((a, b) => a - b),
    height = heights[Math.floor(heights.length / 2)]
  if (!height) return
  const stubLines = []
  for (const i of source.filter(
    (i) => i.rect[0] >= cuts[1] && i.rect[2] <= cuts[2] && i.height >= height * 0.85
  )) {
    const line = stubLines.find((g) => Math.abs(g[0].baseline - i.baseline) < height * 0.1)
    if (line) line.push(i)
    else stubLines.push([i])
  }
  const anchors = stubLines
    .map((g) => ({
      ...g[0],
      rect: union(g),
      text: g
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join(' ')
        .replace(/\s*[–-]\s*/g, ' ')
    }))
    .filter((i) =>
      /^(?:Baseline|\d+\s*(?:wk|weeks?|mo|months?)|Changes?|P(?:\s*value)?)$/i.test(i.text.trim())
    )
  if (anchors.length < 12 || anchors.length % 4) return
  const canonical = (s) => s.toLowerCase().replace(/\s/g, '')
  const cycle = anchors.slice(0, 4).map((i) => canonical(i.text))
  if (
    cycle[0] !== 'baseline' ||
    !/^\d/.test(cycle[1]) ||
    !/^changes?$/.test(cycle[2]) ||
    !/^p(?:value)?$/.test(cycle[3]) ||
    anchors.some(
      (a, n) =>
        canonical(a.text) !== cycle[n % 4] &&
        !(n % 4 === 3 && /^p(?:value)?$/.test(canonical(a.text)))
    )
  )
    return
  const borders = joinHorizontalTableRules(rules).filter(
    (r) => Math.abs(r[0] - left) < height * 2 && Math.abs(r[2] - right) < height * 2
  )
  const divider = borders
    .filter((r) => r[1] < anchors[0].rect[1] && anchors[0].rect[1] - r[1] < height)
    .at(-1)
  const closing = borders.find((r) => r[1] > anchors.at(-1).baseline && r[1] <= bottom)
  if (!divider || !closing) return
  const header = source.filter((i) => i.rect[3] < divider[1]),
    body = source.filter((i) => !header.includes(i))
  if (body.some((i) => (i.rect[1] + i.rect[3]) / 2 < divider[1] || i.rect[3] > closing[1])) return
  const headings = recoverRuledHeaderBands(header, cuts, rules, top, divider[1])
  if (!headings) return
  const records = anchors.map(() => []),
    labels = anchors.filter((_, n) => n % 4 === 0).map(() => [])
  for (const item of body) {
    if (item.rect[2] <= cuts[1]) {
      const owners = labels
        .map((_, n) => n)
        .filter(
          (n) =>
            item.baseline >=
              anchors[n * 4].baseline - height * (item.height < height * 0.8 ? 0.7 : 0.4) &&
            item.baseline <= anchors[n * 4 + 3].baseline + height * 0.3
        )
      if (owners.length !== 1) return
      labels[owners[0]].push(item)
      continue
    }
    const closest = anchors
      .map((a, n) => ({ n, d: Math.abs(a.baseline - item.baseline) }))
      .sort((a, b) => a.d - b.d)
    if (closest[0].d > height * 0.55 || closest[1].d - closest[0].d < height * 0.1) return
    records[closest[0].n].push(item)
  }
  const number = (s) => /^[<>≤≥−–+-]?(?:\d|\.\d)[\d.,;()%±−–+*/#†‡[\]-]*$/.test(s)
  for (const [n, g] of records.entries()) {
    const v = readSourceRow(g, cuts)
    if (
      !v ||
      !number(v[2]) ||
      !number(v[3]) ||
      (n % 4 !== 3 && !number(v[4])) ||
      (n % 4 === 3 && v[4]) ||
      (v[5] && !number(v[5]))
    )
      return
  }
  if (
    labels.some((g) => !g.length || !g.some((i) => /\p{L}/u.test(i.text))) ||
    !hasUniqueRecordTokens(source, [header, ...records, ...labels])
  )
    return
  const ys = [
    divider[1],
    ...anchors.slice(1).map((a, n) => (a.baseline + anchors[n].baseline - height) / 2),
    closing[1]
  ]
  const spans = [...headings.spans]
  for (let n = 0; n < labels.length; n++) {
    spans.push({ row: headings.rows.length + n * 4, column: 0, rowSpan: 4, colSpan: 1 })
    // An adjusted statistic printed once per outcome spans the whole cycle.
    if (columns.length === 6) {
      const adjusted = records
        .slice(n * 4, n * 4 + 4)
        .flat()
        .filter((i) => i.rect[0] >= cuts[5])
      if (adjusted.length !== 1) return
      spans.push({ row: headings.rows.length + n * 4, column: 5, rowSpan: 4, colSpan: 1 })
    }
  }
  return {
    rows: [...headings.rows, ...records.map((_, n) => [left, ys[n], right, ys[n + 1]])],
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
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

// A closed segmented statistics frame and repeated complete T1/T2 pairs locate
// both numeric lanes and otherwise empty, wide labels without semantic guesses.
function recoverNativePairedVisitStatistics(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect),
    h = source.map((i) => i.height).sort((a, b) => a - b)[source.length >> 1]
  if (!(h > 0)) return
  const bands = []
  for (const r of rules.filter((r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom)) {
    let b = bands.find((b) => Math.abs(b[0][1] - r[1]) < 0.01)
    if (!b) {
      b = []
      bands.push(b)
    }
    b.push(r)
  }
  const full = bands
    .filter((b) => {
      b.sort((a, b) => a[0] - b[0])
      return (
        b.length === 14 &&
        Math.abs(b[0][0] - left) < h &&
        Math.abs(b.at(-1)[2] - right) < h &&
        b.every((r, n) => r[2] - r[0] > h * 2 && (!n || Math.abs(r[0] - b[n - 1][2]) < 0.01))
      )
    })
    .sort((a, b) => a[0][1] - b[0][1])
  if (full.length < 3) return
  const same = (a, b) =>
    a.every((r, n) => Math.abs(r[0] - b[n][0]) < 0.01 && Math.abs(r[2] - b[n][2]) < 0.01)
  const closing = full.at(-1),
    cuts = [left, ...closing.slice(1).map((r, n) => (r[0] + closing[n][2]) / 2), right]
  if (full.some((b) => !same(b, closing))) return
  const groups = groupSourceRowsWithScripts(source, h, 0.35)
  if (!groups || full.filter((b) => b[0][1] > union(groups.at(-1))[3]).length !== 1) return
  // Native horizontal lane endpoints can precede ink by a tiny font-box overhang.
  // Recognition may clamp at most .1em; exported glyph rectangles stay unchanged.
  const read = (g) => {
    const bounded = []
    for (const i of g) {
      const c = cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
      if (c < 0 || i.rect[0] < cuts[c] - h * 0.1 || i.rect[2] > cuts[c + 1] + h * 0.1) return
      bounded.push({
        ...i,
        rect: [Math.max(i.rect[0], cuts[c]), i.rect[1], Math.min(i.rect[2], cuts[c + 1]), i.rect[3]]
      })
    }
    return readSourceRow(bounded, cuts)
  }
  const values = groups.map(read),
    compact = (s) => s.replace(/\s/g, ''),
    number = (s) => /^[−+-]?(?:\d|\.\d)[\d.,()%−–+*†‡-]*$/.test(compact(s))
  const first = values.findIndex(
    (v) => v && /^t1$/i.test(compact(v[0])) && v.slice(1).every(number)
  )
  if (first < 2) return
  const divider = full.filter((b) => b[0][1] < union(groups[first])[1]).at(-1)
  if (!divider || divider === closing || divider[0][1] <= full[0][0][1]) return
  const header = source.filter((i) => i.rect[3] <= divider[0][1]),
    body = source.filter((i) => !header.includes(i))
  if (body.some((i) => i.rect[1] < divider[0][1] || i.rect[3] > closing[0][1])) return
  const units = header
      .filter((i) => /^(?:M|SD)$/.test(i.text))
      .sort((a, b) => a.rect[0] - b.rect[0]),
    role = (c) =>
      header
        .filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1])
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
  if (
    units.length !== 6 ||
    !units.every(
      (i, n) =>
        i.rect[0] >= cuts[n + 1] &&
        i.rect[2] <= cuts[n + 2] &&
        i.text.toUpperCase() === (n % 2 ? 'SD' : 'M')
    ) ||
    !/^variable$/i.test(compact(role(0))) ||
    !/F.*time/i.test(role(7)) ||
    !header.some((i) => /^Omnibus$/i.test(i.text))
  )
    return
  const heading = recoverRuledHeaderBands(header, cuts, rules, full[0][0][1], divider[0][1])
  if (!heading || heading.rows.length !== 2) return
  const records = groupSourceRowsWithScripts(body, h, 0.35)
  if (!records) return
  const spans = [...heading.spans],
    bounds = records.map(union)
  let pairs = 0
  for (let n = 0; n < records.length; n++) {
    const g = records[n]
    if (g.every((i) => /\p{L}/u.test(i.text))) {
      if (!records[n + 1]) return
      spans.push({ row: heading.rows.length + n, column: 0, rowSpan: 1, colSpan: 14 })
      continue
    }
    const v = read(g)
    if (!v) return
    if (/^t1$/i.test(compact(v[0]))) {
      const after = records[n + 1],
        next = after && read(after)
      if (
        !next ||
        !/^t2$/i.test(compact(next[0])) ||
        !v.slice(1).every(number) ||
        !next.slice(1, 8).every(number) ||
        next.slice(8).some(Boolean)
      )
        return
      const stub = g.filter((i) => i.rect[2] <= cuts[1]),
        other = after.filter((i) => i.rect[2] <= cuts[1])
      if (
        !stub.length ||
        !other.length ||
        Math.abs(union(stub)[0] - union(other)[0]) > h * 0.1 ||
        after[0].baseline - g[0].baseline < h * 0.9 ||
        after[0].baseline - g[0].baseline > h * 1.6
      )
        return
      for (const list of [g, after])
        if (
          list.some(
            (i) =>
              Math.abs(i.baseline - list[0].baseline) > h * 0.15 ||
              Math.abs(i.height - h) > h * 0.05
          )
        )
          return
      pairs++
      n++
      continue
    }
    if (g.some((i) => !/\p{L}/u.test(i.text)) || !records[n + 1]) return
    spans.push({ row: heading.rows.length + n, column: 0, rowSpan: 1, colSpan: 14 })
  }
  if (pairs < 3 || !hasUniqueRecordTokens(source, [header, ...records])) return
  const rows = [
    ...heading.rows,
    ...bounds.map((r, n) => [
      left,
      n ? (bounds[n - 1][3] + r[1]) / 2 : divider[0][1],
      right,
      n + 1 < bounds.length ? (r[3] + bounds[n + 1][1]) / 2 : closing[0][1]
    ])
  ]
  if (
    records.some((g, n) => g.some((i) => i.rect[1] < rows[n + 2][1] || i.rect[3] > rows[n + 2][3]))
  )
    return
  return {
    cropRect: [...table.cropRect],
    rows,
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, bottom]),
    headerRows: [0, 1],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}
