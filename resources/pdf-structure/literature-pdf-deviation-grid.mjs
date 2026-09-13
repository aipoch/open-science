/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'
import {
  tableSourceItems,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'

// Separate standard-deviation columns are established by repeated headings and
// complete mean/(±SD) records. Every source token must fit a recovered row.
export function recoverDeviationGrid(table, items, captions) {
  if (!captions.some((c) => captionKind(c.lines[0]) === 'table')) return
  const [left, top, right, bottom] = table.cropRect
  const source = tableSourceItems(items, table.cropRect)
  const deviations = source.filter((i) => /^Standard(?: deviation)?$/.test(i.text))
  if (deviations.length < 2 || deviations.length > 3) return
  const height = deviations[0].height
  if (deviations.some((i) => Math.abs(i.baseline - deviations[0].baseline) > height * 0.3)) return
  const end = Math.max(
    ...deviations.map((i) =>
      i.text === 'Standard deviation'
        ? i.rect[3]
        : (source.find(
            (j) =>
              j.text === 'deviation' &&
              Math.abs(j.rect[0] - i.rect[0]) < 1 &&
              j.baseline > i.baseline &&
              j.baseline - i.baseline < height * 1.5
          )?.rect[3] ?? Infinity)
    )
  )
  const body = source.filter((i) => i.rect[1] > end + 1)
  const baselines = []
  for (const i of body.filter((i) => i.height >= height * 0.8)) {
    if (!baselines.some((y) => Math.abs(y - i.baseline) < height * 0.3)) baselines.push(i.baseline)
  }
  const groups = baselines.map((y) =>
    body.filter((i) => i.height >= height * 0.8 && Math.abs(y - i.baseline) < height * 0.3)
  )
  for (const mark of body.filter((i) => i.height < height * 0.8)) {
    const owners = groups.filter((g) =>
      g.some(
        (i) =>
          Math.abs(i.rect[2] - mark.rect[0]) < height * 0.3 &&
          Math.abs(i.baseline - mark.baseline) < height * 0.6
      )
    )
    if (owners.length !== 1) return
    owners[0].push(mark)
  }
  const first = groups.find((g) => g.filter((i) => i.text === '±').length === deviations.length)
  if (!first) return
  const ordered = [...first].sort((a, b) => a.rect[0] - b.rect[0])
  const starts = []
  for (const [n, i] of ordered.entries()) {
    if (i.text !== '±') continue
    const mean = ordered[n - 2],
      bracket = ordered[n - 1]
    if (!mean || !/^\d+(?:\.\d+)?$/.test(mean.text) || bracket.text !== '(') return
    starts.push(mean.rect[0], bracket.rect[0])
  }
  const p = source.find((i) => i.text === 'P' && i.rect[3] <= end + 1 && i.rect[0] > starts.at(-1))
  if (!p || starts.length !== deviations.length * 2) return
  const cuts = [left, ...starts.map((x) => x - height * 0.1), p.rect[0] - height * 0.1, right]
  if (cuts.some((x, n) => n && x <= cuts[n - 1])) return
  const spans = []
  let complete = 0
  for (const [n, g] of groups.entries()) {
    const cells = readSourceRow(g, cuts)
    if (!cells) return
    if (!cells[0]) return
    if (cells.slice(1).every((v) => !v)) {
      spans.push({ row: n + 1, column: 0, rowSpan: 1, colSpan: cuts.length - 1 })
      continue
    }
    const sd = starts.filter((_, c) => c % 2).map((_, c) => cells[c * 2 + 2])
    if (
      sd.every(
        (v, c) => /^\(±?\d+(?:\.\d+)?\)$/.test(v) || (/^[-–]$/.test(v) && cells[c * 2 + 1] === v)
      )
    ) {
      if (
        starts
          .filter((_, c) => c % 2 === 0)
          .some(
            (_, c) =>
              !/^\d+(?:\.\d+)?$/.test(cells[c * 2 + 1]) &&
              !(/^[-–]$/.test(sd[c]) && sd[c] === cells[c * 2 + 1])
          )
      )
        return
      complete++
    } else if (sd.every((v) => !v)) {
      if (
        starts
          .filter((_, c) => c % 2 === 0)
          .some((_, c) => !/^(?:0|\d+\(\d+(?:\.\d+)?%\)?)$/.test(cells[c * 2 + 1]))
      )
        return
    } else return
    if (cells.at(-1) && !/^[<>≤≥]?\d+(?:\.\d+)?$/.test(cells.at(-1))) return
  }
  if (complete < 8 || !hasUniqueRecordTokens(body, groups)) return
  const firstY = Math.min(...body.map((i) => i.rect[1])) - 0.1
  const headers = source.filter((i) => i.rect[3] < firstY)
  if (!readSourceRow(headers, cuts)) return
  return {
    rows: [
      [left, top, right, firstY],
      ...groups.map((g) => {
        const r = union(g)
        return [left, r[1] - 0.1, right, r[3] + 0.1]
      })
    ],
    columns: cuts.slice(1).map((x, c) => [cuts[c], top, x, bottom]),
    spans,
    completeSpans: true
  }
}
