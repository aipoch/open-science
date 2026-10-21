/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Preserve complete captioned symbolic arrays as native images. The repeated
// row stubs, column anchors and source fences prove ownership, never cell order.
const rect = (t) => t.rect,
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  inside = (a, b) =>
    a[0] >= b[0] - 0.02 && a[1] >= b[1] - 0.02 && a[2] <= b[2] + 0.02 && a[3] <= b[3] + 0.02,
  over = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ]
export function recoverCaptionedMathArrays(
  items,
  rules,
  captions,
  pageNumber,
  existing = [],
  graphics = [],
  page
) {
  if (
    page?.invalidGraphicsBounds !== 0 ||
    !(page.width > 0) ||
    !(page.height > 0) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) ||
    !graphics.length ||
    graphics.some((g) => !valid(g.rect))
  )
    return []
  const visible = items.filter((t) => t.text?.trim())
  if (
    visible.some(
      (t) =>
        !valid(t.rect) ||
        !t.horizontal ||
        !t.sourceItem ||
        t.sourceItem.pageNumber !== pageNumber ||
        t.sourceItem.text !== t.text ||
        !Number.isSafeInteger(t.sourceItem.index) ||
        t.sourceItem.index < 0 ||
        !Number.isFinite(t.baseline) ||
        !(t.height > 0)
    )
  )
    return []
  if (new Set(visible.map((t) => t.sourceItem.index)).size !== visible.length) return []
  const heights = new Map()
  for (const t of visible) heights.set(t.height, (heights.get(t.height) ?? 0) + 1)
  const h = [...heights].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!h) return []
  const rows = (ts) => {
    const out = []
    for (const t of ts.toSorted((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      let r = out.at(-1)
      if (!r || t.baseline - r.y > h * 0.3) out.push((r = { y: t.baseline, items: [] }))
      r.items.push(t)
    }
    return out
  }
  const short = (t) => !/[A-Za-z]{4,}/.test(t.text) && t.rect[2] - t.rect[0] < h * 5
  const lines = []
  for (const r of rules
    .filter((r) => r.every(Number.isFinite) && r[1] === r[3] && r[0] < r[2])
    .toSorted((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const last = lines.at(-1)
    if (last && Math.abs(last[1] - r[1]) < 0.02 && r[0] - last[2] < 0.02)
      last[2] = Math.max(last[2], r[2])
    else lines.push([...r])
  }
  const verticalLines = []
  for (const r of rules
    .filter((r) => r.every(Number.isFinite) && r[0] === r[2] && r[1] < r[3])
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = verticalLines.at(-1)
    if (last && Math.abs(last[0] - r[0]) < 0.02 && r[1] - last[3] < 0.02)
      last[3] = Math.max(last[3], r[3])
    else verticalLines.push([...r])
  }
  const blocks = []
  for (const line of lines.filter((r) => r[2] - r[0] >= h * 8)) {
    // Every point of the header separator must have native paint support.
    let paintedRight = line[0]
    for (const ink of graphics
      .map(rect)
      .filter((r) => r[1] <= line[1] && r[3] >= line[1])
      .toSorted((a, b) => a[0] - b[0])) {
      if (ink[0] <= paintedRight + 0.02) paintedRight = Math.max(paintedRight, ink[2])
    }
    if (paintedRight < line[2] - 0.02) continue
    const local = visible.filter((t) => t.rect[0] >= line[0] - 0.02 && t.rect[2] <= line[2] + 0.02),
      all = rows(local),
      header = all.filter((r) => r.y < line[1]).at(-1),
      body = []
    if (!header || line[1] - header.y > h || !header.items.every(short) || header.items.length < 4)
      continue
    for (const row of all.filter((r) => r.y > line[1])) {
      const previous = body.at(-1)?.y ?? line[1]
      if (row.y - previous > h * 1.7 || !row.items.every(short)) break
      body.push(row)
    }
    if (body.length < 3 || body.length > 20) continue
    const main = (r) =>
      r.items
        .filter((t) => t.height >= h * 0.9 && t.text.trim() !== '→')
        .toSorted((a, b) => a.rect[0] - b.rect[0])
    const rowMain = body.map(main),
      count = rowMain[0].length
    if (
      count < 4 ||
      rowMain.some((r) => r.length !== count) ||
      rowMain.some((r) =>
        r.some(
          (t, n) =>
            Math.abs((t.rect[0] + t.rect[2] - rowMain[0][n].rect[0] - rowMain[0][n].rect[2]) / 2) >
            h * (n === 0 ? 1 : 0.5)
        )
      )
    )
      continue
    const arrow = body.every((r, k) => {
      const arrows = r.items.filter((t) => t.text.trim() === '→')
      return (
        arrows.length === count - 2 &&
        rowMain[k]
          .slice(1, -1)
          .every(
            (left, n) =>
              arrows.filter(
                (t) =>
                  t.rect[0] >= left.rect[2] - 0.02 && t.rect[2] <= rowMain[k][n + 2].rect[0] + 0.02
              ).length === 1
          )
      )
    })
    const vertical = verticalLines.filter(
      (r) =>
        r[0] === r[2] &&
        r[0] > line[0] &&
        r[0] < line[2] &&
        Math.min(r[1], r[3]) <= line[1] + h * 0.05 &&
        Math.max(r[1], r[3]) >= body.at(-1).y
    )
    if (
      !arrow &&
      (!header.items.some((t) => /[=≤≥]/u.test(t.text)) ||
        rowMain.some((row) =>
          row
            .slice(0, -1)
            .some(
              (left, n) => !vertical.some((v) => v[0] > left.rect[2] && v[0] < row[n + 1].rect[0])
            )
        ))
    )
      continue
    if (arrow) {
      const headerMain = main(header)
      if (
        headerMain.length !== count - 1 ||
        headerMain.some(
          (t, n) =>
            Math.abs(
              (t.rect[0] + t.rect[2] - rowMain[0][n + 1].rect[0] - rowMain[0][n + 1].rect[2]) / 2
            ) >
            h * 0.5
        )
      )
        continue
    }
    let owned = [...header.items, ...body.flatMap((r) => r.items)],
      upper = all.filter((r) => r.y < header.y).at(-1)
    if (
      upper &&
      header.y - upper.y < h * 3 &&
      upper.items.every(short) &&
      upper.items.some((t) => /[=≤≥<>]/u.test(t.text))
    ) {
      const bounds = union(upper.items.map(rect))
      if (Math.abs((bounds[0] + bounds[2] - line[0] - line[2]) / 2) < h) owned.push(...upper.items)
    }
    if (arrow && owned.length === header.items.length + body.flatMap((r) => r.items).length)
      continue
    const stubs = body.map((r, k) =>
      r.items
        .filter((t) => t.rect[2] < rowMain[k][1].rect[0] - h * 0.2)
        .toSorted((a, b) => a.sourceItem.index - b.sourceItem.index)
        .map((t) => t.text)
        .join('')
        .replace(/\s+/gu, '')
    )
    if (new Set(stubs).size !== stubs.length) continue
    const box = union([...owned.map(rect), [line[0], line[1] - 0.5, line[2], line[1] + 0.5]])
    blocks.push({
      box,
      owned,
      line,
      stubs,
      kind: arrow ? 'arrow-array' : 'ruled-array',
      rows: body.length,
      columns: count
    })
  }
  const output = []
  for (const caption of captions.filter(
    (c) => c.page === pageNumber && valid(c.rect) && /^Table\s+\d+/i.test(c.lines?.[0] ?? '')
  )) {
    const textKey = (s) => s.replace(/\s+/gu, '')
    const captionItems = visible
      .filter((t) => inside(t.rect, caption.rect))
      .toSorted((a, b) => a.sourceItem.index - b.sourceItem.index)
    if (
      !captionItems.length ||
      textKey(captionItems.map((t) => t.text).join('')) !== textKey(caption.lines.join(''))
    )
      continue
    const near = blocks
      .filter((b) => caption.rect[1] > b.box[3] && caption.rect[1] - b.box[3] < h * 3)
      .sort((a, b) => b.box[3] - a.box[3])
    if (!near.length) continue
    const selected = [near[0]]
    let changed = true
    while (changed) {
      changed = false
      const box = union(selected.map((b) => b.box))
      for (const b of blocks) {
        if (selected.includes(b) || b.box[3] > box[3] + h * 0.2) continue
        const dx = Math.max(0, box[0] - b.box[2], b.box[0] - box[2]),
          dy = Math.max(0, box[1] - b.box[3], b.box[1] - box[3])
        if (dx < h * 7 && dy < h * 3) {
          selected.push(b)
          changed = true
        }
      }
    }
    if (
      selected.length < 2 ||
      selected.length > 6 ||
      selected.some(
        (b) =>
          b.kind !== selected[0].kind ||
          JSON.stringify(b.stubs) !== JSON.stringify(selected[0].stubs)
      )
    )
      continue
    const tiers = []
    for (const b of selected.toSorted((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])) {
      let tier = tiers.at(-1)
      if (!tier || Math.abs(b.box[1] - tier[0].box[1]) > h * 0.3) tiers.push((tier = []))
      else if (Math.abs(b.box[3] - tier[0].box[3]) > h * 0.3 || b.box[0] <= tier.at(-1).box[2]) {
        tier.push({ invalid: true })
        break
      }
      tier.push(b)
    }
    if (tiers.some((t) => t.some((b) => b.invalid))) continue
    const overall = union(selected.map((b) => b.box)),
      center = (overall[0] + overall[2]) / 2
    if (
      Math.abs((caption.rect[0] + caption.rect[2]) / 2 - center) > h ||
      tiers.some((t) => {
        const r = union(t.map((b) => b.box))
        return Math.abs((r[0] + r[2]) / 2 - center) > h
      })
    )
      continue
    const allOwned = selected.flatMap((b) => b.owned),
      owned = [...new Set(allOwned)]
    if (owned.length !== allOwned.length) continue
    // A separate native line just above one panel can be its own title. Do not
    // omit it and infer shared caption ownership from repeated row stubs alone.
    // Use complete page rows so pieces of spanning prose are not local titles.
    if (
      rows(visible).some((r) => {
        if (r.items.some((t) => owned.includes(t))) return false
        const bounds = union(r.items.map(rect))
        return selected.some(
          (b) =>
            bounds[3] < b.box[1] &&
            b.box[1] - bounds[3] < h * 2 &&
            bounds[0] >= b.box[0] &&
            bounds[2] <= b.box[2]
        )
      })
    )
      continue
    const box = union(selected.map((b) => b.box))
    let crop = [box[0] - h * 0.35, box[1] - h * 0.35, box[2] + h * 0.35, box[3] + h * 0.35]
    const ink = graphics.filter((g) => valid(g.rect) && over(g.rect, crop))
    crop = union([crop, ...ink.map(rect)])
    if (crop.some((n, j) => Math.abs(n - box[j]) > h)) continue
    if (
      !inside(crop, [0, 0, page.width, page.height]) ||
      caption.rect[1] - crop[3] < h * 0.5 ||
      visible.some((t) => over(t.rect, crop) && !owned.includes(t)) ||
      captions.some((c) => c !== caption && over(c.rect, crop)) ||
      existing.some((t) => over(t.cropRect, crop))
    )
      continue
    if (graphics.some((g) => !valid(g.rect) || (over(g.rect, crop) && !inside(g.rect, crop))))
      continue
    output.push({
      cropRect: crop,
      caption,
      sourceItems: owned.map((t) => t.sourceItem).sort((a, b) => a.index - b.index),
      proof: selected.map((b) => ({ kind: b.kind, box: b.box, rows: b.rows, columns: b.columns }))
    })
  }
  return output
}
