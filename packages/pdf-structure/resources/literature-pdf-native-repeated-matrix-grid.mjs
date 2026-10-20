/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readSourceRow, hasUniqueRecordTokens } from './literature-pdf-source-records.mjs'

// Candidate eligibility and native panel identity are proved by the existing
// candidate helper. This adapter additionally requires complete literal cells
// and empty source gutters; it never divides a text item across a column.
export function recoverNativeRepeatedMatrixParts(candidate, scale = 1.5) {
  if (!candidate?.panels || !(scale > 0) || !Number.isFinite(scale)) return
  const parts = [],
    owners = [],
    titles = []
  for (const panel of candidate.panels) {
    const { opening, divider, closing, owned } = panel
    if (
      !owned?.length ||
      ![opening, divider, closing].every(
        (r) => r?.length === 4 && r.every(Number.isFinite) && r[1] === r[3]
      ) ||
      !(opening[1] < divider[1] && divider[1] < closing[1]) ||
      owned.some(
        (i) =>
          !i.text?.trim() ||
          ![...i.rect, i.baseline, i.height].every(Number.isFinite) ||
          i.height <= 0 ||
          i.rect[2] <= i.rect[0] ||
          i.rect[3] <= i.rect[1]
      )
    )
      return
    if (
      [divider, closing].some(
        (r) => Math.abs(r[0] - opening[0]) > 0.01 || Math.abs(r[2] - opening[2]) > 0.01
      )
    )
      return
    const title = owned.filter((i) => i.baseline <= opening[1]),
      header = owned.filter((i) => i.baseline > opening[1] && i.baseline < divider[1]),
      body = owned.filter((i) => i.baseline > divider[1] && i.baseline < closing[1])
    const numeric = (i) => /^[−+-]?\d+(?:\.\d+)?$/.test(i.text.trim()),
      center = (i) => (i.rect[0] + i.rect[2]) / 2
    const leaves = header.filter(numeric).sort((a, b) => center(a) - center(b)),
      corner = header.filter((i) => !numeric(i)),
      h = leaves[0]?.height
    if (
      !(h > 0) ||
      title.length !== 3 ||
      !/^\p{L}$/u.test(title[0].text) ||
      title[1].text !== '=' ||
      !/^\d+$/.test(title[2].text) ||
      title.some((i) => Math.abs(i.baseline - title[0].baseline) > 0.01) ||
      corner.length < 1 ||
      corner.length > 4 ||
      !corner.every((i) => /^[\p{L}\\/]+$/u.test(i.text.trim())) ||
      leaves.length < 3 ||
      leaves.length > 8 ||
      header.some(
        (i) => Math.abs(i.baseline - leaves[0].baseline) > 0.01 || Math.abs(i.height - h) > 0.01
      )
    )
      return
    const centers = leaves.map(center),
      anchors = []
    for (const i of [...body].sort((a, b) => a.baseline - b.baseline))
      if (!anchors.some((y) => Math.abs(y - i.baseline) < 0.01)) anchors.push(i.baseline)
    if (
      anchors.length < 4 ||
      anchors.length > 8 ||
      body.some((i) => !numeric(i) || Math.abs(i.height - h) > 0.01) ||
      anchors.slice(1).some((y, n) => Math.abs(y - anchors[n] - h) > h * 0.25)
    )
      return
    const records = anchors.map((y) => body.filter((i) => Math.abs(i.baseline - y) < 0.01)),
      fields = []
    fields.push([corner, ...leaves.map((i) => [i])])
    for (const row of records) {
      const right = centers.map((x) => row.filter((i) => Math.abs(center(i) - x) < h * 0.05)),
        left = row.filter((i) => !right.some((l) => l.includes(i)))
      if (
        left.length !== 1 ||
        right.some((l) => l.length !== 1) ||
        !hasUniqueRecordTokens(row, [left, ...right]) ||
        left[0].rect[2] >= Math.min(...leaves.map((i) => i.rect[0]))
      )
        return
      fields.push([left, ...right])
    }
    const cuts = [
      Math.min(opening[0], ...header.map((i) => i.rect[0]), ...body.map((i) => i.rect[0]))
    ]
    for (let k = 1; k <= leaves.length; k++) {
      const left = Math.max(...fields.flatMap((r) => r[k - 1]).map((i) => i.rect[2])),
        right = Math.min(...fields.flatMap((r) => r[k]).map((i) => i.rect[0]))
      if (right - left < h * 0.05) return
      cuts.push((left + right) / 2)
    }
    cuts.push(Math.max(opening[2], ...header.map((i) => i.rect[2]), ...body.map((i) => i.rect[2])))
    if (
      header.some(
        (i) =>
          (i.rect[1] + i.rect[3]) / 2 <= opening[1] ||
          (i.rect[1] + i.rect[3]) / 2 >= divider[1] ||
          i.rect[1] < opening[1] - h * 0.2 ||
          i.rect[3] > divider[1] + h * 0.2
      ) ||
      records[0].some(
        (i) => (i.rect[1] + i.rect[3]) / 2 <= divider[1] || i.rect[1] < divider[1] - h * 0.2
      ) ||
      records.at(-1).some((i) => i.rect[3] > closing[1])
    )
      return
    const edges = [Math.min(opening[1], ...header.map((i) => i.rect[1]))]
    const bands = [header, ...records]
    for (let n = 1; n < bands.length; n++) {
      const bottom = Math.max(...bands[n - 1].map((i) => i.rect[3])),
        top = Math.min(...bands[n].map((i) => i.rect[1]))
      if (top <= bottom) return
      edges.push((bottom + top) / 2)
    }
    edges.push(closing[1])
    if (
      !hasUniqueRecordTokens(owned, [title, header, ...records]) ||
      fields.some((row, n) =>
        row.flat().some((i) => i.rect[1] < edges[n] || i.rect[3] > edges[n + 1])
      )
    )
      return
    const grid = [],
      cells = []
    for (let row = 0; row < fields.length; row++) {
      const text = []
      for (let column = 0; column < fields[row].length; column++) {
        const tokens = fields[row][column].sort((a, b) => a.rect[0] - b.rect[0]),
          value = readSourceRow(tokens, [cuts[column], cuts[column + 1]])?.[0]
        if (!value) return
        text.push(value)
        cells.push({
          row,
          column,
          rowSpan: 1,
          colSpan: 1,
          header: row === 0,
          text: value,
          textRuns: [{ text: value, position: 'normal' }],
          rect: [cuts[column], edges[row], cuts[column + 1], edges[row + 1]].map((v) => v * scale),
          sourceRects: tokens.map((i) => i.rect.map((v) => v * scale))
        })
      }
      grid.push(text)
    }
    const titleText = readSourceRow(title, [
      Math.min(...title.map((i) => i.rect[0])),
      Math.max(...title.map((i) => i.rect[2]))
    ])?.[0]
    if (!titleText) return
    parts.push({ title: titleText, grid, cells, unassigned: [], issues: [], notes: [] })
    owners.push(...header, ...body)
    titles.push(...title)
  }
  if (
    parts.length < 3 ||
    parts.length > 8 ||
    !hasUniqueRecordTokens(
      [...owners, ...titles],
      candidate.panels.map((p) => p.owned)
    )
  )
    return
  return {
    parts,
    ownedTokens: new Set([...owners, ...titles]),
    cellTokens: new Set(owners),
    titleTokens: new Set(titles)
  }
}
