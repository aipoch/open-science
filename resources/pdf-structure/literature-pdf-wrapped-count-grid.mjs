/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { union } from './literature-pdf-table-geometry.mjs'

// Headerless manuscript continuations still contain independent table evidence:
// repeated aligned count/percentage pairs, complete category totals and one
// shared probability per category. Inferred denominators validate ownership only;
// they never supply output text or replace a missing source value.
export function recoverWrappedCountTable(items, rules, pageNumber) {
  const source = items
    .filter((i) => i.horizontal)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
  const integer = (i) => /^\d+$/.test(i.text)
  const pairs = []
  for (const count of source.filter(integer)) {
    const heads = source.filter(
      (i) =>
        /^\(\d+\./.test(i.text) &&
        i.rect[0] > count.rect[2] &&
        i.rect[0] - count.rect[2] < count.height * 5 &&
        i.baseline < count.baseline &&
        count.baseline - i.baseline < count.height * 1.5
    )
    if (heads.length !== 1) continue
    const head = heads[0]
    const tails = source.filter(
      (i) =>
        /^[\d]*\)$/.test(i.text) &&
        Math.abs(i.rect[0] - head.rect[0]) < count.height * 0.2 &&
        i.baseline > count.baseline &&
        i.baseline - count.baseline < count.height * 1.5
    )
    if (tails.length !== 1 || !/^\(\d+\.\d+\)$/.test(head.text + tails[0].text)) continue
    pairs.push({ count, head, tail: tails[0] })
  }
  const seeds = []
  for (const pair of pairs) {
    const seed = seeds.find(
      (g) => Math.abs(g[0].count.baseline - pair.count.baseline) < pair.count.height * 0.3
    )
    if (seed) seed.push(pair)
    else seeds.push([pair])
  }
  const complete = seeds
    .filter((g) => g.length >= 3 && g.length <= 6)
    .map((g) => g.sort((a, b) => a.count.rect[0] - b.count.rect[0]))
  if (complete.length < 6) return
  const first = complete[0].sort((a, b) => a.count.rect[0] - b.count.rect[0]),
    h = first[0].count.height
  const xs = first.flatMap((p) => [p.count.rect[0], p.head.rect[0]])
  if (
    complete.some(
      (g) =>
        g.length !== first.length ||
        g.some(
          (p, c) =>
            Math.abs(p.count.rect[0] - xs[c * 2]) > h * 0.2 ||
            Math.abs(p.head.rect[0] - xs[c * 2 + 1]) > h * 0.2
        )
    )
  )
    return
  const rowAnchors = source.filter(
    (i) => (integer(i) || i.text === '-') && Math.abs(i.rect[0] - xs[0]) < h * 0.2
  )
  if (rowAnchors.length < 6 || rowAnchors.length > 40) return
  const records = [],
    joinedTokens = new Set()
  for (const anchor of rowAnchors) {
    const row = []
    const values = []
    for (let c = 0; c < first.length; c++) {
      const counts = source.filter(
        (i) =>
          (integer(i) || i.text === '-') &&
          Math.abs(i.rect[0] - xs[c * 2]) < h * 0.2 &&
          Math.abs(i.baseline - anchor.baseline) < h * 0.3
      )
      if (counts.length !== 1) return
      const count = counts[0],
        pair = pairs.find((p) => p.count === count)
      if (pair) {
        const percent = Number((pair.head.text + pair.tail.text).slice(1, -1))
        if (percent < 0 || percent > 100) return
        row.push(count, pair.head, pair.tail)
        joinedTokens.add(pair.tail)
        values.push([Number(count.text), percent])
      } else {
        const dash = source.filter(
          (i) =>
            i.text === '-' &&
            Math.abs(i.rect[0] - xs[c * 2 + 1]) < h * 0.2 &&
            Math.abs(i.baseline - anchor.baseline) < h * 0.3
        )
        if (count.text !== '-' || dash.length !== 1) return
        row.push(count, dash[0])
        values.push(null)
      }
    }
    const bounds = union(row)
    const stub = source.filter(
      (i) =>
        i.rect[2] < xs[0] && i.rect[1] >= bounds[1] - h * 0.2 && i.rect[3] <= bounds[3] + h * 0.2
    )
    if (!stub.length || stub.some((i) => i.height > h * 1.2 || i.height < h * 0.8)) return
    row.push(...stub)
    records.push({ items: row, rect: union(row), values })
  }
  if (records.some((r, i) => i && r.rect[1] <= records[i - 1].rect[3])) return
  const assigned = new Set(records.flatMap((r) => r.items))
  const left = Math.min(
    ...records.flatMap((r) => r.items.filter((i) => i.rect[2] < xs[0]).map((i) => i.rect[0]))
  )
  const top = records[0].rect[1],
    bottom = records.at(-1).rect[3]
  const titleTokens = source.filter(
    (i) =>
      !assigned.has(i) &&
      i.rect[2] < xs[0] &&
      i.rect[3] <= bottom &&
      i.rect[1] >= top - h * 4 &&
      /[\p{L}]/u.test(i.text)
  )
  const titles = []
  for (const item of titleTokens) {
    const prior = titles.at(-1)
    if (
      prior &&
      item.rect[1] - prior.rect[3] < h * 1.5 &&
      !records.some((r) => r.rect[1] > prior.rect[3] && r.rect[3] < item.rect[1])
    ) {
      prior.items.push(item)
      prior.rect = union(prior.items)
    } else titles.push({ items: [item], rect: [...item.rect] })
  }
  if (
    titles.length < 2 ||
    titles.some((i) => i.rect[0] >= left - h || Math.abs(i.rect[0] - titles[0].rect[0]) > h * 0.2)
  )
    return
  const groups = titles.map((title, n) => ({
    title,
    records: records.filter(
      (r) => r.rect[1] > title.rect[3] && r.rect[3] < (titles[n + 1]?.rect[1] ?? bottom + 1)
    )
  }))
  if (
    groups.some((g) => g.records.length < 2) ||
    groups.flatMap((g) => g.records).length !== records.length
  )
    return
  const denominators = first.map((_, c) => {
    const totals = groups.map((g) => g.records.reduce((n, r) => n + (r.values[c]?.[0] ?? 0), 0))
    return totals.every((n) => n === totals[0]) ? totals[0] : 0
  })
  if (
    denominators.some((n) => n <= 0) ||
    records.some((r) =>
      r.values.some((v, c) => v && Math.abs((v[0] / denominators[c]) * 100 - v[1]) > 0.2)
    )
  )
    return
  const probabilities = source.filter(
    (i) =>
      !assigned.has(i) &&
      /^0?\.\d+$/.test(i.text) &&
      i.rect[0] > xs.at(-1) &&
      i.rect[1] >= top &&
      i.rect[3] <= bottom
  )
  if (
    probabilities.length !== groups.length ||
    probabilities.some(
      (i) => Number(i.text) > 1 || Math.abs(i.rect[0] - probabilities[0].rect[0]) > h * 0.2
    )
  )
    return
  const rows = [],
    spans = []
  for (const group of groups) {
    rows.push({
      ...group.title,
      rect: [
        group.title.rect[0],
        group.title.rect[1],
        probabilities[0].rect[2],
        group.title.rect[3]
      ]
    })
    const firstRow = rows.length
    const start = group.records[0].rect[1],
      end = group.records.at(-1).rect[3]
    const ps = probabilities.filter((i) => i.rect[1] >= start && i.rect[3] <= end)
    if (ps.length !== 1) return
    for (let n = 0; n < group.records.length; n++) {
      const r = group.records[n],
        next = group.records[n + 1]
      rows.push({
        rect: [
          group.title.rect[0],
          n ? (group.records[n - 1].rect[3] + r.rect[1]) / 2 : r.rect[1],
          ps[0].rect[2],
          next ? (r.rect[3] + next.rect[1]) / 2 : r.rect[3]
        ]
      })
    }
    spans.push({ row: firstRow, column: xs.length + 1, rowSpan: group.records.length, colSpan: 1 })
  }
  // Retain an isolated next-category heading at the page bottom literally.
  // It is not evidence for joining its text to the following page.
  const tail = source.filter(
    (i) => i.rect[1] > bottom && i.rect[1] - bottom < h * 3 && i.rect[2] < xs[0]
  )
  const trailing =
    tail.length &&
    /^[\p{L}]/u.test(tail[0].text) &&
    Math.abs(tail[0].rect[0] - titles[0].rect[0]) < h * 0.2 &&
    tail.every(
      (i) => /^[\p{L}\s-]+$/u.test(i.text) && Math.abs(i.baseline - tail[0].baseline) < h * 0.3
    )
      ? tail
      : []
  if (trailing.length) {
    const t = union(trailing)
    rows.push({ rect: [titles[0].rect[0], t[1], probabilities[0].rect[2], t[3]] })
  }
  const content = [...assigned, ...titles.flatMap((t) => t.items), ...probabilities, ...trailing]
  const cropRect = union(content).map((v, i) => v + (i < 2 ? -1 : 1))
  if (
    source.some(
      (i) =>
        !content.includes(i) &&
        i.rect[0] >= cropRect[0] &&
        i.rect[2] <= cropRect[2] &&
        i.rect[1] >= cropRect[1] &&
        i.rect[3] <= cropRect[3]
    )
  )
    return
  const starts = [cropRect[0], ...xs, probabilities[0].rect[0]]
  const cuts = [cropRect[0]]
  for (let c = 1; c < starts.length; c++) {
    const previous = content.filter(
      (i) => i.rect[0] >= starts[c - 1] - h * 0.2 && i.rect[0] < starts[c] - h * 0.2
    )
    const end = Math.max(...previous.map((i) => i.rect[2]))
    if (!previous.length || end >= starts[c]) return
    cuts.push((end + starts[c]) / 2)
  }
  cuts.push(cropRect[2])
  if (
    rules.some(
      (r) =>
        r[1] === r[3] &&
        records.some(
          (record) =>
            r[1] > record.rect[1] && r[1] < record.rect[3] && r[0] <= cuts[1] && r[2] >= cuts.at(-2)
        )
    )
  )
    return
  const columns = cuts.slice(1).map((x, c) => [cuts[c], cropRect[1], x, cropRect[3]])
  return {
    id: `page-${pageNumber}-wrapped-count-table`,
    cropRect,
    structure: {
      objects: [
        ...rows.map((r) => ({
          label: 'table row',
          rect: r.rect.map((v, i) => v - cropRect[i % 2])
        })),
        ...columns.map((rect) => ({
          label: 'table column',
          rect: rect.map((v, i) => v - cropRect[i % 2])
        }))
      ]
    },
    wrappedCountGrid: {
      rows: rows.map((r) => r.rect),
      columns,
      spans,
      joinedTokens,
      completeSpans: true
    }
  }
}
