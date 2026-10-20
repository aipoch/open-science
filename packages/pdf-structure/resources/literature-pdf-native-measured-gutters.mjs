/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { splitNativeMeasuredFields } from './literature-pdf-native-header-grid.mjs'
import { isAdjacentTableScript } from './literature-pdf-table-geometry.mjs'

const scalar = /^[−+-]?\d+(?:\.\d+)?$/u
const interval = /^\[[−+-]?\d+(?:\.\d+)?,[−+-]?\d+(?:\.\d+)?\]$/u
const numeric = (text) =>
  scalar.test(text.replace(/\s/gu, '')) || interval.test(text.replace(/\s/gu, ''))

// Header ink and complete peer records authorize measured TJ whitespace only.
// Model cuts locate the leaf titles; they never supply a glyph split position.
export function recoverNativeMeasuredGutterTokens(table, items, captions, rules, runs) {
  const crop = table.cropRect
  const columns = table.structure.objects
    .filter((o) => o.label === 'table column')
    .sort((a, b) => a.rect[0] - b.rect[0])
  if (![3, 5].includes(columns.length) || !runs.length) return items
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.rect[0] >= crop[0] &&
      i.rect[2] <= crop[2] &&
      i.baseline > crop[1] &&
      i.baseline < crop[3]
  )
  if (!source.length) return items
  const height = Math.max(...source.map((i) => i.height))
  const full = joinHorizontalTableRules(rules).filter(
    (r) =>
      r[1] >= crop[1] - height &&
      r[1] <= crop[3] + height &&
      Math.abs(r[0] - crop[0]) < height &&
      Math.abs(r[2] - crop[2]) < height
  )
  if (
    full.length < 3 ||
    full.some((r) => Math.abs(r[0] - full[0][0]) > 0.02 || Math.abs(r[2] - full[0][2]) > 0.02)
  )
    return items
  const [opening, divider] = full,
    closing = full.at(-1)
  if (
    divider[1] - opening[1] < height * 0.5 ||
    divider[1] - opening[1] > height * 2.5 ||
    closing[1] - divider[1] < height * 2
  )
    return items
  if (
    captions.filter(
      (c) =>
        captionKind(c.lines[0]) === 'table' &&
        c.rect[3] < opening[1] &&
        opening[1] - c.rect[3] < height * 4 &&
        c.rect[0] < closing[2] &&
        c.rect[2] > closing[0]
    ).length !== 1
  )
    return items
  const initial = [
    opening[0],
    ...columns.slice(1).map((c, n) => crop[0] + (columns[n].rect[2] + c.rect[0]) / 2),
    opening[2]
  ]
  const lane = (item) => initial.slice(1).findIndex((x) => (item.rect[0] + item.rect[2]) / 2 < x)
  const headers = columns.map(() => [])
  for (const item of source.filter((i) => i.baseline > opening[1] && i.baseline <= divider[1])) {
    const index = lane(item)
    if (index < 0) return items
    headers[index].push(item)
  }
  if (headers.some((h) => !h.length || !h.some((i) => /\p{L}/u.test(i.text)))) return items
  const bands = headers
    .slice(1)
    .map((h, n) => [
      Math.max(...headers[n].map((i) => i.rect[2])) - 0.01,
      Math.min(...h.map((i) => i.rect[0])) + 0.01
    ])
  if (bands.some((b) => b[1] - b[0] < height * 0.25)) return items
  const replacement = new Map()
  const body = source.filter((i) => i.baseline > divider[1] && i.baseline < closing[1])
  for (const item of body) {
    if (!(/\p{L}.*\s\d+\.\d+$/u.test(item.text) || /\]\s+\[/u.test(item.text))) continue
    const observed = runs.filter(
      (r) => r.text === item.text && r.rect.every((v, n) => Math.abs(v - item.rect[n]) < 0.02)
    )
    if (
      observed.length !== 1 ||
      !observed[0].glyphRuns.length ||
      new Set(observed[0].glyphRuns).size !== 1
    )
      return items
    const selected = bands
      .flatMap((band) => {
        const matches = observed[0].gaps.filter(
          (g) => g.left >= band[0] && g.right <= band[1] && g.right - g.left >= height * 0.25
        )
        return matches.length === 1 ? matches : []
      })
      .sort((a, b) => a.index - b.index)
    if (!selected.length) continue
    const parts = [],
      characters = [...item.text]
    let at = 0,
      count = 0
    for (let index = 0; index < characters.length; index++) {
      if (/\s/u.test(characters[index])) continue
      const gap = selected.find((g) => g.index === count)
      if (gap) {
        parts.push(characters.slice(at, index).join('').trim())
        at = index
      }
      count++
    }
    parts.push(characters.slice(at).join('').trim())
    if (parts.length !== selected.length + 1 || parts.some((p) => !p)) return items
    replacement.set(
      item,
      parts.map((text, n) => ({
        ...item,
        text,
        rect: [
          n ? selected[n - 1].right : item.rect[0],
          item.rect[1],
          n < selected.length ? selected[n].left : item.rect[2],
          item.rect[3]
        ]
      }))
    )
  }
  if (!replacement.size) return items
  const rows = []
  for (const item of body
    .flatMap((i) => replacement.get(i) ?? [i])
    .sort((a, b) => a.baseline - b.baseline)) {
    let row = rows.find((r) => Math.abs(r[0].baseline - item.baseline) < height * 0.25)
    if (!row) rows.push((row = []))
    row.push(item)
  }
  let complete = 0
  for (const row of rows) {
    const fields = columns.map(() => [])
    for (const item of row) {
      const n = lane(item)
      if (n < 0) return items
      fields[n].push(item)
    }
    const texts = fields.map((f) =>
      f
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join('')
    )
    if (!texts.slice(1).some(numeric)) continue // A separately ruled second header tier.
    if (!/\p{L}/u.test(texts[0]) || !texts.slice(1).every(numeric)) return items
    complete++
  }
  if (complete < 3) return items
  return items.flatMap((i) => replacement.get(i) ?? [i])
}

const finiteRect = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite)
const same = (a, b) => Math.abs(a - b) < 1e-6
const overlap = (a, b) =>
  Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1])
const inside = (a, b) => b[0] >= a[0] && b[1] > a[1] && b[2] <= a[2] && b[3] < a[3]

// Native ruled header/record proof. No model labels, inferred
// mathematical values, uniform-width splitting, or post-hoc source deletion.
export function proveNativeOrdinalFractionGutters(inventory, rules, runs) {
  if (
    !Array.isArray(inventory) ||
    !Array.isArray(rules) ||
    !Array.isArray(runs) ||
    rules.some((r) => !finiteRect(r)) ||
    inventory.some((i) => !finiteRect(i.rect))
  )
    return []
  const groups = []
  for (const rule of joinHorizontalTableRules(rules)) {
    let group = groups.find((g) => same(g[0][0], rule[0]) && same(g[0][2], rule[2]))
    if (!group) groups.push((group = []))
    group.push(rule)
  }
  const plans = []
  for (const group of groups) {
    group.sort((a, b) => a[1] - b[1])
    for (let n = 0; n + 2 < group.length; n++) {
      const [opening, divider, closing] = group.slice(n, n + 3),
        rect = [opening[0], opening[1], opening[2], closing[1]]
      const source = inventory.filter((i) => finiteRect(i.rect) && overlap(rect, i.rect))
      if (
        !source.length ||
        source.some((i) => !inside(rect, i.rect)) ||
        !proveNativeUniqueWholeFonts(source, inventory)
      )
        continue
      if (
        rules.some(
          (r) =>
            r[0] !== r[2] &&
            r[1] !== r[3] &&
            overlap(rect, [
              Math.min(r[0], r[2]),
              Math.min(r[1], r[3]),
              Math.max(r[0], r[2]),
              Math.max(r[1], r[3])
            ])
        )
      )
        continue
      if (
        rules.some(
          (r) =>
            r[0] === r[2] && r[0] > rect[0] && r[0] < rect[2] && r[1] < rect[3] && r[3] > rect[1]
        )
      )
        continue
      if (
        rules.some(
          (r) =>
            r[1] === r[3] &&
            r[1] > rect[1] &&
            r[1] < rect[3] &&
            !same(r[1], divider[1]) &&
            r[0] < rect[2] &&
            r[2] > rect[0]
        )
      )
        continue
      const header = source.filter((i) => i.rect[3] < divider[1]),
        body = source.filter((i) => i.rect[1] > divider[1])
      if (header.length + body.length !== source.length || header.length < 2 || body.length < 6)
        continue
      const expanded = [],
        parents = []
      let invalid = false
      for (const item of body) {
        if (/^\d+ \d+$/.test(item.text)) {
          const parts = splitNativeMeasuredFields(item, runs, item.height)
          if (parts?.length !== 2 || parts.some((p) => !/^\d+$/.test(p.text))) {
            invalid = true
            break
          }
          expanded.push(...parts)
          parents.push(item)
        } else if (/^\d+$/.test(item.text) || item.text === '/') expanded.push(item)
        else {
          invalid = true
          break
        }
      }
      if (invalid || !parents.length) continue
      const rows = []
      for (const item of expanded.sort(
        (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
      )) {
        let row = rows.find((g) => same(g[0].baseline, item.baseline))
        if (!row) rows.push((row = []))
        row.push(item)
      }
      if (
        rows.length < 3 ||
        rows.some(
          (g) =>
            ![2, 4].includes(g.length) ||
            !/^\d+$/.test(g[0].text) ||
            g.some((i) => !same(i.height, g[0].height)) ||
            !(g.length === 2
              ? /^\d+$/.test(g[1].text)
              : /^\d+$/.test(g[1].text) && g[2].text === '/' && /^\d+$/.test(g[3].text))
        )
      )
        continue
      // Reuse the existing nativeRecordText inline spacing contract: separated
      // numeric fields must not be recognized as one printed fraction.
      if (
        rows.some(
          (g) =>
            g.length === 4 &&
            g
              .slice(2)
              .some(
                (i, n) => i.rect[0] - g[n + 1].rect[2] > Math.min(i.height, g[n + 1].height) * 0.12
              )
        )
      )
        continue
      if (
        rows
          .slice(1)
          .some(
            (g, i) =>
              BigInt(g[0].text) !== BigInt(rows[i][0].text) + 1n ||
              Math.min(...g.map((i) => i.rect[1])) <= Math.max(...rows[i].map((i) => i.rect[3]))
          )
      )
        continue
      if (!rows.some((g) => g.length === 4)) continue
      const leftMax = Math.max(...rows.map((g) => g[0].rect[2])),
        rightMin = Math.min(...rows.flatMap((g) => g.slice(1).map((i) => i.rect[0])))
      if (!(rightMin > leftMax)) continue
      const cut = (leftMax + rightMin) / 2
      const leaves = [
        header.filter((i) => i.rect[2] <= cut),
        header.filter((i) => i.rect[0] >= cut)
      ]
      if (leaves.flat().length !== header.length || leaves.some((g) => !g.length)) continue
      const anchors = leaves.map((g) =>
        g.filter((i) => i.height === Math.max(...g.map((i) => i.height)))
      )
      if (
        anchors.some((g) => g.length !== 1 || !/[\p{L}]/u.test(g[0].text)) ||
        !same(anchors[0][0].baseline, anchors[1][0].baseline)
      )
        continue
      if (
        leaves.some((g, c) =>
          g.some((i) => i !== anchors[c][0] && !isAdjacentTableScript(i, anchors[c][0]))
        )
      )
        continue
      if (header.some((i) => i.rect[0] < rect[0] || i.rect[2] > rect[2])) continue
      // Each measured partition must straddle this one common, empty native
      // gutter. A string containing a space does not independently authorize it.
      if (
        parents.some((i) => {
          const p = splitNativeMeasuredFields(i, runs, i.height)
          return !(p[0].rect[2] < cut && p[1].rect[0] > cut)
        })
      )
        continue
      plans.push({ rect, cuts: [cut], gutterBands: [[leftMax, rightMin]] })
    }
  }
  return plans.filter(
    (plan, n) => !plans.some((other, m) => m !== n && overlap(plan.rect, other.rect))
  )
}
