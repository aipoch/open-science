/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { inside, union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import {
  joinHorizontalTableRules,
  clusterTableRulePositions,
  classifyTableRuleEdge
} from './literature-pdf-table-rules.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'

// Repeated four-part native header/footer strokes and two sample-qualified
// cohorts establish these leaf lanes. Physical section baselines and complete
// paired records retain every source token, independently of model row spans.
export function recoverTwoCohortSectionGrid(table, items, captions, rules) {
  if (table.structure.objects.filter((o) => o.label === 'table column').length !== 4) return
  const crop = table.cropRect,
    sourceHeight = items
      .filter((i) => i.horizontal && inside(crop, i))
      .map((i) => i.height)
      .sort((a, b) => a - b),
    height = sourceHeight[Math.floor(sourceHeight.length / 2)]
  if (!(height > 0)) return
  const bands = [
    ...Map.groupBy(
      rules.filter((r) => r[1] === r[3] && r[1] >= crop[1] - height && r[1] <= crop[3] + height),
      (r) => r[1]
    ).values()
  ]
    .map((band) => [...band].sort((a, b) => a[0] - b[0]))
    .filter(
      (band) =>
        band.length === 4 &&
        Math.abs(band[0][0] - crop[0]) < height &&
        Math.abs(band[3][2] - crop[2]) < height &&
        band.slice(1).every((r, n) => Math.abs(r[0] - band[n][2]) < height * 0.01)
    )
    .sort((a, b) => a[0][1] - b[0][1])
  if (bands.length < 3 || bands.length > 4) return
  const [upper, divider] = bands,
    closing = bands.at(-1),
    tolerance = height * 0.01
  if (
    divider[0][1] - upper[0][1] > height * 5 ||
    bands.some((band) =>
      band.some(
        (r, n) =>
          Math.abs(r[0] - upper[n][0]) > tolerance || Math.abs(r[2] - upper[n][2]) > tolerance
      )
    )
  )
    return
  const caption = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= upper[0][1] &&
      upper[0][1] - c.rect[3] < height * 2 &&
      c.rect[0] < upper[3][2] &&
      c.rect[2] > upper[0][0]
  )
  if (caption.length !== 1) return
  const frame = [upper[0][0] - 0.1, upper[0][1], upper[3][2] + 0.1, closing[0][1]],
    cuts = [frame[0], ...upper.slice(1).map((r) => r[0] - 0.001), frame[2]],
    source = tableSourceItems(items, frame),
    header = source.filter((i) => i.rect[3] < divider[0][1]),
    body = source.filter((i) => i.rect[1] > divider[0][1])
  // Native statistic ink can overhang a column-start vertex by a fraction of
  // an em. Move that boundary only to the observed ink edge; the complete
  // paired records below still have to fit every resulting leaf lane.
  for (let c = 1; c < cuts.length - 1; c++) {
    const crossing = body.filter(
      (i) =>
        i.rect[0] >= cuts[c - 1] + height &&
        i.rect[0] < cuts[c] &&
        i.rect[2] > cuts[c] &&
        /^(?:p\s*=|[<>≤≥]?(?:\d|\.\d))[\d.,\s()%±−–+*/=<>≤≥tFχ²dfp-]*$/u.test(i.text)
    )
    if (!crossing.length) continue
    const edge = Math.min(...crossing.map((i) => i.rect[0]))
    if (cuts[c] - edge > height * 0.1) return
    cuts[c] = edge - 0.001
  }
  const heads = readSourceRow(header, cuts, { multiline: true })
  if (
    !heads ||
    heads[0] ||
    !heads.slice(1, 3).every((v) => /^\p{L}[\p{L}-]*(?:group|cohort)\(n=\d+\)$/iu.test(v)) ||
    !/^(?:p|Statisticalanalysis\([A-Z-]+\))$/i.test(heads[3])
  )
    return
  const physical = groupSourceRowsWithScripts(body, height, 0.3)
  if (!physical || physical.length < 8 || !hasUniqueRecordTokens(source, [header, ...physical]))
    return
  const scalar = (v) => /^(?:[−–+-]?\d[\d.,/%()±−–+-]*|[—–-])$/.test(v),
    statistic = (v) => /^(?:p=)?[<>≤≥]?(?:\d|\.\d)[\d.,()%±−–+*/=<>≤≥tFχ²dfp-]*$/u.test(v),
    groups = [],
    spans = []
  let records = 0,
    sections = 0
  for (const g of physical) {
    const v = readSourceRow(g, cuts),
      row = groups.length + 1
    if (v && v[0] && scalar(v[1]) && scalar(v[2]) && (!v[3] || statistic(v[3]))) records++
    else {
      const summaries = g.filter((i) => i.rect[0] >= cuts[3]),
        labels = g.filter((i) => !summaries.includes(i)),
        labelText = labels.map((i) => i.text).join('')
      if (
        !labels.length ||
        Math.abs(Math.min(...labels.map((i) => i.rect[0])) - frame[0]) > height * 1.5 ||
        !/\p{L}/u.test(labelText) ||
        (summaries.length &&
          (!statistic(
            summaries
              .map((i) => i.text)
              .join('')
              .replace(/\s/g, '')
          ) ||
            labels.some((i) => i.rect[2] > cuts[3]))) ||
        labels.some((i) => i.rect[0] >= cuts[1] && !isAdjacentTableScript(i, labels[0]))
      )
        return
      spans.push({ row, column: 0, rowSpan: 1, colSpan: summaries.length ? 3 : 4 })
      sections++
    }
    groups.push(g)
  }
  if (records < 6 || sections < 2) return
  return {
    cropRect: frame,
    rows: [
      [frame[0], frame[1], frame[2], divider[0][1]],
      ...groups.map((g, n) => [
        frame[0],
        n ? (union(groups[n - 1])[3] + union(g)[1]) / 2 : divider[0][1],
        frame[2],
        groups[n + 1] ? (union(g)[3] + union(groups[n + 1])[1]) / 2 : frame[3]
      ])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Record recognizers share strict source containment, while each recognizer
// retains its own anchors, row tolerances and statistical expressions.
// Six overlapping native leaf underlines and repeated two-complete/one-sparse
// sample-qualified cohorts prove physical records independently of model gaps.
export function recoverSampleQualifiedSparseCohortGrid(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect,
    sourceHeight = tableSourceItems(items, crop)
      .map((i) => i.height)
      .sort((a, b) => a - b),
    height = sourceHeight[sourceHeight.length >> 1]
  if (!(height > 0)) return
  const bands = [
    ...Map.groupBy(
      rules.filter((r) => r[1] === r[3] && r[1] >= crop[1] && r[1] <= crop[3]),
      (r) => r[1]
    ).values()
  ].sort((a, b) => a[0][1] - b[0][1])
  if (bands.length !== 3 || bands[0].length !== 1 || bands[1].length !== 6 || bands[2].length !== 1)
    return
  const upper = bands[0][0],
    leaf = [...bands[1]].sort((a, b) => a[0] - b[0]),
    lower = bands[2][0],
    divider = leaf[0][1],
    left = upper[0],
    right = upper[2]
  if (
    Math.abs(left - lower[0]) > height * 0.01 ||
    Math.abs(right - lower[2]) > height * 0.01 ||
    Math.abs(left - leaf[0][0]) > height * 0.01 ||
    Math.abs(right - leaf.at(-1)[2]) > height * 0.01 ||
    divider - upper[1] > height * 4
  )
    return
  const overlaps = leaf.slice(1).map((r, n) => leaf[n][2] - r[0])
  if (
    overlaps.some((x) => x < height || x > height * 2.5) ||
    Math.max(...overlaps) - Math.min(...overlaps) > height * 0.01
  )
    return
  const cuts = [
    left - 0.001,
    ...leaf.slice(1).map((r, n) => (leaf[n][2] + r[0]) / 2),
    right + 0.001
  ]
  const nearby = tableSourceItems(items, crop),
    firstInk = Math.min(...nearby.filter((i) => i.rect[3] < divider).map((i) => i.rect[1])),
    top = Math.min(upper[1], firstInk)
  if (upper[1] - top > Math.min(0.1, height * 0.01)) return
  const frame = [cuts[0], top, cuts.at(-1), lower[1]],
    source = tableSourceItems(items, frame),
    header = source.filter((i) => i.rect[3] < divider),
    body = source.filter((i) => i.rect[1] > divider)
  if (
    !hasUniqueRecordTokens(nearby, [header, body]) ||
    !readSourceRow(header, cuts, { multiline: true })?.every((v) => /\p{L}/u.test(v))
  )
    return
  const physical = groupSourceRowsWithScripts(body, height, 0.3)
  if (!physical || !hasUniqueRecordTokens(source, [header, ...physical])) return
  const values = physical.map((g) => readSourceRow(g, cuts)),
    numeric = /^[−–+-]?\d+(?:\.\d+)?$/,
    sample = /^([\p{L}-]+)\(n=\d+\)$/u,
    spans = []
  let cohortNames,
    groups = 0,
    sections = 0
  for (let n = 0; n < physical.length;) {
    const v = values[n]
    if (!v) return
    if (!sample.test(v[0])) {
      if (
        !/\p{L}/u.test(v[0]) ||
        v.slice(1).some(Boolean) ||
        Math.abs(Math.min(...physical[n].map((i) => i.rect[0])) - left) > height * 0.05
      )
        return
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: 6 })
      sections++
      n++
      continue
    }
    const triple = values.slice(n, n + 3)
    if (
      triple.length !== 3 ||
      triple.some((s) => !s || !sample.test(s[0]) || !numeric.test(s[1]) || !numeric.test(s[2]))
    )
      return
    if (
      triple.slice(0, 2).some((s) => !numeric.test(s[3]) || !numeric.test(s[4]) || !s[5]) ||
      triple[2].slice(3).some(Boolean)
    )
      return
    const names = triple.map((s) => sample.exec(s[0])[1])
    if (new Set(names).size !== 3 || (cohortNames && names.some((s, k) => s !== cohortNames[k])))
      return
    cohortNames ??= names
    groups++
    n += 3
  }
  if (groups < 3 || sections < 3) return
  const mainBaselines = physical.map((g) =>
    Math.max(...g.filter((i) => Math.abs(i.height - height) < height * 0.1).map((i) => i.baseline))
  )
  if (mainBaselines.some((b) => !Number.isFinite(b))) return
  const gaps = mainBaselines.slice(1).map((b, n) => b - mainBaselines[n])
  if (
    gaps.some((g) => g < height || g > height * 1.6) ||
    Math.max(...gaps) - Math.min(...gaps) > height * 0.1
  )
    return
  const ys = [
    top,
    divider,
    ...physical.slice(1).map((g, n) => (union(physical[n])[3] + union(g)[1]) / 2),
    lower[1]
  ]
  return {
    cropRect: frame,
    rows: ys.slice(1).map((y, n) => [frame[0], ys[n], frame[2], y]),
    columns: cuts.slice(1).map((x, n) => [cuts[n], top, x, lower[1]]),
    spans,
    headerRows: [0],
    completeSpans: true,
    preservePhysicalRows: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

export function tableSourceItems(items, [left, top, right, bottom]) {
  return items
    .filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
}

// A sample qualifier's closing parenthesis can straddle a predicted leaf cut.
// Adjacent native glyphs and an independent P heading witness its owner. Move
// that cut only when every body glyph retains its original column assignment.
export function recoverSampleQualifiedHeaderCuts(source, cuts, top, bottom) {
  if (cuts.length < 4 || cuts.length > 10 || !Number.isFinite(bottom)) return
  const head = source.filter((i) => i.horizontal && i.rect[1] >= top && i.rect[3] < bottom)
  if (!head.length) return
  const height = Math.max(...head.map((i) => i.height))
  const c = cuts.length - 3,
    cut = cuts[c + 1]
  const col = (i, xs) => xs.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const p = head.filter((i) => /^p(?:-value)?$/i.test(i.text) && col(i, cuts) === c + 1)
  const close = head.filter(
    (i) => i.text === ')' && col(i, cuts) === c + 1 && i.rect[0] < cut && i.rect[2] > cut
  )
  if (p.length !== 1 || close.length !== 1 || p[0].rect[0] <= close[0].rect[2] + height) return
  const own = head.filter(
    (i) =>
      i !== close[0] &&
      col(i, cuts) === c &&
      i.rect[2] <= close[0].rect[0] + height * 0.1 &&
      Math.abs(i.baseline - close[0].baseline) < height * 0.65
  )
  const text = own
    .sort((a, b) => a.rect[0] - b.rect[0])
    .map((i) => i.text)
    .join('')
    .replace(/\s/g, '')
  if (
    !/\(n=\d+[a-z](?:,[a-z])*$/i.test(text) ||
    !/\p{L}{3}/u.test(text) ||
    !own.some(
      (i) =>
        Math.abs(i.rect[2] - close[0].rect[0]) < height * 0.1 &&
        own.some((a) => isAdjacentTableScript(i, a))
    )
  )
    return
  const peers = head
    .filter((i) => col(i, cuts) < c && Math.abs(i.baseline - close[0].baseline) < height * 0.65)
    .sort((a, b) => a.rect[0] - b.rect[0])
    .map((i) => i.text)
    .join('')
    .replace(/\s/g, '')
  if (!/\(n=\d+[a-z](?:,[a-z])*\)/i.test(peers)) return
  const next = [...cuts]
  next[c + 1] = (close[0].rect[2] + p[0].rect[0]) / 2
  if (
    source.some((i) => !head.includes(i) && col(i, cuts) !== col(i, next)) ||
    head.some((i) => i !== close[0] && col(i, cuts) !== col(i, next))
  )
    return
  return next
}

// Compact strings are for recognition only. Never write them back to source
// tokens or use them as replacement text in the exported table.
export function readSourceRow(items, cuts, { multiline = false } = {}) {
  if (
    cuts.length < 2 ||
    cuts.some((x, n) => !Number.isFinite(x) || (n > 0 && x <= cuts[n - 1])) ||
    new Set(items).size !== items.length
  )
    return
  const cells = cuts.slice(1).map(() => [])
  for (const item of items) {
    const [left, , right] = item.rect
    if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) return
    const column = cuts.slice(1).findIndex((x) => (left + right) / 2 < x)
    if (column < 0 || left < cuts[column] || right > cuts[column + 1]) return
    cells[column].push(item)
  }
  return cells.map((cell) =>
    cell
      .sort((a, b) =>
        multiline && Math.abs(a.baseline - b.baseline) > Math.min(a.height, b.height) * 0.35
          ? a.baseline - b.baseline
          : a.rect[0] - b.rect[0]
      )
      .map((item) => item.text)
      .join('')
      .replace(/\s/g, '')
  )
}

// A token may not disappear or be claimed twice when nearby anchors produce
// overlapping record groups. Repeated values at different positions are valid.
export function hasUniqueRecordTokens(items, groups) {
  const remaining = new Set(items)
  if (remaining.size !== items.length) return false
  for (const group of groups) {
    if (!group.length) return false
    for (const item of group) if (!remaining.delete(item)) return false
  }
  return remaining.size === 0
}

// Source is already in baseline order. Callers choose their row tolerance;
// small scripts must have exactly one row owner instead of creating a new row.
export function groupSourceRowsWithScripts(source, height, tolerance) {
  if (!(height > 0) || !(tolerance > 0)) return
  const groups = []
  const scripts = new Set(
    source.filter(
      (i) =>
        i.height < height * 0.8 ||
        (/^[a-z](?:,[a-z])*$/.test(i.text) && source.some((a) => isAdjacentTableScript(i, a)))
    )
  )
  for (const item of source.filter((i) => !scripts.has(i))) {
    const last = groups.at(-1)
    if (last && Math.abs(item.baseline - last[0].baseline) < height * tolerance) last.push(item)
    else groups.push([item])
  }
  for (const item of source.filter((i) => scripts.has(i))) {
    const owners = groups.filter((group) =>
      group.some(
        (i) =>
          isAdjacentTableScript(item, i) ||
          // A signed exponent may be split into a raised sign and raised digits.
          // Extend only an already attached script along its own tight baseline.
          (scripts.has(i) &&
            Math.abs(item.baseline - i.baseline) < Math.min(item.height, i.height) * 0.15 &&
            item.rect[0] - i.rect[2] >= -i.height * 0.1 &&
            item.rect[0] - i.rect[2] <= i.height * 0.35)
      )
    )
    if (owners.length !== 1) return
    owners[0].push(item)
  }
  return hasUniqueRecordTokens(source, groups) ? groups : undefined
}

// Native group underlines partition a wrapped parent title from its children.
// Single-column headers occupy both bands; every glyph must have one owner.
export function recoverRuledHeaderBands(source, cuts, rules, top, bottom) {
  const insetParents = recoverInsetParentHeaderBands(source, cuts, rules, top, bottom)
  if (insetParents) return insetParents
  const sharedCounts = recoverSharedSampleCountHeaderBands(source, cuts, rules, top, bottom)
  if (sharedCounts) return sharedCounts
  const counts = recoverSampleCountHeaderBands(source, cuts, top, bottom)
  if (counts) return counts
  const siblings = recoverSiblingHeaderBands(source, cuts, rules, top, bottom)
  if (siblings) return siblings
  const faces = recoverClosedNativeHeaderBands(source, cuts, rules, top, bottom)
  if (faces) return faces
  const hierarchy = recoverNativeHeaderHierarchy(source, cuts, rules, top, bottom)
  if (hierarchy) return hierarchy
  const left = cuts[0],
    right = cuts.at(-1),
    height = Math.max(...source.map((i) => i.height))
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const firstInk = Math.min(...source.map((i) => i.rect[1]))
  const nativeTops = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[1] >= top &&
      r[1] < firstInk &&
      r[1] - top < height &&
      r[0] <= left + height &&
      r[2] >= right - height
  )
  const parentTop = nativeTops.length === 1 ? nativeTops[0][1] : top
  const parents = joinHorizontalTableRules(rules)
    // Touching underlines can belong to different parents when a native
    // vertical border divides the upper tier. Leaf dividers start below it.
    .flatMap((r) => {
      const xs = [
        ...new Set(
          rules
            .filter(
              (v) =>
                v[0] === v[2] &&
                v[0] > r[0] + 1 &&
                v[0] < r[2] - 1 &&
                v[1] <= parentTop + height * 0.05 &&
                v[3] >= r[1] - 1
            )
            .map((v) => v[0])
        )
      ].sort((a, b) => a - b)
      return [r[0], ...xs].map((x, n) => [x, r[1], xs[n] ?? r[2], r[3]])
    })
    .filter(
      (r) => r[1] === r[3] && r[1] > top && r[1] < bottom && r[2] - r[0] < (right - left) * 0.85
    )
    .flatMap((r) => {
      const above = source.filter(
        (i) =>
          i.rect[3] <= r[1] + height * 0.1 &&
          ((i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1) ||
            // A centered heading can slightly overhang its own underline.
            // Keep the tolerance font-relative and require the same center;
            // nearby text still cannot borrow another group's rule.
            (i.rect[0] >= r[0] - height * 0.2 &&
              i.rect[2] <= r[2] + height * 0.2 &&
              Math.abs((i.rect[0] + i.rect[2] - r[0] - r[2]) / 2) < height * 0.5))
      )
      const below = source.filter((i) => {
        if ((i.rect[1] + i.rect[3]) / 2 <= r[1]) return false
        if (i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1) return true
        const c = col(i)
        // Insets at an underline's ends need not match a leaf's font box.
        // Only a complete, uniquely contained leaf may overhang slightly;
        // its parent must share the native stroke's center.
        return (
          c >= 0 &&
          i.rect[0] >= cuts[c] &&
          i.rect[2] <= cuts[c + 1] &&
          i.rect[0] >= r[0] - i.height * 0.2 &&
          i.rect[2] <= r[2] + i.height * 0.2 &&
          (i.rect[0] + i.rect[2]) / 2 > r[0] &&
          (i.rect[0] + i.rect[2]) / 2 < r[2] &&
          above.length > 0 &&
          Math.abs((union(above)[0] + union(above)[2] - r[0] - r[2]) / 2) < height * 0.5
        )
      })
      const columns = [...new Set(below.map(col))].sort((a, b) => a - b)
      if (
        !above.length ||
        columns.length < 1 ||
        columns.some((c, n) => n && c !== columns[n - 1] + 1) ||
        above.some((i) => !columns.includes(col(i)))
      )
        return []
      const parent = { rule: r, above, column: columns[0], colSpan: columns.length }
      // A continuous stroke can underline several independent parent cells.
      // Repeated complete leaf roles and native leaf-width border segments
      // establish their partition; separate names alone do not prove a span.
      const labels = readSourceRow(below, cuts)?.slice(
        parent.column,
        parent.column + parent.colSpan
      )
      for (let size = 2; size <= 4; size++) {
        if (
          columns.length < size * 3 ||
          columns.length % size ||
          !labels?.every((s, n) => /\p{L}/u.test(s) && s === labels[n % size]) ||
          new Set(labels.slice(0, size)).size !== size
        )
          continue
        const strokes = rules.filter((s) => s[1] === s[3])
        const firstInk = Math.min(...above.map((i) => i.rect[1]))
        const nativeLeaves = columns.every((c) =>
          [top, bottom].every((y, n) =>
            strokes.some(
              (s) =>
                (n ? Math.abs(s[1] - y) < height * 0.1 : s[1] >= y && s[1] < firstInk) &&
                Math.abs(s[0] - cuts[c]) < height &&
                Math.abs(s[2] - cuts[c + 1]) < height
            )
          )
        )
        if (!nativeLeaves) continue
        const groups = Array.from({ length: columns.length / size }, (_, n) => {
          const column = parent.column + n * size
          return {
            rule: r,
            column,
            colSpan: size,
            above: above.filter(
              (i) =>
                i.rect[0] >= cuts[column] - height * 0.5 &&
                i.rect[2] <= cuts[column + size] + height * 0.5
            )
          }
        })
        if (
          groups.every((g) => {
            if (!g.above.some((i) => /\p{L}{2}/u.test(i.text))) return false
            const rect = union(g.above)
            return (
              Math.abs((rect[0] + rect[2] - cuts[g.column] - cuts[g.column + size]) / 2) < height &&
              Math.max(...g.above.map((i) => i.baseline)) -
                Math.min(...g.above.map((i) => i.baseline)) <
                height * 0.2
            )
          }) &&
          hasUniqueRecordTokens(
            above,
            groups.map((g) => g.above)
          )
        )
          return groups
      }
      return [parent]
    })
    .sort((a, b) => a.column - b.column)
  if (!parents.length) return { rows: [[left, top, right, bottom]], spans: [] }
  if (parents.some((p, n) => n && p.column < parents[n - 1].column + parents[n - 1].colSpan)) return
  let split = parents[0].rule[1]
  if (parents.some((p) => Math.abs(p.rule[1] - split) > height * 0.2)) {
    // Sibling underlines may be staggered without introducing another tier.
    // Use their shared glyph-free gap only when every parent and child agrees;
    // an underline alone must not move text across a logical row boundary.
    const upper = parents.flatMap((p) => p.above)
    const lower = source.filter((i) => !upper.includes(i))
    const upperBottom = Math.max(...upper.map((i) => i.rect[3]))
    const lowerTop = Math.min(...lower.map((i) => i.rect[1]))
    const ys = parents.map((p) => p.rule[1])
    if (
      parents.length < 2 ||
      parents.some((p) => p.colSpan < 2) ||
      Math.max(...ys) - Math.min(...ys) > height ||
      !lower.length ||
      lowerTop <= upperBottom ||
      lowerTop - upperBottom > height ||
      parents.some((p) =>
        lower.some(
          (i) => col(i) >= p.column && col(i) < p.column + p.colSpan && i.rect[1] <= p.rule[1]
        )
      )
    )
      return
    split = (upperBottom + lowerTop) / 2
  }
  const rows = [
    [left, top, right, split],
    [left, split, right, bottom]
  ]
  const spans = parents.map((p) => ({ row: 0, column: p.column, rowSpan: 1, colSpan: p.colSpan }))
  const vertical = rules.filter((r) => r[0] === r[2])
  const horizontal = rules.filter((r) => r[1] === r[3])
  const borders = clusterTableRulePositions(vertical.map((r) => r[0])).filter(
    (x) => classifyTableRuleEdge(vertical, 0, x, top, bottom) === 1
  )
  const enclosedAcrossTiers = (c) => {
    // Glyph centers do not identify a merged header's row: a centered title
    // can sit below the parent underline. Require a uniquely enclosed native
    // cell and no internal stroke, including partial strokes, before merging.
    const sides = [cuts[c], cuts[c + 1]].map((cut) =>
      borders.filter((x) => Math.abs(x - cut) < height)
    )
    if (sides.some((xs) => xs.length !== 1)) return false
    const [start, end] = sides.map((xs) => xs[0])
    const own = source.filter((i) => col(i) === c)
    return (
      start < end &&
      own.length > 0 &&
      own.every((i) => i.rect[0] >= start && i.rect[2] <= end) &&
      [top, bottom].every((y) => classifyTableRuleEdge(horizontal, 1, y, start, end) === 1) &&
      classifyTableRuleEdge(horizontal, 1, split, start + 1, end - 1) === 0
    )
  }
  for (let c = 0; c < cuts.length - 1; c++)
    if (
      !parents.some((p) => c >= p.column && c < p.column + p.colSpan) &&
      (source.some((i) => col(i) === c && (i.rect[1] + i.rect[3]) / 2 < split) ||
        enclosedAcrossTiers(c)) &&
      !source.some(
        (i) =>
          col(i) === c &&
          i.rect[1] > split &&
          /^[\p{L}]$/u.test(i.text) &&
          source.filter(
            (other) =>
              col(other) !== c &&
              other.text === i.text &&
              Math.abs(other.baseline - i.baseline) < height * 0.2
          ).length >= 2
      )
    )
      spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
  const owners = []
  for (const p of parents) {
    owners.push(p.above)
    for (let c = p.column; c < p.column + p.colSpan; c++)
      owners.push(
        source.filter(
          (i) => col(i) === c && !p.above.includes(i) && (i.rect[1] + i.rect[3]) / 2 > split
        )
      )
  }
  for (let c = 0; c < cuts.length - 1; c++)
    if (!parents.some((p) => c >= p.column && c < p.column + p.colSpan))
      owners.push(source.filter((i) => col(i) === c))
  if (
    !hasUniqueRecordTokens(
      source,
      owners.filter((g) => g.length)
    )
  )
    return
  return { rows, spans }
}

// Short underlines cover the ink of left-aligned population titles, while
// repeated leaf roles and native leaf-width footer strokes prove the full
// population lanes. Never extend a title from its text meaning alone.
function recoverInsetParentHeaderBands(source, cuts, rules, top, bottom) {
  if (!source.length || cuts.length < 8) return
  const height = Math.max(...source.map((i) => i.height))
  const footer = rules
    .filter((r) => r[1] === r[3] && Math.abs(r[1] - bottom) < height * 0.1)
    .sort((a, b) => a[0] - b[0])
  if (
    footer.length !== cuts.length - 1 ||
    Math.abs(footer[0][0] - cuts[0]) > height * 1.5 ||
    Math.abs(footer.at(-1)[2] - cuts.at(-1)) > height * 1.5 ||
    footer.some(
      (r, n) =>
        n &&
        (Math.abs(r[1] - footer[0][1]) > height * 0.05 ||
          Math.abs(r[0] - footer[n - 1][2]) > height * 0.1)
    )
  )
    return
  const ys = [
    ...new Set(rules.filter((r) => r[1] === r[3] && r[1] > top && r[1] < bottom).map((r) => r[1]))
  ]
  for (const split of ys) {
    const parents = source.filter((i) => i.rect[3] < split).sort((a, b) => a.rect[0] - b.rect[0])
    const leaves = source.filter((i) => i.rect[1] > split).sort((a, b) => a.rect[0] - b.rect[0])
    if (
      parents.length !== 2 ||
      leaves.length !== cuts.length - 2 ||
      leaves.length % 2 ||
      leaves.length < 6 ||
      !hasUniqueRecordTokens(source, [parents, leaves]) ||
      leaves.some(
        (i) => !/\p{L}/u.test(i.text) || Math.abs(i.baseline - leaves[0].baseline) > height * 0.2
      )
    )
      continue
    const size = leaves.length / 2
    if (
      leaves.slice(1, size).some((i, n) => i.text !== leaves[size + n + 1].text) ||
      new Set(leaves.slice(1, size).map((i) => i.text)).size < 2 ||
      leaves.some(
        (i, n) =>
          i.rect[0] < footer[n + 1][0] - 1 ||
          i.rect[2] > footer[n + 1][2] + 1 ||
          cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x) !== n + 1
      ) ||
      parents.some(
        (i, n) =>
          Math.abs(i.rect[0] - leaves[n * size].rect[0]) > height * 0.1 ||
          !rules.some(
            (r) =>
              r[1] === r[3] &&
              Math.abs(r[1] - split) < height * 0.05 &&
              Math.abs(r[0] - i.rect[0]) < height * 0.1 &&
              r[2] >= i.rect[2] &&
              r[2] < footer[(n + 1) * size][2] - height
          )
      )
    )
      continue
    return {
      rows: [
        [cuts[0], top, cuts.at(-1), split],
        [cuts[0], split, cuts.at(-1), bottom]
      ],
      spans: [
        { row: 0, column: 1, rowSpan: 1, colSpan: size },
        { row: 0, column: size + 1, rowSpan: 1, colSpan: size }
      ]
    }
  }
}

// A shared count title may underline its two sample-qualified treatment
// leaves with separate drawing commands. Their small native gap belongs to
// this explicit parent only; it does not merge unrelated sibling headings.
export function recoverSharedSampleCountHeaderBands(source, cuts, rules, top, bottom) {
  const cohortPair = recoverUnderlinedCohortPairHeaderBands(source, cuts, rules, top, bottom)
  if (cohortPair) return cohortPair
  if (cuts.length < 4 || cuts.length > 8 || !source.length) return
  const height = Math.max(...source.map((i) => i.height))
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const samples = source
    .filter((i) => /\p{L}{3}.*\(n\s*=\s*\d+\)$/iu.test(i.text))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    samples.length !== 2 ||
    col(samples[1]) !== col(samples[0]) + 1 ||
    Math.abs(samples[0].baseline - samples[1].baseline) > height * 0.2
  )
    return
  const start = col(samples[0]),
    end = start + 2
  if (start < 1 || samples.some((i) => i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1]))
    return
  const parent = source.filter(
    (i) =>
      !samples.includes(i) &&
      i.rect[3] < Math.min(...samples.map((s) => s.rect[1])) &&
      i.rect[0] >= cuts[start] &&
      i.rect[2] <= cuts[end]
  )
  const parentText = parent
    .map((i) => i.text)
    .join('')
    .replace(/\s/g, '')
  const box = parent.length && union(parent)
  if (
    !box ||
    !/^Numberof(?:patients|participants|subjects)\(%\)$/i.test(parentText) ||
    box[0] >= cuts[start + 1] ||
    box[2] <= cuts[start + 1]
  )
    return
  const strokes = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > box[3] &&
        r[1] < Math.min(...samples.map((s) => s.rect[1])) &&
        r[0] >= cuts[start] &&
        r[2] <= cuts[end]
    )
    .sort((a, b) => a[0] - b[0])
  if (
    strokes.length !== 2 ||
    Math.abs(strokes[0][1] - strokes[1][1]) > 0.01 ||
    strokes[1][0] - strokes[0][2] < 0 ||
    strokes[1][0] - strokes[0][2] > height * 0.1 ||
    strokes.some(
      (r, n) =>
        Math.abs(r[0] - cuts[start + n]) > height ||
        Math.abs(r[2] - cuts[start + n + 1]) > height ||
        samples[n].rect[0] < r[0] ||
        samples[n].rect[2] > r[2]
    )
  )
    return
  const split = strokes[0][1]
  const others = source.filter((i) => !samples.includes(i) && !parent.includes(i))
  if (
    others.some(
      (i) =>
        col(i) < 0 ||
        (col(i) >= start && col(i) < end) ||
        i.rect[0] < cuts[col(i)] ||
        i.rect[2] > cuts[col(i) + 1] ||
        !/\p{L}/u.test(i.text)
    )
  )
    return
  const outside = cuts
    .slice(1)
    .map((_, c) => others.filter((i) => col(i) === c))
    .filter((g) => g.length)
  if (!hasUniqueRecordTokens(source, [parent, ...samples.map((i) => [i]), ...outside])) return
  return {
    rows: [
      [cuts[0], top, cuts.at(-1), split],
      [cuts[0], split, cuts.at(-1), bottom]
    ],
    spans: [
      { row: 0, column: start, rowSpan: 1, colSpan: 2 },
      ...outside.map((g) => ({ row: 0, column: col(g[0]), rowSpan: 2, colSpan: 1 }))
    ]
  }
}

// A left-aligned group title owns two sample-qualified leaves when its native
// underline starts with the first leaf and ends with the second. A fragmentary
// text run is read as native tokens, never rewritten into a fabricated header.
export function recoverUnderlinedCohortPairHeaderBands(source, cuts, rules, top, bottom) {
  if (cuts.length < 4 || cuts.length > 8 || !source.length) return
  const height = Math.max(...source.map((i) => i.height))
  for (const rule of joinHorizontalTableRules(rules).filter(
    (r) => r[1] > top && r[1] < bottom && r[2] - r[0] < (cuts.at(-1) - cuts[0]) * 0.85
  )) {
    const parent = source.filter(
      (i) => i.rect[3] < rule[1] && i.rect[0] >= rule[0] - 1 && i.rect[2] <= rule[2] + 1
    )
    if (
      parent.length !== 1 ||
      parent[0].text !== 'Group' ||
      Math.abs(parent[0].rect[0] - rule[0]) > height * 0.1
    )
      continue
    const leaves = cuts.slice(1).flatMap((x, column) => {
      const tokens = source.filter(
        (i) =>
          i.rect[1] > rule[1] &&
          i.rect[0] >= cuts[column] &&
          i.rect[2] <= x &&
          i.rect[0] >= rule[0] - 1 &&
          i.rect[2] <= rule[2] + 1
      )
      const text = readSourceRow(tokens, cuts, { multiline: true })?.[column]?.replace(/\s/g, '')
      return text && /^\p{L}{3}.*\(n=\d+\)$/iu.test(text) ? [{ column, tokens }] : []
    })
    if (leaves.length !== 2 || leaves[1].column !== leaves[0].column + 1) continue
    const lower = leaves.flatMap((g) => g.tokens),
      box = union(lower)
    if (
      Math.abs(box[0] - rule[0]) > height * 0.1 ||
      Math.abs(box[2] - rule[2]) > height * 0.1 ||
      box[3] - box[1] > height * 1.5 ||
      box[1] - parent[0].rect[3] > height * 2 ||
      lower.some((i) => Math.abs(i.height - height) > height * 0.1)
    )
      continue
    const start = leaves[0].column,
      end = leaves[1].column + 1
    const others = source.filter((i) => !parent.includes(i) && !lower.includes(i))
    const outside = cuts
      .slice(1)
      .map((x, c) => others.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= x))
      .filter((g) => g.length)
    if (
      others.some((i) => i.rect[0] < cuts[end] && i.rect[2] > cuts[start]) ||
      !outside.every((g) => /\p{L}/u.test(g.map((i) => i.text).join(''))) ||
      !hasUniqueRecordTokens(source, [parent, ...leaves.map((g) => g.tokens), ...outside])
    )
      continue
    return {
      rows: [
        [cuts[0], top, cuts.at(-1), rule[1]],
        [cuts[0], rule[1], cuts.at(-1), bottom]
      ],
      spans: [
        { row: 0, column: start, rowSpan: 1, colSpan: 2 },
        ...outside.map((g) => ({
          row: 0,
          column: cuts.slice(1).findIndex((x) => (g[0].rect[0] + g[0].rect[2]) / 2 < x),
          rowSpan: 2,
          colSpan: 1
        }))
      ]
    }
  }
}

// Sample-qualified cohort titles and repeated count/percentage leaves can
// establish a two-tier header without parent underlines. All native glyphs
// must fit one group; unrelated text and incomplete repeated pairs decline.
export function recoverSampleCountHeaderBands(source, cuts, top, bottom) {
  if (!source.length || cuts.length < 6 || cuts.length > 10) return
  const height = Math.max(...source.map((i) => i.height))
  const leaves = source
    .filter((i) => /^(?:No\.|n|%)$/i.test(i.text.trim()))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    leaves.length < 4 ||
    leaves.length % 2 ||
    leaves.some((i) => Math.abs(i.baseline - leaves[0].baseline) > height * 0.15)
  )
    return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const start = col(leaves[0])
  if (
    start < 1 ||
    leaves.some(
      (i, n) =>
        col(i) !== start + n ||
        i.rect[0] < cuts[col(i)] ||
        i.rect[2] > cuts[col(i) + 1] ||
        (n % 2 ? i.text !== '%' : !/^(?:No\.|n)$/i.test(i.text))
    )
  )
    return
  const leafTop = Math.min(...leaves.map((i) => i.rect[1]))
  const parents = []
  for (let n = 0; n < leaves.length; n += 2) {
    const c = start + n
    const group = source.filter(
      (i) =>
        !leaves.includes(i) &&
        i.rect[3] < leafTop &&
        i.rect[0] >= cuts[c] &&
        i.rect[2] <= cuts[c + 2]
    )
    const text = [...group]
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
    if (
      !group.length ||
      !/\p{L}{3}/u.test(text) ||
      !/\(n=\d+\)$/i.test(text) ||
      Math.max(...group.map((i) => i.baseline)) - Math.min(...group.map((i) => i.baseline)) >
        height * 1.5
    )
      return
    parents.push(group)
  }
  const parentBottom = Math.max(...parents.flat().map((i) => i.rect[3]))
  if (
    leafTop <= parentBottom ||
    leafTop - parentBottom > height * 2 ||
    bottom - Math.max(...leaves.map((i) => i.rect[3])) > height * 2
  )
    return
  const others = source.filter((i) => !leaves.includes(i) && !parents.flat().includes(i))
  const end = start + leaves.length
  if (
    others.some(
      (i) =>
        col(i) < 0 ||
        (col(i) >= start && col(i) < end) ||
        i.rect[0] < cuts[col(i)] ||
        i.rect[2] > cuts[col(i) + 1] ||
        !/\p{L}/u.test(i.text)
    )
  )
    return
  if (
    !hasUniqueRecordTokens(source, [
      ...parents,
      leaves,
      ...cuts
        .slice(1)
        .map((_, c) => others.filter((i) => col(i) === c))
        .filter((g) => g.length)
    ])
  )
    return
  const split = (parentBottom + leafTop) / 2
  return {
    rows: [
      [cuts[0], top, cuts.at(-1), split],
      [cuts[0], split, cuts.at(-1), bottom]
    ],
    spans: [
      ...parents.map((_, n) => ({ row: 0, column: start + n * 2, rowSpan: 1, colSpan: 2 })),
      ...[...new Set(others.map(col))].map((column) => ({ row: 0, column, rowSpan: 2, colSpan: 1 }))
    ]
  }
}

// Multiple native underline tiers (or separated, left-aligned parent bands)
// describe a tree over leaf columns. Construct that tree before consulting
// overlapping model spans; each source token must have exactly one owner.
export function recoverNativeHeaderHierarchy(source, cuts, rules, top, bottom) {
  if (!source.length || cuts.length < 3) return
  const height = Math.max(...source.map((i) => i.height))
  // A crop may include blank space above a native table frame. Its unique
  // full-width border before all header ink fixes the physical first tier.
  const firstInk = Math.min(...source.map((i) => i.rect[1]))
  const nativeTops = [
    ...new Set(
      joinHorizontalTableRules(rules)
        .filter(
          (r) =>
            r[1] === r[3] &&
            r[1] >= top &&
            r[1] < firstInk &&
            r[1] - top < height &&
            r[0] <= cuts[0] + 1 &&
            r[2] >= cuts.at(-1) - 1
        )
        .map((r) => r[1])
    )
  ]
  if (nativeTops.length === 1) top = nativeTops[0]
  // A later native body border may be close to the predicted header bottom.
  // Reject it when one baseline already forms a labeled numerical record;
  // sample-qualified population headings retain their explicit n/N markers.
  const physical = groupSourceRowsWithScripts(
    [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    height,
    0.35
  )
  if (
    physical?.some((g) => {
      const v = readSourceRow(g, cuts)
      const values = v?.slice(1).filter(Boolean)
      return (
        v &&
        /\p{L}/u.test(v[0]) &&
        values.length >= 2 &&
        values.every((s) => /^(?:[<>≤≥−+-]?\d[\d.,()%±–−+/-]*[*†‡§#]?|[–—-])$/.test(s))
      )
    })
  )
    return
  const left = cuts[0],
    right = cuts.at(-1)
  // Per-cell drawing commands can leave subpixel joins in one underline.
  // Use the same bounded stroke tolerance as native edge classification.
  const lines = joinHorizontalTableRules(rules, Math.min(1, height * 0.05)).filter(
    (r) =>
      r[1] > top &&
      r[1] < bottom &&
      r[2] - r[0] < (right - left) * 0.9 &&
      source.some(
        (i) => i.rect[3] <= r[1] + height * 0.1 && i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1
      ) &&
      source.some(
        (i) =>
          i.rect[1] >= r[1] - height * 0.05 &&
          (i.rect[1] + i.rect[3]) / 2 > r[1] &&
          i.rect[0] >= r[0] - 1 &&
          i.rect[2] <= r[2] + 1
      )
  )
  let splits = [...new Set(lines.map((r) => r[1]))].sort((a, b) => a - b)
  splits = splits.filter((y, n) => !n || y - splits[n - 1] > height * 0.2)
  if (!splits.length) {
    const baselines = [
      ...new Set(source.filter((i) => i.height > height * 0.85).map((i) => i.baseline))
    ].sort((a, b) => a - b)
    for (let n = 1; n < baselines.length; n++)
      if (baselines[n] - baselines[n - 1] > height * 1.65)
        splits.push((baselines[n] - height + baselines[n - 1]) / 2)
    // Whitespace alone needs at least two parent levels and a broad root.
    if (
      splits.length !== 2 ||
      !source.some((i) => i.rect[3] < splits[0] && i.rect[2] - i.rect[0] > height * 10)
    )
      return
  } else if (splits.length < 2) return
  if (splits.length > 3) return
  const ys = [top, ...splits, bottom],
    spans = [],
    owned = []
  let regions = [{ start: 0, end: cuts.length - 1 }]
  const rowOf = (i) => ys.slice(1).findIndex((y) => (i.rect[1] + i.rect[3]) / 2 < y)
  for (let row = 0; row < ys.length - 1; row++) {
    const next = []
    for (const region of regions) {
      const tokens = source.filter(
        (i) =>
          rowOf(i) === row &&
          i.rect[0] >= cuts[region.start] - 1 &&
          i.rect[2] <= cuts[region.end] + 1
      )
      const descendants = source.filter(
        (i) =>
          rowOf(i) > row && i.rect[0] >= cuts[region.start] - 1 && i.rect[2] <= cuts[region.end] + 1
      )
      if (!tokens.length) {
        next.push(region)
        continue
      }
      const native = lines.filter(
        (r) =>
          Math.abs(r[1] - ys[row + 1]) < height * 0.2 &&
          r[0] >= cuts[region.start] - height &&
          r[2] <= cuts[region.end] + height
      )
      const nodes = []
      for (const r of native) {
        const group = tokens.filter((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
        const leafCols = cuts
          .slice(1)
          .flatMap((x, c) =>
            c >= region.start &&
            c < region.end &&
            descendants.some(
              (i) =>
                i.rect[0] >= r[0] - 1 &&
                i.rect[2] <= r[2] + 1 &&
                (i.rect[0] + i.rect[2]) / 2 >= cuts[c] &&
                (i.rect[0] + i.rect[2]) / 2 < x
            )
              ? [c]
              : []
          )
        if (!group.length || !leafCols.length) continue
        const siblings = leafCols.map((c) => ({
          start: c,
          end: c + 1,
          tokens: group.filter((i) => i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + 1]),
          children: descendants.filter(
            (i) =>
              i.rect[0] >= cuts[c] &&
              i.rect[2] <= cuts[c + 1] &&
              i.rect[0] >= r[0] - 1 &&
              i.rect[2] <= r[2] + 1
          )
        }))
        if (
          row > 0 &&
          siblings.length >= 2 &&
          siblings.every(
            (s) =>
              s.tokens.some((i) => /\p{L}{3}/u.test(i.text)) &&
              /^N=\d+$/i.test(
                s.children
                  .map((i) => i.text)
                  .join('')
                  .replace(/\s/g, '')
              )
          ) &&
          hasUniqueRecordTokens(
            group,
            siblings.map((s) => s.tokens)
          ) &&
          new Set(siblings.map((s) => s.tokens.map((i) => i.text).join(''))).size ===
            siblings.length
        )
          nodes.push(...siblings)
        else nodes.push({ start: leafCols[0], end: leafCols.at(-1) + 1, tokens: group })
      }
      for (const i of tokens
        .filter((i) => !nodes.some((n) => n.tokens.includes(i)))
        .sort((a, b) => a.rect[0] - b.rect[0])) {
        const start = cuts.slice(1).findIndex((x) => i.rect[0] < x - 0.1)
        if (start < region.start || start >= region.end) return
        // Adjacent scripts still belong to their unruled statistic heading
        // when neighboring cohort headings have native underlines.
        let node = nodes.find(
          (n) =>
            (!native.length && n.start === start) ||
            n.tokens.some(
              (t) =>
                isAdjacentTableScript(i, t) ||
                (Math.abs(t.baseline - i.baseline) < height * 0.2 &&
                  i.rect[0] >= t.rect[2] - 0.1 &&
                  i.rect[0] - t.rect[2] < height * 0.25)
            )
        )
        if (!node) {
          node = { start, end: start + 1, tokens: [] }
          nodes.push(node)
        }
        node.tokens.push(i)
      }
      nodes.sort((a, b) => a.start - b.start)
      for (let n = 0; n < nodes.length; n++) {
        const node = nodes[n],
          limit = nodes[n + 1]?.start ?? region.end
        if (!native.length && row < ys.length - 2) node.end = limit
        if (
          node.end > limit ||
          node.start < region.start ||
          node.tokens.some((i) => i.rect[2] > cuts[node.end] + 1)
        )
          return
        let rowSpan = 1
        if (
          node.end - node.start === 1 &&
          !descendants.some(
            (i) => i.rect[0] >= cuts[node.start] - 1 && i.rect[2] <= cuts[node.end] + 1
          )
        )
          rowSpan = ys.length - 1 - row
        spans.push({ row, column: node.start, rowSpan, colSpan: node.end - node.start })
        owned.push(node.tokens)
        if (rowSpan === 1) next.push({ start: node.start, end: node.end })
      }
      // A stub may be printed only beside the leaf tier.
      let cursor = region.start
      for (const node of nodes) {
        if (node.start > cursor) next.push({ start: cursor, end: node.start })
        cursor = node.end
      }
      if (cursor < region.end) next.push({ start: cursor, end: region.end })
    }
    regions = next
  }
  if (!hasUniqueRecordTokens(source, owned)) return
  return { rows: ys.slice(1).map((y, n) => [left, ys[n], right, y]), spans }
}

// Some native frames partition the top by parent cells and the bottom by
// leaves. A wrapped title crossing a leaf cut and complete, aligned children
// prove the hierarchy without inventing an underline between the two tiers.
export function recoverSplitBorderHeaderBands(source, cuts, rules, top, bottom) {
  if (
    !source.length ||
    cuts.length < 4 ||
    cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))
  )
    return
  const height = Math.max(...source.map((i) => i.height))
  if (
    !(height > 0) ||
    source.some((i) => !i.horizontal || Math.abs(i.height - height) > height * 0.2)
  )
    return
  const first = Math.min(...source.map((i) => i.rect[1]))
  const partition = (y) =>
    rules
      .filter((r) => r[1] === r[3] && Math.abs(r[1] - y) < height * 0.01)
      .sort((a, b) => a[0] - b[0])
  const upper = rules.filter(
    (r) => r[1] === r[3] && r[1] >= top && Math.abs(r[1] - first) < height * 0.1
  )
  if (!upper.length) return
  const edges = partition(upper[0][1]),
    leaves = partition(bottom)
  const contiguous = (lines) =>
    lines.length >= 2 &&
    Math.abs(lines[0][0] - cuts[0]) < height * 0.5 &&
    Math.abs(lines.at(-1)[2] - cuts.at(-1)) < height * 0.5 &&
    lines.every(
      (r, n) =>
        r[2] > r[0] && (!n || (r[0] >= lines[n - 1][2] && r[0] - lines[n - 1][2] < height * 0.1))
    )
  if (
    !contiguous(edges) ||
    !contiguous(leaves) ||
    leaves.length !== cuts.length - 1 ||
    edges.length >= leaves.length ||
    leaves.some(
      (r, c) =>
        Math.abs(r[0] - cuts[c]) > height * 0.5 || Math.abs(r[2] - cuts[c + 1]) > height * 0.5
    )
  )
    return
  const spans = [],
    owned = [],
    splits = []
  let column = 0
  for (const edge of edges) {
    const start = column
    if (Math.abs(edge[0] - leaves[start]?.[0]) > height * 0.1) return
    while (column < leaves.length && leaves[column][2] < edge[2] - height * 0.1) column++
    if (column >= leaves.length || Math.abs(leaves[column][2] - edge[2]) > height * 0.1) return
    const end = ++column
    const group = source.filter((i) => i.rect[0] >= edge[0] && i.rect[2] <= edge[2])
    if (!group.length || !group.some((i) => /\p{L}/u.test(i.text))) return
    if (end - start === 1) {
      if (!readSourceRow(group, cuts)?.[start]) return
      spans.push({ row: 0, column: start, rowSpan: 2, colSpan: 1 })
      owned.push(group)
      continue
    }
    const crossing = group.filter((i) =>
      cuts.slice(start + 1, end).some((x) => i.rect[0] < x && i.rect[2] > x)
    )
    if (!crossing.length) return
    const upperBottom = Math.max(...crossing.map((i) => i.rect[3]))
    const children = group.filter((i) => i.rect[1] > upperBottom)
    if (!children.length) return
    const childTop = Math.min(...children.map((i) => i.rect[1]))
    if (childTop - upperBottom > height || childTop - upperBottom < height * 0.05) return
    const names = group.filter((i) => i.rect[3] <= upperBottom)
    const nameRect = union(names)
    const labels = readSourceRow(children, cuts, { multiline: true })?.slice(start, end)
    if (
      !hasUniqueRecordTokens(group, [names, children]) ||
      !names.some((i) => /\p{L}{2}/u.test(i.text)) ||
      Math.abs(nameRect[0] + nameRect[2] - edge[0] - edge[2]) > height ||
      !labels?.every((s) => /\p{L}/u.test(s) && !/\d/u.test(s)) ||
      new Set(labels).size !== labels.length
    )
      return
    const childBands = Array.from({ length: end - start }, (_, n) =>
      union(
        children.filter((i) => i.rect[0] >= cuts[start + n] && i.rect[2] <= cuts[start + n + 1])
      )
    )
    if (
      childBands.some(
        (r) =>
          Math.abs(r[1] - childBands[0][1]) > height * 0.1 ||
          Math.abs(r[3] - childBands[0][3]) > height * 0.1
      ) ||
      rules.some(
        (r) =>
          r[0] < edge[2] &&
          r[2] > edge[0] &&
          r[1] > upper[0][1] + height * 0.1 &&
          r[1] < bottom - height * 0.1
      )
    )
      return
    splits.push((upperBottom + childTop) / 2)
    spans.push({ row: 0, column: start, rowSpan: 1, colSpan: end - start })
    owned.push(names, children)
  }
  if (
    column !== leaves.length ||
    !splits.length ||
    splits.some((y) => Math.abs(y - splits[0]) > height * 0.1) ||
    !hasUniqueRecordTokens(source, owned)
  )
    return
  return {
    rows: [
      [cuts[0], top, cuts.at(-1), splits[0]],
      [cuts[0], splits[0], cuts.at(-1), bottom]
    ],
    spans
  }
}

// Segmented parent frames may include narrow, empty spacers, with separate
// leaf strokes only below the entire header. Repeated complete leaf labels
// and a common glyph-free tier boundary corroborate the native partitions.
export function recoverSegmentedCohortHeaderBands(source, cuts, rules, top, bottom) {
  if (
    !source.length ||
    cuts.length < 7 ||
    cuts.some((x, n) => !Number.isFinite(x) || (n && x <= cuts[n - 1]))
  )
    return
  const height = Math.max(...source.map((i) => i.height)),
    first = Math.min(...source.map((i) => i.rect[1])),
    centers = cuts.slice(1).map((x, c) => (cuts[c] + x) / 2)
  if (
    !(height > 0) ||
    source.some((i) => !i.horizontal || Math.abs(i.height - height) > height * 0.1)
  )
    return
  const topLines = rules
    .filter((r) => r[1] === r[3] && r[1] >= top && Math.abs(r[1] - first) < height * 0.1)
    .sort((a, b) => a[0] - b[0])
  if (
    topLines.length < 3 ||
    Math.abs(topLines[0][0] - cuts[0]) > height * 1.5 ||
    Math.abs(topLines.at(-1)[2] - cuts.at(-1)) > height * 1.5 ||
    topLines.some(
      (r, n) =>
        r[2] <= r[0] ||
        (n &&
          (Math.abs(r[1] - topLines[0][1]) > height * 0.01 ||
            r[0] < topLines[n - 1][2] ||
            r[0] - topLines[n - 1][2] > height * 0.1))
    )
  )
    return
  const parents = [],
    singles = [],
    owned = []
  for (const edge of topLines) {
    const columns = centers.flatMap((x, c) => (x >= edge[0] && x <= edge[2] ? [c] : []))
    const tokens = source.filter(
      (i) => i.rect[0] >= edge[0] - height * 0.05 && i.rect[2] <= edge[2] + height * 0.05
    )
    if (!columns.length) {
      if (tokens.length || edge[2] - edge[0] > height * 1.5) return
      continue
    }
    if (!tokens.length || columns.some((c, n) => n && c !== columns[n - 1] + 1)) return
    const node = { edge, tokens, start: columns[0], end: columns.at(-1) + 1 }
    if (columns.length === 1) {
      if (
        tokens.some(
          (i) =>
            i.rect[0] < cuts[node.start] || i.rect[2] > cuts[node.end] || !/\p{L}/u.test(i.text)
        )
      )
        return
      singles.push(node)
    } else parents.push(node)
    owned.push(tokens)
  }
  if (parents.length < 3 || !hasUniqueRecordTokens(source, owned)) return
  const leafLines = rules.filter((r) => r[1] === r[3] && Math.abs(r[1] - bottom) < height * 0.1)
  if (
    !centers.every((x, c) =>
      leafLines.some(
        (r) =>
          x >= r[0] &&
          x <= r[2] &&
          r[2] - r[0] >= (cuts[c + 1] - cuts[c]) * 0.5 &&
          Math.abs(r[0] - cuts[c]) < height * 1.5 &&
          Math.abs(r[2] - cuts[c + 1]) < height * 1.5
      )
    )
  )
    return
  const members = parents.flatMap((p) => p.tokens),
    candidates = []
  for (const y of [...new Set(members.map((i) => i.rect[3]))]) {
    const below = members.filter((i) => i.rect[1] > y)
    if (!below.length || members.some((i) => i.rect[1] <= y && i.rect[3] > y)) continue
    const next = Math.min(...below.map((i) => i.rect[1]))
    if (next - y > height) continue
    const labels = [],
      spans = []
    let valid = true
    for (const p of parents) {
      const upper = p.tokens.filter((i) => i.rect[3] <= y),
        lower = p.tokens.filter((i) => i.rect[1] >= next)
      const values = readSourceRow(lower, cuts)?.slice(p.start, p.end)
      const rect = upper.length && union(upper)
      if (
        !rect ||
        !values?.every((s) => /\p{L}/u.test(s)) ||
        new Set(values).size < 2 ||
        !upper.some((i) => /\p{L}{2}/u.test(i.text)) ||
        !upper.some((i) =>
          cuts.slice(p.start + 1, p.end).some((x) => i.rect[0] < x && i.rect[2] > x)
        ) ||
        Math.abs((rect[0] + rect[2] - p.edge[0] - p.edge[2]) / 2) > height * 0.5 ||
        rules.some(
          (r) =>
            r[1] > topLines[0][1] + height * 0.1 &&
            r[1] < bottom - height * 0.1 &&
            r[0] < p.edge[2] &&
            r[2] > p.edge[0]
        )
      ) {
        valid = false
        break
      }
      labels.push(values)
      spans.push({ row: 0, column: p.start, rowSpan: 1, colSpan: p.end - p.start })
    }
    if (!valid || labels.some((v) => JSON.stringify(v) !== JSON.stringify(labels[0]))) continue
    candidates.push({ split: (y + next) / 2, spans })
  }
  if (candidates.length !== 1) return
  const { split, spans } = candidates[0]
  spans.push(...singles.map((p) => ({ row: 0, column: p.start, rowSpan: 2, colSpan: 1 })))
  return {
    rows: [
      [cuts[0], top, cuts.at(-1), split],
      [cuts[0], split, cuts.at(-1), bottom]
    ],
    spans
  }
}

// Some publishers paint the top border once per parent cell, then draw one
// continuous underline below all parents. Preserve the native top segments
// when separate centered names and repeated child labels corroborate them.
export function recoverSegmentedParentBands(source, cuts, rules, top, bottom) {
  if (!source.length) return
  const height = Math.max(...source.map((i) => i.height))
  const first = Math.min(...source.map((i) => i.rect[1]))
  const edge = rules
    .filter((r) => r[1] === r[3] && r[1] >= top && r[1] < first && first - r[1] < height * 2)
    .sort((a, b) => a[0] - b[0])
  if (
    edge.length < 3 ||
    edge.some(
      (r, n) => n && (Math.abs(r[1] - edge[0][1]) > 0.1 || Math.abs(r[0] - edge[n - 1][2]) > 0.1)
    )
  )
    return
  const bands = joinHorizontalTableRules(rules).filter(
    (r) => r[1] > first && r[1] < bottom && r[0] > cuts[0] && r[2] < cuts.at(-1)
  )
  for (const line of bands) {
    const upper = source.filter((i) => i.rect[3] < line[1]),
      lower = source.filter((i) => i.rect[1] > line[1])
    if (!hasUniqueRecordTokens(source, [upper, lower])) continue
    const parents = []
    let valid = true
    for (const r of edge) {
      const names = upper.filter((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
      if (!names.length) continue
      const children = lower.filter((i) => i.rect[0] >= r[0] - 1 && i.rect[2] <= r[2] + 1)
      const cols = [
        ...new Set(
          children.map((i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x))
        )
      ].sort((a, b) => a - b)
      const rect = union(names)
      if (
        cols.length < 2 ||
        cols.some((c, n) => n && c !== cols[n - 1] + 1) ||
        Math.abs((rect[0] + rect[2] - r[0] - r[2]) / 2) > height ||
        !names.some((i) => /\p{L}{2}/u.test(i.text))
      ) {
        valid = false
        break
      }
      const labels = readSourceRow(children, cuts)?.slice(cols[0], cols.at(-1) + 1)
      if (!labels?.every((s) => /\p{L}/u.test(s))) {
        valid = false
        break
      }
      parents.push({
        members: names,
        labels,
        row: 0,
        column: cols[0],
        colSpan: cols.length,
        rowSpan: 1
      })
    }
    if (
      !valid ||
      parents.length < 2 ||
      !hasUniqueRecordTokens(
        upper,
        parents.map((p) => p.members)
      )
    )
      continue
    if (parents.some((p) => JSON.stringify(p.labels) !== JSON.stringify(parents[0].labels)))
      continue
    if (parents.some((p, n) => n && p.column < parents[n - 1].column + parents[n - 1].colSpan))
      continue
    const spans = parents.map((p) => ({
      row: p.row,
      column: p.column,
      rowSpan: p.rowSpan,
      colSpan: p.colSpan
    }))
    return {
      rows: [
        [cuts[0], top, cuts.at(-1), line[1]],
        [cuts[0], line[1], cuts.at(-1), bottom]
      ],
      spans
    }
  }
}

// Repeated leaf labels establish equal-sized child groups even without inset
// underlines. A third-level title must be centered over all those groups, not
// merely positioned above a single middle column.
export function recoverRepeatedHeaderHierarchy(source, cuts, top, bottom) {
  const height = Math.max(...source.map((i) => i.height)),
    baseline = Math.max(...source.map((i) => i.baseline))
  const leaves = source
    .filter((i) => Math.abs(i.baseline - baseline) < height * 0.2)
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (leaves.length < 6 || leaves.some((i) => !/^[\p{L} -]+$/u.test(i.text))) return
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  if (leaves.some((i, n) => n && col(i) !== col(leaves[n - 1]) + 1)) return
  const size = leaves.slice(1).findIndex((i) => i.text === leaves[0].text) + 1
  if (size < 2 || leaves.length % size || leaves.some((i, n) => i.text !== leaves[n % size].text))
    return
  const start = col(leaves[0]),
    end = col(leaves.at(-1)) + 1,
    parents = []
  for (let n = 0; n < leaves.length; n += size) {
    const a = col(leaves[n]),
      b = a + size
    const owner = source.filter(
      (i) =>
        !leaves.includes(i) &&
        i.rect[3] < union(leaves)[1] &&
        Math.abs((i.rect[0] + i.rect[2] - cuts[a] - cuts[b]) / 2) < height * 0.6
    )
    const lowest = owner.sort((a, b) => b.baseline - a.baseline)[0]
    if (!lowest || lowest.rect[0] < cuts[a] || lowest.rect[2] > cuts[b]) return
    parents.push(lowest)
  }
  if (parents.some((i) => Math.abs(i.baseline - parents[0].baseline) > height * 0.2)) return
  const roots = source.filter(
    (i) =>
      !parents.includes(i) &&
      i.rect[3] < union(parents)[1] &&
      i.rect[0] >= cuts[start] &&
      i.rect[2] <= cuts[end] &&
      Math.abs((i.rect[0] + i.rect[2] - cuts[start] - cuts[end]) / 2) < height * 0.6
  )
  if (roots.length !== 1) return
  const root = roots[0],
    others = source.filter((i) => !leaves.includes(i) && !parents.includes(i) && i !== root)
  if (others.some((i) => col(i) >= start && col(i) < end)) return
  const ys = [
    top,
    (root.rect[3] + union(parents)[1]) / 2,
    (union(parents)[3] + union(leaves)[1]) / 2,
    bottom
  ]
  const spans = [
    { row: 0, column: start, rowSpan: 1, colSpan: end - start },
    ...parents.map((_, n) => ({ row: 1, column: start + n * size, rowSpan: 1, colSpan: size }))
  ]
  for (let c = 0; c < cuts.length - 1; c++)
    if (c < start || c >= end) spans.push({ row: 0, column: c, rowSpan: 3, colSpan: 1 })
  return { rows: ys.slice(1).map((y, n) => [cuts[0], ys[n], cuts.at(-1), y]), spans }
}

// Split only a uniquely owned model row. Unlike strict column containment in
// readSourceRow, row repair uses glyph centers, matching cell assignment. The
// caller supplies ordered source groups and retains responsibility for deciding
// whether their labels/values justify a split. No source tokens are rewritten.
export function splitOwnedSourceRow(rows, items, upper, lower, bounds) {
  return splitOwnedSourceRows(rows, items, [upper, lower], bounds)
}

// The same ownership check applies when one model band contains several
// complete source records. Keep the pair interface for existing recognizers.
export function splitOwnedSourceRows(rows, items, groups, [left, right]) {
  const members = groups.flat()
  if (
    groups.length < 2 ||
    !hasUniqueRecordTokens(members, groups) ||
    members.some((i) => !items.includes(i))
  )
    return
  const owns = (row, item) => inside([left, row.rect[1], right, row.rect[3]], item)
  const owners = rows.filter((row) => members.every((item) => owns(row, item)))
  if (
    owners.length !== 1 ||
    items.some((item) => !members.includes(item) && owns(owners[0], item)) ||
    rows.some((row) => row !== owners[0] && members.some((item) => owns(row, item)))
  )
    return
  const rects = groups.map(union)
  if (
    rects.some((rect, n) => {
      if (!n || rects[n - 1][3] < rect[1]) return false
      // Font ascent boxes may touch even on distinct native baselines. Permit
      // only a small overlap between uniform, unscripted lines; their centers
      // still have a unique boundary and no glyph changes its record owner.
      const pair = [groups[n - 1], groups[n]]
      const height = Math.min(...pair.flat().map((i) => i.height))
      return (
        rects[n - 1][3] - rect[1] > height * 0.1 ||
        pair.some((g) =>
          g.some(
            (i) =>
              Math.abs(i.baseline - g[0].baseline) > height * 0.1 ||
              Math.abs(i.height - height) > height * 0.1
          )
        ) ||
        groups[n][0].baseline - groups[n - 1][0].baseline < height * 0.8
      )
    })
  )
    return
  return {
    index: rows.indexOf(owners[0]),
    rows: rects.map((rect, n) => ({
      rect: [
        left,
        n ? (rects[n - 1][3] + rect[1]) / 2 : rect[1],
        right,
        n + 1 < rects.length ? (rect[3] + rects[n + 1][1]) / 2 : rect[3]
      ],
      origin: 'source-text'
    }))
  }
}

// Closed header faces can establish several tiers even when their parent
// titles wrap across multiple leaf cuts. Incomplete native edges never imply
// a merge, and every original glyph must fit exactly one rectangular face.
export function recoverClosedNativeHeaderBands(source, cuts, rules, top, bottom) {
  if (!source.length || cuts.length < 4 || cuts.length > 15) return
  const height = Math.max(...source.map((i) => i.height))
  const local = rules.filter(
    (r) =>
      r[1] >= top - 1 &&
      r[3] <= bottom + 1 &&
      r[0] >= cuts[0] - height &&
      r[2] <= cuts.at(-1) + height
  )
  const vertical = local.filter((r) => r[0] === r[2])
  const horizontal = local.filter((r) => r[1] === r[3])
  const xs = clusterTableRulePositions(vertical.map((r) => r[0]))
  if (xs.length !== cuts.length || xs.some((x, c) => Math.abs(x - cuts[c]) > height)) return
  const raw = clusterTableRulePositions(horizontal.map((r) => r[1]))
  const ys = []
  for (const y of raw) {
    const previous = ys.at(-1)
    if (
      previous !== undefined &&
      y - previous < height * 0.3 &&
      !source.some((i) => (i.rect[1] + i.rect[3]) / 2 > previous && (i.rect[1] + i.rect[3]) / 2 < y)
    )
      continue
    else ys.push(y)
  }
  if (
    ys.length < 3 ||
    ys.length > 5 ||
    Math.abs(ys[0] - top) > 1 ||
    Math.abs(ys.at(-1) - bottom) > height * 0.35
  )
    return
  const h = ys.map((y) =>
    xs.slice(1).map((x, c) => classifyTableRuleEdge(horizontal, 1, y, xs[c] + 0.5, x - 0.5))
  )
  const v = ys
    .slice(1)
    .map((y, r) => xs.map((x) => classifyTableRuleEdge(vertical, 0, x, ys[r] + 0.5, y - 0.5)))
  if (
    [...h.flat(), ...v.flat()].includes(-1) ||
    h[0].includes(0) ||
    h.at(-1).includes(0) ||
    v.some((row) => !row[0] || !row.at(-1))
  )
    return
  const seen = new Set(),
    spans = [],
    owners = []
  const width = xs.length - 1,
    depth = ys.length - 1
  for (let row = 0; row < depth; row++)
    for (let col = 0; col < width; col++) {
      const id = row * width + col
      if (seen.has(id)) continue
      const queue = [[row, col]],
        slots = []
      while (queue.length) {
        const [r, c] = queue.pop(),
          key = r * width + c
        if (seen.has(key)) continue
        seen.add(key)
        slots.push([r, c])
        if (r && !h[r][c]) queue.push([r - 1, c])
        if (r + 1 < depth && !h[r + 1][c]) queue.push([r + 1, c])
        if (c && !v[r][c]) queue.push([r, c - 1])
        if (c + 1 < width && !v[r][c + 1]) queue.push([r, c + 1])
      }
      const startRow = Math.min(...slots.map(([r]) => r)),
        endRow = Math.max(...slots.map(([r]) => r)) + 1,
        startCol = Math.min(...slots.map(([, c]) => c)),
        endCol = Math.max(...slots.map(([, c]) => c)) + 1
      if (slots.length !== (endRow - startRow) * (endCol - startCol)) return
      const group = source.filter(
        (i) =>
          i.rect[0] >= xs[startCol] &&
          i.rect[2] <= xs[endCol] &&
          (i.rect[1] + i.rect[3]) / 2 > ys[startRow] &&
          (i.rect[1] + i.rect[3]) / 2 < ys[endRow]
      )
      if (
        (group.length && !group.some((i) => /\p{L}/u.test(i.text))) ||
        group.some((i) => i.rect[0] < cuts[startCol] || i.rect[2] > cuts[endCol])
      )
        return
      if (group.length) owners.push(group)
      if (endRow - startRow > 1 || endCol - startCol > 1)
        spans.push({
          row: startRow,
          column: startCol,
          rowSpan: endRow - startRow,
          colSpan: endCol - startCol
        })
    }
  if (!spans.some((s) => s.colSpan > 1) || !hasUniqueRecordTokens(source, owners)) return
  return { rows: ys.slice(1).map((y, r) => [cuts[0], ys[r], cuts.at(-1), y]), spans }
}

// A continuous rule can underline several independent cohort names. Repeated
// child statistics retain one leaf per name; a single explicit summary label
// over the same ruled region is shared by those adjacent cohorts.
export function recoverSiblingHeaderBands(source, cuts, rules, top, bottom) {
  if (!source.length || cuts.length < 4) return
  const height = Math.max(...source.map((i) => i.height))
  for (const rule of joinHorizontalTableRules(rules).filter(
    (r) => r[1] > top && r[1] < bottom && r[2] - r[0] < (cuts.at(-1) - cuts[0]) * 0.85
  )) {
    const upper = source.filter((i) => i.rect[3] <= rule[1] + height * 0.1),
      lower = source.filter((i) => (i.rect[1] + i.rect[3]) / 2 > rule[1])
    if (!hasUniqueRecordTokens(source, [upper, lower])) continue
    const titles = upper.filter((i) => i.rect[0] >= rule[0] - 1 && i.rect[2] <= rule[2] + 1)
    const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    const indices = [...new Set(titles.map(col))].sort((a, b) => a - b)
    if (
      indices.length < 2 ||
      indices.some((c, n) => c < 0 || (n && c !== indices[n - 1] + 1)) ||
      titles.some((i) => i.rect[0] < cuts[col(i)] || i.rect[2] > cuts[col(i) + 1])
    )
      continue
    const children = lower.filter((i) => i.rect[0] >= rule[0] - 1 && i.rect[2] <= rule[2] + 1)
    if (
      !children.length ||
      union(children)[3] - rule[1] > height * 2.5 ||
      titles.some((i) => !/\p{L}/u.test(i.text))
    )
      continue
    const start = indices[0],
      end = indices.at(-1) + 1
    const labels = readSourceRow(children, cuts, { multiline: true })?.slice(start, end)
    const compact = children
      .map((i) => i.text)
      .join('')
      .replace(/\s/g, '')
    const repeated = labels?.every((s) => s && s === labels[0] && /\p{L}/u.test(s))
    const shared =
      /^(?:Median\(IQR\)|Mean(?:±|\(SD\)|\(SD\),Range))$/u.test(compact) &&
      children.every((i) => col(i) === start)
    if (!repeated && !shared) continue
    const spans = []
    for (let c = 0; c < cuts.length - 1; c++) {
      const outside = source.filter(
        (i) => col(i) === c && !titles.includes(i) && !children.includes(i)
      )
      if (c >= start && c < end) {
        if (outside.length) return
        if (shared && c === start)
          spans.push({ row: 1, column: start, rowSpan: 1, colSpan: end - start })
      } else if (outside.length) {
        if (outside.some((i) => i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 1])) return
        spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
      }
    }
    return {
      rows: [
        [cuts[0], top, cuts.at(-1), rule[1]],
        [cuts[0], rule[1], cuts.at(-1), bottom]
      ],
      spans
    }
  }
}
