/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { captionKind } from './literature-pdf-caption-group.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

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
