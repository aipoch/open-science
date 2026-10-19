/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { splitNativeMeasuredFields } from './literature-pdf-native-header-grid.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'

const compact = (s) => s.replace(/\s/gu, '')
const centre = (i) => (i.rect[0] + i.rect[2]) / 2
const sorted = (fonts) => [...fonts].sort((a, b) => a.rect[0] - b.rect[0])
const literal = (fonts) =>
  compact(
    sorted(fonts)
      .map((i) => i.text)
      .join('')
  )
const numeric = (i) => /^[+−-]?\d+(?:\.\d+)?$/u.test(i.text.trim())

// Receives the final grid's validated whole-source packet. These contradictions
// only disable structure consumption; neither cell text nor native sources move.
export function hasNativeLiteralColumnConflict(proof, inventory, rules) {
  return splitDecimal(proof, inventory, rules) || mergedRepeatedLeaves(proof, inventory)
}

const completeDomain = (fonts, inventory) => {
  const r = [
    Math.min(...fonts.map((i) => i.rect[0])),
    Math.min(...fonts.map((i) => i.rect[1])),
    Math.max(...fonts.map((i) => i.rect[2])),
    Math.max(...fonts.map((i) => i.rect[3]))
  ]
  return !inventory.some(
    (i) =>
      !fonts.includes(i) &&
      i.text?.trim() &&
      (!Array.isArray(i.rect) ||
        i.rect.length !== 4 ||
        !i.rect.every(Number.isFinite) ||
        i.rect[2] <= i.rect[0] ||
        i.rect[3] <= i.rect[1] ||
        (i.rect[0] < r[2] && i.rect[2] > r[0] && i.rect[1] < r[3] && i.rect[3] > r[1]))
  )
}

function splitDecimal({ proved }, inventory, rules) {
  const owners = new Map(proved.flatMap((p) => p.fonts.map((i) => [i, p.cell])))
  for (const dot of owners.keys()) {
    if (dot.text !== '.') continue
    const h = dot.height
    const sameLine = (i) =>
      Math.abs(i.height - h) < h * 0.001 && Math.abs(i.baseline - dot.baseline) < h * 0.001
    const before = inventory.filter(
      (i) => i.rect && sameLine(i) && Math.abs(i.rect[2] - dot.rect[0]) < h * 0.002
    )
    const after = inventory.filter(
      (i) => i.rect && sameLine(i) && Math.abs(i.rect[0] - dot.rect[2]) < h * 0.002
    )
    if (before.length !== 1 || after.length !== 1) continue
    const a = before[0],
      b = after[0]
    // A complete native parent may also contain the following description.
    // Its leading digits still touch the decimal point exactly; retain that
    // parent whole and flag the cross-cell assignment instead of splitting it.
    if (!/^[+−-]?\d+$/u.test(a.text) || !/^\d+(?:\s+\p{L}[^\r\n]*)?$/u.test(b.text)) continue
    if (!completeDomain([a, dot, b], inventory)) continue
    const cells = [owners.get(a), owners.get(dot), owners.get(b)]
    if (
      cells.some(
        (c) => !c || c.colSpan !== 1 || c.rowSpan !== cells[0].rowSpan || c.row !== cells[0].row
      ) ||
      new Set(cells).size !== 2 ||
      Math.max(...cells.map((c) => c.column)) - Math.min(...cells.map((c) => c.column)) !== 1 ||
      rules.some(
        (r) =>
          r[0] === r[2] &&
          r[0] > a.rect[0] &&
          r[0] < b.rect[2] &&
          r[1] < dot.rect[3] &&
          r[3] > dot.rect[1]
      )
    )
      continue
    return true
  }
  return false
}

// A complete repeated header/record component may establish separate native
// lanes even when one wider value narrows a single row's gap. This is review
// evidence, not a new column reconstruction or a relaxation of conflict proof.
export function hasNativeRepeatedLeafAmbiguity(proof, table, inventory) {
  return (
    proveNativeUniqueWholeFonts(
      proof.proved.flatMap((p) => p.fonts),
      inventory
    ) && mergedRepeatedLeaves(proof, inventory, table)
  )
}

function mergedRepeatedLeaves({ proved }, inventory, reviewTable) {
  for (const p of proved) {
    if (p.cell.colSpan !== 1 || p.cell.rowSpan !== 1 || p.cell.row > 1) continue
    const fonts = sorted(p.fonts),
      h = Math.max(...fonts.map((i) => i.height))
    if (
      Math.max(...fonts.map((i) => i.baseline)) - Math.min(...fonts.map((i) => i.baseline)) >
      h * 0.25
    )
      continue
    const cuts = fonts
      .slice(1)
      .map((i, n) => (i.rect[0] - fonts[n].rect[2] > h * 0.45 ? n + 1 : -1))
      .filter((n) => n > 0)
    if (cuts.length !== 1) continue
    const groups = [fonts.slice(0, cuts[0]), fonts.slice(cuts[0])]
    if (!completeDomain(fonts, inventory)) continue
    if (groups.some((g) => !/\p{L}/u.test(literal(g)))) continue
    const texts = groups.map(literal)
    const peers = proved.filter(
      (v) => v.cell.row === p.cell.row && v.cell.rowSpan === 1 && v.cell.colSpan === 1 && v !== p
    )
    if (
      !peers.some(
        (a) =>
          literal(a.fonts) === texts[0] &&
          peers.some(
            (b) =>
              b.cell.column === a.cell.column + 1 &&
              literal(b.fonts) === texts[1] &&
              completeDomain([...a.fonts, ...b.fonts], inventory)
          )
      )
    )
      continue
    const body = proved.filter((v) => v.cell.column === p.cell.column && v.cell.row > p.cell.row)
    if (
      reviewTable &&
      (body.length < 3 ||
        reviewTable.cells.some(
          (cell) =>
            cell.text.trim() &&
            (cell.row === p.cell.row || (cell.column === p.cell.column && cell.row > p.cell.row)) &&
            !proved.some((q) => q.cell === cell)
        ))
    )
      continue
    if (
      body.length < 2 ||
      body.some(
        (v) =>
          v.cell.colSpan !== 1 ||
          v.cell.rowSpan !== 1 ||
          v.fonts.length !== 2 ||
          !v.fonts.every(numeric)
      )
    )
      continue
    const rows = body.map((v) => sorted(v.fonts))
    if (rows.some((g) => !completeDomain(g, inventory))) continue
    if (
      rows.some(
        (g) =>
          g.some((i) => Math.abs(i.height - h) > h * 0.05) ||
          Math.abs(g[0].baseline - g[1].baseline) > h * 0.02 ||
          (!reviewTable && g[1].rect[0] - g[0].rect[2] < h * 0.5)
      )
    )
      continue
    const splitLeft = Math.max(...rows.map((g) => g[0].rect[2]), ...groups[0].map((i) => i.rect[2]))
    const splitRight = Math.min(
      ...rows.map((g) => g[1].rect[0]),
      ...groups[1].map((i) => i.rect[0])
    )
    if (splitRight - splitLeft < h * 0.4) continue
    if (
      groups.some((g, c) =>
        rows.some(
          (r) =>
            Math.abs(
              centre(r[c]) -
                (Math.min(...g.map((i) => i.rect[0])) + Math.max(...g.map((i) => i.rect[2]))) / 2
            ) >
            h * 0.3
        )
      )
    )
      continue
    return true
  }
  return false
}

// This is only an ambiguity detector, deliberately absent from the conflict
// classifier: a legitimate right-aligned overhang has the same geometry.
export function hasNativeMeasuredHeadingAmbiguity({ proved }, table, inventory, rules, runs) {
  for (const p of proved) {
    if (p.cell.row !== 0 || p.cell.colSpan !== 1) continue
    for (const font of p.fonts) {
      const parts = splitNativeMeasuredFields(font, runs, font.height)
      if (parts?.length !== 2 || parts.some((i) => !/^\p{L}[\p{L}-]*$/u.test(i.text))) continue
      const [a, b] = parts,
        h = font.height
      if (!completeDomain(p.fonts, inventory)) continue
      if (b.rect[0] < p.cell.rect[0] || b.rect[2] > p.cell.rect[2] || a.rect[2] >= p.cell.rect[0])
        continue
      const vacant = table.cells.filter(
        (c) =>
          c.row === 0 &&
          c.column === p.cell.column - 1 &&
          c.colSpan === 1 &&
          !c.text.trim() &&
          centre(a) > c.rect[0] &&
          centre(a) < c.rect[2]
      )
      if (vacant.length !== 1) continue
      const left = vacant[0]
      const divider = rules.filter(
        (r) =>
          r[1] === r[3] &&
          r[1] > font.rect[3] &&
          r[1] >= p.cell.rect[3] - 0.02 &&
          r[1] <= p.cell.rect[3] + 0.02 &&
          r[0] <= left.rect[0] &&
          r[2] >= p.cell.rect[2]
      )
      if (divider.length !== 1) continue
      const body = proved.filter(
        (v) =>
          v.cell.row >= p.cell.rowSpan &&
          (v.cell.column === left.column || v.cell.column === p.cell.column)
      )
      const rows = [...new Set(body.map((v) => v.cell.row))]
      if (
        rows.some(
          (r) =>
            !completeDomain(
              body.filter((v) => v.cell.row === r).flatMap((v) => v.fonts),
              inventory
            )
        )
      )
        continue
      if (rows.length < 2 || rows.some((r) => body.filter((v) => v.cell.row === r).length !== 2))
        continue
      if (
        body.some(
          (v) =>
            v.cell.rowSpan !== 1 ||
            v.cell.colSpan !== 1 ||
            v.fonts.some((i) => i.rect[0] < v.cell.rect[0] || i.rect[2] > v.cell.rect[2])
        )
      )
        continue
      // An independently wrapped right title stays in its own lane. A centred
      // parent spanning both lanes or a single-line overhang is not this proof.
      const wrapped = p.fonts.filter((i) => i !== font)
      if (
        !wrapped.length ||
        wrapped.some(
          (i) =>
            i.rect[0] < p.cell.rect[0] ||
            i.rect[2] > p.cell.rect[2] ||
            i.baseline <= font.baseline + h * 0.5
        )
      )
        continue
      if (
        inventory.some(
          (i) =>
            i !== font &&
            i.rect &&
            i.text?.trim() &&
            i.rect[0] < left.rect[2] &&
            i.rect[2] > left.rect[0] &&
            i.rect[1] > font.rect[3] &&
            i.rect[3] < divider[0][1]
        )
      )
        continue
      return true
    }
  }
  return false
}
