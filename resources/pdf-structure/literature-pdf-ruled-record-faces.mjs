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
  const inset = recoverInsetRecordFaces(table, items, captions, rules)
  if (inset) return inset
  const captioned = captions.some((c) => captionKind(c.lines[0]) === 'table')
  const crop = table.cropRect
  const joined = joinHorizontalTableRules(rules, 1)
  const tolerance = Math.max(16, (crop[2] - crop[0]) * 0.06)
  const edges = joined.filter(
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
            Math.min(...next.filter((i) => i.rect[2] < cuts[1]).map((i) => i.rect[0])) <
              label[0] + height * 0.4
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
  if ((!header || header.some((v) => !/\p{L}/u.test(v))) && !(headings?.rows.length > 1)) return
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
