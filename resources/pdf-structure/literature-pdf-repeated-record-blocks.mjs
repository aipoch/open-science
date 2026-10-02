/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import {
  tableSourceItems,
  groupSourceRowsWithScripts,
  readSourceRow,
  hasUniqueRecordTokens
} from './literature-pdf-source-records.mjs'
import { captionKind } from './literature-pdf-caption-group.mjs'
import { union } from './literature-pdf-table-geometry.mjs'

// Two independently bounded side-by-side record blocks, with identical native
// leaf headings, prove both grids. Detection is not required on the second
// block. Every source glyph must fit one physical record and one leaf lane.
export function recoverRepeatedRecordBlocks(tables, tokens, captions, rules, pageNumber) {
  const horizontal = joinHorizontalTableRules(rules, 1),
    bands = []
  for (const rule of horizontal) {
    const group = bands.find(
      (g) => Math.abs(g[0][0] - rule[0]) < 0.1 && Math.abs(g[0][2] - rule[2]) < 0.1
    )
    if (group) group.push(rule)
    else bands.push([rule])
  }
  const blocks = []
  for (const band of bands) {
    if (band.length !== 5) continue
    const [top, doubleTop, divider, lower, doubleLower] = band
    const source = tableSourceItems(tokens, [top[0] - 0.01, top[1], top[2] + 0.01, doubleLower[1]])
    if (
      tokens.some(
        (item) =>
          item.horizontal &&
          item.text.trim() &&
          item.rect[0] < top[2] &&
          item.rect[2] > top[0] &&
          item.rect[1] < doubleLower[1] &&
          item.rect[3] > top[1] &&
          !source.includes(item)
      )
    )
      continue
    const heights = source.map((i) => i.height).sort((a, b) => a - b),
      height = heights[Math.floor(heights.length / 2)]
    if (
      !(height > 0) ||
      doubleTop[1] - top[1] > height * 0.4 ||
      divider[1] - doubleTop[1] > height * 2 ||
      doubleLower[1] - lower[1] > height * 0.4
    )
      continue
    const header = source.filter((i) => i.baseline < divider[1]),
      body = source.filter((i) => i.baseline >= divider[1])
    const headGroups = []
    for (const item of [...header].sort((a, b) => a.rect[0] - b.rect[0])) {
      const last = headGroups.at(-1)
      if (last && item.rect[0] - Math.max(...last.map((i) => i.rect[2])) < height * 0.75)
        last.push(item)
      else headGroups.push([item])
    }
    if (headGroups.length !== 6) continue
    const cuts = [
      top[0] - 0.01,
      ...headGroups.slice(1).map((g, n) => (union(headGroups[n])[2] + union(g)[0]) / 2),
      top[2] + 0.01
    ]
    for (let c = 1; c < cuts.length - 1; c++) {
      const crossing = body.filter((i) => i.rect[0] < cuts[c] && i.rect[2] > cuts[c])
      if (!crossing.length) continue
      if (c === 1 && crossing.every((i) => /^\p{L}[\p{L}\d-]*$/u.test(i.text))) {
        const edge = Math.max(...crossing.map((i) => i.rect[2]))
        if (headGroups[c].every((i) => i.rect[0] > edge)) {
          cuts[c] = edge + 0.001
          continue
        }
      }
      const edge = Math.min(...crossing.map((i) => i.rect[0]))
      if (
        cuts[c] - edge > height ||
        headGroups[c - 1].some((i) => i.rect[2] >= edge) ||
        !crossing.every((i) => /^[\d.−–—+×·-]+$/u.test(i.text))
      )
        continue
      cuts[c] = edge - 0.001
    }
    const headings = readSourceRow(header, cuts),
      groups = groupSourceRowsWithScripts(body, height, 0.3)
    if (
      !headings ||
      !groups ||
      groups.length < 4 ||
      !hasUniqueRecordTokens(source, [header, ...groups])
    )
      continue
    if (
      !headings.slice(0, 2).every((s) => /^\p{L}+$/u.test(s)) ||
      !/^\p{L}\([^()]+\)$/u.test(headings[2]) ||
      !headings.slice(3).every((s) => /^\p{L}\d+$/u.test(s))
    )
      continue
    const scalar = (s) => /^(?:[−+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[×·]10[−+-]?\d+)?|[−–—-])$/u.test(s)
    const values = groups.map((g) => readSourceRow(g, cuts))
    if (
      values.some(
        (v, n) =>
          !v ||
          (!(
            v[0] &&
            /^\p{L}[\p{L}\d-]*$/u.test(v[0]) &&
            /^\p{L}$/u.test(v[1]) &&
            v.slice(2).every(scalar)
          ) &&
            !(
              n === groups.length - 1 &&
              !v[0] &&
              !v[1] &&
              v.slice(2).every((s) => /^[−–—-]$/u.test(s))
            ))
      )
    )
      continue
    const frame = [cuts[0], top[1], cuts.at(-1), doubleLower[1]]
    const rows = [
      [frame[0], frame[1], frame[2], divider[1]],
      ...groups.map((g, n) => [
        frame[0],
        n ? (union(groups[n - 1])[3] + union(g)[1]) / 2 : divider[1],
        frame[2],
        groups[n + 1] ? (union(g)[3] + union(groups[n + 1])[1]) / 2 : frame[3]
      ])
    ]
    blocks.push({ frame, cuts, rows, headings, height, source })
  }
  if (blocks.length !== 2) return
  blocks.sort((a, b) => a.frame[0] - b.frame[0])
  const [a, b] = blocks
  if (
    a.frame[2] >= b.frame[0] ||
    Math.abs(a.frame[1] - b.frame[1]) > 0.1 ||
    Math.abs(a.frame[3] - b.frame[3]) > Math.min(a.height, b.height) * 0.1 ||
    JSON.stringify(a.headings) !== JSON.stringify(b.headings)
  )
    return
  const owners = captions.filter(
    (c) =>
      captionKind(c.lines[0]) === 'table' &&
      c.rect[3] <= a.frame[1] &&
      a.frame[1] - c.rect[3] < a.height * 4 &&
      c.rect[0] >= a.frame[0] - a.height &&
      c.rect[0] < b.frame[0]
  )
  if (owners.length !== 1) return
  const replaced = tables.filter((t) =>
    blocks.some((block) => {
      const r = t.cropRect,
        f = block.frame,
        intersection =
          Math.max(0, Math.min(r[2], f[2]) - Math.max(r[0], f[0])) *
          Math.max(0, Math.min(r[3], f[3]) - Math.max(r[1], f[1]))
      return intersection / ((r[2] - r[0]) * (r[3] - r[1])) > 0.9
    })
  )
  if (
    tables.some(
      (t) =>
        !replaced.includes(t) &&
        blocks.some(
          ({ frame: f }) =>
            t.cropRect[0] < f[2] &&
            t.cropRect[2] > f[0] &&
            t.cropRect[1] < f[3] &&
            t.cropRect[3] > f[1]
        )
    )
  )
    return
  return {
    replaced,
    caption: owners[0],
    tables: blocks.map((block, n) => {
      const cropRect = block.frame,
        relative = (r) => r.map((v, axis) => v - cropRect[axis % 2]),
        object = (label, rect) => ({ label, score: 1, rect: relative(rect) })
      return {
        id: `page-${pageNumber}-native-repeated-record-block-${n + 1}`,
        cropRect,
        structure: {
          objects: [
            ...block.rows.map((r) => object('table row', r)),
            ...block.cuts
              .slice(1)
              .map((x, c) => object('table column', [block.cuts[c], cropRect[1], x, cropRect[3]])),
            object('table column header', block.rows[0])
          ]
        }
      }
    })
  }
}

export function groupRepeatedRecordBlocks(tables, proof) {
  if (!proof) return tables
  const parts = proof.tables.map((raw) => tables.find((table) => table.id === raw.id))
  if (parts.some((part) => !part || part.parts || !part.grid?.length)) return tables
  const [first, second] = parts
  if (!first.caption || second.caption?.text !== first.caption.text) return tables
  const notes = [
    ...new Map(
      parts.flatMap((part) => part.notes ?? []).map((note) => [JSON.stringify(note), note])
    ).values()
  ]
  return [
    ...tables.filter((table) => !parts.includes(table)),
    {
      id: first.id.replace(/-1$/, ''),
      page: first.page,
      caption: first.caption,
      cropRect: [
        first.cropRect[0],
        Math.min(first.cropRect[1], second.cropRect[1]),
        second.cropRect[2],
        Math.max(first.cropRect[3], second.cropRect[3])
      ],
      notes,
      parts: parts.map((part) => ({
        title: part.grid[0][0],
        sourceViewport: part.sourceViewport,
        grid: part.grid,
        cells: part.cells,
        unassigned: part.unassigned,
        issues: part.issues,
        notes: []
      }))
    }
  ]
}
