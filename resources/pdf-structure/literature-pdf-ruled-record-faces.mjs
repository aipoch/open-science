/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  joinHorizontalTableRules,
  classifyTableRuleEdge,
  clusterTableRulePositions
} from './literature-pdf-table-rules.mjs'
import { inside, union, isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import {
  groupSourceRowsWithScripts,
  readSourceRow,
  hasUniqueRecordTokens,
  recoverRuledHeaderBands,
  tableSourceItems
} from './literature-pdf-source-records.mjs'

// These placeholders explicitly state a missing statistic; preserve their
// source text while allowing the surrounding numeric records to establish rows.
const numeric = (value) =>
  /^(?:[<>≤≥−–+-]?(?:\d|\.\d)[\d.,;:()%/±−–+*†‡a-z-]*|[–—-]|NA|N\/A|Notestimated)$/i.test(
    value.replace(/[\p{Cc}\s]/gu, '')
  )

// Complete horizontal faces carry stronger row evidence than overlapping
// model bands. Recover only when every source record validates the columns.
export function recoverRuledRecordFaces(table, items, captions, rules) {
  const titled = recoverInsetStatisticTitle(table, items, captions, rules)
  if (titled) return titled
  const complete = recoverCompleteNativeLeafRecords(table, items, captions, rules)
  if (complete) return complete
  const sparse = recoverNativeSparseGroupedStatistics(table, items, captions, rules)
  if (sparse) return sparse
  const leaves = recoverIndependentNumericLeafLanes(table, items, captions, rules)
  if (leaves) return leaves
  const grouped = recoverRepeatedRuledMatrixGroups(table, items, captions, rules)
  if (grouped) return grouped
  const scientific = recoverScientificRecordFaces(table, items, captions, rules)
  if (scientific) return scientific
  const inset = recoverInsetRecordFaces(table, items, captions, rules)
  if (inset) return inset
  const multiline = recoverMultitierClosedRecords(table, items, captions, rules)
  if (multiline) return multiline
  const captioned = captions.some((c) => captionKind(c.lines[0]) === 'table')
  const crop = table.cropRect
  // Cell strokes may stop at the ink width of an intersecting vertical corner.
  // Bridge only that independently drawn corner, never arbitrary missing edges.
  const joined = joinHorizontalTableRules(rules, 1, 2)
  const tolerance = Math.max(16, (crop[2] - crop[0]) * 0.06)
  let edges = joined.filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < tolerance &&
      Math.abs(r[2] - crop[2]) < tolerance &&
      r[1] >= crop[1] - 16 &&
      r[1] <= crop[3] + 16
  )
  if (
    edges.length < 3 ||
    Math.abs(edges[0][1] - crop[1]) > 16 ||
    Math.abs(edges.at(-1)[1] - crop[3]) > 16
  )
    return
  const left = Math.min(crop[0], edges[0][0]),
    right = Math.max(crop[2], edges[0][2]),
    top = edges[0][1],
    bottom = edges.at(-1)[1]
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 3 || predicted.length > 8) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = items
    .filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= left - 0.1 &&
        i.rect[2] <= right + 0.1 &&
        inside([left, top, right, bottom], i)
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  if (source.length < 20) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  // A closing double stroke below all native ink is one boundary. Interior
  // empty strips need an independent corner; a shared unit band is otherwise
  // indistinguishable from a genuine header face.
  edges = edges.filter(
    (r, n) =>
      !edges[n + 1] ||
      edges[n + 1][1] - r[1] > height * 0.3 ||
      Math.abs(edges[n + 1][0] - r[0]) > 1 ||
      Math.abs(edges[n + 1][2] - r[2]) > 1 ||
      !(
        (n === edges.length - 2 &&
          r[1] >= crop[3] - height &&
          source.every((i) => i.rect[3] <= r[1])) ||
        rules.some(
          (v) =>
            v[0] === v[2] &&
            (Math.abs(v[0] - r[0]) <= 2 || Math.abs(v[0] - r[2]) <= 2) &&
            v[1] <= r[1] &&
            v[3] >= edges[n + 1][1]
        )
      ) ||
      source.some(
        (i) => (i.rect[1] + i.rect[3]) / 2 >= r[1] && (i.rect[1] + i.rect[3]) / 2 < edges[n + 1][1]
      )
  )
  if (edges.length === 3) {
    const header = source.filter((i) => i.rect[3] <= edges[1][1]),
      body = source.filter((i) => i.rect[1] >= edges[1][1])
    // A captionless continuation needs its own measurement signature. A
    // generic ruled numeric list is not sufficient evidence of a table.
    if (
      !captioned &&
      !(
        predicted.length === 4 &&
        header.some((i) => /^N$/.test(i.text.trim())) &&
        header.some((i) => /^Mean\s*\(SD\)/i.test(i.text.trim())) &&
        header.some((i) => /^Range$/i.test(i.text.trim()))
      )
    )
      return
    const groups = groupSourceRowsWithScripts(body, height, 0.35)
    const headings = recoverRuledHeaderBands(header, cuts, rules, top, edges[1][1])
    if (
      !groups ||
      groups.length < 3 ||
      !headings ||
      !hasUniqueRecordTokens(source, [header, ...groups])
    )
      return
    const sectionRows = []
    let records = 0
    // Without recovered parent tiers, a multiline header may include a
    // wrapped leaf or even the first record. Leave that layout to its owner.
    if (
      headings.rows.length === 1 &&
      Math.max(...header.map((i) => i.baseline)) - Math.min(...header.map((i) => i.baseline)) >
        height * 0.35
    )
      return
    const headerColumns = header.map((i) =>
      cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    )
    if (!cuts.slice(2).every((_, n) => headerColumns.includes(n + 1))) return
    if (
      groups.some((g, n) => {
        const v = readSourceRow(g, cuts)
        if (!v || !/\p{L}/u.test(v[0])) return true
        if (v.slice(1).every((s) => !s)) {
          const next = groups[n + 1],
            label = union(g)
          if (
            !next ||
            !next.some((i) => i.rect[0] > cuts[1]) ||
            !/^[\p{Lu}]/u.test(v[0]) ||
            (Math.min(...next.filter((i) => i.rect[2] < cuts[1]).map((i) => i.rect[0])) <
              label[0] + height * 0.4 &&
              !/^Mean;SD(?:\(range\))?$/i.test(readSourceRow(next, cuts)?.[0] ?? ''))
          )
            return true
          sectionRows.push(n)
          return false
        }
        records++
        return !v.slice(1).some(numeric) || !v.slice(1).every((s) => !s || numeric(s))
      })
    )
      return
    if (
      records < 4 &&
      !(headings.rows.length === 2 && headings.spans.filter((s) => s.colSpan > 1).length >= 2)
    )
      return
    // Sparse unsectioned comparisons may share a statistic across visits.
    // Their vertical ownership needs stronger evidence than aligned baselines.
    if (
      !sectionRows.length &&
      groups.some((g) =>
        readSourceRow(g, cuts)
          .slice(1)
          .some((s) => !s)
      )
    )
      return
    return {
      cropRect: [left, top, right, bottom],
      rows: [
        ...headings.rows,
        ...groups.map((g) => {
          const r = union(g)
          return [left, r[1], right, r[3]]
        })
      ],
      columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
      headerRows: headings.rows.map((_, n) => n),
      spans: [
        ...headings.spans,
        ...sectionRows.map((n) => ({
          row: headings.rows.length + n,
          column: 0,
          rowSpan: 1,
          colSpan: cuts.length - 1
        }))
      ],
      completeSpans: true,
      ownedTokens: new Set(source)
    }
  }
  if (!captioned || edges.length < 5) return
  const faces = edges
    .slice(1)
    .map((r, n) => source.filter((i) => inside([left, edges[n][1], right, r[1]], i)))
  if (faces.some((g) => !g.length) || !hasUniqueRecordTokens(source, faces)) return
  const centered = recoverSectionedCenteredRecords(faces, cuts, edges, height)
  if (centered)
    return {
      cropRect: [left, top, right, bottom],
      rows: [
        [left, top, right, edges[1][1]],
        ...centered.map((g) => {
          const r = union(g)
          return [left, r[1], right, r[3]]
        })
      ],
      columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
      headerRows: [0],
      spans: [],
      completeSpans: true,
      ownedTokens: new Set(source)
    }
  const sectionGroups = groupSourceRowsWithScripts(faces.slice(1).flat(), height, 0.35)
  const sectionLabel = (g) =>
    g
      .map((i) => i.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  const countSections = sectionGroups?.filter((g) => /,\s*n\s*\(%\)$/.test(sectionLabel(g))) ?? []
  const sectionHeader = recoverRuledHeaderBands(faces[0], cuts, rules, top, edges[1][1])
  if (
    countSections.length >= 3 &&
    sectionHeader &&
    countSections.every(
      (g) =>
        Math.abs(union(g)[0] - left) < height * 1.5 &&
        edges.some((r) => union(g)[1] >= r[1] && union(g)[1] - r[1] < height * 0.6)
    ) &&
    sectionGroups.every((g) => {
      if (countSections.includes(g)) return true
      const values = readSourceRow(g, cuts)
      return (
        values &&
        /\p{L}/u.test(values[0]) &&
        values.slice(1).filter(numeric).length >= 4 &&
        values.slice(1).every((s) => !s || numeric(s))
      )
    }) &&
    hasUniqueRecordTokens(source, [faces[0], ...sectionGroups])
  ) {
    return {
      cropRect: [left, top, right, bottom],
      rows: [
        ...sectionHeader.rows,
        ...sectionGroups.map((g) => {
          const r = union(g)
          return [left, r[1], right, r[3]]
        })
      ],
      columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
      headerRows: sectionHeader.rows.map((_, n) => n),
      spans: [
        ...sectionHeader.spans,
        ...countSections.map((g) => ({
          row: sectionHeader.rows.length + sectionGroups.indexOf(g),
          column: 0,
          rowSpan: 1,
          colSpan: cuts.length - 1
        }))
      ],
      completeSpans: true,
      ownedTokens: new Set(source)
    }
  }
  const rawColumn = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const col = (i) => {
    const anchors = source.filter(
      (a) =>
        a !== i &&
        (isAdjacentTableScript(i, a) ||
          (/^[)]+$/.test(i.text) &&
            a.text.includes('(') &&
            Math.abs(i.baseline - a.baseline) < a.height * 0.2 &&
            i.rect[0] >= a.rect[2] &&
            i.rect[0] - a.rect[2] < a.height * 0.7))
    )
    return anchors.length === 1 ? rawColumn(anchors[0]) : rawColumn(i)
  }
  // Full-width section headings do not constrain column gutters.
  const body = faces
    .slice(1)
    .filter((g) => new Set(g.map(col)).size >= 3)
    .flat()
  if (body.length < 12) return
  for (let c = 1; c < cuts.length - 1; c++) {
    const a = body.filter((i) => col(i) === c - 1),
      b = body.filter((i) => col(i) === c)
    if (!a.length || !b.length) return
    const end = Math.max(...a.map((i) => i.rect[2])),
      start = Math.min(...b.map((i) => i.rect[0]))
    if (end >= start) return
    cuts[c] = (end + start) / 2
  }
  const header = readSourceRow(faces[0], cuts)
  const headings = recoverRuledHeaderBands(faces[0], cuts, rules, top, edges[1][1])
  if (
    (!header ||
      !header.slice(1).every((v) => /\p{L}/u.test(v)) ||
      (header[0] && !/\p{L}/u.test(header[0]))) &&
    !(headings?.rows.length > 1)
  )
    return
  const width = cuts.length - 1,
    rows = headings ? [...headings.rows] : [[left, top, right, edges[1][1]]],
    spans = headings?.spans ?? [],
    owned = [faces[0]]
  const headerValues = readSourceRow(faces[0], cuts, { multiline: true })
  const sharedStart = headerValues?.slice(-2).every((v) => /p[- ]?value$/i.test(v))
    ? width - 2
    : width - 1
  let records = 0
  for (let n = 1; n < faces.length; n++) {
    const g = faces[n],
      upper = edges[n][1],
      lower = edges[n + 1][1],
      v = readSourceRow(g, cuts)
    const ink = union(g),
      text = g.map((i) => i.text).join(' ')
    if (
      (new Set(g.map(col)).size === 1 || g.every((i) => /^[\p{L}\s/()-]+$/u.test(i.text))) &&
      /\p{L}/u.test(text) &&
      !/^\d/.test(text)
    ) {
      if (ink[0] < left + height * 2 || Math.abs(ink[0] + ink[2] - left - right) < height * 2) {
        spans.push({ row: rows.length, column: 0, rowSpan: 1, colSpan: width })
        rows.push([left, upper, right, lower])
        owned.push(g)
        continue
      }
    }
    const core = g.filter((i) => col(i) < sharedStart)
    const groups = groupSourceRowsWithScripts(core, height, 0.35)
    const complete = groups?.filter((group) => {
      const cells = readSourceRow(group, cuts)
      return (
        cells &&
        (/\p{L}/u.test(cells[0]) || /^\d{1,3}$/.test(cells[0])) &&
        cells.slice(1, sharedStart).every(numeric)
      )
    })
    if (complete?.length >= 2) {
      const rest = core.filter((i) => !complete.some((row) => row.includes(i)))
      if (
        rest.length &&
        (!rest.every((i) => col(i) === 0) ||
          !rest.some((i) => /\p{L}/u.test(i.text)) ||
          Math.max(...rest.map((i) => i.rect[3])) >= union(complete[0])[1])
      )
        return
      const values = g.filter((i) => col(i) >= sharedStart)
      const shared = cuts.slice(sharedStart + 1).every((_, n) => {
        const own = values.filter((i) => col(i) === sharedStart + n)
        return own.length === 1 && numeric(own[0].text)
      })
      if (sharedStart < width - 1 && !shared) return
      const start = rows.length + (rest.length ? 1 : 0)
      const ys = [
        upper,
        ...complete.slice(1).map((group, k) => (union(complete[k])[3] + union(group)[1]) / 2),
        lower
      ]
      if (rest.length) {
        const cut = (union(rest)[3] + union(complete[0])[1]) / 2
        rows.push([left, upper, right, cut])
        owned.push(rest)
        spans.push({ row: start - 1, column: 0, rowSpan: 1, colSpan: sharedStart })
        ys[0] = cut
      }
      for (let k = 0; k < complete.length; k++) {
        const row = complete[k],
          extra = shared ? [] : values.filter((i) => inside([left, ys[k], right, ys[k + 1]], i))
        if (extra.some((i) => !numeric(i.text))) return
        rows.push([left, ys[k], right, ys[k + 1]])
        owned.push([...row, ...extra])
        records++
      }
      if (shared) {
        for (let c = sharedStart; c < width; c++)
          spans.push({
            row: sharedStart < width - 1 && rest.length ? start - 1 : start,
            column: c,
            rowSpan: complete.length + (sharedStart < width - 1 && rest.length ? 1 : 0),
            colSpan: 1
          })
        owned.at(-1).push(...values)
      } else if (
        !hasUniqueRecordTokens(
          values,
          owned
            .slice(-complete.length)
            .map((row) => row.filter((i) => col(i) >= sharedStart))
            .filter((row) => row.length)
        )
      )
        return
    } else {
      if (
        !v ||
        !/\p{L}/u.test(v[0]) ||
        !v.slice(1, -1).every(numeric) ||
        (v.at(-1) && !numeric(v.at(-1)))
      )
        return
      // Multiple independent stub lines cannot be swallowed into one face.
      const labels = g.filter((i) => col(i) === 0 && !g.some((a) => isAdjacentTableScript(i, a)))
      if (
        labels.some((i) =>
          labels.some((j) => i !== j && Math.abs(i.baseline - j.baseline) > height * 1.8)
        )
      )
        return
      rows.push([left, upper, right, lower])
      owned.push(g)
      records++
    }
  }
  if (records < 4 || !hasUniqueRecordTokens(source, owned)) return
  return {
    cropRect: [left, top, right, bottom],
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    headerRows: (headings?.rows ?? [0]).map((_, n) => n),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Four full native strokes separate an inset title, repeated parent/leaf
// headings and complete statistical records. The title owns its own face;
// source whitespace across every record establishes the nine leaf lanes.
function recoverInsetStatisticTitle(table, items, captions, rules) {
  const crop = table.cropRect
  if (table.structure.objects.filter((o) => o.label === 'table column').length !== 9) return
  const nearby = tableSourceItems(items, crop)
  if (!nearby.length || !captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const height = nearby.map((i) => i.height).sort((a, b) => a - b)[Math.floor(nearby.length / 2)]
  const edges = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < height * 1.5 &&
        Math.abs(r[2] - crop[2]) < height * 1.5 &&
        r[1] >= crop[1] - height &&
        r[1] <= crop[3] + height * 1.5
    )
    .sort((a, b) => a[1] - b[1])
  if (
    edges.length !== 4 ||
    edges.some((r) => Math.abs(r[0] - edges[0][0]) > 0.1 || Math.abs(r[2] - edges[0][2]) > 0.1)
  )
    return
  const [opening, titleEnd, divider, closing] = edges
  const source = tableSourceItems(items, [opening[0], opening[1], opening[2], closing[1]])
  if (
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[1] < closing[1] &&
        i.rect[3] > opening[1] &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0] &&
        !source.includes(i)
    )
  )
    return
  const parents = rules
    .filter(
      (r) =>
        r[1] === r[3] &&
        r[1] > titleEnd[1] &&
        r[1] < divider[1] &&
        r[0] > opening[0] + height &&
        r[2] < opening[2] - height * 0.2
    )
    .sort((a, b) => a[0] - b[0])
  if (
    parents.length !== 2 ||
    Math.abs(parents[0][1] - parents[1][1]) > 0.1 ||
    parents[0][2] >= parents[1][0]
  )
    return
  const title = source.filter((i) => i.rect[3] <= titleEnd[1]),
    upper = source.filter((i) => i.rect[1] >= titleEnd[1] && i.rect[3] <= parents[0][1]),
    leaves = source
      .filter((i) => i.rect[1] >= parents[0][1] && i.rect[3] <= divider[1])
      .sort((a, b) => a.rect[0] - b.rect[0]),
    body = source.filter((i) => i.rect[1] >= divider[1])
  if (
    !title.length ||
    title.some(
      (i) => !/[\p{L}]/u.test(i.text) || Math.abs(i.baseline - title[0].baseline) > height * 0.15
    ) ||
    Math.abs((union(title)[0] + union(title)[2] - opening[0] - opening[2]) / 2) > height ||
    upper.length !== 2 ||
    leaves.length !== 9
  )
    return
  if (
    upper.some(
      (i, n) =>
        !/[\p{L}]/u.test(i.text) ||
        i.rect[0] < parents[n][0] - height * 0.2 ||
        i.rect[2] > parents[n][2] + height * 0.2 ||
        Math.abs((i.rect[0] + i.rect[2] - parents[n][0] - parents[n][2]) / 2) > height * 0.6 ||
        Math.abs(i.baseline - upper[0].baseline) > height * 0.15
    )
  )
    return
  if (
    leaves.some((i) => Math.abs(i.baseline - leaves[0].baseline) > height * 0.15) ||
    leaves.slice(1, 5).some((i, n) => i.text.trim() !== leaves[n + 5].text.trim()) ||
    !/\p{L}/u.test(leaves[0].text)
  )
    return
  if (
    leaves
      .slice(1)
      .some(
        (i, n) =>
          i.rect[0] < parents[Math.floor(n / 4)][0] - height * 0.3 ||
          i.rect[2] > parents[Math.floor(n / 4)][2] + height * 0.3
      )
  )
    return
  const centers = leaves.map((i) => (i.rect[0] + i.rect[2]) / 2)
  const records = groupSourceRowsWithScripts(body, height, 0.25)
  if (
    !records ||
    records.length < 3 ||
    records.some(
      (g) =>
        Math.max(...g.map((i) => i.baseline)) - Math.min(...g.map((i) => i.baseline)) > height * 0.2
    ) ||
    !hasUniqueRecordTokens(source, [title, upper, leaves, ...records])
  )
    return
  const stub = new Set()
  for (const g of records) {
    const ordered = [...g].sort((a, b) => a.rect[0] - b.rect[0])
    const first = ordered.findIndex(
      (i) => /^[<>≤≥−+-]?(?:\d|\.\d)/u.test(i.text.trim()) || /^[–—-]$/.test(i.text.trim())
    )
    if (first < 1 || !ordered.slice(0, first).some((i) => /\p{L}/u.test(i.text))) return
    for (const i of ordered.slice(0, first)) stub.add(i)
  }
  const col = (i) =>
    stub.has(i)
      ? 0
      : centers.reduce(
          (best, x, c) =>
            c &&
            Math.abs(x - (i.rect[0] + i.rect[2]) / 2) <
              Math.abs(centers[best] - (i.rect[0] + i.rect[2]) / 2)
              ? c
              : best,
          leaves.includes(i) ? leaves.indexOf(i) : 1
        )
  const shared = new Map()
  for (const g of records)
    for (const i of g.filter((i) => /^[–—-]$/.test(i.text.trim()))) {
      const parent = parents.findIndex(
        (p) =>
          i.rect[0] >= p[0] &&
          i.rect[2] <= p[2] &&
          Math.abs((i.rect[0] + i.rect[2] - p[0] - p[2]) / 2) <= height * 0.25
      )
      if (
        parent < 0 ||
        g.some(
          (a) =>
            a !== i &&
            !stub.has(a) &&
            a.rect[0] < parents[parent][2] &&
            a.rect[2] > parents[parent][0]
        )
      )
        return
      shared.set(i, parent)
    }
  const lanes = leaves.map((_, c) =>
    [...leaves, ...body].filter((i) => !shared.has(i) && col(i) === c)
  )
  if (
    lanes
      .slice(1)
      .some(
        (g, c) =>
          Math.min(...g.map((i) => i.rect[0])) - Math.max(...lanes[c].map((i) => i.rect[2])) <
          height * 0.2
      )
  )
    return
  const cuts = [
    opening[0],
    ...lanes
      .slice(1)
      .map(
        (g, c) =>
          (Math.max(...lanes[c].map((i) => i.rect[2])) + Math.min(...g.map((i) => i.rect[0]))) / 2
      ),
    opening[2]
  ]
  let completeGroups = 0
  if (
    records.some((g) => {
      const v = readSourceRow(
        g.filter((i) => !shared.has(i)),
        cuts
      )
      if (!v || !/\p{L}/u.test(v[0])) return true
      for (let p = 0; p < 2; p++) {
        if (g.some((i) => shared.get(i) === p)) continue
        if (
          !v.slice(p * 4 + 1, p * 4 + 5).every((s) => numeric(s) || /^\[[\d.,; −–+-]+\]$/.test(s))
        )
          return true
        completeGroups++
      }
      return false
    }) ||
    completeGroups < 3
  )
    return
  return {
    cropRect: [
      Math.min(crop[0], opening[0]),
      Math.min(crop[1], opening[1]),
      Math.max(crop[2], opening[2] + 0.5),
      Math.max(crop[3], closing[1] + 0.5)
    ],
    rows: [
      [opening[0], opening[1], opening[2], titleEnd[1]],
      [opening[0], titleEnd[1], opening[2], parents[0][1]],
      [opening[0], parents[0][1], opening[2], divider[1]],
      ...records.map((g) => [opening[0], union(g)[1], opening[2], union(g)[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
    headerRows: [0, 1, 2],
    spans: [
      { row: 0, column: 0, rowSpan: 1, colSpan: 9 },
      { row: 1, column: 1, rowSpan: 1, colSpan: 4 },
      { row: 1, column: 5, rowSpan: 1, colSpan: 4 },
      ...records.flatMap((g, r) =>
        g
          .filter((i) => shared.has(i))
          .map((i) => ({ row: r + 3, column: shared.get(i) * 4 + 1, rowSpan: 1, colSpan: 4 }))
      )
    ],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Complete rows with large shared gutters can disprove an extra model lane.
// Keep interval atoms together; their internal spaces do not create columns.
function recoverCompleteNativeLeafRecords(table, items, captions, rules) {
  const crop = table.cropRect,
    count = table.structure.objects.filter((o) => o.label === 'table column').length
  if (count < 5 || count > 6) return
  const nearby = tableSourceItems(items, crop)
  if (!nearby.length) return
  const height = Math.max(...nearby.map((i) => i.height))
  const full = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] &&
        r[1] <= crop[3] &&
        Math.abs(r[0] - crop[0]) < height &&
        Math.abs(r[2] - crop[2]) < height
    )
    .sort((a, b) => a[1] - b[1])
  if (
    full.length < 3 ||
    full.length > 6 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.1 || Math.abs(r[2] - full[0][2]) > 0.1)
  )
    return
  const [opening, divider] = full,
    closing = full.at(-1),
    frame = [opening[0], opening[1], opening[2], closing[1]]
  const caption = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= opening[1] &&
      opening[1] - c.rect[3] < height * 3 &&
      c.rect[0] >= frame[0] - height &&
      c.rect[2] <= frame[2] + height
  )
  if (caption.length !== 1) return
  const source = tableSourceItems(items, [frame[0] - 0.1, frame[1], frame[2] + 0.1, frame[3]])
  const header = source.filter((i) => i.rect[3] < divider[1]).sort((a, b) => a.rect[0] - b.rect[0])
  const body = source.filter((i) => i.rect[1] > divider[1])
  if (
    header.length !== count - 1 ||
    header.some(
      (i) => !/\p{L}/u.test(i.text) || Math.abs(i.baseline - header[0].baseline) > height * 0.1
    )
  )
    return
  const rows = groupSourceRowsWithScripts(body, height, 0.1)
  if (
    !rows ||
    rows.length < 2 ||
    rows.some(
      (g) =>
        Math.max(...g.map((i) => i.baseline)) - Math.min(...g.map((i) => i.baseline)) > height * 0.1
    ) ||
    !hasUniqueRecordTokens(source, [header, ...rows])
  )
    return
  const fields = rows.map((g) => {
    const groups = []
    for (const i of [...g].sort((a, b) => a.rect[0] - b.rect[0])) {
      const previous = groups.at(-1)
      if (previous && i.rect[0] - Math.max(...previous.map((i) => i.rect[2])) <= height * 1.1)
        previous.push(i)
      else groups.push([i])
    }
    return groups
  })
  if (fields.some((g) => g.length !== header.length)) return
  const lanes = header.map((i, c) => [i, ...fields.flatMap((g) => g[c])])
  const cuts = [
    frame[0],
    ...lanes
      .slice(1)
      .map(
        (g, c) =>
          (Math.max(...lanes[c].map((i) => i.rect[2])) + Math.min(...g.map((i) => i.rect[0]))) / 2
      ),
    frame[2] + 0.1
  ]
  if (
    lanes
      .slice(1)
      .some(
        (g, c) =>
          Math.min(...g.map((i) => i.rect[0])) - Math.max(...lanes[c].map((i) => i.rect[2])) <
          height * 1.1
      )
  )
    return
  const numericField = (s) => /^[-+−–<>≤≥\d.,\s[\]()%/±]+$/u.test(s) && /\d/u.test(s)
  if (
    !readSourceRow(header, cuts)?.every(Boolean) ||
    rows.some((g) => {
      const values = readSourceRow(g, cuts)
      return (
        !values?.every(Boolean) ||
        !values.slice(2).every(numericField) ||
        !(/\p{L}/u.test(values[0]) || numericField(values[0])) ||
        !(/\p{L}/u.test(values[1]) || numericField(values[1]))
      )
    })
  )
    return
  if (full.slice(2, -1).some((r) => body.some((i) => i.rect[1] < r[1] && i.rect[3] > r[1]))) return
  return {
    cropRect: [
      Math.min(crop[0], frame[0]),
      crop[1],
      Math.max(crop[2], frame[2] + 0.5),
      Math.max(crop[3], frame[3] + 0.5)
    ],
    rows: [
      [frame[0], union(header)[1], frame[2], divider[1]],
      ...rows.map((g) => [frame[0], union(g)[1], frame[2], union(g)[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Two native four-leaf underlines and a complete measured row establish the
// missing lane. A second baseline's centered scalars belong to those exact
// native groups, without inferring a statistical hierarchy from their names.
function recoverNativeSparseGroupedStatistics(table, items, captions, rules) {
  const modelColumns = table.structure.objects.filter((o) => o.label === 'table column').length
  if (modelColumns < 8 || modelColumns > 9) return
  const crop = table.cropRect,
    nearby = tableSourceItems(items, crop)
  if (!nearby.length) return
  const height = Math.max(...nearby.map((i) => i.height))
  const strokes = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[1] >= crop[1] && r[1] <= crop[3] && r[0] >= crop[0] - height && r[2] <= crop[2] + height
  )
  const full = strokes.filter(
    (r) => Math.abs(r[0] - crop[0]) < height && Math.abs(r[2] - crop[2]) < height
  )
  const bands = []
  for (const r of full.sort((a, b) => a[1] - b[1])) {
    const band = bands.at(-1)
    if (band && r[1] - band.at(-1)[1] < height * 0.3) band.push(r)
    else bands.push([r])
  }
  if (
    bands.length !== 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.1 || Math.abs(r[2] - full[0][2]) > 0.1)
  )
    return
  const [opening, divider, closing] = [bands[0][0], bands[1][0], bands[2].at(-1)]
  const frame = [opening[0], opening[1], opening[2], closing[1]]
  const adjacent = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= opening[1] &&
      opening[1] - c.rect[3] < height * 3 &&
      c.rect[0] >= frame[0] - height &&
      c.rect[2] <= frame[2] + height
  )
  if (adjacent.length !== 1) return
  const source = tableSourceItems(items, frame)
  const header = source.filter((i) => i.rect[3] < divider[1])
  const body = source.filter((i) => i.rect[1] > divider[1])
  const parents = strokes
    .filter((r) => r[1] > bands[0].at(-1)[1] && r[1] < divider[1] && !full.includes(r))
    .sort((a, b) => a[0] - b[0])
  if (
    parents.length !== 2 ||
    parents[0][2] >= parents[1][0] ||
    Math.abs(parents[0][1] - parents[1][1]) > height * 0.1
  )
    return
  const leaf = header.filter((i) => i.rect[1] > parents[0][1]).sort((a, b) => a.rect[0] - b.rect[0])
  if (
    leaf.length !== 8 ||
    leaf.some(
      (i) => !/^\p{L}$/u.test(i.text) || Math.abs(i.baseline - leaf[0].baseline) > height * 0.1
    )
  )
    return
  const upper = parents.map((r) =>
    header.filter((i) => i.rect[3] < r[1] && i.rect[0] >= r[0] && i.rect[2] <= r[2])
  )
  if (
    parents.some(
      (r, n) =>
        upper[n].length === 0 ||
        Math.abs((union(upper[n])[0] + union(upper[n])[2] - r[0] - r[2]) / 2) > height * 0.6 ||
        leaf.slice(n * 4, n * 4 + 4).some((i) => i.rect[0] < r[0] || i.rect[2] > r[2])
    )
  )
    return
  const records = groupSourceRowsWithScripts(body, height, 0.2)
  if (
    !records ||
    records.length !== 2 ||
    !hasUniqueRecordTokens(source, [...upper, leaf, ...records])
  )
    return
  const measured = records[0]
    .filter((i) => /^\d+$/.test(i.text))
    .sort((a, b) => a.rect[0] - b.rect[0])
  const stub = records.map((g) => g.filter((i) => i.rect[2] < parents[0][0]))
  if (
    measured.length !== 8 ||
    stub.some((g) => !g.some((i) => /\p{L}/u.test(i.text))) ||
    measured.some(
      (i, n) =>
        Math.abs((i.rect[0] + i.rect[2] - leaf[n].rect[0] - leaf[n].rect[2]) / 2) > height * 0.2
    )
  )
    return
  const lanes = [stub.flat(), ...leaf.map((i, n) => [i, measured[n]])]
  const cuts = [
    frame[0],
    ...lanes
      .slice(1)
      .map(
        (g, n) =>
          (Math.max(...lanes[n].map((i) => i.rect[2])) + Math.min(...g.map((i) => i.rect[0]))) / 2
      ),
    frame[2]
  ]
  if (
    lanes
      .slice(1)
      .some(
        (g, n) =>
          Math.min(...g.map((i) => i.rect[0])) - Math.max(...lanes[n].map((i) => i.rect[2])) <
          height * 0.2
      )
  )
    return
  const sparse = records[1]
    .filter((i) => !stub[1].includes(i))
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    sparse.length !== 2 ||
    sparse.some(
      (i, n) =>
        !/^\d+$/.test(i.text) ||
        Math.abs((i.rect[0] + i.rect[2] - parents[n][0] - parents[n][2]) / 2) > height * 0.2 ||
        i.rect[0] < cuts[n * 4 + 1] ||
        i.rect[2] > cuts[n * 4 + 5]
    )
  )
    return
  if (
    !readSourceRow(records[0], cuts)?.every(Boolean) ||
    !hasUniqueRecordTokens(body, [...lanes.map((g) => g.filter((i) => body.includes(i))), sparse])
  )
    return
  return {
    cropRect: [
      Math.min(crop[0], frame[0]),
      crop[1],
      Math.max(crop[2], frame[2]),
      Math.max(crop[3], frame[3] + 0.5)
    ],
    rows: [
      [frame[0], union(upper.flat())[1], frame[2], parents[0][1]],
      [frame[0], parents[0][1], frame[2], divider[1]],
      ...records.map((g) => [frame[0], union(g)[1], frame[2], union(g)[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], frame[1], x, frame[3]]),
    headerRows: [0, 1],
    spans: [0, 1].flatMap((n) => [
      { row: 0, column: n * 4 + 1, rowSpan: 1, colSpan: 4 },
      { row: 3, column: n * 4 + 1, rowSpan: 1, colSpan: 4 }
    ]),
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Independent native leaf titles and complete repeated numeric baselines can
// disprove a model's merged last pair. All cuts lie in observed whitespace;
// crossing source runs are left to the native glyph parser, never split here.
function recoverIndependentNumericLeafLanes(table, items, captions, rules) {
  const crop = table.cropRect,
    cols = table.structure.objects.filter((o) => o.label === 'table column')
  if (cols.length < 3 || cols.length > 10) return
  const nearby = tableSourceItems(items, crop)
  if (!nearby.length) return
  const height = nearby.map((i) => i.height).sort((a, b) => a - b)[Math.floor(nearby.length / 2)]
  const edges = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= crop[1] &&
        r[1] <= crop[3] &&
        Math.abs(r[0] - crop[0]) < height * 1.5 &&
        Math.abs(r[2] - crop[2]) < height * 1.5
    )
    .sort((a, b) => a[1] - b[1])
  if (
    edges.length !== 3 ||
    edges.some((r) => Math.abs(r[0] - edges[0][0]) > 0.1 || Math.abs(r[2] - edges[0][2]) > 0.1)
  )
    return
  const caption = captions.filter((c) => captionKind(c.lines[0]) === 'table')
  if (caption.length !== 1) return
  const [opening, divider, closing] = edges,
    frame = [Math.min(crop[0], opening[0]), opening[1], Math.max(crop[2], opening[2]), closing[1]]
  const source = tableSourceItems(items, frame).sort(
      (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
    ),
    header = source.filter((i) => i.rect[3] <= divider[1]),
    body = source.filter((i) => i.rect[1] >= divider[1])
  if (
    header.length !== cols.length + 1 ||
    header.some(
      (i) =>
        !/^\p{L}[\p{L}\s-]*$/u.test(i.text) ||
        Math.abs(i.baseline - header[0].baseline) > height * 0.15
    )
  )
    return
  header.sort((a, b) => a.rect[0] - b.rect[0])
  const centers = header.map((i) => (i.rect[0] + i.rect[2]) / 2)
  const col = (i) =>
    centers.reduce(
      (best, x, c) =>
        Math.abs(x - (i.rect[0] + i.rect[2]) / 2) <
        Math.abs(centers[best] - (i.rect[0] + i.rect[2]) / 2)
          ? c
          : best,
      0
    )
  const records = groupSourceRowsWithScripts(body, height, 0.25)
  if (!records || records.length < 4 || !hasUniqueRecordTokens(source, [header, ...records])) return
  const lanes = header.map((_, c) => source.filter((i) => col(i) === c))
  const cuts = [
    frame[0],
    ...lanes
      .slice(1)
      .map(
        (g, c) =>
          (Math.max(...lanes[c].map((i) => i.rect[2])) + Math.min(...g.map((i) => i.rect[0]))) / 2
      ),
    frame[2]
  ]
  if (
    lanes
      .slice(1)
      .some(
        (g, c) =>
          Math.min(...g.map((i) => i.rect[0])) - Math.max(...lanes[c].map((i) => i.rect[2])) <
          height * 0.2
      )
  )
    return
  const heads = readSourceRow(header, cuts)
  if (!heads?.every(Boolean)) return
  const scalar = /^[<>≤≥]?[−+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u
  if (
    records.some((g) => {
      const v = readSourceRow(g, cuts)
      return !v || !/\p{L}/u.test(v[0]) || !v.slice(1).every((s) => scalar.test(s))
    })
  )
    return
  return {
    cropRect: [frame[0], crop[1], frame[2] + 0.5, closing[1] + 0.5],
    rows: [
      [frame[0], union(header)[1], frame[2], divider[1]],
      ...records.map((g) => [frame[0], union(g)[1], frame[2], union(g)[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Repeated complete records between matching full-width dividers establish a
// centered category's exact physical extent. Neither empty slots nor label
// meaning establish a span without those endpoints and repeated lane owners.
function recoverRepeatedRuledMatrixGroups(table, items, captions, rules) {
  const crop = table.cropRect
  const cols = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (cols.length < 4 || cols.length > 12) return
  const cuts = [
    crop[0],
    ...cols.slice(1).map((c, n) => crop[0] + (cols[n].rect[2] + c.rect[0]) / 2),
    crop[2]
  ]
  const source = tableSourceItems(items, crop).sort(
    (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
  )
  if (!source.length) return
  const height = Math.max(...source.map((i) => i.height)),
    edges = joinHorizontalTableRules(rules)
      .filter(
        (r) =>
          r[1] >= crop[1] &&
          r[1] <= crop[3] &&
          Math.abs(r[0] - crop[0]) < height &&
          Math.abs(r[2] - crop[2]) < height
      )
      .sort((a, b) => a[1] - b[1])
  if (
    edges.length < 5 ||
    edges.length > 8 ||
    edges.some((r) => Math.abs(r[0] - edges[0][0]) > 0.1 || Math.abs(r[2] - edges[0][2]) > 0.1)
  )
    return
  const caption = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= edges[0][1] &&
      edges[0][1] - c.rect[3] < height * 3 &&
      c.rect[0] < crop[2] &&
      c.rect[2] > crop[0]
  )
  if (caption.length !== 1) return
  const header = source.filter((i) => i.rect[1] >= edges[0][1] && i.rect[3] <= edges[1][1])
  const heads = readSourceRow(header, cuts)
  if (
    !heads?.every(Boolean) ||
    header.some((i) => Math.abs(i.baseline - header[0].baseline) > height * 0.15)
  )
    return
  const groups = [],
    categoryTokens = [],
    records = [],
    spans = []
  for (let n = 1; n < edges.length - 1; n++) {
    const top = edges[n][1],
      bottom = edges[n + 1][1],
      band = source.filter((i) => i.rect[1] >= top && i.rect[3] <= bottom)
    const category = band.filter((i) => i.rect[0] >= cuts[0] && i.rect[2] <= cuts[1]),
      rest = band.filter((i) => !category.includes(i))
    if (
      !category.length ||
      Math.max(...category.map((i) => i.baseline)) - Math.min(...category.map((i) => i.baseline)) >
        height * 0.1
    )
      return
    // Small capitals on the same baseline are ordinary text, not exponents.
    const originals = new Map(),
      normalized = rest.map((i) => {
        const sameBaseline =
          i.height < height * 0.8 &&
          /^[\p{L}]+$/u.test(i.text) &&
          rest.some(
            (a) =>
              a !== i &&
              a.height >= height * 0.8 &&
              Math.abs(a.baseline - i.baseline) < height * 0.1
          )
        const token = sameBaseline ? { ...i, height } : i
        originals.set(token, i)
        return token
      })
    const physical = groupSourceRowsWithScripts(normalized, height, 0.25)?.map((g) =>
      g.map((i) => originals.get(i))
    )
    if (!physical || physical.length < 3 || physical.length > 8) return
    const values = physical.map((g) => readSourceRow(g, cuts))
    if (
      values.some(
        (v) =>
          !v ||
          v[0] ||
          !v.slice(1).every(Boolean) ||
          !/[\p{L}]/u.test(v[1]) ||
          v.slice(2).filter((s) => /^[−+-]?(?:\d|\.\d)[\d.,%·×−+*/()-]*$/u.test(s)).length < 2
      )
    )
      return
    const midpoint = (physical[0][0].baseline + physical.at(-1)[0].baseline) / 2
    if (Math.abs(category[0].baseline - midpoint) > height * 0.5) return
    if (
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[1] > top + 0.1 &&
          r[1] < bottom - 0.1 &&
          r[0] < cuts[1] &&
          r[2] > cuts[0]
      )
    )
      return
    const signature = values.map((v) => v[1]).join('|')
    if (groups.length && signature !== groups[0].signature) return
    spans.push({ row: records.length + 1, column: 0, rowSpan: physical.length, colSpan: 1 })
    groups.push({ signature, physical, top, bottom })
    categoryTokens.push(category)
    records.push(...physical)
  }
  if (!hasUniqueRecordTokens(source, [header, ...categoryTokens, ...records])) return
  const rows = [[crop[0], edges[0][1], crop[2], edges[1][1]]]
  for (const group of groups)
    for (let n = 0; n < group.physical.length; n++) {
      const g = group.physical[n]
      rows.push([
        crop[0],
        n ? (union(group.physical[n - 1])[3] + union(g)[1]) / 2 : group.top,
        crop[2],
        n + 1 < group.physical.length
          ? (union(g)[3] + union(group.physical[n + 1])[1]) / 2
          : group.bottom
      ])
    }
  return {
    cropRect: [...crop],
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], crop[1], x, crop[3]]),
    headerRows: [0],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Signed raised exponents belong to their measured baseline. A complete
// scientific matrix between three matching native strokes proves records
// independently of missing or overlapping model row bands.
function recoverScientificRecordFaces(table, items, captions, rules) {
  const crop = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 4 || predicted.length > 12) return
  const cuts = [
    crop[0],
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    crop[2]
  ]
  if (cuts.some((x, n) => n && x <= cuts[n - 1])) return
  const source = tableSourceItems(items, crop).sort(
    (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
  )
  if (!source.length) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  const edges = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < height * 1.5 &&
        Math.abs(r[2] - crop[2]) < height * 1.5 &&
        r[1] >= crop[1] &&
        r[1] <= crop[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (
    edges.length !== 3 ||
    edges.some((r) => Math.abs(r[0] - edges[0][0]) > 0.1 || Math.abs(r[2] - edges[0][2]) > 0.1)
  )
    return
  const [opening, divider, closing] = edges
  const caption = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= opening[1] &&
      opening[1] - c.rect[3] < height * 3 &&
      c.rect[0] < crop[2] &&
      c.rect[2] > crop[0]
  )
  if (caption.length !== 1) return
  const header = source.filter((i) => (i.rect[1] + i.rect[3]) / 2 < divider[1]),
    body = source.filter((i) => !header.includes(i))
  if (
    header.some((i) => i.rect[1] < opening[1] - height * 0.25 || i.rect[3] > divider[1]) ||
    body.some((i) => i.rect[1] < divider[1] - height * 0.25 || i.rect[3] > closing[1])
  )
    return
  const heads = readSourceRow(header, cuts)
  if (
    !heads ||
    !heads.every((v) => /\p{L}/u.test(v)) ||
    Math.max(...header.map((i) => i.baseline)) - Math.min(...header.map((i) => i.baseline)) >
      height * 0.15
  )
    return
  const records = groupSourceRowsWithScripts(body, height, 0.3)
  if (!records || records.length < 4 || !hasUniqueRecordTokens(source, [header, ...records])) return
  const scientific = /^[−+-]?(?:\d+(?:\.\d+)?|\.\d+)[·×]10[−+-]?\d+$/u
  if (
    records.some((g) => {
      const values = readSourceRow(g, cuts)
      return (
        !values || !/\p{L}/u.test(values[0]) || !values.slice(1).every((v) => scientific.test(v))
      )
    })
  )
    return
  return {
    cropRect: [crop[0], Math.min(opening[1], union(header)[1]), crop[2], closing[1] + 0.5],
    rows: [
      [crop[0], union(header)[1], crop[2], divider[1]],
      ...records.map((g) => [crop[0], union(g)[1], crop[2], union(g)[3]])
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]]),
    headerRows: [0],
    spans: [],
    completeSpans: true,
    ownedTokens: new Set(source),
    preservePhysicalRows: true,
    repair: 'native-body-records-recovered'
  }
}

// Several native header faces may precede records whose SD/CI wraps within a
// closed face. Neither the parent header alone nor a model row crossing a rule
// owns that record. Require every numerical lane and exactly one primary value
// baseline per face; lower numerical lines must complete parentheses.
function recoverMultitierClosedRecords(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 3 || predicted.length > 12) return
  const edges = joinHorizontalTableRules(rules, 1, 2).filter(
    (r) =>
      Math.abs(r[0] - crop[0]) < 16 &&
      Math.abs(r[2] - crop[2]) < 16 &&
      r[1] >= crop[1] - 16 &&
      r[1] <= crop[3] + 16
  )
  if (
    edges.length < 7 ||
    Math.abs(edges[0][1] - crop[1]) > 16 ||
    Math.abs(edges.at(-1)[1] - crop[3]) > 16
  )
    return
  const left = edges[0][0],
    right = edges[0][2],
    top = edges[0][1],
    bottom = edges.at(-1)[1]
  if (edges.some((e) => Math.abs(e[0] - left) > 1 || Math.abs(e[2] - right) > 1)) return
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const middle = (i) => (i.rect[1] + i.rect[3]) / 2
  const source = items
    .filter(
      (i) =>
        i.horizontal &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        middle(i) >= top &&
        middle(i) < bottom
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  if (source.length < 30) return
  const height = source.map((i) => i.height).sort((a, b) => a - b)[Math.floor(source.length / 2)]
  if (source.some((i) => i.rect[1] < top - height * 0.2 || i.rect[3] > bottom + height * 0.2))
    return
  const faces = edges
    .slice(1)
    .map((r, n) => source.filter((i) => middle(i) >= edges[n][1] && middle(i) < r[1]))
  if (faces.some((g) => !g.length) || !hasUniqueRecordTokens(source, faces)) return
  const values = faces.map((g) => readSourceRow(g, cuts, { multiline: true }))
  const measured = (v) => v && /\p{L}/u.test(v[0]) && v.slice(1).every(numeric)
  const first = values.findIndex(measured)
  if (first < 2 || first > 4) return
  const header = faces.slice(0, first).flat(),
    headerTop = Math.min(top, ...header.map((i) => i.rect[1]))
  const headings =
    recoverRuledHeaderBands(header, cuts, rules, headerTop, edges[first][1]) ??
    recoverClosedHeaderFaces(faces.slice(0, first), cuts, edges, height)
  if (!headings || headings.rows.length < 2 || !hasUniqueRecordTokens(header, [header])) return
  const rows = [...headings.rows],
    spans = [...headings.spans],
    owned = [header]
  let records = 0,
    wrapped = 0
  for (let n = first; n < faces.length; n++) {
    const g = faces[n],
      v = values[n]
    if (!v) return
    const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
    if (v[0] && v.slice(1).every((s) => !s) && /\p{L}/u.test(v[0])) {
      if (g.some((i) => col(i) !== 0) || groupSourceRowsWithScripts(g, height, 0.35)?.length !== 1)
        return
      spans.push({ row: rows.length, column: 0, rowSpan: 1, colSpan: cuts.length - 1 })
    } else {
      if (!measured(v)) return
      const primary = []
      for (let c = 1; c < cuts.length - 1; c++) {
        const cell = g.filter((i) => col(i) === c),
          lines = groupSourceRowsWithScripts(cell, height, 0.35)
        if (!lines?.length || lines.length > 3) return
        primary.push(lines[0][0].baseline)
        const texts = lines.map((line) =>
          line
            .map((i) => i.text)
            .join('')
            .replace(/\s/g, '')
        )
        if (lines.length > 1) {
          const a = texts[0],
            tail = texts.slice(1).join('')
          if (
            !(/^\([\d.,−–+%/-]+\)$/.test(tail) && numeric(a)) &&
            !(a.includes('(') && !a.includes(')') && /^[\d.,−–+%/-]+\)$/.test(tail))
          )
            return
          wrapped++
        }
      }
      if (Math.max(...primary) - Math.min(...primary) > height * 0.35) return
      const labels = groupSourceRowsWithScripts(
        g.filter((i) => col(i) === 0),
        height,
        0.35
      )
      if (
        !labels?.length ||
        labels.length > 3 ||
        labels.some((line, k) => k && line[0].baseline - labels[k - 1][0].baseline > height * 1.6)
      )
        return
      records++
    }
    rows.push([
      left,
      Math.min(edges[n][1], ...g.map((i) => i.rect[1])),
      right,
      Math.max(edges[n + 1][1], ...g.map((i) => i.rect[3]))
    ])
    owned.push(g)
  }
  if (records < 4 || wrapped < 4 || !hasUniqueRecordTokens(source, owned)) return
  return {
    cropRect: [
      Math.min(crop[0], left - 0.5),
      Math.min(crop[1], headerTop),
      Math.max(crop[2], right + 0.5),
      Math.max(crop[3], bottom + 0.5)
    ],
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], headerTop, x, bottom]),
    headerRows: headings.rows.map((_, n) => n),
    spans,
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

function recoverClosedHeaderFaces(faces, cuts, edges, height) {
  const rows = [],
    spans = [],
    covered = new Set()
  for (let r = 0; r < faces.length; r++) {
    const face = faces[r]
    if (face.some((i) => !/[\p{L}Δ%]/u.test(i.text))) return
    const claimed = []
    for (const i of face) {
      const first = cuts.slice(1).findIndex((x) => i.rect[0] < x),
        last = cuts.slice(1).findIndex((x) => i.rect[2] <= x)
      if (first < 0 || last < first || i.rect[0] < cuts[first] || last - first > 2) return
      covered.add(first)
      if (last > first) {
        if (
          !/\p{L}/u.test(i.text) ||
          i.rect[2] - i.rect[0] < height * 3 ||
          claimed.some((s) => first < s.column + s.colSpan && last >= s.column)
        )
          return
        const span = { row: r, column: first, rowSpan: 1, colSpan: last - first + 1 }
        claimed.push(span)
        spans.push(span)
        for (let c = first; c <= last; c++) covered.add(c)
      }
    }
    for (const span of claimed) {
      if (
        face.some(
          (i) =>
            i.rect[0] < cuts[span.column + span.colSpan] &&
            i.rect[2] > cuts[span.column] &&
            !(i.rect[0] >= cuts[span.column] && i.rect[2] <= cuts[span.column + span.colSpan])
        )
      )
        return
    }
    rows.push([
      cuts[0],
      Math.min(edges[r][1], ...face.map((i) => i.rect[1])),
      cuts.at(-1),
      Math.max(edges[r + 1][1], ...face.map((i) => i.rect[3]))
    ])
  }
  if (spans.length < 2 || !cuts.slice(2).every((_, c) => covered.has(c + 1))) return
  return { rows, spans }
}

// Repeated inset rules bound measurement records while deliberately bypassing
// shared stubs and sample counts. Require complete native faces in every column;
// a missing separator alone must never merge unrelated measurements.
export function recoverInsetRecordFaces(table, items, captions, rules) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const crop = table.cropRect
  const predicted = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (predicted.length < 6 || predicted.length > 16) return
  const horizontal = joinHorizontalTableRules(rules, 1).filter(
    (r) =>
      r[1] >= crop[1] - 16 && r[1] <= crop[3] + 16 && r[0] >= crop[0] - 16 && r[2] <= crop[2] + 16
  )
  const full = horizontal.filter(
    (r) => Math.abs(r[0] - crop[0]) < 16 && Math.abs(r[2] - crop[2]) < 16
  )
  if (
    full.length < 3 ||
    Math.abs(full[0][1] - crop[1]) > 16 ||
    Math.abs(full.at(-1)[1] - crop[3]) > 16
  )
    return
  const [left, top, right] = full[0],
    bottom = full.at(-1)[1],
    divider = full[1][1]
  const cuts = [
    left,
    ...predicted.slice(1).map((c, n) => crop[0] + (predicted[n].rect[2] + c.rect[0]) / 2),
    right
  ]
  const source = tableSourceItems(items, [left, top, right, bottom]),
    header = source.filter((i) => i.rect[3] <= divider)
  const headings = recoverRuledHeaderBands(header, cuts, rules, top, divider)
  if (!headings || headings.rows.length !== 2) return
  const height = Math.max(...header.map((i) => i.height)),
    split = headings.rows[0][3]
  const col = (i) => cuts.slice(1).findIndex((x) => (i.rect[0] + i.rect[2]) / 2 < x)
  const leaf = header.filter((i) => i.rect[1] >= split),
    values = readSourceRow(leaf, cuts, { multiline: true })
  if (!values || values.filter((v) => /^n$/i.test(v)).length < 2) return
  // One continuous underline can cover independent parents. Repeated complete
  // leaf sequences and a distinct title inside each sequence prove the split.
  const spans = [],
    owned = [],
    signatures = []
  for (const parent of headings.spans.filter((s) => s.colSpan > 1)) {
    const sequence = values.slice(parent.column, parent.column + parent.colSpan)
    const repeat = sequence.findIndex((v, n) => n > 0 && v === sequence[0]),
      period = repeat < 0 ? sequence.length : repeat
    if (
      period < 2 ||
      sequence.length % period ||
      sequence.some((v, n) => !v || v !== sequence[n % period])
    )
      return
    for (let c = parent.column; c < parent.column + parent.colSpan; c += period) {
      const tokens = header.filter(
        (i) => i.rect[3] <= split && i.rect[0] >= cuts[c] && i.rect[2] <= cuts[c + period]
      )
      if (
        !tokens.length ||
        !tokens.some((i) => /\p{L}/u.test(i.text)) ||
        Math.max(...tokens.map((i) => i.baseline)) - Math.min(...tokens.map((i) => i.baseline)) >
          height * 0.35
      )
        return
      spans.push({ row: 0, column: c, rowSpan: 1, colSpan: period })
      signatures.push(sequence.slice(0, period).join('|'))
      owned.push(tokens)
    }
  }
  if (spans.length < 2 || new Set(signatures).size !== 1) return
  for (let c = 0; c < predicted.length; c++) {
    const tokens = header.filter((i) => col(i) === c && !owned.some((g) => g.includes(i)))
    if (!tokens.length) continue
    if (tokens.some((i) => i.rect[0] < cuts[c] || i.rect[2] > cuts[c + 1])) return
    if (spans.some((s) => c >= s.column && c < s.column + s.colSpan)) {
      if (tokens.some((i) => i.rect[1] < split)) return
    } else spans.push({ row: 0, column: c, rowSpan: 2, colSpan: 1 })
    owned.push(tokens)
  }
  if (!hasUniqueRecordTokens(header, owned)) return
  const body = source.filter((i) => i.rect[1] >= divider)
  if (!hasUniqueRecordTokens(source, [header, body])) return
  const ys = clusterTableRulePositions(
    horizontal.filter((r) => r[1] >= divider && r[1] <= bottom).map((r) => r[1])
  )
  if (ys.length < 6 || ys.length > 60) return
  const rows = [...headings.rows, ...ys.slice(1).map((y, n) => [left, ys[n], right, y])]
  const sections = new Set()
  for (let n = 0; n < ys.length - 1; n++) {
    const g = body.filter((i) => i.rect[1] >= ys[n] && i.rect[3] <= ys[n + 1])
    if (!g.length || readSourceRow(g, cuts, { multiline: true })) continue
    const rect = union(g)
    if (
      g.some((i) => /\d/.test(i.text)) ||
      !g.some((i) => /\p{L}/u.test(i.text)) ||
      Math.max(...g.map((i) => i.baseline)) - Math.min(...g.map((i) => i.baseline)) >
        height * 0.35 ||
      Math.abs(rect[0] + rect[2] - left - right) > height * 2 ||
      ![ys[n], ys[n + 1]].every((y) => full.some((r) => Math.abs(r[1] - y) < 0.1))
    )
      return
    sections.add(n)
    spans.push({ row: n + 2, column: 0, rowSpan: 1, colSpan: predicted.length })
    owned.push(g)
  }
  const records = body.filter((i) => !owned.some((g) => g.includes(i)))
  if (!readSourceRow(records, cuts, { multiline: true })) return
  let shared = 0,
    insetBands = 0
  const edges = cuts.slice(1).map((_, c) => {
    const tokens = records.filter((i) => col(i) === c)
    if (!tokens.length) return
    const bounds = union(tokens)
    return ys.map((y) => classifyTableRuleEdge(horizontal, 1, y, bounds[0], bounds[2]))
  })
  if (edges.some((e) => !e || e.some((v) => v < 0))) return
  for (let n = 1; n < ys.length - 1; n++) {
    const count = edges.filter((e) => e[n] === 1).length
    if (count >= 3 && count < predicted.length) insetBands++
  }
  if (insetBands < 3) return
  for (let c = 0; c < predicted.length; c++) {
    for (let start = 0; start < ys.length - 1;) {
      if (sections.has(start)) {
        start++
        continue
      }
      let end = start + 1
      while (end < ys.length - 1 && !edges[c][end] && !sections.has(end)) end++
      if (!edges[c][start] || !edges[c][end]) return
      const g = records.filter(
        (i) => col(i) === c && i.rect[1] >= ys[start] && i.rect[3] <= ys[end]
      )
      if (!g.length) return
      const text = readSourceRow(g, cuts, { multiline: true })?.[c]
      if (end - start > 1) {
        const count = header
          .filter((i) => col(i) === c)
          .map((i) => i.text)
          .join('')
          .trim()
        if (c === 0) {
          if (!/\p{L}/u.test(text)) return
          const lines = groupSourceRowsWithScripts(g, height, 0.35)
          if (
            !lines ||
            lines.some((line, n) => n && line[0].baseline - lines[n - 1][0].baseline > height * 1.5)
          )
            return
        } else {
          if (
            !/^n$/i.test(count) ||
            !/^\d+$/.test(text) ||
            g.length !== 1 ||
            Math.abs(g[0].rect[1] + g[0].rect[3] - ys[start] - ys[end]) > height * 2
          )
            return
          shared++
        }
        spans.push({ row: start + 2, column: c, rowSpan: end - start, colSpan: 1 })
      }
      owned.push(g)
      start = end
    }
  }
  if (shared < 2 || !hasUniqueRecordTokens(source, owned)) return
  return {
    cropRect: [left, top, right, bottom],
    rows,
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    headerRows: [0, 1],
    spans,
    completeSpans: true,
    ownedTokens: new Set(source)
  }
}

// Native faces bound each section; complete numeric bands anchor records even
// when a value is vertically centered against a wrapped stub. Label-only bands
// must introduce indented children or occupy the beginning of a ruled section.
function recoverSectionedCenteredRecords(faces, cuts, edges, height) {
  const head = readSourceRow(faces[0], cuts, { multiline: true })
  if (
    !head ||
    head[0] ||
    cuts.length < 4 ||
    cuts.length > 7 ||
    !head.slice(1).every((v) => /\p{L}/u.test(v) && /\([Nn]=\d+\)/.test(v))
  )
    return
  const owned = []
  let records = 0,
    wrapped = 0
  for (const face of faces.slice(1)) {
    const stub = face.filter((i) => i.rect[2] <= cuts[1]),
      data = face.filter((i) => i.rect[0] >= cuts[1])
    if (!hasUniqueRecordTokens(face, [stub, data])) return
    const lines = groupSourceRowsWithScripts(stub, height, 0.35),
      bands = groupSourceRowsWithScripts(data, height, 0.35)
    if (
      !lines ||
      !bands ||
      bands.length < 2 ||
      bands.some((g) => !readSourceRow(g, cuts)?.slice(1).every(numeric))
    )
      return
    const labels = []
    for (const line of lines) {
      const value = readSourceRow(line, cuts)?.[0],
        previous = labels.at(-1)
      if (!value || !/\p{L}/u.test(value)) return
      if (/^[a-z(]/.test(value)) {
        if (
          !previous ||
          Math.abs(union(previous)[0] - union(line)[0]) > 1 ||
          line[0].baseline - Math.max(...previous.map((i) => i.baseline)) > height * 1.5
        )
          return
        previous.push(...line)
        wrapped++
      } else labels.push([...line])
    }
    const assignments = labels.map(() => [])
    for (const band of bands) {
      const b = union(band),
        center = (b[1] + b[3]) / 2,
        owners = labels.flatMap((g, n) => {
          const r = union(g)
          return center >= r[1] && center <= r[3] ? [n] : []
        })
      if (owners.length !== 1 || assignments[owners[0]].length) return
      assignments[owners[0]] = band
    }
    for (const [n, label] of labels.entries()) {
      const data = assignments[n]
      if (
        !data.length &&
        n &&
        (!labels[n + 1] || union(labels[n + 1])[0] < union(label)[0] + height * 0.5)
      )
        return
      if (data.length) records++
      owned.push([...label, ...data])
    }
  }
  const bounds = owned.map(union)
  if (
    records < 10 ||
    wrapped < 3 ||
    !hasUniqueRecordTokens(faces.flat(), [faces[0], ...owned]) ||
    bounds.some((b, n) => n && b[1] <= bounds[n - 1][3]) ||
    bounds.some((b) => edges.slice(1, -1).some((r) => r[1] > b[1] + height * 0.1 && r[1] < b[3]))
  )
    return
  return owned
}
