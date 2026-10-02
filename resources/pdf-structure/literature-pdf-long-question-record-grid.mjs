/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  tableSourceItems,
  groupSourceRowsWithScripts,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

const numeric = /^\d+(?:\.\d+)?$/
const text = (items) =>
  items
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    .map((i) => i.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
const box = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]
const heightOf = (items) => items.map((i) => i.height).sort((a, b) => a - b)[items.length >> 1]

// These source paths carry the native field boundaries even when their tiny
// stroke gaps make them look like one continuous rule in the rendered page.
export function questionRecordRuleBands(rules, count, height) {
  return [
    ...Map.groupBy(
      rules.filter((r) => r[1] === r[3]),
      (r) => r[1]
    ).values()
  ]
    .map((g) => [...g].sort((a, b) => a[0] - b[0]))
    .filter(
      (g) =>
        g.length === count &&
        g.every((r, n) => r[2] > r[0] && (!n || Math.abs(r[0] - g[n - 1][2]) < height * 0.075))
    )
    .sort((a, b) => a[0][1] - b[0][1])
}
const sameBand = (a, b, h) =>
  a.length === b.length &&
  a.every((r, n) => Math.abs(r[0] - b[n][0]) < h * 0.1 && Math.abs(r[2] - b[n][2]) < h * 0.1)
const cutsFor = (band) => [
  band[0][0] - 0.001,
  ...band.slice(1).map((r, n) => (band[n][2] + r[0]) / 2),
  band.at(-1)[2] + 0.001
]

function sourceInFrame(items, crop) {
  const source = tableSourceItems(items, crop)
  if (
    items.some(
      (i) =>
        i.horizontal &&
        i.text.trim() &&
        i.rect[0] < crop[2] &&
        i.rect[2] > crop[0] &&
        i.rect[1] < crop[3] &&
        i.rect[3] > crop[1] &&
        !source.includes(i)
    )
  )
    return
  return source
}

function sourceAboveStatisticalFooter(items, crop, height) {
  const external = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[1] < crop[3] &&
      i.rect[3] > crop[3] &&
      i.rect[0] >= crop[0] &&
      i.rect[2] <= crop[2]
  )
  if (
    external.length &&
    (!/^\* indicates p</.test(text([...external])) ||
      external.some((i) => crop[3] - i.rect[1] > height * 0.1))
  )
    return
  return sourceInFrame(
    items.filter((i) => !external.includes(i)),
    crop
  )
}

function recordProof(source, cuts, crop, records, spans = [], headerRows = []) {
  if (
    !hasUniqueRecordTokens(
      source,
      records.map((r) => r.parts)
    )
  )
    return
  const starts = records.map((r) => r.start),
    edges = [crop[1]]
  for (const start of starts.slice(1)) {
    const prior = source.filter((i) => i.rect[3] <= start + 0.01)
    if (!prior.length) return
    const edge = (Math.max(...prior.map((i) => i.rect[3])) + start) / 2
    if (edge <= edges.at(-1) || edge >= crop[3]) return
    edges.push(edge)
  }
  edges.push(crop[3])
  const rows = edges.slice(1).map((y, n) => [crop[0], edges[n], crop[2], y])
  const columns = cuts.slice(1).map((x, n) => [cuts[n], crop[1], x, crop[3]])
  return {
    cropRect: crop,
    rows,
    columns,
    spans,
    headerRows,
    completeSpans: true,
    ownedTokens: new Set(source),
    repair: 'native-body-records-recovered'
  }
}

function quantitativeProof(table, items, captions, rules, height) {
  const bands = questionRecordRuleBands(rules, 4, height)
  for (const top of bands) {
    const matching = bands.filter((b) => b[0][1] >= top[0][1] && sameBand(top, b, height))
    if (matching.length !== 3) continue
    const divider = matching[1][0][1],
      bottom = matching[2][0][1]
    if (divider - top[0][1] > height * 3 || Math.abs(bottom - table.cropRect[3]) > height) continue
    if (
      captions.filter(
        (c) =>
          /^Table\s+\d+/.test(c.lines[0]) &&
          c.rect[3] <= top[0][1] &&
          top[0][1] - c.rect[3] < height * 3
      ).length !== 1
    )
      continue
    const cuts = cutsFor(top),
      crop = [cuts[0], top[0][1], cuts.at(-1), bottom],
      source = sourceInFrame(items, crop)
    if (!source) continue
    const header = source.filter((i) => i.rect[3] < divider),
      body = source.filter((i) => i.rect[1] > divider)
    if (
      !hasUniqueRecordTokens(source, [header, body]) ||
      readSourceRow(header, cuts)?.join('|') !== 'QuantitativeQuestions|n|Mean|SD'
    )
      continue
    const physical = groupSourceRowsWithScripts(body, height, 0.25)
    if (!physical) continue
    const questionStarts = physical.filter((g) =>
      /^\d+[.)]/.test(readSourceRow(g, cuts)?.[0] ?? '')
    )
    if (
      questionStarts.length < 2 ||
      questionStarts.some((g, n) => Number(/^\d+/.exec(readSourceRow(g, cuts)[0])[0]) !== n + 1)
    )
      continue
    const records = [{ start: crop[1], parts: header }],
      firstY = box(questionStarts[0])[1]
    const intro = body.filter((i) => i.rect[3] < firstY)
    if (intro.length) {
      if (readSourceRow(intro, cuts).slice(1).some(Boolean)) continue
      records.push({ start: box(intro)[1], parts: intro })
    }
    let valid = true
    for (const [n, g] of questionStarts.entries()) {
      const start = box(g)[1],
        next = n + 1 < questionStarts.length ? box(questionStarts[n + 1])[1] : Infinity
      const parts = body.filter((i) => i.rect[1] >= start - 0.01 && i.rect[1] < next)
      const values = readSourceRow(g, cuts)
      if (!values?.slice(1).every((v) => numeric.test(v))) {
        valid = false
        break
      }
      const tail = parts.filter((i) => !g.includes(i) && i.rect[0] >= cuts[1])
      if (n + 1 < questionStarts.length && tail.length) {
        valid = false
        break
      }
      if (n + 1 === questionStarts.length && tail.length) {
        const average = physical.find((p) => p.some((i) => tail.includes(i)))
        if (
          !average ||
          readSourceRow(average, cuts)
            .slice(-2)
            .some((v) => !numeric.test(v)) ||
          readSourceRow(average, cuts)[1] !== 'Average'
        ) {
          valid = false
          break
        }
        const averageY = box(average)[1]
        records.push(
          { start, parts: parts.filter((i) => i.rect[1] < averageY) },
          { start: averageY, parts: parts.filter((i) => i.rect[1] >= averageY) }
        )
      } else records.push({ start, parts })
    }
    if (valid) {
      const proof = recordProof(source, cuts, crop, records, [], [0])
      if (proof) return proof
    }
  }
}

function qualitativeProof(table, items, rules, height) {
  const bands = questionRecordRuleBands(rules, 3, height)
  for (const top of bands) {
    const matching = bands.filter((b) => b[0][1] >= top[0][1] && sameBand(top, b, height))
    if (matching.length !== 3) continue
    const bottom = matching[2][0][1]
    if (Math.abs(bottom - table.cropRect[3]) > height) continue
    const cuts = cutsFor(top),
      crop = [cuts[0], top[0][1], cuts.at(-1), bottom],
      source = sourceInFrame(items, crop)
    if (!source || !readSourceRow(source, cuts)) continue
    const physical = groupSourceRowsWithScripts(source, height, 0.25)
    if (!physical) continue
    const labels = ['QualitativeQuestions', 'CommonThemes', 'Example']
    const headings = labels.map((label, c) =>
      physical.filter((g) => readSourceRow(g, cuts)?.[c] === label)
    )
    if (headings.some((groups) => groups.length !== 1)) continue
    const header = [...new Set(headings.flat(2))],
      headerBox = box(header)
    if (headerBox[3] - headerBox[1] > height * 6) continue
    const body = source.filter((i) => !header.includes(i)),
      bodyPhysical = groupSourceRowsWithScripts(body, height, 0.25)
    if (!bodyPhysical) continue
    const quotes = bodyPhysical.filter((g) => /^[“"]/.test(readSourceRow(g, cuts)[2]))
    const questions = bodyPhysical.filter((g) => /^\d+[.)]/.test(readSourceRow(g, cuts)[0]))
    if (
      quotes.length < 2 ||
      questions.length < 1 ||
      questions.some(
        (g, n) =>
          n &&
          Number(/^\d+/.exec(readSourceRow(g, cuts)[0])[0]) !==
            Number(/^\d+/.exec(readSourceRow(questions[n - 1], cuts)[0])[0]) + 1
      )
    )
      continue
    const records = quotes.map((g, n) => ({
      start: box(g)[1],
      parts: body.filter(
        (i) =>
          i.rect[0] >= cuts[1] &&
          i.rect[1] >= box(g)[1] - 0.01 &&
          i.rect[1] < (quotes[n + 1] ? box(quotes[n + 1])[1] : Infinity)
      )
    }))
    if (
      records.some((r) => {
        const values = readSourceRow(r.parts, cuts, { multiline: true })
        return (
          !values ||
          !/\(n=\d+\)/.test(values[1]) ||
          (!values[2].startsWith('“') && !values[2].startsWith('"'))
        )
      })
    )
      continue
    const spans = []
    let valid = true
    for (const [n, g] of questions.entries()) {
      const start = box(g)[1],
        next = questions[n + 1] ? box(questions[n + 1])[1] : Infinity
      const owned = records.filter(
        (r) => r.start >= start - height * 0.2 && r.start < next - height * 0.2
      )
      const question = body.filter(
        (i) => i.rect[2] <= cuts[1] && i.rect[1] >= start - 0.01 && i.rect[1] < next
      )
      if (!owned.length || !question.length) {
        valid = false
        break
      }
      owned[0].parts.push(...question)
      if (owned.length > 1)
        spans.push({ record: owned[0], column: 0, rowSpan: owned.length, colSpan: 1 })
    }
    if (!valid) continue
    const headerRecord = { start: headerBox[1], parts: header }
    records.push(headerRecord)
    records.sort((a, b) => a.start - b.start)
    const mappedSpans = spans.map(({ record, ...span }) => ({
      ...span,
      row: records.indexOf(record)
    }))
    const proof = recordProof(source, cuts, crop, records, mappedSpans, [
      records.indexOf(headerRecord)
    ])
    if (proof) return proof
  }
}

// Numbered questions and native schema-specific paths delimit long records.
// Quoted examples establish theme starts; adjacent question ink is shared
// only across those proved theme rows, with every source token owned once.
export function recoverNativeQuestionRecordGrid(table, items, captions, rules) {
  const nearby = tableSourceItems(items, table.cropRect),
    height = heightOf(nearby)
  if (!(height > 0)) return
  return (
    quantitativeProof(table, items, captions, rules, height) ??
    qualitativeProof(table, items, rules, height)
  )
}

// Admit the extra schema only as a source-proved part of this numbered,
// closed quantitative table, never as an independent unnumbered candidate.
export function recoverMixedQuestionSections(tables, items, captions, rules, pageNumber) {
  const matches = []
  for (const table of tables) {
    const h = heightOf(tableSourceItems(items, table.cropRect))
    if (!(h > 0)) continue
    const upper = quantitativeProof(table, items, captions, rules, h)
    if (!upper) continue
    const bands = questionRecordRuleBands(rules, 3, h).filter(
      (b) => b[0][1] > upper.cropRect[3] && b[0][1] - upper.cropRect[3] < h * 25
    )
    if (
      bands.length !== 3 ||
      bands[0][0][1] - upper.cropRect[3] > h * 3 ||
      !sameBand(bands[0], bands[2], h)
    )
      continue
    const lowerTable = {
      ...table,
      cropRect: [bands[0][0][0], bands[0][0][1], bands[0].at(-1)[2], bands.at(-1)[0][1]]
    }
    const lower = qualitativeProof(lowerTable, items, rules, h)
    if (
      !lower ||
      Math.abs(upper.cropRect[0] - lower.cropRect[0]) > h * 0.1 ||
      Math.abs(upper.cropRect[2] - lower.cropRect[2]) > h * 0.1
    )
      continue
    if (
      tables.some(
        (other) =>
          other !== table &&
          other.cropRect[0] < lower.cropRect[2] &&
          other.cropRect[2] > lower.cropRect[0] &&
          other.cropRect[1] < lower.cropRect[3] &&
          other.cropRect[3] > lower.cropRect[1]
      )
    )
      continue
    const build = (proof, n) => ({
      id: `page-${pageNumber}-native-mixed-question-section-${n}`,
      cropRect: proof.cropRect,
      structure: {
        objects: [
          ...proof.rows.map((rect) => ({
            label: 'table row',
            rect: rect.map((v, i) => v - proof.cropRect[i % 2])
          })),
          ...proof.columns.map((rect) => ({
            label: 'table column',
            rect: rect.map((v, i) => v - proof.cropRect[i % 2])
          }))
        ]
      }
    })
    matches.push({ replaced: [table], tables: [build(upper, 1), build(lower, 2)] })
  }
  return matches.length === 1 ? matches[0] : undefined
}

export function groupMixedQuestionSections(tables) {
  const result = [],
    used = new Set()
  for (const first of tables) {
    if (used.has(first)) continue
    const id = /^(page-\d+-native-mixed-question)-section-1$/.exec(first.id)
    const second = id && tables.find((t) => t.id === id[1] + '-section-2' && t.page === first.page)
    if (
      !second ||
      !first.caption ||
      second.caption ||
      first.parts ||
      second.parts ||
      first.notes?.length ||
      second.cropRect[1] <= first.cropRect[3] ||
      Math.abs(first.cropRect[0] - second.cropRect[0]) > 1 ||
      Math.abs(first.cropRect[2] - second.cropRect[2]) > 1 ||
      second.cropRect[1] - first.cropRect[3] > (first.cropRect[2] - first.cropRect[0]) * 0.1 ||
      first.grid?.[0]?.length !== 4 ||
      second.grid?.[0]?.length !== 3
    ) {
      result.push(first)
      continue
    }
    used.add(second)
    result.push({
      id: id[1],
      page: first.page,
      caption: first.caption,
      cropRect: [first.cropRect[0], first.cropRect[1], first.cropRect[2], second.cropRect[3]],
      notes: second.notes ?? [],
      parts: [first, second].map((p) => ({
        title: p.grid[0][0],
        sourceViewport: p.sourceViewport,
        grid: p.grid,
        cells: p.cells,
        unassigned: p.unassigned,
        issues: p.issues,
        clipped: p.clipped ?? [],
        notes: []
      }))
    })
  }
  return result
}

// Eight native closing-path faces retain empty predictor lanes. Every outcome
// has the same occupied-lane mask for estimate, standard error and effect
// size; a wrapped technical label does not create an extra statistical row.
export function recoverNativeSparseModelRecordGrid(table, items, captions, rules) {
  const height = heightOf(tableSourceItems(items, table.cropRect))
  if (!(height > 0)) return
  const bands = questionRecordRuleBands(rules, 8, height)
  if (!bands.length) return
  const closing = bands.at(-1),
    matching = bands.filter((b) => sameBand(b, closing, height))
  if (matching.length !== bands.length || Math.abs(closing[0][1] - table.cropRect[3]) > height)
    return
  const cuts = cutsFor(closing),
    full = rules.filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[0] - cuts[0]) < height * 0.1 &&
        Math.abs(r[2] - cuts.at(-1)) < height * 0.1 &&
        r[1] <= table.cropRect[1] + height
    )
  const top = matching.length > 1 ? matching[0][0][1] : full.length === 1 ? full[0][1] : undefined
  if (top === undefined) return
  const leading = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[1] < top &&
      i.rect[3] > top &&
      i.rect[0] >= cuts[0] &&
      i.rect[2] <= cuts[1]
  )
  if (
    leading.length &&
    (!/^[\p{L} ]+$/u.test(text([...leading])) ||
      leading.some((i) => top - i.rect[1] > height * 0.1))
  )
    return
  const crop = [
    cuts[0],
    Math.min(top, ...leading.map((i) => i.rect[1])),
    cuts.at(-1),
    closing[0][1]
  ]
  const source = sourceAboveStatisticalFooter(items, crop, height)
  if (!source) return
  const records = [],
    headerParts = new Set(),
    headers = []
  for (const [n, band] of matching.entries()) {
    const after = matching[n + 1]
    if (!after || after[0][1] - band[0][1] > height * 9) continue
    const parts = source.filter((i) => i.rect[1] > band[0][1] && i.rect[3] < after[0][1]),
      values = readSourceRow(parts, cuts, { multiline: true })
    if (
      values?.[0] !== 'Outcomevariable' ||
      !values[6]?.includes('interaction') ||
      !values[7]?.includes('interaction')
    )
      continue
    if (
      headers.some(
        (h) => readSourceRow(h.parts, cuts, { multiline: true }).join('|') !== values.join('|')
      )
    )
      return
    const record = { start: band[0][1], parts }
    headers.push(record)
    records.push(record)
    parts.forEach((i) => headerParts.add(i))
  }
  const body = source.filter((i) => !headerParts.has(i)),
    physical = groupSourceRowsWithScripts(body, height, 0.25)
  if (!physical) return
  const spans = [],
    value = /^[−+-]?\d+(?:\.\d+)?\*?$/
  let sections = 0
  for (let n = 0; n < physical.length;) {
    const section = physical[n],
      label = text([...section])
    if (
      !/^\p{L}/u.test(label) ||
      /\d/.test(label) ||
      /^(?:Table|Figure|Estimate|Standard|Error|Effect Size)\b/i.test(label) ||
      section.some((i) => i.rect[0] >= cuts[1])
    )
      return
    const projected = { start: box(section)[1], parts: section }
    records.push(projected)
    spans.push({ record: projected, column: 0, rowSpan: 1, colSpan: 8 })
    sections++
    n++
    const group = []
    for (const name of ['Estimate', 'StandardError', 'EffectSize']) {
      let parts = physical[n]
      if (!parts) return
      let values = readSourceRow(parts, cuts)
      if (
        name === 'StandardError' &&
        values?.[0] === 'Standard' &&
        values.slice(1).every((v) => !v)
      ) {
        const next = physical[n + 1]
        if (
          !next ||
          readSourceRow(next, cuts)?.[0] !== 'Error' ||
          box(next)[1] - box(parts)[3] > height * 1.5
        )
          return
        parts = [...parts, ...next]
        n++
        values = readSourceRow(parts, cuts, { multiline: true })
      }
      if (
        values?.[0] !== name ||
        values.slice(1).filter(Boolean).length < 2 ||
        values.slice(1).some((v) => v && !value.test(v))
      )
        return
      group.push({ start: box(parts)[1], parts, mask: values.slice(1).map(Boolean).join('|') })
      n++
    }
    if (group.some((g) => g.mask !== group[0].mask)) return
    records.push(...group)
  }
  if (sections < 2) return
  records.sort((a, b) => a.start - b.start)
  return recordProof(
    source,
    cuts,
    crop,
    records,
    spans.map(({ record, ...span }) => ({ ...span, row: records.indexOf(record) })),
    headers.map((h) => records.indexOf(h))
  )
}
// Native three-face paths and repeated sample-qualified headers identify the
// two-cohort schema. Lowercase stub tails retain their source numeric pair;
// independent section baselines and printed statistics remain unchanged.
export function recoverNativeCohortRecordGrid(table, items, captions, rules) {
  if (table.structure.objects.filter((o) => o.label === 'table column').length !== 3) return
  const height = heightOf(tableSourceItems(items, table.cropRect))
  if (!(height > 0)) return
  const bands = questionRecordRuleBands(rules, 3, height)
  if (![1, 4].includes(bands.length)) return
  const first = bands[0],
    cuts = cutsFor(first)
  if (bands.some((b) => !sameBand(b, first, height))) return
  const continued = bands.length === 1
  if (continued && Math.abs(first[0][1] - table.cropRect[3]) > height) return
  if (
    !continued &&
    (!captions.some(
      (c) =>
        /^Table\s+\d+/.test(c.lines[0]) &&
        first[0][1] - c.rect[3] >= 0 &&
        first[0][1] - c.rect[3] < height * 3
    ) ||
      bands[1][0][1] - first[0][1] > height * 5 ||
      bands[3][0][1] - bands[2][0][1] > height * 5)
  )
    return
  const crop = [
      cuts[0],
      continued ? table.cropRect[1] : first[0][1],
      cuts.at(-1),
      continued ? first[0][1] : table.cropRect[3]
    ],
    source = continued
      ? sourceAboveStatisticalFooter(items, crop, height)
      : sourceInFrame(items, crop)
  if (!source) return
  const records = [],
    headerParts = new Set(),
    headers = []
  if (!continued) {
    for (const n of [0, 2]) {
      const parts = source.filter(
          (i) => i.rect[1] > bands[n][0][1] && i.rect[3] < bands[n + 1][0][1]
        ),
        values = readSourceRow(parts, cuts, { multiline: true })
      if (
        !values ||
        values[0] !== 'Characteristic' ||
        values.slice(1).some((v) => !/^\p{L}+n=\d+$/u.test(v))
      )
        return
      if (
        headers.length &&
        values.join('|') !== readSourceRow(headers[0].parts, cuts, { multiline: true }).join('|')
      )
        return
      const record = { start: bands[n][0][1], parts }
      records.push(record)
      headers.push(record)
      parts.forEach((i) => headerParts.add(i))
    }
  }
  const physical = groupSourceRowsWithScripts(
    source.filter((i) => !headerParts.has(i)),
    height,
    0.25
  )
  if (!physical) return
  const pair = /^\d+(?:\.\d+)?\(\d+(?:\.\d+)?\)\*?$/,
    body = []
  let pairs = 0,
    formats = 0
  for (const row of physical) {
    const values = readSourceRow(row, cuts)
    if (!values) return
    const stub = values[0],
      numbers = values.slice(1),
      prior = body.at(-1),
      lower = /^\p{Ll}/u.test(stub)
    if (!stub) {
      if (
        continued ||
        !numbers.every((v) => /^(?:X\(SD\)|N\(%\))$/.test(v)) ||
        numbers[0] !== numbers[1]
      )
        return
      body.push({ start: box(row)[1], parts: row })
      formats++
      continue
    }
    if (numbers.every((v) => !v)) {
      if (
        lower &&
        prior &&
        Math.abs(
          row[0].rect[0] -
            Math.min(...prior.parts.filter((i) => i.rect[2] < cuts[1]).map((i) => i.rect[0]))
        ) <
          height * 0.1 &&
        box(row)[1] - box(prior.parts)[3] < height * 1.5
      ) {
        prior.parts.push(...row)
        continue
      }
      if (lower) return
      body.push({ start: box(row)[1], parts: row })
      continue
    }
    if (!numbers.every((v) => pair.test(v))) return
    if (
      lower &&
      prior &&
      readSourceRow(prior.parts, cuts, { multiline: true })
        .slice(1)
        .every((v) => !v) &&
      box(row)[1] - box(prior.parts)[3] < height * 1.5
    ) {
      prior.parts.push(...row)
    } else body.push({ start: box(row)[1], parts: row })
    pairs++
  }
  if (pairs < (continued ? 8 : 10) || (!continued && formats !== 2)) return
  records.push(...body)
  records.sort((a, b) => a.start - b.start)
  return recordProof(
    source,
    cuts,
    crop,
    records,
    [],
    headers.map((h) => records.indexOf(h))
  )
}
