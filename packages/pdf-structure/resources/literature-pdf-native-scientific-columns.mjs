/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { groupSourceRowsWithScripts } from './literature-pdf-source-records.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'

// A blank model leaf may cut through repeated, tightly typeset scientific
// values. Preserve every native item: remove only that model boundary when a
// single independent leaf header and all enclosed records prove one field.
export function recoverNativeScientificColumns(table, items, rules) {
  if (
    !Array.isArray(table?.cropRect) ||
    table.cropRect.length !== 4 ||
    !table.cropRect.every(Number.isFinite) ||
    !Array.isArray(table.structure?.objects) ||
    !Array.isArray(items) ||
    !Array.isArray(rules)
  )
    return
  const crop = table.cropRect,
    model = table.structure.objects
      .filter((o) => o.label === 'table column')
      .sort((a, b) => a.rect[0] - b.rect[0])
  if (
    model.length < 3 ||
    model.some(
      (o) => !Array.isArray(o.rect) || o.rect.length !== 4 || !o.rect.every(Number.isFinite)
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.text.trim() &&
      i.rect[0] >= crop[0] &&
      i.rect[2] <= crop[2] &&
      i.rect[1] >= crop[1] &&
      i.rect[3] <= crop[3]
  )
  const hs = source.map((i) => i.height).sort((a, b) => a - b),
    h = hs[Math.floor(hs.length / 2)]
  if (!(h > 0)) return
  const borders = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        Math.abs(r[0] - crop[0]) < h &&
        Math.abs(r[2] - crop[2]) < h &&
        r[1] >= crop[1] &&
        r[1] <= crop[3]
    )
    .sort((a, b) => a[1] - b[1])
  if (borders.length < 3) return
  const frame = source.filter((i) => i.rect[1] > borders[0][1] && i.rect[3] < borders.at(-1)[1])
  const groups = groupSourceRowsWithScripts(
    frame.slice().sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
    h,
    0.35
  )
  if (!groups) return
  const cut = [
    crop[0],
    ...model.slice(1).map((o, n) => crop[0] + (model[n].rect[2] + o.rect[0]) / 2),
    crop[2]
  ]
  const corrected = []
  for (let n = 1; n < model.length; n++) {
    const left = cut[n - 1],
      split = cut[n],
      right = cut[n + 1]
    if (
      items.some(
        (i) =>
          i.text?.trim() &&
          i.rect[0] < right &&
          i.rect[2] > left &&
          i.rect[1] < crop[3] &&
          i.rect[3] > crop[1] &&
          !frame.includes(i)
      )
    )
      continue
    const rows = groups.map((g) => g.filter((i) => i.rect[0] < right && i.rect[2] > left))
    // A native full-width divider separates the last complete leaf header from all records.
    const divider = borders[1][1],
      header = rows
        .filter((r) => r.length && Math.max(...r.map((i) => i.baseline)) < divider)
        .at(-1),
      body = rows.filter((r) => r.length && Math.min(...r.map((i) => i.baseline)) > divider)
    if (
      !header ||
      body.length < 3 ||
      groups.some(
        (g, row) => Math.min(...g.map((i) => i.baseline)) > divider && !rows[row].length
      ) ||
      !header.every((i) => i.rect[0] >= split) ||
      header.filter((i) => i.height >= h * 0.8).length !== 1 ||
      !header.some((i) => /\p{L}/u.test(i.text))
    )
      continue
    if (
      [header, ...body].some((r) =>
        r.some((i) => !i.horizontal || i.rect[0] < left || i.rect[2] > right)
      )
    )
      continue
    if (!proveNativeUniqueWholeFonts([header, ...body].flat(), items)) continue
    let crossing = 0,
      valid = true
    for (const r of body) {
      const sorted = r.slice().sort((a, b) => a.rect[0] - b.rect[0]),
        s = sorted
          .map((i) => i.text)
          .join('')
          .replace(/\s/gu, '')
      const main = sorted.filter((i) => i.height >= h * 0.8),
        scripts = sorted.filter((i) => i.height < h * 0.8)
      if (!main.length || main.some((i) => Math.abs(i.baseline - main[0].baseline) > h * 0.04)) {
        valid = false
        break
      }
      if (sorted.every((i) => i.rect[0] >= split)) {
        if (sorted.length !== 1 || !/^\d+(?:\.\d+)?$/.test(s)) {
          valid = false
          break
        }
        continue
      }
      if (
        !/^\d+(?:\.\d+)?×10[−+-]?\d+$/.test(s) ||
        !scripts.length ||
        !main.some((i) => i.text === '×') ||
        main.at(-1).text !== '10' ||
        scripts.some((i) => !/^[−+\d-]+$/.test(i.text)) ||
        main.some(
          (i, k) =>
            k &&
            (i.rect[0] - main[k - 1].rect[2] > h * 0.3 || i.rect[0] < main[k - 1].rect[2] - 0.02)
        )
      ) {
        valid = false
        break
      }
      if (
        !scripts.every((i, k) =>
          k === 0
            ? isAdjacentTableScript(i, main.at(-1))
            : Math.abs(i.baseline - scripts[k - 1].baseline) < h * 0.04 &&
              i.rect[0] >= scripts[k - 1].rect[2] - 0.02 &&
              i.rect[0] - scripts[k - 1].rect[2] < h * 0.1
        )
      ) {
        valid = false
        break
      }
      if (!sorted.some((i) => i.rect[2] <= split) || !sorted.some((i) => i.rect[0] >= split)) {
        valid = false
        break
      }
      crossing++
    }
    if (
      !valid ||
      crossing < 2 ||
      rules.some(
        (r) =>
          r[0] === r[2] && r[0] > left && r[0] < right && r[1] < borders.at(-1)[1] && r[3] > divider
      )
    )
      continue
    corrected.push(n)
  }
  if (corrected.length !== 1) return
  const n = corrected[0],
    columns = model.map((o) => ({ ...o, rect: [...o.rect] }))
  columns[n - 1].rect[2] = columns[n].rect[2]
  columns.splice(n, 1)
  return {
    ...table,
    structure: {
      ...table.structure,
      objects: [...table.structure.objects.filter((o) => o.label !== 'table column'), ...columns]
    }
  }
}
