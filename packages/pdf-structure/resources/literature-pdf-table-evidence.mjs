/* eslint-disable @typescript-eslint/explicit-function-return-type, no-control-regex, no-useless-escape */
import { isDeepStrictEqual as navigationSourceExact } from 'node:util'
import { inside } from './literature-pdf-table-geometry.mjs'
import { area, intersection } from './literature-pdf-page-geometry.mjs'
import { hasNativeNonTableLayout } from './literature-pdf-native-non-table-layout.mjs'
import { joinHorizontalTableRules, classifyTableRuleEdge } from './literature-pdf-table-rules.mjs'
import { groupSourceRowsWithScripts } from './literature-pdf-source-records.mjs'
import { proveNativeClosedLeafHeader } from './literature-pdf-native-header-grid.mjs'
import { captionKind, groupPageLines } from './literature-pdf-caption-group.mjs'

// Complete first-page name/institution/contact lanes plus an independent
// larger Abstract heading identify metadata without an institution dictionary.
// A table caption, intersecting rule, or incomplete font box defeats this proof.
export function isNativeRepeatedAuthorContactPanel(table, items, pageNumber, caption, rules) {
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const crop = table?.cropRect
  if (
    pageNumber !== 1 ||
    caption ||
    !valid(crop) ||
    table.grid?.length !== 2 ||
    table.grid.some((row) => row.length !== 3) ||
    !Array.isArray(rules)
  )
    return false
  const source = items.filter(
    (i) => i.text?.trim() && valid(i.rect) && intersection(i.rect, crop) > 0
  )
  if (
    source.some(
      (i) =>
        !i.horizontal ||
        i.rect[0] < crop[0] ||
        i.rect[1] < crop[1] ||
        i.rect[2] > crop[2] ||
        i.rect[3] > crop[3]
    ) ||
    rules.some(
      (r) =>
        r?.length === 4 &&
        r.every(Number.isFinite) &&
        intersection(
          [
            Math.min(r[0], r[2]) - 0.01,
            Math.min(r[1], r[3]) - 0.01,
            Math.max(r[0], r[2]) + 0.01,
            Math.max(r[1], r[3]) + 0.01
          ],
          crop
        ) > 0
    )
  )
    return false
  const abstracts = source.filter((i) => /^Abstract\s*:?$/iu.test(i.text.trim()))
  const emails = source.filter((i) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(i.text.trim()))
  if (abstracts.length !== 1 || emails.length !== 3) return false
  const h = emails[0].height,
    heading = abstracts[0]
  if (
    !(h > 0) ||
    !Number.isFinite(h) ||
    !Number.isFinite(heading.height) ||
    heading.height < h * 1.1 ||
    heading.height > h * 1.5
  )
    return false
  const markers = source.filter((i) => /^[∗*†‡]$/u.test(i.text.trim()) && i.height < h * 0.8)
  const ordinary = source.filter((i) => i !== heading && !markers.includes(i))
  if (
    ordinary.length !== 9 ||
    ordinary.some(
      (i) =>
        !Number.isFinite(i.height) || Math.abs(i.height - h) > 0.02 || !Number.isFinite(i.baseline)
    ) ||
    new Set(ordinary.map((i) => JSON.stringify([i.text, i.rect]))).size !== 9
  )
    return false
  const rows = []
  for (const item of [...ordinary].sort(
    (a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]
  )) {
    const row = rows.find((r) => Math.abs(r[0].baseline - item.baseline) < 0.02)
    if (row) row.push(item)
    else rows.push([item])
  }
  if (rows.length !== 3 || rows.some((row) => row.length !== 3)) return false
  const centre = (i) => (i.rect[0] + i.rect[2]) / 2
  const gap = rows[1][0].baseline - rows[0][0].baseline
  if (
    gap < h * 0.75 ||
    gap > h * 2 ||
    Math.abs(rows[2][0].baseline - rows[1][0].baseline - gap) > 0.02 ||
    rows[0].some(
      (i) => !/^\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){1,5}$/u.test(i.text.trim())
    ) ||
    rows[1].some((i) => !/^[\p{L}][\p{L}\s'-]*$/u.test(i.text.trim())) ||
    rows[2].some((i) => !emails.includes(i)) ||
    rows.some((row) => row.some((i, n) => n && i.rect[0] - row[n - 1].rect[2] < h * 2)) ||
    rows[0].some((i, n) => rows.some((row) => Math.abs(centre(row[n]) - centre(i)) > h * 0.2)) ||
    heading.rect[1] <= Math.max(...emails.map((i) => i.rect[3])) ||
    heading.rect[1] - Math.max(...emails.map((i) => i.rect[3])) > h * 5 ||
    Math.abs(centre(heading) - (crop[0] + crop[2]) / 2) > h * 0.2
  )
    return false
  return markers.every(
    (marker) =>
      rows[0].filter(
        (name) =>
          Math.abs(marker.rect[0] - name.rect[2]) < h * 0.1 &&
          marker.rect[3] > name.rect[1] &&
          marker.rect[3] < name.rect[3]
      ).length === 1
  )
}

// A native image fallback adds nothing when a source-backed grid already owns
// exactly the same glyphs and its thumbnail contains every one. Printed caption
// numbers and detector fence margins do not establish a different physical table.
export function isNativeClosedFrameOwnedByTable(table, frame) {
  const valid = (rect) =>
    Array.isArray(rect) &&
    rect.length === 4 &&
    rect.every(Number.isFinite) &&
    rect[2] > rect[0] &&
    rect[3] > rect[1]
  const crop = table?.cropRect
  if (
    !valid(crop) ||
    !Array.isArray(table.grid) ||
    table.grid.length < 2 ||
    (table.grid[0]?.length ?? 0) < 2 ||
    !Array.isArray(frame?.sourceTokens) ||
    frame.sourceTokens.length < 4
  )
    return false
  const assigned = (table.cells ?? []).flatMap((cell) => cell.sourceRects ?? [])
  if (assigned.length !== frame.sourceTokens.length || assigned.some((rect) => !valid(rect)))
    return false
  const owned = new Set()
  for (const token of frame.sourceTokens) {
    const rect = token.rect
    if (
      !valid(rect) ||
      !token.text?.trim() ||
      rect[0] < crop[0] - 0.02 ||
      rect[1] < crop[1] - 0.02 ||
      rect[2] > crop[2] + 0.02 ||
      rect[3] > crop[3] + 0.02
    )
      return false
    const matches = assigned.flatMap((source, index) =>
      source.every((value, axis) => Math.abs(value - rect[axis]) <= 0.02) ? [index] : []
    )
    if (matches.length !== 1 || owned.has(matches[0])) return false
    owned.add(matches[0])
  }
  return owned.size === assigned.length
}

// A detector result may repeat a section or an exact complete native table.
// Compare exact source owners inside that table's own closed frame;
// equal values, overlap, or a shared caption do not establish duplication.
export function nativeSourceDuplicateTableIndices(tables, associations, items, rules) {
  const duplicates = new Set()
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const same = (a, b) => a.every((v, n) => Math.abs(v - b[n]) <= 0.02)
  const horizontal = joinHorizontalTableRules(rules ?? []).filter((r) => r.every(Number.isFinite))
  for (const [index, table] of tables.entries()) {
    const caption = associations[index]?.caption
    if (
      !valid(caption?.rect) ||
      !/^Table\s/iu.test(caption.lines?.[0] ?? caption.text ?? '') ||
      !valid(table.cropRect) ||
      !Array.isArray(table.grid) ||
      table.grid.length < 3 ||
      table.grid[0]?.length < 2 ||
      table.unassigned?.length ||
      table.clipped?.length
    )
      continue
    const assigned = (table.cells ?? []).flatMap((c) => c.sourceRects ?? [])
    if (assigned.length < 6 || assigned.some((r) => !valid(r))) continue
    const owners = assigned.map((r) => items.filter((i) => valid(i.rect) && same(i.rect, r)))
    if (owners.some((matches) => matches.length !== 1)) continue
    const source = owners.map(([item]) => item)
    if (
      new Set(source).size !== source.length ||
      source.some((i) => !i.horizontal || !Number.isFinite(i.height) || !(i.height > 0))
    )
      continue
    const heights = source.map((i) => i.height).sort((a, b) => a - b),
      h = heights[heights.length >> 1]
    const x0 = Math.min(...source.map((i) => i.rect[0])),
      x1 = Math.max(...source.map((i) => i.rect[2])),
      y0 = Math.min(...source.map((i) => i.rect[1])),
      y1 = Math.max(...source.map((i) => i.rect[3]))
    const captionBottom = caption.rect[3] * (table.sourceViewport?.scale ?? 1.5)
    const opening = horizontal
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[0] <= x0 &&
          r[2] >= x1 &&
          r[1] < y0 &&
          y0 - r[1] <= h * 1.5 &&
          r[1] >= captionBottom &&
          r[1] - captionBottom <= h * 2
      )
      .sort((a, b) => b[1] - a[1])[0]
    if (!opening) continue
    const closing = horizontal
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[1] > y1 &&
          r[1] - y1 <= h * 1.5 &&
          Math.abs(r[0] - opening[0]) <= 0.02 &&
          Math.abs(r[2] - opening[2]) <= 0.02
      )
      .sort((a, b) => a[1] - b[1])[0]
    if (!closing) continue
    const frame = [opening[0], opening[1], opening[2], closing[1]]
    const native = items.filter(
      (i) => i.text?.trim() && valid(i.rect) && intersection(i.rect, frame) > 0.02
    )
    if (!isNativeClosedFrameOwnedByTable(table, { sourceTokens: native })) continue
    for (const [partialIndex, partial] of tables.entries()) {
      if (
        partialIndex === index ||
        associations[partialIndex]?.caption ||
        partial.unassigned?.length ||
        partial.clipped?.length ||
        !Array.isArray(partial.grid) ||
        partial.grid.length < 2 ||
        (partial.grid.length >= table.grid.length &&
          !(
            partial.grid.length === table.grid.length &&
            JSON.stringify(partial.grid) === JSON.stringify(table.grid) &&
            JSON.stringify(partial.cells) === JSON.stringify(table.cells) &&
            JSON.stringify(partial.cropRect) === JSON.stringify(table.cropRect)
          )) ||
        partial.grid[0]?.length !== table.grid[0].length
      )
        continue
      const subset = (partial.cells ?? []).flatMap((c) => c.sourceRects ?? [])
      if (subset.length < 4 || subset.length > assigned.length || subset.some((r) => !valid(r)))
        continue
      const matches = subset.map((r) => assigned.flatMap((s, n) => (same(r, s) ? [n] : [])))
      if (matches.every((m) => m.length === 1) && new Set(matches.flat()).size === subset.length)
        duplicates.add(partialIndex)
    }
  }
  for (const index of nativeForeignFrameDuplicateIndices(tables, associations, items, rules))
    duplicates.add(index)
  for (const index of nativeCaptionPartialDuplicateIndices(tables, associations, items, rules))
    duplicates.add(index)
  return duplicates
}

// A caption continuation can seed an open-rule candidate over the header and
// first record of the real table. Its clipped grid is redundant only when one
// complete native title and closed body own every source glyph and source box.
function nativeCaptionPartialDuplicateIndices(tables, associations, items, rules) {
  const duplicates = new Set()
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const contained = (a, b) =>
    a[0] >= b[0] - 0.02 && a[1] >= b[1] - 0.02 && a[2] <= b[2] + 0.02 && a[3] <= b[3] + 0.02
  const glyphs = (text) => text.replace(/\s/gu, '')
  if (
    items.some(
      (item) =>
        item.text?.trim() &&
        (!valid(item.rect) ||
          !Number.isFinite(item.baseline) ||
          !Number.isFinite(item.height) ||
          !(item.height > 0))
    )
  )
    return duplicates
  const frames = tables.map((table) => proveNativeAssignedClosedTableFrame(table, items, rules))
  for (const [index, table] of tables.entries()) {
    const caption = associations[index]?.caption,
      crop = table.cropRect
    if (
      frames[index] ||
      !valid(crop) ||
      !valid(caption?.rect) ||
      caption.lines?.length !== 1 ||
      !/^Table\s/iu.test(caption.lines[0]) ||
      !table.cells?.length
    )
      continue
    const matches = []
    for (const [ownerIndex, owner] of tables.entries()) {
      const frame = frames[ownerIndex],
        full = associations[ownerIndex]?.caption,
        scale = owner.sourceViewport?.scale ?? 1.5
      if (
        !frame ||
        owner.unassigned?.length ||
        owner.clipped?.length ||
        !valid(full?.rect) ||
        full.lines?.length < 4 ||
        glyphs(full.lines[0]) !== glyphs(caption.lines[0]) ||
        !(scale > 0) ||
        !Number.isFinite(scale)
      )
        continue
      const rect = full.rect.map((value) => value * scale),
        first = caption.rect.map((value) => value * (table.sourceViewport?.scale ?? 1.5))
      const title = items.filter(
        (item) => item.text?.trim() && valid(item.rect) && intersection(item.rect, rect) > 0.02
      )
      if (
        !title.length ||
        title.some(
          (item) =>
            !item.horizontal ||
            !Number.isFinite(item.baseline) ||
            !Number.isFinite(item.height) ||
            !(item.height > 0) ||
            !contained(item.rect, rect)
        )
      )
        continue
      const ordered = [...title].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0]),
        h = Math.max(...title.map((item) => item.height))
      const firstSource = ordered.filter((item) => intersection(item.rect, first) > 0.02)
      if (
        !firstSource.length ||
        firstSource.some((item) => !contained(item.rect, first)) ||
        glyphs(firstSource.map((item) => item.text).join('')) !== glyphs(caption.lines[0]) ||
        title.some((item) => Math.abs(item.height - h) > h * 0.03) ||
        glyphs(ordered.map((item) => item.text).join('')) !== glyphs(full.lines.join('')) ||
        rect[3] >= frame.cropRect[1] ||
        frame.cropRect[1] - rect[3] > h * 3 ||
        Math.abs(first[0] - rect[0]) > 0.02 ||
        Math.abs(first[1] - rect[1]) > 0.02 ||
        crop[1] < first[3] - 0.02 ||
        crop[1] >= frame.cropRect[1] ||
        crop[3] >= frame.cropRect[3] ||
        crop[3] <= frame.cropRect[1] ||
        crop[0] < rect[0] ||
        crop[2] > rect[2]
      )
        continue
      const corridor = [rect[0], rect[3], rect[2], frame.cropRect[1]]
      if (
        items.some(
          (item) =>
            item.text?.trim() && valid(item.rect) && intersection(item.rect, corridor) > 0.02
        )
      )
        continue
      const native = items.filter(
        (item) => item.text?.trim() && valid(item.rect) && intersection(item.rect, crop) > 0.02
      )
      const owned = [...title, ...frame.sourceTokens]
      const continuationBaselines = new Set(
        native
          .filter((item) => title.includes(item) && item.rect[1] >= first[3])
          .map((item) => item.baseline)
      )
      if (
        continuationBaselines.size < 2 ||
        native.filter((item) => frame.sourceTokens.includes(item)).length < 4 ||
        native.some((item) => owned.filter((source) => source === item).length !== 1)
      )
        continue
      const assigned = table.cells.flatMap((cell) => cell.sourceRects ?? [])
      if (
        !assigned.length ||
        assigned.some(
          (source) =>
            !valid(source) || owned.filter((item) => contained(source, item.rect)).length !== 1
        )
      )
        continue
      matches.push(ownerIndex)
    }
    if (matches.length === 1) duplicates.add(index)
  }
  return duplicates
}

// A distant table title cannot own a detector aggregate made entirely from two
// other independently titled, closed source bodies. Account for all native ink
// and every sliced source box; overlap or matching values alone is insufficient.
function nativeForeignFrameDuplicateIndices(tables, associations, items, rules) {
  const duplicates = new Set()
  const valid = (rect) =>
    Array.isArray(rect) &&
    rect.length === 4 &&
    rect.every(Number.isFinite) &&
    rect[2] > rect[0] &&
    rect[3] > rect[1]
  const contained = (small, large) =>
    small[0] >= large[0] - 0.02 &&
    small[1] >= large[1] - 0.02 &&
    small[2] <= large[2] + 0.02 &&
    small[3] <= large[3] + 0.02
  const captionKey = (caption) => JSON.stringify([caption?.page, caption?.rect, caption?.lines])
  const glyphs = (text) => text.replace(/\s/gu, '')
  if (!Array.isArray(items) || !Array.isArray(rules)) return duplicates
  if (
    items.some(
      (item) =>
        item.text?.trim() &&
        (!valid(item.rect) ||
          !Number.isFinite(item.baseline) ||
          !Number.isFinite(item.height) ||
          !(item.height > 0))
    )
  )
    return duplicates
  const frames = tables.map((table) => proveNativeAssignedClosedTableFrame(table, items, rules))
  const owners = frames.map((frame, index) => {
    const table = tables[index],
      caption = associations[index]?.caption
    if (
      !frame ||
      !valid(caption?.rect) ||
      !caption.lines?.length ||
      !/^Table\s/iu.test(caption.lines[0]) ||
      table.unassigned?.length ||
      table.clipped?.length
    )
      return
    const scale = table.sourceViewport?.scale ?? 1.5
    if (!Number.isFinite(scale) || !(scale > 0)) return
    const rect = caption.rect.map((value) => value * scale)
    const source = items.filter(
      (item) => item.text?.trim() && valid(item.rect) && intersection(item.rect, rect) > 0.02
    )
    if (
      !source.length ||
      source.some(
        (item) =>
          !item.horizontal ||
          !Number.isFinite(item.height) ||
          !(item.height > 0) ||
          !Number.isFinite(item.baseline) ||
          !contained(item.rect, rect)
      )
    )
      return
    const ordered = [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    if (glyphs(ordered.map((item) => item.text).join('')) !== glyphs(caption.lines.join(''))) return
    const height = Math.max(...source.map((item) => item.height))
    const overlap = Math.max(
      0,
      Math.min(rect[2], frame.cropRect[2]) - Math.max(rect[0], frame.cropRect[0])
    )
    if (
      rect[3] > frame.cropRect[1] ||
      frame.cropRect[1] - rect[3] > height * 2 ||
      overlap < Math.min(rect[2] - rect[0], frame.cropRect[2] - frame.cropRect[0]) * 0.8
    )
      return
    const corridor = [
      Math.min(rect[0], frame.cropRect[0]),
      rect[3],
      Math.max(rect[2], frame.cropRect[2]),
      frame.cropRect[1]
    ]
    if (
      items.some(
        (item) =>
          item.text?.trim() &&
          valid(item.rect) &&
          !source.includes(item) &&
          intersection(item.rect, corridor) > 0.02
      )
    )
      return
    return { frame, key: captionKey(caption), captionSource: source }
  })
  for (const [index, table] of tables.entries()) {
    const caption = associations[index]?.caption
    if (
      !valid(table.cropRect) ||
      !valid(caption?.rect) ||
      !Array.isArray(table.grid) ||
      table.grid.length < 3 ||
      !table.cells?.length ||
      frames[index]
    )
      continue
    const titleOwners = owners.filter(
      (owner, ownerIndex) => ownerIndex !== index && owner?.key === captionKey(caption)
    )
    if (titleOwners.length !== 1 || intersection(titleOwners[0].frame.cropRect, table.cropRect) > 0)
      continue
    const foreign = owners.filter(
      (owner) =>
        owner &&
        owner.key !== titleOwners[0].key &&
        intersection(owner.frame.cropRect, table.cropRect) > 0.02
    )
    if (
      foreign.length !== 2 ||
      new Set(foreign.map((owner) => owner.key)).size !== 2 ||
      foreign.filter((owner) => contained(owner.frame.cropRect, table.cropRect)).length !== 1
    )
      continue
    const native = items.filter(
      (item) =>
        item.text?.trim() && valid(item.rect) && intersection(item.rect, table.cropRect) > 0.02
    )
    if (
      !native.length ||
      native.some(
        (item) =>
          foreign.filter(
            (owner) => owner.frame.sourceTokens.includes(item) || owner.captionSource.includes(item)
          ).length !== 1
      ) ||
      foreign.some(
        (owner) => native.filter((item) => owner.frame.sourceTokens.includes(item)).length < 4
      )
    )
      continue
    const assigned = table.cells.flatMap((cell) => cell.sourceRects ?? [])
    if (
      !assigned.length ||
      assigned.some(
        (rect) =>
          !valid(rect) ||
          foreign.flatMap((owner) =>
            owner.frame.sourceTokens.filter((item) => contained(rect, item.rect))
          ).length !== 1
      )
    )
      continue
    duplicates.add(index)
  }
  return duplicates
}

// Tighten a detector crop only when an independently closed native frame owns
// every assigned glyph and every native glyph within it. Neighboring panel
// ink cannot lend a wider boundary to this complete source grid.
export function proveNativeAssignedClosedTableFrame(
  table,
  items,
  rules,
  allowRuleOverhang = false
) {
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const crop = table.cropRect
  if (
    !valid(crop) ||
    !Array.isArray(table.grid) ||
    table.grid.length < 3 ||
    table.grid[0]?.length < 2
  )
    return
  const cells = (table.cells ?? []).filter((c) => c.sourceRects?.length)
  if (
    new Set(cells.map((c) => c.row)).size !== table.grid.length ||
    cells.some((c) => !Number.isInteger(c.row) || c.row < 0 || c.row >= table.grid.length)
  )
    return
  const source = cells.flatMap((c) => c.sourceRects)
  if (!source.length || source.some((r) => !valid(r))) return
  const same = (a, b) => a.every((v, n) => Math.abs(v - b[n]) <= 0.02)
  const tokens = source.map((r) => items.filter((i) => i.text?.trim() && same(r, i.rect)))
  if (tokens.some((matches) => matches.length !== 1)) return
  const owned = tokens.map((matches) => matches[0])
  if (
    new Set(owned).size !== owned.length ||
    owned.some((i) => !i.horizontal || !Number.isFinite(i.height) || !(i.height > 0))
  )
    return
  const headers = cells.filter((c) => c.row === 0).flatMap((c) => c.sourceRects)
  const body = cells.filter((c) => c.row > 0).flatMap((c) => c.sourceRects)
  if (!headers.length || !body.length) return
  const height = Math.max(...owned.map((i) => i.height))
  const x0 = Math.min(...source.map((r) => r[0])),
    x1 = Math.max(...source.map((r) => r[2])),
    y0 = Math.min(...source.map((r) => r[1])),
    y1 = Math.max(...source.map((r) => r[3]))
  const horizontal = joinHorizontalTableRules(rules).filter(
    (r) =>
      r.every(Number.isFinite) &&
      r[1] === r[3] &&
      (allowRuleOverhang || (r[0] >= crop[0] - 0.02 && r[2] <= crop[2] + 0.02)) &&
      r[1] >= crop[1] - 0.02 &&
      r[1] <= crop[3] + 0.02 &&
      r[0] <= x0 + 0.02 &&
      r[2] >= x1 - 0.02 &&
      x0 - r[0] <= height * 2 &&
      r[2] - x1 <= height * 2
  )
  const proofs = []
  for (const opening of horizontal.filter((r) => r[1] < y0 && y0 - r[1] <= height)) {
    for (const closing of horizontal.filter((r) => r[1] > y1 && r[1] - y1 <= height)) {
      if (Math.abs(opening[0] - closing[0]) > 0.02 || Math.abs(opening[2] - closing[2]) > 0.02)
        continue
      const dividers = horizontal.filter(
        (r) =>
          Math.abs(r[0] - opening[0]) <= 0.02 &&
          Math.abs(r[2] - opening[2]) <= 0.02 &&
          r[1] > Math.max(...headers.map((s) => s[3])) &&
          r[1] < Math.min(...body.map((s) => s[1]))
      )
      if (dividers.length !== 1) continue
      const rect = [opening[0], opening[1], opening[2], closing[1]]
      const native = items.filter((i) => i.text?.trim() && intersection(i.rect, rect) > 0.02)
      if (
        native.length !== owned.length ||
        native.some(
          (i) =>
            !owned.includes(i) ||
            i.rect[0] < rect[0] - 0.02 ||
            i.rect[1] < rect[1] - 0.02 ||
            i.rect[2] > rect[2] + 0.02 ||
            i.rect[3] > rect[3] + 0.02
        )
      )
        continue
      proofs.push({ cropRect: rect, sourceTokens: native })
    }
  }
  return proofs.length === 1 ? proofs[0] : undefined
}

// An unfinished title can stop at its first source line while native paragraph
// continuations separate it from the table. Require one fully assigned closed
// body, literal title glyphs, stable paragraph edges/font/leading and a printed
// terminal boundary. Preserve the source lines without interpreting the prose.
function recoverNativeClosedCaptionParagraph(table, items, rules, page, captions, tables) {
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  if (
    items.some(
      (item) =>
        item.text?.trim() &&
        (!valid(item.rect) ||
          !Number.isFinite(item.baseline) ||
          !Number.isFinite(item.height) ||
          !(item.height > 0))
    )
  )
    return
  const scale = table.sourceViewport?.scale ?? 1.5
  if (!(scale > 0) || !Number.isFinite(scale) || table.unassigned?.length || table.clipped?.length)
    return
  const proof = proveNativeAssignedClosedTableFrame(table, items, rules)
  if (
    !proof ||
    tables.some(
      (other) =>
        other !== table &&
        (() => {
          const frame = proveNativeAssignedClosedTableFrame(other, items, rules)
          return frame && intersection(frame.cropRect, proof.cropRect) > 0.02
        })()
    )
  )
    return
  const eligible = captions.filter(
    (caption) =>
      caption.page === page.pageNumber &&
      valid(caption.rect) &&
      caption.lines?.length === 1 &&
      /^Table\s/iu.test(caption.lines[0]) &&
      /\p{Ll}{2,}-?$/u.test(caption.lines[0])
  )
  const results = []
  for (const caption of eligible) {
    const start = caption.rect.map((value) => value * scale),
      frame = proof.cropRect
    if (start[3] >= frame[1] || start[0] > frame[0] || start[2] < frame[2]) continue
    const source = items.filter(
      (item) =>
        item.text?.trim() &&
        valid(item.rect) &&
        intersection(item.rect, [start[0], start[1], start[2], frame[1]]) > 0.02
    )
    if (
      !source.length ||
      source.some(
        (item) =>
          !item.horizontal ||
          !Number.isFinite(item.height) ||
          !(item.height > 0) ||
          !Number.isFinite(item.baseline) ||
          item.rect[0] < start[0] - 0.02 ||
          item.rect[2] > start[2] + 0.02 ||
          item.rect[1] < start[1] - 0.02 ||
          item.rect[3] >= frame[1]
      )
    )
      continue
    const rows = groupPageLines({
      ...page,
      lines: source.map((item) => ({
        text: item.text,
        x: item.rect[0],
        y: item.rect[1],
        width: item.rect[2] - item.rect[0],
        height: item.height,
        fontSize: item.height
      }))
    }).sort((a, b) => a.y - b.y || a.x - b.x)
    if (
      rows.length < 3 ||
      rows[0].text.replace(/\s/gu, '') !== caption.lines[0].replace(/\s/gu, '') ||
      [rows[0].x, rows[0].y, rows[0].right, rows[0].bottom].some(
        (value, axis) => Math.abs(value - start[axis]) > 0.02
      )
    )
      continue
    const h = rows[0].fontSize,
      leading = rows[1].y - rows[0].y
    if (
      !(leading >= h * 1.2 && leading <= h * 2) ||
      !/^\p{Ll}/u.test(rows[1].text) ||
      !/[.!?]$/u.test(rows.at(-1).text) ||
      rows.some(
        (row, index) =>
          Math.abs(row.fontSize - h) > h * 0.03 ||
          Math.abs(row.bottom - row.y - h) > h * 0.03 ||
          Math.abs(row.x - start[0]) > h * 0.03 ||
          (index && Math.abs(row.y - rows[index - 1].y - leading) > h * 0.03) ||
          (index && /^Table\s/iu.test(row.text))
      )
    )
      continue
    const rect = [
      Math.min(...source.map((item) => item.rect[0])),
      Math.min(...source.map((item) => item.rect[1])),
      Math.max(...source.map((item) => item.rect[2])),
      Math.max(...source.map((item) => item.rect[3]))
    ]
    if (
      frame[1] - rect[3] > h * 3 ||
      captions.some(
        (other) =>
          other !== caption &&
          other.page === page.pageNumber &&
          valid(other.rect) &&
          intersection(
            other.rect.map((value) => value * scale),
            [rect[0], rect[1], rect[2], frame[1]]
          ) > 0.02
      ) ||
      joinHorizontalTableRules(rules).some(
        (rule) => rule[1] > rect[1] && rule[1] < frame[1] && rule[2] > rect[0] && rule[0] < rect[2]
      )
    )
      continue
    results.push({
      ...caption,
      lines: [caption.lines[0], ...rows.slice(1).map((row) => row.text)],
      rect: rect.map((value) => value / scale)
    })
  }
  return results.length === 1 ? results[0] : undefined
}

// A narrow native table may also be centered in a wider prose column while its
// title starts at that column's left edge. Require the complete source frame
// and independently repeated column instead of lowering ordinary overlap.
export function recoverNativeCenteredTableCaption(table, items, rules, page, captions, tables) {
  const paragraph = recoverNativeClosedCaptionParagraph(table, items, rules, page, captions, tables)
  if (paragraph) return paragraph
  if (
    tables.length !== 1 ||
    table.unassigned?.length ||
    table.clipped?.length ||
    !Number.isFinite(page.width) ||
    !(page.width > 0)
  )
    return
  const scale = table.sourceViewport?.scale ?? 1.5
  if (!Number.isFinite(scale) || !(scale > 0)) return
  const proof = proveNativeAssignedClosedTableFrame(table, items, rules)
  if (!proof) return
  const frame = proof.cropRect.map((v) => v / scale)
  const own = captions.filter(
    (c) =>
      c.page === page.pageNumber &&
      /^Table\s+(?:[A-Z]?\d+(?:\.\d+)*|[A-Z][.-]\d+|[IVXLCDM]+)\s*[.:|]\s+\p{L}/iu.test(
        c.lines?.join(' ') ?? ''
      )
  )
  if (own.length !== 1) return
  const caption = own[0],
    box = caption.rect
  if (
    !Array.isArray(box) ||
    box.length !== 4 ||
    !box.every(Number.isFinite) ||
    box[2] <= box[0] ||
    box[3] <= box[1]
  )
    return
  const native = page.lines.filter(
    (l) =>
      l.text?.trim() &&
      Number.isFinite(l.fontSize) &&
      l.fontSize > 0 &&
      intersection([l.x, l.y, l.x + l.width, l.y + l.height], box) > 0.02
  )
  if (!native.length || native.some((l) => !caption.lines.includes(l.text))) return
  const heights = native.map((l) => l.fontSize).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  const overlap = Math.min(box[2], frame[2]) - Math.max(box[0], frame[0]),
    width = frame[2] - frame[0]
  if (
    box[3] > frame[1] ||
    frame[1] - box[3] > h * 2 ||
    box[0] >= frame[0] - h ||
    !(overlap > 0) ||
    overlap / Math.min(width, box[2] - box[0]) >= 0.5
  )
    return
  const peers = page.lines.filter(
    (l) =>
      l.text?.trim().length >= 70 &&
      Math.abs(l.fontSize - h) <= h * 0.05 &&
      Math.abs(l.x - box[0]) <= h * 0.2 &&
      l.width > width * 1.8 &&
      l.x >= 0 &&
      l.x + l.width <= page.width &&
      l.y >= frame[3] + h &&
      l.y <= frame[3] + h * 12 &&
      Math.abs(l.x + l.width / 2 - (frame[0] + frame[2]) / 2) <= h * 0.3
  )
  const rowTops = []
  for (const y of peers.map((l) => l.y).sort((a, b) => a - b))
    if (!rowTops.length || y - rowTops.at(-1) >= h * 0.9) rowTops.push(y)
  if (rowTops.length < 3) return
  const right = Math.max(...peers.map((l) => l.x + l.width)),
    corridor = [box[0], box[3], right, frame[1]]
  if (
    page.lines.some(
      (l) =>
        l.text?.trim() && intersection([l.x, l.y, l.x + l.width, l.y + l.height], corridor) > 0.02
    )
  )
    return
  return caption
}

export function isRecognizedAlgorithmOwnedTable(table, caption, algorithms, scale = 1.5) {
  if (
    caption ||
    !Number.isFinite(scale) ||
    !(scale > 0) ||
    (table.rows?.length ?? table.grid?.length ?? 0) < 2
  )
    return false
  const source = (table.cells ?? []).flatMap((c) => c.sourceRects ?? [])
  if (
    !source.length ||
    source.some((r) => r.length !== 4 || !r.every(Number.isFinite) || r[2] <= r[0] || r[3] <= r[1])
  )
    return false
  return algorithms.some((algorithm) => {
    if (
      algorithm.rect?.length !== 4 ||
      !algorithm.rect.every(Number.isFinite) ||
      algorithm.rect[2] <= algorithm.rect[0] ||
      algorithm.rect[3] <= algorithm.rect[1]
    )
      return false
    const owned = source.filter(
      (r) =>
        r[0] / scale >= algorithm.rect[0] - 0.5 &&
        r[1] / scale >= algorithm.rect[1] - 0.5 &&
        r[2] / scale <= algorithm.rect[2] + 0.5 &&
        r[3] / scale <= algorithm.rect[3] + 0.5
    )
    return (
      owned.length >= 2 &&
      owned.reduce((sum, r) => sum + area(r), 0) >=
        source.reduce((sum, r) => sum + area(r), 0) * 0.99
    )
  })
}

// The explicit procedure title can lie above the detector's first row. Only a
// complete native title/divider/footer and ordered routine own that source;
// aligned numeric data or an isolated Algorithm reference are insufficient.
function isNativeTitledProcedure(table, caption, items, rules) {
  if (caption || !table.cropRect || table.grid.length < 4 || !Array.isArray(rules)) return false
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const assigned = (table.cells ?? []).flatMap((c) => c.sourceRects ?? [])
  if (assigned.length < 8 || assigned.some((r) => !valid(r))) return false
  const same = (a, b) => a.every((v, n) => Math.abs(v - b[n]) <= 0.02)
  const owned = assigned.map((r) => items.filter((i) => valid(i.rect) && same(i.rect, r)))
  if (owned.some((matches) => matches.length !== 1)) return false
  const source = owned.map(([item]) => item)
  if (
    new Set(source).size !== source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !Number.isFinite(i.height) ||
        !Number.isFinite(i.baseline) ||
        !(i.height > 0)
    )
  )
    return false
  const heights = source.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1],
    top = Math.min(...source.map((i) => i.rect[1])),
    bottom = Math.max(...source.map((i) => i.rect[3]))
  const horizontal = joinHorizontalTableRules(rules).filter(
    (r) => r.every(Number.isFinite) && r[1] === r[3]
  )
  const titles = items.filter(
    (i) =>
      i.horizontal &&
      valid(i.rect) &&
      /^Algorithm\s+(?:[A-Z][.-])?\d+\b/iu.test(i.text?.trim() ?? '') &&
      i.rect[3] <= top &&
      top - i.rect[3] <= h * 3
  )
  const proofs = []
  for (const title of titles) {
    const aligned = horizontal.filter(
      (r) => Math.abs(r[0] - title.rect[0]) <= h * 0.5 && r[2] >= title.rect[2]
    )
    const opening = aligned.filter((r) => Math.abs(r[1] - title.rect[1]) <= h * 0.5)
    const divider = aligned.filter((r) => r[1] > title.rect[3] && r[1] < top && top - r[1] <= h)
    const closing = aligned.filter((r) => r[1] > bottom && r[1] - bottom <= h)
    if (opening.length !== 1 || divider.length !== 1 || closing.length !== 1) continue
    if (
      [divider[0], closing[0]].some(
        (r) => Math.abs(r[0] - opening[0][0]) > 0.02 || Math.abs(r[2] - opening[0][2]) > 0.02
      )
    )
      continue
    const frame = [opening[0][0], divider[0][1], opening[0][2], closing[0][1]]
    if (
      source.some(
        (i) =>
          i.rect[0] < frame[0] - 0.02 ||
          i.rect[1] < frame[1] - 0.02 ||
          i.rect[2] > frame[2] + 0.02 ||
          i.rect[3] > frame[3] + 0.02
      )
    )
      continue
    const native = items.filter(
      (i) => i.text?.trim() && valid(i.rect) && intersection(i.rect, frame) > 0.02
    )
    if (native.length !== source.length || native.some((i) => !source.includes(i))) continue
    const ordinals = native
      .filter((i) => /^\d+\s*:$/u.test(i.text.trim()))
      .sort((a, b) => a.baseline - b.baseline)
    if (
      ordinals.length < 4 ||
      ordinals.some(
        (i, n) =>
          Number(i.text.trim().match(/^\d+/u)[0]) !== n + 1 ||
          Math.abs(i.rect[0] - ordinals[0].rect[0]) > h * 0.2 ||
          Math.abs(i.height - h) > h * 0.1
      )
    )
      continue
    const parameters = native.filter(
      (i) =>
        /^(?:Hyperparameters|Parameters|Input|Require)\s*:/iu.test(i.text.trim()) &&
        i.rect[3] <= ordinals[0].rect[1] + 0.02
    )
    if (parameters.length !== 1) continue
    const anchors = [parameters[0], ...ordinals],
      bands = anchors.map(() => [])
    let complete = true
    for (const item of native) {
      const owners = anchors.flatMap((a, n) =>
        Math.abs(item.baseline - a.baseline) <= h * 0.45 ? [n] : []
      )
      if (owners.length !== 1 || item.height > h * 1.3) {
        complete = false
        break
      }
      bands[owners[0]].push(item)
    }
    if (!complete) continue
    const steps = bands.slice(1).map((band) =>
      band
        .toSorted((a, b) => a.rect[0] - b.rect[0])
        .map((i) => i.text)
        .join(' ')
        .trim()
    )
    if (
      !/^1\s*:\s*(?:procedure|function)\b[^()]*\([^()]+\)\s*$/iu.test(steps[0]) ||
      !/^\d+\s*:\s*return\b/iu.test(steps.at(-1)) ||
      !steps.slice(1, -1).every((line) => /←/u.test(line))
    )
      continue
    proofs.push(frame)
  }
  return proofs.length === 1
}

function isNativeProseFootnoteOverlap(table, caption, items, rules) {
  if (
    caption ||
    !table.cropRect ||
    !table.cells?.length ||
    table.grid.length > 4 ||
    table.grid[0]?.length > 3
  )
    return false
  const numbers = table.cells.filter((c) => /^\d{1,3}$/u.test(c.text?.trim() ?? ''))
  if (!numbers.length || numbers.length > 2) return false
  const source = table.cells.flatMap((c) => c.sourceRects ?? [])
  const assigned = items.filter((i) =>
    source.some((r) => r.every((v, n) => Math.abs(v - i.rect[n]) < 0.02))
  )
  const prose = assigned.filter(
    (i) =>
      i.horizontal &&
      (i.text.match(/\p{L}{2,}/gu) ?? []).length >= 5 &&
      i.rect[0] < table.cropRect[0] - i.height &&
      i.rect[2] < table.cropRect[2] - i.height
  )
  if (prose.length < 2) return false
  const h = Math.max(...prose.map((i) => i.height))
  if (
    Math.max(...prose.map((i) => i.rect[0])) - Math.min(...prose.map((i) => i.rect[0])) >
    h * 0.08
  )
    return false
  return numbers.every((c) => {
    const markers = items.filter(
      (i) =>
        i.horizontal &&
        i.text.trim() === c.text.trim() &&
        i.height < h * 0.65 &&
        (c.sourceRects ?? []).some((r) => r.every((v, n) => Math.abs(v - i.rect[n]) < 0.02))
    )
    if (markers.length !== 1) return false
    const marker = markers[0]
    return (
      rules.some(
        (r) =>
          r[1] === r[3] &&
          r[0] <= marker.rect[0] &&
          r[2] > marker.rect[2] &&
          r[2] - r[0] < h * 9 &&
          marker.rect[1] - r[1] >= 0 &&
          marker.rect[1] - r[1] < h * 0.3
      ) &&
      items.some(
        (i) =>
          i !== marker &&
          i.horizontal &&
          /\p{L}/u.test(i.text) &&
          (i.height > marker.height * 1.3 ||
            (i.height > marker.height * 1.15 && i.height < h * 0.8)) &&
          i.rect[0] >= marker.rect[2] &&
          i.rect[0] - marker.rect[2] < marker.height &&
          Math.abs(i.baseline - marker.baseline) < marker.height
      )
    )
  })
}

// A literal caption and a closed native frame preserve the visual table when
// its detector grid cannot prove cell semantics. This does not create cells or
// propagate a grouped stub through quoted or mathematical records.
// Printed literal delimiters prove one complete quoted block, not detector
// columns or semantic records. Preserve it through the existing visual result.
function proveCaptionedNativeLiteralFrame(table, caption, items, rules) {
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  if (
    !valid(table?.cropRect) ||
    !valid(caption?.rect) ||
    !/^Table\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLC]+)\s*[:.]/iu.test(caption.lines?.[0] ?? '')
  )
    return
  if (items.some((i) => i.text?.trim() && !valid(i.rect))) return
  const nearby = items.filter(
    (i) => i.horizontal && i.height > 0 && intersection(i.rect, table.cropRect) > 0
  )
  const h = Math.max(0, ...nearby.map((i) => i.height))
  if (!Number.isFinite(h) || h <= 0) return
  const horizontal = joinHorizontalTableRules(rules).filter((r) => r.every(Number.isFinite))
  const openings = horizontal.filter(
    (r) =>
      r[1] > caption.rect[3] &&
      r[1] - caption.rect[3] < h * 2 &&
      r[1] <= table.cropRect[1] + h &&
      r[0] <= table.cropRect[0] + h &&
      r[2] >= table.cropRect[2] - h
  )
  const proofs = []
  for (const opening of openings) {
    const closing = horizontal
      .filter(
        (r) =>
          r[1] > table.cropRect[3] - h &&
          r[1] > opening[1] + h * 3 &&
          Math.abs(r[0] - opening[0]) < 0.05 &&
          Math.abs(r[2] - opening[2]) < 0.05
      )
      .sort((a, b) => a[1] - b[1])[0]
    if (!closing) continue
    const crop = [opening[0], opening[1], closing[2], closing[1]]
    const source = items.filter((i) => i.text?.trim() && intersection(i.rect, crop) > 0)
    if (
      source.length < 8 ||
      new Set(source.map((i) => JSON.stringify([i.text, i.rect, i.baseline]))).size !==
        source.length ||
      source.some(
        (i) =>
          !i.horizontal ||
          !valid(i.rect) ||
          !Number.isFinite(i.height) ||
          i.height <= 0 ||
          !Number.isFinite(i.baseline) ||
          i.rect[0] < crop[0] ||
          i.rect[1] < crop[1] ||
          i.rect[2] > crop[2] ||
          i.rect[3] > crop[3] ||
          /^(?:Table|Figure|Algorithm)\s+\d+\b/iu.test(i.text.trim())
      )
    )
      continue
    const delimiters = source
      .filter((i) => /^(?:`{3}|‘{3}|'{3})$/u.test(i.text.trim()))
      .sort((a, b) => a.baseline - b.baseline)
    if (
      delimiters.length !== 2 ||
      delimiters[0].text !== delimiters[1].text ||
      Math.abs(delimiters[0].rect[0] - delimiters[1].rect[0]) > 0.05 ||
      Math.abs(delimiters[0].height - delimiters[1].height) > 0.05 ||
      !source.some((i) => i.rect[1] > delimiters[0].rect[3] && i.rect[3] < delimiters[1].rect[1]) ||
      source.some((i) => i.rect[1] >= delimiters[1].rect[3]) ||
      closing[1] - delimiters[1].rect[3] > h * 2 ||
      horizontal.some(
        (r) => r[1] > opening[1] && r[1] < closing[1] && r[0] <= crop[0] && r[2] >= crop[2]
      ) ||
      items.some(
        (i) =>
          i.text?.trim() &&
          i.rect[0] < crop[2] &&
          i.rect[2] > crop[0] &&
          i.rect[1] < opening[1] &&
          i.rect[3] > caption.rect[3]
      )
    )
      continue
    proofs.push({ kind: 'native-closed-table-visual', cropRect: crop, sourceTokens: source })
  }
  return proofs.length === 1 ? proofs[0] : undefined
}

function proveCaptionedNativeDoubleRulePlate(table, caption, items, rules) {
  const crop = table?.cropRect
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  if (
    !valid(crop) ||
    !valid(caption?.rect) ||
    !/^Table\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLC]+)\s*[:.]/iu.test(caption.lines?.[0] ?? '')
  )
    return
  if (items.some((i) => i.text?.trim() && !valid(i.rect))) return
  const near = items.filter((i) => i.horizontal && intersection(i.rect, crop) > 0)
  const h = Math.max(0, ...near.map((i) => i.height))
  if (!Number.isFinite(h) || h <= 0 || caption.rect[1] <= crop[3]) return
  const horizontal = joinHorizontalTableRules(rules).filter((r) => r.every(Number.isFinite))
  const pair = (a, b) =>
    Math.abs(a[0] - b[0]) < 0.01 &&
    Math.abs(a[2] - b[2]) < 0.01 &&
    b[1] - a[1] > h * 0.1 &&
    b[1] - a[1] < h * 0.3
  const openings = horizontal.filter(
    (r) => Math.abs(r[1] - crop[1]) < h && r[0] < crop[0] + h && r[2] > crop[2] - h
  )
  const closings = horizontal.filter(
    (r) => r[1] < caption.rect[1] && caption.rect[1] - r[1] < h * 2
  )
  const captionStarts = items.filter(
    (i) =>
      i.horizontal &&
      /^Table\s+(?:[A-Z]?\d+(?:\.\d+)*|[IVXLC]+)\s*[:.]$/iu.test(i.text.trim()) &&
      intersection(i.rect, caption.rect) > 0 &&
      Number.isFinite(i.baseline)
  )
  const captionLine = (i) =>
    captionStarts.length === 1 &&
    i.horizontal &&
    Number.isFinite(i.baseline) &&
    Math.abs(i.baseline - captionStarts[0].baseline) < 0.01 &&
    i.rect[0] >= caption.rect[0] &&
    i.rect[2] <= caption.rect[2] &&
    i.rect[1] >= caption.rect[1] - i.height * 0.02 &&
    i.rect[3] <= caption.rect[3]
  const matches = []
  for (const a of openings)
    for (const b of openings.filter((r) => pair(a, r))) {
      for (const c of closings)
        for (const d of closings.filter((r) => pair(c, r))) {
          if (
            c[1] <= crop[3] ||
            Math.abs(a[0] - c[0]) > 0.01 ||
            Math.abs(a[2] - c[2]) > 0.01 ||
            Math.abs((caption.rect[0] + caption.rect[2] - a[0] - a[2]) / 2) > h * 2
          )
            continue
          const source = items.filter(
            (i) =>
              i.text?.trim() &&
              i.rect?.[1] < c[1] &&
              i.rect[3] > b[1] &&
              i.rect[0] < a[2] &&
              i.rect[2] > a[0]
          )
          if (
            source.length < 12 ||
            new Set(source.map((i) => JSON.stringify([i.text, i.rect, i.baseline]))).size !==
              source.length ||
            source.some(
              (i) =>
                !i.horizontal ||
                !i.rect.every(Number.isFinite) ||
                !Number.isFinite(i.height) ||
                i.height <= 0 ||
                !Number.isFinite(i.baseline) ||
                i.rect[1] < b[1] ||
                i.rect[3] > c[1] ||
                i.rect[0] < a[0] - h ||
                i.rect[2] > a[2] + h ||
                /^(?:Table|Figure|Algorithm)\s+\d+\b/iu.test(i.text.trim())
            )
          )
            continue
          const divider = horizontal.filter(
            (r) =>
              r[1] > b[1] + h &&
              r[1] < c[1] - h &&
              Math.abs(r[0] - a[0]) < 0.01 &&
              Math.abs(r[2] - a[2]) < 0.01
          )
          if (
            divider.length !== 1 ||
            !source.some((i) => i.baseline < divider[0][1]) ||
            !source.some((i) => i.rect[1] > divider[0][1]) ||
            source.filter((i) => /[=∂∇∫]/u.test(i.text)).length < 3 ||
            items.some(
              (i) =>
                i.text?.trim() &&
                i.rect[0] < a[2] &&
                i.rect[2] > a[0] &&
                i.rect[1] < caption.rect[1] &&
                i.rect[3] > d[1] &&
                !captionLine(i)
            )
          )
            continue
          matches.push({
            kind: 'native-closed-table-visual',
            cropRect: [
              Math.min(a[0], ...source.map((i) => i.rect[0])),
              a[1],
              Math.max(a[2], ...source.map((i) => i.rect[2])),
              d[1]
            ],
            sourceTokens: source
          })
        }
    }
  return matches.length === 1 ? matches[0] : undefined
}

export function proveCaptionedNativeClosedTableFrame(table, caption, items, rules) {
  const literal = proveCaptionedNativeLiteralFrame(table, caption, items, rules)
  if (literal) return literal
  const doubleRulePlate = proveCaptionedNativeDoubleRulePlate(table, caption, items, rules)
  if (doubleRulePlate) return doubleRulePlate
  if (
    !table.cropRect ||
    !caption?.rect ||
    !/^Table\s+(?:[A-Z]?\d+(?:\.\d+)*|[A-Z]\.\d+(?:\.\d+)*|[IVXLC]+)\s*[:.]/iu.test(
      caption.lines?.[0] ?? ''
    )
  )
    return
  const [left, top, right, bottom] = table.cropRect
  const near = items.filter(
    (i) =>
      i.horizontal &&
      i.height > 0 &&
      i.rect[0] >= left - 2 &&
      i.rect[2] <= right + 2 &&
      i.rect[1] >= top - 20 &&
      i.rect[3] <= bottom + 20
  )
  const heights = near.map((i) => i.height).sort((a, b) => a - b),
    // Dense uncertainty scripts can outnumber full-size row glyphs. Use the
    // ordinary upper font band to measure the two-line header enclosure.
    h = heights[Math.floor(heights.length * 0.8)]
  if (!(h > 0)) return
  let horizontal = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h * 1.5 &&
        r[1] <= bottom + h * 1.5 &&
        Math.abs(r[0] - left) < h * 1.5 &&
        r[2] >= right - h * 1.5 &&
        r[2] - right < (right - left) * 0.4
    )
    .sort((a, b) => a[1] - b[1])
  if (horizontal.length < 2) return
  const opening = horizontal.toSorted((a, b) => Math.abs(a[1] - top) - Math.abs(b[1] - top))[0]
  horizontal = horizontal.filter(
    (r) =>
      r[1] >= opening[1] && Math.abs(r[0] - opening[0]) < 0.05 && Math.abs(r[2] - opening[2]) < 0.05
  )
  const closing = horizontal.toSorted(
    (a, b) => Math.abs(a[1] - bottom) - Math.abs(b[1] - bottom)
  )[0]
  horizontal = horizontal.filter((r) => r[1] <= closing[1])
  if (
    closing[1] - opening[1] < h * 3 ||
    Math.abs(opening[0] - closing[0]) > 0.05 ||
    Math.abs(opening[2] - closing[2]) > 0.05 ||
    caption.rect[0] >= opening[2] ||
    caption.rect[2] <= opening[0] ||
    !(
      (caption.rect[3] <= opening[1] && opening[1] - caption.rect[3] < h * 3) ||
      (caption.rect[1] >= closing[1] && caption.rect[1] - closing[1] < h * 4)
    )
  )
    return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.rect[0] >= opening[0] - 0.05 &&
      i.rect[2] <= opening[2] + 0.05 &&
      i.rect[1] >= opening[1] - h * 0.2 &&
      i.rect[3] <= closing[1] + 0.05
  )
  if (source.length < 8 || source.some((i) => /^Algorithm\s+\d/iu.test(i.text))) return
  const vertical = rules.filter(
    (r) =>
      r[0] === r[2] &&
      r[0] >= opening[0] - 0.6 &&
      r[0] <= opening[2] + 0.6 &&
      classifyTableRuleEdge(rules, 0, r[0], opening[1], closing[1]) === 1
  )
  const cuts = [...new Set(vertical.map((r) => r[0]))].sort((a, b) => a - b)
  if (
    cuts.length >= 3 &&
    cuts.length <= 7 &&
    Math.abs(cuts[0] - opening[0]) < 0.6 &&
    Math.abs(cuts.at(-1) - opening[2]) < 0.6 &&
    cuts
      .slice(1)
      .filter((x, c) => source.some((i) => i.rect[0] >= cuts[c] - 0.05 && i.rect[2] <= x + 0.05))
      .length >= 2
  ) {
    return {
      kind: 'native-boxed-table-visual',
      cropRect: [opening[0], opening[1], opening[2], closing[1]],
      sourceTokens: source,
      columns: cuts.slice(1).map((x, c) => [cuts[c], opening[1], x, closing[1]])
    }
  }
  // A double opening stroke still encloses one header. Collapse only that
  // tightly adjacent pair; an internal body separator is a different boundary.
  if (horizontal.length === 4 && horizontal[1][1] - opening[1] < h * 0.4)
    horizontal = [opening, ...horizontal.slice(2)]
  if (horizontal.length !== 3) return
  const divider = horizontal[1]
  if (
    Math.abs(divider[0] - opening[0]) > 0.05 ||
    Math.abs(divider[2] - opening[2]) > 0.05 ||
    divider[1] - opening[1] > h * 4.5
  )
    return
  const header = source.filter((i) => i.baseline > opening[1] && i.rect[3] < divider[1])
  if (header.length < 2 || header.length > 24) return
  const headerHeight = Math.max(...header.map((i) => i.height))
  const ordinary = header.filter((i) => i.height >= headerHeight * 0.8)
  const firstBaseline = Math.min(...ordinary.map((i) => i.baseline))
  const first = ordinary.filter((i) => Math.abs(i.baseline - firstBaseline) <= headerHeight * 0.2)
  const ordered = first.toSorted((a, b) => a.rect[0] - b.rect[0])
  const fields = []
  for (const i of ordered) {
    const previous = fields.at(-1)
    if (previous && i.rect[0] - previous.at(-1).rect[2] < h * 0.4) previous.push(i)
    else fields.push([i])
  }
  if (
    fields.length < 2 ||
    fields.length > 6 ||
    fields.some((g) => !g.some((i) => /\p{L}/u.test(i.text)))
  )
    return
  const wrapped = header.some((i) => Math.abs(i.baseline - firstBaseline) > headerHeight * 0.2)
  if (wrapped) {
    // Every lower header glyph must belong to one independently printed leaf
    // label. This proves visual ownership, not a mathematical serialization.
    const lanes = fields.map((g, index) => [
      index ? (fields[index - 1].at(-1).rect[2] + g[0].rect[0]) / 2 : opening[0],
      index + 1 < fields.length ? (g.at(-1).rect[2] + fields[index + 1][0].rect[0]) / 2 : opening[2]
    ])
    if (
      header.some(
        (i) => lanes.filter(([a, b]) => i.rect[0] >= a - 0.05 && i.rect[2] <= b + 0.05).length !== 1
      )
    )
      return
  } else if (divider[1] - opening[1] > h * 2.8) return
  const body = source.filter((i) => i.baseline > divider[1])
  // A visual-only fallback does not need to assign ambiguous scripts to a
  // body record. The complete native enclosure and explicit leaf header own
  // those glyphs; repeated ordinary baselines prove there is table content.
  const ordinaryBands = []
  for (const i of body
    .filter((i) => i.height >= headerHeight * 0.8)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const band = ordinaryBands.at(-1)
    if (band && Math.abs(i.baseline - band[0].baseline) < headerHeight * 0.2) band.push(i)
    else ordinaryBands.push([i])
  }
  const bands = groupSourceRowsWithScripts(body, headerHeight, 0.2) ?? ordinaryBands
  if (
    !bands ||
    bands.length < 4 ||
    body.filter((i) => /\p{L}/u.test(i.text)).length < Math.min(6, bands.length)
  )
    return
  if (
    wrapped &&
    ordinaryBands.filter((band) => {
      const numeric = band.filter((i) => /^\d[\d .]*(?:\s+[–−-])?$/u.test(i.text.trim()))
      const supported = fields.filter((g) =>
        numeric.some((i) => Math.abs(i.rect[0] - g[0].rect[0]) < headerHeight * 0.85)
      )
      return supported.length >= 2
    }).length < Math.max(3, Math.ceil(ordinaryBands.length * 0.6))
  )
    return
  return {
    kind: 'native-closed-table-visual',
    cropRect: [opening[0], opening[1], opening[2], closing[1]],
    sourceTokens: source,
    headerTokens: header
  }
}

// Seed only unique closed native tables next to the supplied literal caption.
// Further boxed parts must continue the same physical fence widths; they have
// no invented caption ownership and are returned as visual-only source parts.
export function findCaptionedNativeClosedTableFrames(caption, items, rules) {
  if (
    !caption?.rect ||
    !/^Table\s+(?:[A-Z]?\d+(?:\.\d+)*|[A-Z]\.\d+(?:\.\d+)*|[IVXLC]+)\s*[:.]/iu.test(
      caption.lines?.[0] ?? ''
    )
  )
    return []
  const h = items
    .filter((i) => i.height > 0)
    .map((i) => i.height)
    .sort((a, b) => a - b)[items.filter((i) => i.height > 0).length >> 1]
  if (!(h > 0)) return []
  const horizontal = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[2] - r[0] > h * 8 &&
        r[1] > caption.rect[3] &&
        r[0] < caption.rect[2] &&
        r[2] > caption.rect[0]
    )
    .sort((a, b) => a[1] - b[1])
  const openings = horizontal.filter((r) => r[1] - caption.rect[3] < h * 3)
  const matches = []
  for (const opening of openings) {
    const closing = horizontal.filter(
      (r) =>
        r[1] > opening[1] + h * 3 &&
        Math.abs(r[0] - opening[0]) < 0.05 &&
        Math.abs(r[2] - opening[2]) < 0.05
    )
    const frames = closing
      .map((r) =>
        proveCaptionedNativeClosedTableFrame(
          { cropRect: [opening[0], opening[1], r[2], r[1]] },
          caption,
          items,
          rules
        )
      )
      .filter(Boolean)
    if (frames.length) matches.push(frames.at(-1))
  }
  if (matches.length !== 1) return []
  const center = (caption.rect[0] + caption.rect[2]) / 2
  const frame = matches[0].cropRect
  const first = {
      ...matches[0],
      caption: center >= frame[0] - h && center <= frame[2] + h ? caption : undefined
    },
    out = [first]
  if (first.kind !== 'native-boxed-table-visual') return out
  let previous = first
  for (let n = 0; n < 2; n++) {
    const opening = horizontal.find(
      (r) =>
        r[1] > previous.cropRect[3] + h * 0.3 &&
        r[1] - previous.cropRect[3] < h * 2 &&
        Math.abs(r[0] - first.cropRect[0]) < 0.6 &&
        Math.abs(r[2] - first.cropRect[2]) < 0.6
    )
    if (!opening) break
    const intervening = items.filter(
      (i) =>
        i.horizontal &&
        i.text?.trim() &&
        i.rect[1] > previous.cropRect[3] + 0.05 &&
        i.rect[3] < opening[1] - 0.05 &&
        i.rect[0] < opening[2] &&
        i.rect[2] > opening[0]
    )
    if (intervening.length) break
    const fakeCaption = {
      ...caption,
      rect: [opening[0], opening[1] - h, opening[2], opening[1] - 0.01]
    }
    const proofs = horizontal
      .filter(
        (r) =>
          r[1] > opening[1] + h * 3 &&
          Math.abs(r[0] - opening[0]) < 0.05 &&
          Math.abs(r[2] - opening[2]) < 0.05
      )
      .map((r) =>
        proveCaptionedNativeClosedTableFrame(
          { cropRect: [opening[0], opening[1], r[2], r[1]] },
          fakeCaption,
          items,
          rules
        )
      )
      .filter((p) => p?.kind === 'native-boxed-table-visual')
    if (!proofs.length) break
    previous = { ...proofs.at(-1), caption: undefined }
    out.push(previous)
  }
  return out
}

// A complete native definition frame is stronger ownership than a damaged
// formula-like detector grid. Return geometry proof, never invented math cells.
export function proveCaptionedNativeDefinitionFrame(table, caption, items, rules) {
  if (
    !table.cropRect ||
    !caption?.rect ||
    !/^Table\s+[\dIVXLC]+\s*[:.]/iu.test(caption.lines?.[0] ?? '')
  )
    return
  const [left, top, right, bottom] = table.cropRect
  const near = items.filter(
    (i) =>
      i.horizontal &&
      i.height > 0 &&
      i.rect[0] >= left - 5 &&
      i.rect[2] <= right + 5 &&
      i.rect[1] >= top - 15 &&
      i.rect[3] <= bottom + 15
  )
  const heights = near.map((i) => i.height).sort((a, b) => a - b),
    h = heights[heights.length >> 1]
  if (!(h > 0)) return
  const frame = joinHorizontalTableRules(rules)
    .filter(
      (r) =>
        r[1] >= top - h &&
        r[1] <= bottom + h &&
        Math.abs(r[0] - left) < h &&
        Math.abs(r[2] - right) < h
    )
    .sort((a, b) => a[1] - b[1])
  if (frame.length !== 2 && frame.length !== 3) return
  const opening = frame[0],
    closing = frame.at(-1)
  if (
    opening[1] - caption.rect[3] < -0.05 ||
    opening[1] - caption.rect[3] > h * 2 ||
    caption.rect[2] <= opening[0] ||
    caption.rect[0] >= opening[2] ||
    closing[1] - opening[1] < h * 4
  )
    return
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.text?.trim() &&
      i.rect[0] >= opening[0] - 0.05 &&
      i.rect[2] <= opening[2] + 0.05 &&
      i.rect[1] >= opening[1] - h * 0.3 &&
      i.rect[3] <= closing[1] + 0.05
  )
  if (!source.length) return
  const cropRect = [
    opening[0],
    Math.min(opening[1], ...source.map((i) => i.rect[1])),
    closing[2],
    closing[1]
  ]
  if (frame.length === 3) {
    const divider = frame[1],
      header = source.filter((i) => i.baseline < divider[1])
    if (
      header.length !== 3 ||
      header.map((i) => i.text.trim()).join('|') !== 'Symbol|Meaning|Notes' ||
      header.some((i) => Math.abs(i.baseline - header[0].baseline) > h * 0.15) ||
      divider[1] - opening[1] > h * 2.5
    )
      return
    const body = source.filter((i) => i.baseline > divider[1])
    if (body.length < 30 || body.filter((i) => /[=∑∏≤≥]/u.test(i.text)).length < 3) return
    return { kind: 'native-notation-visual', cropRect, sourceTokens: source, headerTokens: header }
  }
  const bands = groupSourceRowsWithScripts(source, h, 0.25)
  if (!bands || bands.length < 4 || bands.length > 12) return
  const labels = bands.map((g) => g.toSorted((a, b) => a.rect[0] - b.rect[0])[0])
  if (
    labels.some((i) => !/^\p{L}[\p{L}\d\s,/()−-]{5,60}$/u.test(i.text.trim())) ||
    labels.some((i) => Math.abs(i.rect[0] - labels[0].rect[0]) > h * 0.1)
  )
    return
  const values = bands.map((g, n) => g.filter((i) => i !== labels[n]))
  if (
    values.some(
      (g) =>
        g.length < 2 ||
        !g.some((i) => /\d/u.test(i.text)) ||
        !g.some((i) => /[=<>≤≥]/u.test(i.text))
    )
  )
    return
  const labelRight = Math.max(...labels.map((i) => i.rect[2])),
    valueLeft = Math.min(...values.flat().map((i) => i.rect[0]))
  if (valueLeft - labelRight < h * 0.8) return
  const cut = (labelRight + valueLeft) / 2
  if (
    bands
      .slice(1)
      .some(
        (g, n) =>
          Math.max(...bands[n].map((i) => i.rect[3])) - Math.min(...g.map((i) => i.rect[1])) >
          h * 0.1
      )
  )
    return
  const rows = bands.map((g, n) => [
    opening[0],
    n
      ? Math.min(
          Math.min(...g.map((i) => i.rect[1])),
          (Math.max(...bands[n - 1].map((i) => i.rect[3])) + Math.min(...g.map((i) => i.rect[1]))) /
            2
        )
      : cropRect[1],
    closing[2],
    n === bands.length - 1
      ? closing[1]
      : Math.max(
          Math.max(...g.map((i) => i.rect[3])),
          (Math.max(...g.map((i) => i.rect[3])) + Math.min(...bands[n + 1].map((i) => i.rect[1]))) /
            2
        )
  ])
  if (
    rows.some((r) => r[3] <= r[1]) ||
    bands.some((g, n) =>
      g.some((i) => i.rect[1] < rows[n][1] - 0.05 || i.rect[3] > rows[n][3] + 0.05)
    )
  )
    return
  return {
    kind: 'native-parameter-records',
    cropRect,
    sourceTokens: source,
    columns: [
      [opening[0], cropRect[1], cut, closing[1]],
      [cut, cropRect[1], closing[2], closing[1]]
    ],
    rows,
    bodyRecords: bands,
    headerRows: []
  }
}

// Native paragraph ink crosses a detector's artificial column cuts. Require
// several connected words on the same baseline; separate description columns
// and independently measured records do not supply this proof.
function hasContinuousNativeProse(table, items) {
  if (!table.cropRect || !table.cells?.length) return false
  const [left, top, right, bottom] = table.cropRect
  const cuts = [
    ...new Set(
      table.cells
        .filter((c) => c.colSpan === 1)
        .map((c) => c.rect[2])
        .filter((x) => x > left + 2 && x < right - 2)
    )
  ]
  if (!cuts.length) return false
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.height > 0 &&
      i.rect[3] > top &&
      i.rect[1] < bottom &&
      i.rect[2] > left &&
      i.rect[0] < right
  )
  if (!source.length) return false
  const em = Math.max(...source.map((i) => i.height))
  const rows = []
  for (const item of source
    .filter((i) => i.height >= em * 0.85)
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
    const row = rows.find((r) => Math.abs(r[0].rect[1] - item.rect[1]) < em * 0.15)
    if (row) row.push(item)
    else rows.push([item])
  }
  const prose = []
  for (const row of rows) {
    const chains = []
    for (const item of row.sort((a, b) => a.rect[0] - b.rect[0])) {
      const chain = chains.at(-1),
        previous = chain?.at(-1)
      if (previous && item.rect[0] - previous.rect[2] < em * 0.9) chain.push(item)
      else chains.push([item])
    }
    for (const chain of chains) {
      const text = chain.map((i) => i.text).join(' ')
      if (
        (text.match(/\p{L}{2,}/gu) ?? []).length >= 5 &&
        chain.at(-1).rect[2] - chain[0].rect[0] > (right - left) * 0.5 &&
        cuts.some((x) => chain[0].rect[0] < x - em && chain.at(-1).rect[2] > x + em)
      )
        prose.push(chain)
    }
  }
  const measuredRows = table.grid.filter(
    (row) => row.filter((t) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(t.trim())).length >= 2
  )
  if (
    measuredRows.length ||
    table.grid.some((row) => row.some((t) => /^[-+−]?\d+(?:\.\d+)?\s*\([^)]*\)$/.test(t.trim())))
  )
    return false
  const text = source.map((i) => i.text).join(' ')
  return (
    prose.length >= 2 ||
    (prose.length === 1 && /[=≤≥⪰≳]/.test(text) && source.some((i) => /^[∇∥≥≤=−+]/.test(i.text)))
  )
}

function isNumberedNativeDisplay(table, items) {
  const equations = table.grid.filter(
    (row) =>
      row.some((t) => /^\((?:[A-Z]\.)?\d+(?:\.\d+)*\)$/.test(t.trim())) &&
      row.some((t) => /[=≤≥⪰∥∇]/.test(t))
  )
  if (!equations.length || !table.cropRect) return false
  const numericRows = table.grid.filter(
    (row) => row.filter((t) => /^[-+−]?\d+(?:\.\d+)?$/.test(t.trim())).length >= 2
  )
  if (numericRows.length) return false
  return equations.every((row) => {
    const label = row.find((t) => /^\((?:[A-Z]\.)?\d+(?:\.\d+)*\)$/.test(t.trim()))
    const matches = items.filter(
      (i) => i.horizontal && i.text.trim() === label && inside(table.cropRect, i)
    )
    return (
      matches.length === 1 &&
      matches[0].rect[0] > table.cropRect[0] + (table.cropRect[2] - table.cropRect[0]) * 0.8 &&
      items.some(
        (i) =>
          i.horizontal &&
          /[=≤≥⪰∥∇]/.test(i.text) &&
          Math.abs(i.rect[3] - matches[0].rect[3]) < matches[0].height * 0.2 &&
          matches[0].rect[0] - i.rect[2] > matches[0].height * 4
      )
    )
  })
}

// A displayed system of equations can be split into detector columns and look
// like a small table.  Without a caption, repeated mathematical rows and an
// equation ordinal are stronger evidence of native prose than tabular data.
// A detector may see only the middle of a matrix and invent two rows. The
// complete paired native bracket carriers, assignment and enclosed literals
// establish display ownership independently of that damaged grid.
function isNativeBracketedAssignment(table, caption, items, rules) {
  if (caption || !table.cropRect?.every(Number.isFinite) || !Array.isArray(rules)) return false
  const valid = (i) =>
    i.horizontal &&
    i.rect?.length === 4 &&
    i.rect.every(Number.isFinite) &&
    i.rect[2] > i.rect[0] &&
    i.rect[3] > i.rect[1] &&
    Number.isFinite(i.height) &&
    i.height > 0 &&
    Number.isFinite(i.baseline)
  const starts = items.filter((i) => i.text === '⎡' && valid(i))
  for (const start of starts) {
    const h = start.height
    const left = items
      .filter(
        (i) =>
          '⎡⎢⎣'.includes(i.text) &&
          i.text?.length === 1 &&
          Math.abs(i.rect?.[0] - start.rect[0]) < h * 0.02 &&
          i.rect[1] >= start.rect[1] - h * 0.02
      )
      .sort((a, b) => a.rect[1] - b.rect[1])
    const end = left.findIndex((i) => i.text === '⎣')
    if (end < 3) continue
    left.splice(end + 1)
    const right = items
      .filter(
        (i) =>
          '⎤⎥⎦'.includes(i.text) &&
          i.text?.length === 1 &&
          i.rect?.[0] > start.rect[2] &&
          i.rect[1] >= start.rect[1] - h * 0.02 &&
          i.rect[1] <= left.at(-1).rect[1] + h * 0.02
      )
      .sort((a, b) => a.rect[1] - b.rect[1])
    if (
      right.length !== left.length ||
      right[0]?.text !== '⎤' ||
      right.at(-1)?.text !== '⎦' ||
      left.slice(1, -1).some((i) => i.text !== '⎢') ||
      right.slice(1, -1).some((i) => i.text !== '⎥') ||
      left.some(
        (i, n) =>
          !valid(i) ||
          !valid(right[n]) ||
          Math.abs(i.height - h) > h * 0.02 ||
          Math.abs(right[n].height - h) > h * 0.02 ||
          Math.abs(i.rect[1] - right[n].rect[1]) > h * 0.02 ||
          Math.abs(right[n].rect[0] - right[0].rect[0]) > h * 0.02 ||
          (n && (i.rect[1] <= left[n - 1].rect[1] || i.rect[1] > left[n - 1].rect[3]))
      )
    )
      continue
    const bounds = [start.rect[0], start.rect[1], right[0].rect[2], left.at(-1).rect[3]]
    if (
      intersection(table.cropRect, bounds) < area(bounds) * 0.8 ||
      rules.some((r) => intersection([r[0], r[1], r[2] + 0.01, r[3] + 0.01], bounds) > 0)
    )
      continue
    const body = items.filter(
      (i) => intersection(i.rect, bounds) > 0 && !left.includes(i) && !right.includes(i)
    )
    if (
      !body.length ||
      body.some(
        (i) =>
          !valid(i) ||
          i.rect[0] < start.rect[2] - h * 0.02 ||
          i.rect[2] > right[0].rect[0] + h * 0.02 ||
          i.rect[1] < bounds[1] ||
          i.rect[3] > bounds[3] ||
          !/^[\p{L}\p{N}−+.,⋯⋮⋱ˆ^]+$/u.test(i.text) ||
          [...i.text].length > 3
      )
    )
      continue
    const bands = []
    for (const i of body.filter((i) => i.height >= h * 0.9)) {
      const band = bands.find((b) => Math.abs(b[0].baseline - i.baseline) < h * 0.02)
      if (band) band.push(i)
      else bands.push([i])
    }
    if (bands.length < 3 || bands.some((b) => b.length < 3)) continue
    const equals = items.filter(
      (i) =>
        i.text === '=' &&
        valid(i) &&
        i.rect[2] <= start.rect[0] &&
        start.rect[0] - i.rect[2] < h &&
        i.rect[1] > bounds[1] &&
        i.rect[3] < bounds[3]
    )
    if (equals.length !== 1) continue
    const sign = equals[0]
    const lhs = items.filter(
      (i) =>
        valid(i) &&
        i.rect[2] <= sign.rect[0] &&
        sign.rect[0] - i.rect[2] < h * 4 &&
        Math.abs(i.rect[3] - sign.rect[3]) < h * 0.5
    )
    if (
      !lhs.some((i) => /^\p{L}$/u.test(i.text)) ||
      lhs.some((i) => !/^[\p{L}\p{N}(),]+$/u.test(i.text))
    )
      continue
    const display = new Set([...left, ...right, ...body, sign, ...lhs])
    if (
      items.some(
        (i) => i.text?.trim() && intersection(i.rect, table.cropRect) > 0 && !display.has(i)
      ) ||
      (table.cells ?? [])
        .flatMap((c) => c.sourceRects ?? [])
        .some(
          (rect) => [...display].filter((i) => i.rect.every((v, n) => v === rect[n])).length !== 1
        )
    )
      continue
    return true
  }
  return false
}

function isNativeAssignedMatrixDisplay(table, caption, items, rules) {
  if (isNativeBracketedAssignment(table, caption, items, rules)) return true
  if (caption || !table.cropRect || table.grid.length < 3) return false
  const source = items.filter((i) => i.horizontal && i.text?.trim() && inside(table.cropRect, i))
  const valid = (i) =>
    i.rect?.length === 4 &&
    i.rect.every(Number.isFinite) &&
    i.height > 0 &&
    Number.isFinite(i.baseline)
  if (source.some((i) => !valid(i))) return false
  for (const [leftGlyphs, rightGlyphs] of [
    ['', ''],
    ['⎛⎜⎝', '⎞⎟⎠']
  ]) {
    const left = source
      .filter((i) => leftGlyphs.includes(i.text))
      .sort((a, b) => a.rect[1] - b.rect[1])
    const right = source
      .filter((i) => rightGlyphs.includes(i.text))
      .sort((a, b) => a.rect[1] - b.rect[1])
    const h = left[0]?.height
    if (
      !h ||
      left.length < 4 ||
      right.length !== left.length ||
      left[0].text !== leftGlyphs[0] ||
      left.at(-1).text !== leftGlyphs[2] ||
      right[0].text !== rightGlyphs[0] ||
      right.at(-1).text !== rightGlyphs[2] ||
      left.slice(1, -1).some((i) => i.text !== leftGlyphs[1]) ||
      right.slice(1, -1).some((i) => i.text !== rightGlyphs[1]) ||
      left.some(
        (i, n) =>
          Math.abs(i.rect[0] - left[0].rect[0]) > h * 0.02 ||
          Math.abs(right[n].rect[0] - right[0].rect[0]) > h * 0.02 ||
          Math.abs(i.rect[1] - right[n].rect[1]) > h * 0.02 ||
          Math.abs(i.height - h) > h * 0.02 ||
          Math.abs(right[n].height - h) > h * 0.02 ||
          (n && i.rect[1] - left[n - 1].rect[1] > h * 2)
      )
    )
      continue
    const bounds = [left[0].rect[0], left[0].rect[1], right[0].rect[2], left.at(-1).rect[3] + h * 2]
    if ((rules ?? []).some((r) => intersection([r[0], r[1], r[2] + 0.01, r[3] + 0.01], bounds) > 0))
      continue
    const body = source.filter(
      (i) =>
        i.rect[0] >= left[0].rect[2] - h * 0.02 &&
        i.rect[2] <= right[0].rect[0] + h * 0.02 &&
        i.rect[1] >= bounds[1] &&
        i.rect[3] <= bounds[3]
    )
    if (!body.length || body.some((i) => !/^(?:[-+−]?\d+(?:\.\d+)?|[\p{L}]|[, .])$/u.test(i.text)))
      continue
    const rows = []
    for (const i of body
      .filter((i) => i.height >= h * 0.9)
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const row = rows.at(-1)
      if (row && Math.abs(i.baseline - row[0].baseline) < h * 0.02) row.push(i)
      else rows.push([i])
    }
    if (rows.length < 3 || rows.some((r) => r.length < 3 || r.length !== rows[0].length)) continue
    const equations = source.filter(
      (i) =>
        i.text === '=' &&
        i.rect[2] < left[0].rect[0] &&
        left[0].rect[0] - i.rect[2] < h &&
        i.rect[1] > bounds[1] &&
        i.rect[3] < left.at(-1).rect[3]
    )
    if (equations.length !== 1) continue
    const sign = equations[0]
    const labels = source.filter(
      (i) =>
        /^[\p{L}]$/u.test(i.text) &&
        i.rect[2] < sign.rect[0] &&
        sign.rect[0] - i.rect[2] < h &&
        Math.abs(i.baseline - sign.baseline) < h * 0.02
    )
    if (labels.length === 1) return true
  }
  return false
}

function isNativeFormulaSystem(table, caption) {
  if (caption || !table.cropRect || table.grid.length < 3) return false
  const cells = table.grid
    .flat()
    .map((text) => text.trim())
    .filter(Boolean)
  if (cells.length < 5) return false
  const measuredRows = table.grid.filter(
    (row) =>
      row.filter((text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())).length >= 2
  )
  if (measuredRows.length) return false
  const formulaRows = table.grid.filter(
    (row) =>
      row.some((text) => /[=∈≤≥⪰∥∇]/u.test(text)) && row.some((text) => /[\p{L}α-ω]/u.test(text))
  )
  const ordinals = cells.filter((text) =>
    /(?:^|\s)\((?:[A-Z]\.)?\d+(?:\.\d+)*\)(?:$|[,.])/u.test(text)
  )
  const symbolic = cells.filter((text) => /[=∈≤≥⪰∥∇]/u.test(text)).length
  const prose = cells.filter(
    (text) => text.split(/\s+/).length >= 8 && !/[=∈≤≥⪰∥∇]/u.test(text)
  ).length
  return formulaRows.length >= 3 && ordinals.length >= 1 && symbolic >= 3 && prose <= 1
}

// Detector padding can include a note below a complete ruled body. Those
// glyphs are not evidence of damaged cell math. Prove source ownership inside
// both rules instead of accepting a table merely because it has a caption.
function hasOnlyRuledFooterDamage(table, caption, items, rules) {
  if (!caption?.rect || !rules?.length || !table.cells?.length) return false
  if (table.grid.flat().some((text) => /[\u0000-\u001f�]/u.test(text))) return false
  const valid = (r) => r?.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const captionRect = caption.rect.map((v) => v * (table.sourceViewport?.scale ?? 1.5))
  if (!valid(captionRect)) return false
  const source = table.cells.flatMap((cell) => cell.sourceRects ?? [])
  if (!source.length || source.some((r) => !valid(r))) return false
  const same = (a, b) => a.every((v, n) => Math.abs(v - b[n]) < 0.02)
  const matches = source.map((r) => items.filter((i) => valid(i.rect) && same(r, i.rect)))
  if (matches.some((m) => m.length !== 1)) return false
  const owned = matches.map(([i]) => i)
  if (new Set(owned).size !== owned.length || owned.some((i) => !i.horizontal || !(i.height > 0)))
    return false
  const height = Math.max(...owned.map((i) => i.height)),
    tolerance = height * 0.1
  const body = [
    Math.min(...source.map((r) => r[0])),
    Math.min(...source.map((r) => r[1])),
    Math.max(...source.map((r) => r[2])),
    Math.max(...source.map((r) => r[3]))
  ]
  const edges = joinHorizontalTableRules(rules).filter(
    (r) =>
      r.every(Number.isFinite) &&
      r[1] === r[3] &&
      r[0] <= body[0] + tolerance &&
      r[2] >= body[2] - tolerance &&
      r[0] >= table.cropRect[0] - tolerance &&
      r[2] <= table.cropRect[2] + tolerance
  )
  const opening = edges.filter(
    (r) =>
      r[1] <= body[1] + tolerance &&
      body[1] - r[1] <= height &&
      r[1] >= table.cropRect[1] - tolerance &&
      caption.rect[3] * (table.sourceViewport?.scale ?? 1.5) < r[1]
  )
  const closing = edges.filter(
    (r) => r[1] > body[3] && r[1] - body[3] <= height && r[1] < table.cropRect[3]
  )
  if (
    opening.length !== 1 ||
    closing.length !== 1 ||
    Math.abs(opening[0][0] - closing[0][0]) > tolerance ||
    Math.abs(opening[0][2] - closing[0][2]) > tolerance
  )
    return false
  const frame = [
    opening[0][0] - tolerance,
    opening[0][1] - tolerance,
    opening[0][2] + tolerance,
    closing[0][1]
  ]
  const footer = items.filter(
    (i) =>
      i.text?.trim() &&
      valid(i.rect) &&
      i.rect[1] > closing[0][1] &&
      intersection(i.rect, table.cropRect) > 0
  )
  const remaining = [...footer],
    clipped = []
  for (const item of table.clipped ?? []) {
    if (!valid(item.rect)) return false
    const index = remaining.findIndex((i) => i.text === item.text && same(i.rect, item.rect))
    if (index < 0) return false
    clipped.push(...remaining.splice(index, 1))
  }
  // Diagnostics may overlap for one glyph. Match unassigned text to otherwise
  // unexplained sources first, while retaining multiplicity within each category.
  const unassignedSources = [...remaining, ...clipped]
  for (const text of table.unassigned ?? []) {
    const index = unassignedSources.findIndex((i) => i.text === text)
    if (index < 0) return false
    unassignedSources.splice(index, 1)
  }
  if (unassignedSources.some((i) => !clipped.includes(i))) return false
  const bodyItems = items.filter(
    (i) => i.text?.trim() && valid(i.rect) && intersection(i.rect, frame) > 0
  )
  return (
    bodyItems.length === owned.length &&
    bodyItems.every((i) => owned.includes(i)) &&
    items
      .filter((i) => i.text?.trim() && valid(i.rect) && intersection(i.rect, table.cropRect) > 0)
      .every(
        (i) =>
          owned.includes(i) ||
          footer.includes(i) ||
          i.rect.every((v, n) => (n < 2 ? v >= captionRect[n] - 0.02 : v <= captionRect[n] + 0.02))
      )
  )
}

// Some appendix equations have enough aligned glyphs to be emitted as a
// detector table, but they do not contain a tabular record.  Captionless
// displays are already covered by isNativeFormulaSystem; this conservative
// companion also handles damaged math glyphs (for example boxed operators or
// replacement characters) when the crop carries a large amount of unowned
// text.  A complete two-column parameter table remains eligible because it has
// no crop-boundary/unassigned evidence.
function isDamagedNativeFormulaLayout(table, caption) {
  if (!table.cropRect || table.grid.length < 3) return false
  const populated = table.grid
    .flat()
    .map((text) => text.trim())
    .filter(Boolean)
  if (populated.length < 4) return false
  const math = /[=∈≤≥⪰∥∇∑√∞∫⋆ℓβγθνξ∆⊕⊗∀∃�−+*\/^]/u
  const formulaRows = table.grid.filter((row) => {
    const text = row.filter(Boolean).join(' ')
    return math.test(text) && /[\p{L}α-ω]/u.test(text)
  })
  if (caption && formulaRows.length < 2) return false
  const measuredRows = table.grid.filter(
    (row) =>
      row.filter((text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())).length >= 2
  )
  const controlGlyphs = populated.join(' ').match(/[\u0000-\u001f�]/gu)?.length ?? 0
  const ordinal = populated.some((text) =>
    /(?:^|\s)\((?:[A-Z]\.)?\d+(?:\.\d+)*\)(?:$|[,.])/u.test(text)
  )
  const symbolicCount = (populated.join(' ').match(/[=∈≤≥⪰∥∇∑√∞∫⋆ℓβγθνξ∆⊕⊗∀∃�−+*\/^]/gu) ?? [])
    .length
  if (caption && controlGlyphs === 0 && !ordinal && symbolicCount < 3) return false
  if (
    table.grid.length <= 4 &&
    controlGlyphs >= Math.max(2, Math.ceil(populated.length * 0.2)) &&
    (table.unassigned?.length ?? 0) + (table.clipped?.length ?? 0) >= 2
  )
    return true
  if (measuredRows.length || formulaRows.length < 2) return false
  const damage =
    (table.unassigned?.length ?? 0) + (table.clipped?.length ?? 0) >=
    Math.max(4, populated.length * 0.45)
  return damage && (ordinal || formulaRows.length >= 3 || table.grid.length <= 4)
}

// A wrapped tuple list and a single arrow chain have no independent native
// header or record separator. Require their literal display shape, rather than treating
// every scientific symbol or coordinate as non-table content.
function isNativeContinuousMathDisplay(table, caption, items, rules) {
  if (caption || !table.cropRect || table.grid.length > 4) return false
  const crop = table.cropRect
  const source = items.filter((i) => i.horizontal && i.text?.trim() && inside(crop, i))
  if (!source.length) return false
  const localRules = rules.filter(
    (r) => intersection([r[0], r[1], r[2] + 0.01, r[3] + 0.01], crop) > 0
  )
  const h = Math.max(...source.map((i) => i.height))
  const ordinals = source.filter((i) => /^\(\d+(?:\.\d+)*\)$/u.test(i.text.trim()))
  if (ordinals.length === 1 && !localRules.length) {
    const ordinal = ordinals[0],
      body = source.filter((i) => i !== ordinal)
    const text = body
      .toSorted((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
      .map((i) => i.text)
      .join('')
      .replace(/\s/gu, '')
    if (
      body.every((i) => i.rect[0] > ordinal.rect[2] + h) &&
      /^(?:\([-+−]?\d+(?:,[-+−]?\d+){1,3}\),){5,}\([-+−]?\d+(?:,[-+−]?\d+){1,3}\)[.,]?$/u.test(text)
    )
      return true
  }
  const arrows = source.filter((i) => /[→⟶]/u.test(i.text))
  if (arrows.length < 2 || arrows.some((i) => Math.abs(i.baseline - arrows[0].baseline) > h * 0.2))
    return false
  const baseline = arrows[0].baseline
  const chain = source.filter(
    (i) => i.rect[1] < baseline + h * 0.2 && i.rect[3] > baseline - h * 1.5
  )
  const rest = source.filter((i) => !chain.includes(i))
  // A single equation box has only an outer boundary. An interior native
  // header/column separator instead refuses this narrow display proof.
  const ink = [
    Math.min(...source.map((i) => i.rect[0])),
    Math.min(...source.map((i) => i.rect[1])),
    Math.max(...source.map((i) => i.rect[2])),
    Math.max(...source.map((i) => i.rect[3]))
  ]
  if (
    localRules.some(
      (r) =>
        (r[1] === r[3] && r[1] > ink[1] && r[1] < ink[3]) ||
        (r[0] === r[2] && r[0] > ink[0] && r[0] < ink[2])
    )
  )
    return false
  return (
    chain.length >= 5 &&
    chain.every((i) => i.text.trim().split(/\s+/u).length <= 3) &&
    rest.length > 0 &&
    rest.every((i) => i.rect[1] >= baseline + h * 0.5 && i.rect[3] <= baseline + h * 2) &&
    (
      rest
        .map((i) => i.text)
        .join(' ')
        .match(/\p{L}{2,}/gu) ?? []
    ).length >= 6
  )
}

// A neighboring affiliation column can lend its raised ordinals to a model
// bibliography crop. The external institutional line proves those numbers
// have a different owner; genuinely measured reference tables remain eligible.
function isNativeBibliographyWithAffiliationMarkers(table, items) {
  if (!table.cropRect || table.grid.some((r) => r.length > 2)) return false
  const crop = table.cropRect
  const markers = items.filter(
    (i) =>
      i.horizontal &&
      /^\d{1,2}$/u.test(i.text.trim()) &&
      inside(crop, i) &&
      i.rect[0] > crop[0] + (crop[2] - crop[0]) * 0.85
  )
  const owned = markers.filter((mark) =>
    items.some(
      (i) =>
        i.horizontal &&
        i.rect[0] >= mark.rect[2] &&
        // Refined detector padding may include the institutional prefix;
        // most of the independently raised-marker line must remain outside.
        i.rect[2] - crop[2] > (i.rect[2] - i.rect[0]) * 0.5 &&
        i.rect[0] - mark.rect[2] < i.height &&
        i.height > mark.height * 1.2 &&
        Math.abs(i.baseline - mark.baseline) < i.height * 0.6 &&
        /\b(?:Department|University|Institute|Observatory|Laboratory|Research)\b/iu.test(i.text)
    )
  )
  if (owned.length < 3) return false
  const left = Math.min(...owned.map((i) => i.rect[0]))
  const citation = items
    .filter((i) => i.horizontal && inside(crop, i) && i.rect[2] < left)
    .toSorted((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])
    .map((i) => i.text)
    .join(' ')
  return (
    (citation.match(/\p{L}[\p{L}’'-]+,\s*\p{Lu}\./gu) ?? []).length >= 4 &&
    (citation.match(/\b(?:19|20)\d{2}[a-z]?,\s*[\p{L}& .-]+,\s*\d{1,4},\s*[A-Z]?\d+/gu) ?? [])
      .length >= 4
  )
}

function isImageBackedNonTable(table, caption, sourceGraphics = []) {
  if (caption || !table.cropRect || !sourceGraphics.length) return false
  const image = sourceGraphics.find(
    (graphic) =>
      graphic.kind === 'image' &&
      intersection(graphic.rect, table.cropRect) / area(table.cropRect) > 0.8 &&
      intersection(graphic.rect, table.cropRect) / area(graphic.rect) > 0.6
  )
  if (!image) return false
  const values = [...(table.grid ?? []).flat(), ...(table.unassigned ?? [])]
  const controlGlyphs = values.join(' ').match(/[\u0000-\u001f�]/gu)?.length ?? 0
  const measurements = values.filter((text) =>
    /^[-+−]?\d+(?:\.\d+)?(?:\s*[%±].*)?$/.test(text.trim())
  )
  const cleanWords = values.filter(
    (text) => /\p{L}{2,}/u.test(text) && !/[\u0000-\u001f�]/u.test(text)
  )
  return (
    measurements.length === 0 &&
    controlGlyphs >= Math.max(2, Math.ceil(values.length * 0.2)) &&
    (cleanWords.length < 3 || (table.unassigned?.length ?? 0) >= 2)
  )
}

// A detector can crop the tabular-looking left side of a figure panel while
// the right side remains part of the figure.  Publish the figure as one
// region instead of exposing a misleading partial table when the candidate
// has crop-boundary/unassigned evidence and sits almost entirely inside a
// captioned figure, but occupies only a portion of that figure.
export function isFigureOwnedPartialTable(table, figures, scale = 1.5) {
  if (
    !table?.cropRect ||
    !Array.isArray(figures) ||
    !table.issues?.includes('text-crosses-crop-boundary') ||
    !(table.unassigned?.length ?? 0)
  )
    return false
  const rect = table.cropRect.map((value) => value / scale)
  const rectArea = area(rect)
  if (!rectArea) return false
  return figures.some((figure) => {
    const graphic = figure?.rect
    if (!Array.isArray(graphic) || area(graphic) <= 0) return false
    const overlapArea = intersection(rect, graphic)
    return overlapArea / rectArea >= 0.85 && overlapArea / area(graphic) < 0.8
  })
}

// Assigned text can cross a detector crop without appearing in `unassigned`.
// Reject that fragment only when the unique captioned figure retains every
// whole native owner. No cell reconstruction or enlargement follows from this.
export function isNativeFigureOwnedClippedTable(table, figures, scale, evidence) {
  const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1],
    contains = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6)),
    same = (a, b) => valid(a) && valid(b) && a.every((n, i) => Math.abs(n - b[i]) < 1e-6),
    key = (s) => `${s.pageNumber}:${s.index}`,
    items = evidence?.items
  if (
    !valid(table?.cropRect) ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    !Array.isArray(figures) ||
    !Array.isArray(items) ||
    table.caption ||
    evidence.caption ||
    table.parts ||
    table.cropRects ||
    !table.issues?.includes('native-table-structure-ambiguous') ||
    table.unassigned?.length ||
    !table.cells?.length
  )
    return false
  const references = new Map(),
    active = new Set()
  let remaining = 100000
  const count = (value) => {
    if (--remaining < 0) return false
    if (!value || typeof value !== 'object') return true
    if (active.has(value)) return false
    active.add(value)
    if (Number.isSafeInteger(value.pageNumber) && Number.isSafeInteger(value.index))
      references.set(key(value), (references.get(key(value)) ?? 0) + 1)
    for (const child of Object.values(value)) if (!count(child)) return false
    active.delete(value)
    return true
  }
  if (!count(items)) return false
  const owned = [],
    keys = new Set()
  for (const cell of table.cells) {
    if (
      !cell.text?.trim() &&
      !cell.sourceItems?.length &&
      !cell.sourceRects?.length &&
      !cell.sourceSegments?.length &&
      !cell.sourceTokens?.length
    )
      continue
    if (
      cell.sourceSegments?.length ||
      !cell.sourceItems?.length ||
      cell.sourceItems.length !== cell.sourceRects?.length
    )
      return false
    const fonts = []
    for (const source of cell.sourceItems) {
      if (
        !Number.isSafeInteger(source.pageNumber) ||
        source.pageNumber !== table.page ||
        !Number.isSafeInteger(source.index) ||
        source.index < 0 ||
        typeof source.text !== 'string' ||
        !source.text.trim() ||
        keys.has(key(source)) ||
        references.get(key(source)) !== 1
      )
        return false
      const matches = items.filter(
        (item) => item.sourceItem && key(item.sourceItem) === key(source)
      )
      if (matches.length !== 1) return false
      const item = matches[0]
      if (
        item.text !== source.text ||
        item.sourceItem.text !== source.text ||
        !item.horizontal ||
        !Number.isFinite(item.height) ||
        item.height <= 0 ||
        !valid(item.rect)
      )
        return false
      keys.add(key(source))
      fonts.push(item)
      owned.push(item)
    }
    if (cell.sourceTokens !== undefined) {
      if (!Array.isArray(cell.sourceTokens) || cell.sourceTokens.length !== fonts.length)
        return false
      const matched = new Set()
      for (const token of cell.sourceTokens) {
        const matches = fonts.filter(
          (f) =>
            token?.text === f.text &&
            same(token.rect, f.rect) &&
            token.height === f.height &&
            token.baseline === f.baseline &&
            (token.horizontal === undefined || token.horizontal === f.horizontal) &&
            (token.sourceItem === undefined ||
              navigationSourceExact(token.sourceItem, f.sourceItem)) &&
            !token.sourceToken &&
            !token.sourceSegment
        )
        if (matches.length !== 1 || matched.has(matches[0])) return false
        matched.add(matches[0])
      }
    }
    if (
      cell.sourceRects.some((r) => fonts.filter((f) => same(f.rect, r)).length !== 1) ||
      fonts.some((f) => cell.sourceRects.filter((r) => same(f.rect, r)).length !== 1) ||
      cell.text?.replace(/\s/gu, '') !==
        fonts
          .map((f) => f.text)
          .join('')
          .replace(/\s/gu, '')
    )
      return false
  }
  if (
    owned.length < 3 ||
    !owned.some(
      (f) =>
        intersection(f.rect, table.cropRect) > 0 &&
        (f.rect[0] < table.cropRect[0] - f.height || f.rect[2] > table.cropRect[2] + f.height)
    )
  )
    return false
  const crop = table.cropRect.map((n) => n / scale),
    sourceRects = owned.map((f) => f.rect.map((n) => n / scale)),
    intersecting = figures.filter((f) => valid(f?.rect) && intersection(f.rect, crop) > 0)
  if (intersecting.length !== 1) return false
  const figure = intersecting[0],
    caption = figure.caption
  return (
    !!caption &&
    caption.page === table.page &&
    valid(caption.rect) &&
    typeof caption.lines?.[0] === 'string' &&
    captionKind(caption.lines[0]) === 'figure' &&
    intersection(caption.rect, figure.rect) === 0 &&
    contains(figure.rect, crop) &&
    area(crop) / area(figure.rect) < 0.8 &&
    sourceRects.every((r) => contains(figure.rect, r))
  )
}

function isCaptionedNarrativeCard(table, caption) {
  if (!caption || !table.grid.length || !table.unassigned?.length) return false
  const text = table.grid.flat().join(' ')
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const measurements = table.grid
    .flat()
    .filter((cell) => /^[-+−]?\d+(?:\.\d+)?(?:\s*[%±].*)?$/.test(cell.trim()))
  return (
    measurements.length === 0 &&
    words >= 40 &&
    table.unassigned.length >= 8 &&
    (table.issues?.includes('text-crosses-crop-boundary') ||
      table.issues?.includes('overlapping-predicted-columns')) &&
    table.grid.length <= 5
  )
}

// Syntax-highlighted code listings can look like sparse multi-column tables
// when the detector follows the painted background or indentation.  Keep this
// proof deliberately narrow: require repeated declaration/return lines,
// source-level punctuation, and substantial text that the inferred grid did
// not assign.  Captioned tables remain eligible because a real caption is
// stronger ownership evidence than a lexical code signal.
function isNativeCodeListing(table, caption, items) {
  if (caption || !table.cropRect || !Array.isArray(items)) return false
  const valid = (i) =>
    i.horizontal &&
    i.rect?.length === 4 &&
    i.rect.every(Number.isFinite) &&
    i.rect[0] < i.rect[2] &&
    i.rect[1] < i.rect[3] &&
    Number.isFinite(i.height) &&
    i.height > 0 &&
    Number.isFinite(i.baseline)
  const labels = items.filter(
    (i) =>
      valid(i) &&
      /^Listing\s+\d+\s*[:.]$/iu.test(i.text.trim()) &&
      i.rect[1] >= table.cropRect[3] - i.height &&
      i.rect[1] - table.cropRect[3] < i.height * 3 &&
      i.rect[0] >= table.cropRect[0] &&
      i.rect[2] <= table.cropRect[2]
  )
  if (labels.length === 1) {
    const label = labels[0],
      h = label.height
    const numbers = items
      .filter(
        (i) =>
          /^\d{1,3}$/u.test(i.text?.trim() ?? '') &&
          i.rect?.[1] < label.rect[1] &&
          i.rect[3] > table.cropRect[1] - h * 30 &&
          i.rect[0] >= table.cropRect[0] &&
          i.rect[2] < table.cropRect[0] + h * 2
      )
      .sort((a, b) => a.baseline - b.baseline)
    if (
      numbers.length >= 5 &&
      numbers.length <= 80 &&
      numbers.every(
        (i, n) =>
          valid(i) &&
          Number(i.text) === n + 1 &&
          Math.abs(i.rect[2] - numbers[0].rect[2]) < 0.01 &&
          Math.abs(i.height - numbers[0].height) < 0.01 &&
          (!n ||
            (i.baseline > numbers[n - 1].baseline && i.baseline - numbers[n - 1].baseline < h * 2))
      ) &&
      label.rect[1] - numbers.at(-1).baseline < h * 3
    ) {
      const source = items.filter(
        (i) =>
          i.text?.trim() &&
          i.rect?.[1] >= numbers[0].rect[1] - h &&
          i.rect[3] <= label.rect[1] &&
          i.rect[0] >= Math.min(...numbers.map((n) => n.rect[0])) &&
          i.rect[2] <= table.cropRect[2]
      )
      const code = source.filter((i) => !numbers.includes(i))
      const cells = table.cells ?? [],
        sameRect = (a, b) => Array.isArray(a) && a.length === 4 && a.every((v, n) => v === b[n]),
        gutterCells = cells.filter(
          (cell) =>
            cell.sourceRects?.length === 1 &&
            numbers.filter((n) => n.text === cell.text && sameRect(cell.sourceRects[0], n.rect))
              .length === 1
        )
      const words = code.map((i) =>
        i.text.replace(
          /\b(?:w\s+h\s+i\s+l\s+e|i\s+f|e\s+l\s+s\s+e|f\s+o\s+r|r\s+e\s+t\s+u\s+r\s+n|c\s+o\s+n\s+t\s+i\s+n\s+u\s+e)\b/gu,
          (s) => s.replace(/\s/gu, '')
        )
      )
      if (
        source.every(valid) &&
        gutterCells.length >= 2 &&
        new Set(gutterCells.map((c) => c.column)).size === 1 &&
        cells.every((cell) =>
          (cell.sourceRects ?? []).every(
            (r) => source.filter((i) => sameRect(r, i.rect)).length === 1
          )
        ) &&
        code.length >= 5 &&
        code
          .filter((i) => i.height >= h * 0.9)
          .every(
            (i) => numbers.filter((n) => Math.abs(i.baseline - n.baseline) < h * 0.1).length === 1
          ) &&
        words.filter((text) => /\b(?:while|if|else|for|return|continue)\b/iu.test(text)).length >=
          3 &&
        words.filter((text) => /[():;=]/u.test(text)).length >= 3 &&
        Math.max(...code.map((i) => i.rect[0])) - Math.min(...code.map((i) => i.rect[0])) > h &&
        code.every((i) => i.rect[0] - numbers[0].rect[2] > numbers[0].height)
      )
        return true
    }
  }
  const populated = table.grid.flat().filter((text) => text.trim())
  if (populated.length < 2) return false
  const text = [...populated, ...(table.unassigned ?? [])].join(' ')
  const numberedAlgorithm =
    table.grid.length >= 6 &&
    table.grid.every((row) => row.length === 2 && /^(?:\d+:\s*)+$/.test(row[0].trim())) &&
    table.grid.filter((row) => /\b(?:for|while|if|continue|end\s+(?:if|for|while))\b/i.test(row[1]))
      .length >= 4 &&
    /\b(?:input|initialize|output)\s*:/i.test(text)
  if (numberedAlgorithm) return true
  const procedureRows = table.grid.filter((row) =>
    /\b(?:while|if|then|for\b[^\n]{0,60}\bdo|plan|sub-?goals?|node\s*\(|re-?enter)\b/iu.test(
      row.join(' ')
    )
  )
  const numberedProcedureRows = table.grid.filter((row) =>
    /^\s*\d+(?:\s+\d+)?\s*$/u.test(row.find((value) => value.trim())?.trim() ?? '')
  )
  if (
    table.grid.length >= 5 &&
    table.grid.every((row) => row.length <= 3) &&
    numberedProcedureRows.length >= 3 &&
    procedureRows.length >= 3 &&
    procedureRows.length >= table.grid.length * 0.5
  )
    return true
  if (!table.unassigned?.length || table.unassigned.length < populated.length) return false
  const declarations = (text.match(/\b(?:def|function|class|import|const|let|var)\b/gi) ?? [])
    .length
  const returns = (text.match(/\b(?:return|yield)\b/gi) ?? []).length
  const declarationKinds = new Set(
    (text.match(/\b(?:def|function|class|import|const|let|var)\b/gi) ?? []).map((word) =>
      word.toLowerCase()
    )
  )
  const syntax = (text.match(/[()[\]{}:=#]/g) ?? []).length
  if (syntax < 6) return false
  if (declarations < 2 || returns < 2 || declarationKinds.size < 1) return false
  const source = items.filter(
    (item) =>
      item.horizontal &&
      item.rect?.[1] >= table.cropRect[1] &&
      item.rect?.[3] <= table.cropRect[3] &&
      item.rect?.[2] > table.cropRect[0] &&
      item.rect?.[0] < table.cropRect[2]
  )
  const sourceDeclarations = source.filter((item) =>
    /^(?:def|function|class|import|const|let|var)\b/i.test(item.text.trim())
  ).length
  const sourceReturns = source.filter((item) =>
    /^(?:return|yield)\b/i.test(item.text.trim())
  ).length
  return sourceDeclarations >= 2 && sourceReturns >= 2
}

// A ruled two-column action plan is visually a listing, even though a detector
// can turn each line into a plausible pair of table cells.  These blocks have
// no table caption, little natural-language prose, and repeated identifier()
// calls (often with an ordinal in the left column).  Keep the proof narrow and
// require both closing horizontal rules; captioned two-column tables bypass it.
function isCaptionlessRuledActionListing(table, caption, items, rules) {
  if (
    caption ||
    !table?.cropRect ||
    !Array.isArray(items) ||
    !Array.isArray(rules) ||
    table.grid.length < 6 ||
    Math.max(...table.grid.map((row) => row.length)) !== 2
  )
    return false
  const values = table.grid
    .flat()
    .map((text) => text.trim())
    .filter(Boolean)
  if (values.length < 12) return false
  const action = /\b[a-z][\w-]*_[a-z][\w-]*\s*\([^)]*\)/iu
  const actionCells = values.filter((text) => action.test(text))
  if (actionCells.length < Math.ceil(values.length * 0.6)) return false
  // The rule is for compact command/listing text, not prose tables whose cells
  // happen to contain one function-like example.
  if (values.filter((text) => text.split(/\s+/u).length > 8).length > 1) return false
  const [left, top, right, bottom] = table.cropRect
  const width = right - left
  if (!(width > 0 && bottom > top)) return false
  const frameTolerance = Math.max(8, (bottom - top) * 0.035)
  const frameRules = rules.filter((rule) => {
    if (!Array.isArray(rule) || rule.length !== 4 || !rule.every(Number.isFinite)) return false
    const [x1, y1, x2, y2] = rule
    return (
      Math.abs(y2 - y1) <= 1.5 &&
      x2 - x1 >= width * 0.7 &&
      ((Math.abs(y1 - top) <= frameTolerance && Math.abs(y2 - top) <= frameTolerance) ||
        (Math.abs(y1 - bottom) <= frameTolerance && Math.abs(y2 - bottom) <= frameTolerance))
    )
  })
  if (frameRules.length < 2) return false
  const source = items.filter(
    (item) =>
      item?.horizontal &&
      Array.isArray(item.rect) &&
      item.rect.length === 4 &&
      item.rect.every(Number.isFinite) &&
      item.rect[1] >= top - 2 &&
      item.rect[3] <= bottom + 2 &&
      item.rect[2] > left &&
      item.rect[0] < right
  )
  // PDF text extraction often exposes a complete two-column listing as one
  // combined line per row rather than one item per inferred cell.  Require
  // row-level coverage, while retaining the crop-boundary and two-rule proof;
  // requiring two source items per row rejects the same listing when its
  // columns are only visually separated.
  return source.length >= Math.max(4, Math.ceil(table.grid.length * 0.75))
}

function isNativeSingleColumnDerivation(table, caption, items, rules) {
  if (
    !Array.isArray(rules) ||
    !caption?.rect ||
    !table.cropRect ||
    table.grid.length < 4 ||
    table.grid.some((row) => row.length !== 1)
  )
    return false
  const [left, top, right, bottom] = table.cropRect
  const source = items.filter((i) => i.horizontal && i.height > 0 && inside(table.cropRect, i))
  const em = Math.max(0, ...source.map((i) => i.height))
  const captionTop = caption.rect[1] * 1.5,
    bodyBottom = Math.max(
      ...(table.cells ?? []).flatMap((c) => (c.sourceRects ?? []).map((r) => r[3]))
    )
  if (
    !em ||
    captionTop - bottom > em * 3 ||
    (captionTop < bottom &&
      (!Number.isFinite(bodyBottom) || bottom - captionTop > em * 2 || captionTop <= bodyBottom))
  )
    return false
  if (
    rules.some(
      (r) => r[1] === r[3] && r[1] >= top && r[1] <= bottom && r[2] - r[0] > (right - left) * 0.5
    )
  )
    return false
  const physicalRows = []
  for (const item of source
    .filter((i) => i.rect[1] >= top && i.height >= em * 0.85)
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])) {
    const row = physicalRows.find((r) => Math.abs(r[0].rect[1] - item.rect[1]) < em * 0.15)
    if (row) row.push(item)
    else physicalRows.push([item])
  }
  const prose = physicalRows
    .map((row) => {
      row.sort((a, b) => a.rect[0] - b.rect[0])
      return {
        text: row.map((i) => i.text).join(' '),
        rect: [row[0].rect[0], row[0].rect[1], row.at(-1).rect[2], row[0].rect[3]],
        continuous: row.every((i, n) => !n || i.rect[0] - row[n - 1].rect[2] < em * 0.9)
      }
    })
    .filter(
      (i) =>
        i.continuous &&
        i.rect[2] - i.rect[0] > (right - left) * 0.5 &&
        (i.text.match(/\p{L}{2,}/gu) ?? []).length >= 5
    )
  if (prose.length < 3 || prose.some((i) => Math.abs(i.rect[0] - prose[0].rect[0]) > em * 0.2))
    return false
  const labels = source.filter(
    (i) => /^\(\d+(?:\.\d+)*\)$/.test(i.text.trim()) && i.rect[0] > left + (right - left) * 0.8
  )
  return (
    labels.length === 1 &&
    table.grid.some((row) => (row[0].match(/=/g) ?? []).length >= 2) &&
    source.some(
      (i) =>
        /=/.test(i.text) &&
        Math.abs(i.rect[3] - labels[0].rect[3]) < em * 0.2 &&
        labels[0].rect[0] - i.rect[2] > em * 4
    )
  )
}

// Risk strips belong to their survival plot. A detector can cross the plot
// boundary into prose, so test the assigned numeric cells rather than padding.
export function isFigureRiskTable(table, figures, page, scale = 1.5) {
  const numeric = table.cells.filter((c) => /\d/.test(c.text) && !/\p{L}/u.test(c.text))
  if (numeric.length < 6 || new Set(numeric.map((c) => c.row)).size < 2) return false
  const contains = (outer, inner) =>
    inner.every((v, n) => (n < 2 ? v >= outer[n] - 2 : v <= outer[n] + 2))
  return figures.some(
    (f) =>
      f.rect &&
      /Kaplan[–-]Meier|cumulative (?:risk|incidence)|survival/i.test(f.caption.lines.join(' ')) &&
      page.lines.some(
        (l) =>
          /^(?:Number|No\.?) (?:at risk|of (?:patients|participants) at risk)/i.test(
            l.text.trim()
          ) && contains(f.rect, [l.x, l.y, l.x + l.width, l.y + l.height])
      ) &&
      numeric.every(
        (c) =>
          c.sourceRects?.length &&
          c.sourceRects.every((r) =>
            contains(
              f.rect,
              r.map((v) => v / scale)
            )
          )
      )
  )
}

// A lettered appendix contents directory can look like a two-column table: each
// row has a one-letter section marker, a dotted leader, and a page number. Keep
// this proof deliberately narrow. A real data table may use letter categories,
// but it should not also have a page-level CONTENTS heading and dotted leaders.
function isLetteredContentsDirectory(table, pageItems) {
  if (table.grid.length < 3 || table.grid.some((row) => row.length !== 2)) return false
  if (
    !table.grid.every((row) => {
      const marker = row[0]?.trim() ?? ''
      const entry = row[1]?.trim() ?? ''
      return (
        /^[A-Z]$/.test(marker) &&
        /(?:\s*\.){3,}\s*\d{1,4}\s*$/.test(entry) &&
        /\p{L}{2}/u.test(entry)
      )
    })
  )
    return false

  const heading = pageItems.some((item) => /^contents$/i.test(item?.text?.trim() ?? ''))
  if (heading) return true

  const horizontal = pageItems
    .filter((item) => item?.horizontal !== false && item?.text?.trim() && Array.isArray(item.rect))
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
  const lines = []
  for (const item of horizontal) {
    const itemHeight = Number.isFinite(item.height) ? item.height : item.rect[3] - item.rect[1]
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate[0].rect[1] - item.rect[1]) <
          Math.min(
            Number.isFinite(candidate[0].height)
              ? candidate[0].height
              : candidate[0].rect[3] - candidate[0].rect[1],
            itemHeight
          ) *
            0.3 ||
        Math.abs(candidate[0].rect[3] - item.rect[3]) <
          Math.min(
            Number.isFinite(candidate[0].height)
              ? candidate[0].height
              : candidate[0].rect[3] - candidate[0].rect[1],
            itemHeight
          ) *
            0.3
    )
    if (line) line.push(item)
    else lines.push([item])
  }
  return lines.some(
    (line) =>
      line
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((item) => item.text.trim())
        .join('')
        .replace(/\s+/g, '')
        .toLowerCase() === 'contents'
  )
}

// A flat supplemental directory still has explicit native navigation roles:
// one local Contents title, consecutive S ordinals and a separate right page
// lane. Neither a section-looking data label nor the grid alone proves this.
function isFlatSupplementalContentsDirectory(table, items, rules) {
  if (!table.cropRect || table.grid.length < 4) return false
  const [left, top, right, bottom] = table.cropRect,
    width = right - left,
    source = items.filter(
      (i) =>
        i.horizontal &&
        i.height > 0 &&
        i.text?.trim() &&
        i.rect?.length === 4 &&
        i.rect.every(Number.isFinite)
    ),
    titles = source.filter(
      (i) =>
        /^contents$/iu.test(i.text.trim()) &&
        i.rect[0] >= left &&
        i.rect[2] <= right &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom
    )
  if (titles.length !== 1) return false
  const title = titles[0],
    bands = []
  for (const i of source
    .filter(
      (i) =>
        i.baseline > title.baseline &&
        i.rect[1] >= top &&
        i.rect[3] <= bottom &&
        i.rect[0] >= left &&
        i.rect[2] <= right
    )
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const band = bands.at(-1)
    if (band && Math.abs(i.baseline - band[0].baseline) < Math.min(i.height, band[0].height) * 0.2)
      band.push(i)
    else bands.push([i])
  }
  const entries = bands.flatMap((g) => {
    const ordered = [...g].sort((a, b) => a.rect[0] - b.rect[0]),
      target = ordered.at(-1),
      labelItems = ordered.slice(0, -1),
      label = labelItems.map((i) => i.text.trim()).join(' '),
      match = /^S(\d+)\s+(\p{L}.*)$/u.exec(label)
    if (
      !match ||
      !/^\d{1,4}$/u.test(target.text.trim()) ||
      target.rect[0] < left + width * 0.8 ||
      target.rect[0] - labelItems.at(-1).rect[2] < target.height * 2
    )
      return []
    return [
      { ordinal: Number(match[1]), page: Number(target.text.trim()), target, first: ordered[0] }
    ]
  })
  if (
    entries.length < 4 ||
    entries.length < table.grid.length * 0.8 ||
    entries[0].first.rect[1] - title.rect[3] > entries[0].first.height * 3 ||
    entries.some(
      (e, n) =>
        e.ordinal !== n + 1 ||
        e.page < 1 ||
        (n && e.page < entries[n - 1].page) ||
        Math.abs(e.target.rect[2] - entries[0].target.rect[2]) > e.target.height * 0.2
    )
  )
    return false
  return !rules.some(
    (r) =>
      r[1] === r[3] &&
      r[2] - r[0] > width * 0.5 &&
      r[1] > entries[0].first.rect[1] &&
      r[1] < entries.at(-1).target.rect[3]
  )
}

// Mixed supplemental navigation has complete native title/page pairs, not
// detector row counts. This five-input classifier does not verify operators.
function isNativeMixedSupplementalContentsDirectory(
  table,
  caption,
  items = [],
  rules = [],
  graphics = []
) {
  const rect = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]
  const intersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
  const key = (o) => `${o?.pageNumber}:${o?.index}`
  const literal = (s) => s.replace(/\s/gu, '')
  if (
    caption ||
    !rect(table?.cropRect) ||
    !Array.isArray(table.grid) ||
    table.grid.length < 4 ||
    table.grid.some(
      (r) => !Array.isArray(r) || r.length !== 2 || r.some((v) => typeof v !== 'string')
    ) ||
    !Array.isArray(table.cells) ||
    !table.cells.length ||
    !Array.isArray(table.unassigned) ||
    table.unassigned.some((v) => typeof v !== 'string') ||
    !Array.isArray(table.clipped) ||
    table.clipped.length ||
    !Array.isArray(items) ||
    !items.length ||
    !Array.isArray(rules) ||
    !Array.isArray(graphics)
  )
    return false
  const source = items.filter((i) => typeof i?.text === 'string' && i.text.trim())
  if (
    !source.length ||
    source.some(
      (i) =>
        !rect(i.rect) ||
        !Number.isFinite(i.height) ||
        i.height <= 0 ||
        !Number.isFinite(i.baseline) ||
        typeof i.horizontal !== 'boolean' ||
        !Number.isSafeInteger(i.sourceItem?.pageNumber) ||
        i.sourceItem.pageNumber < 1 ||
        !Number.isSafeInteger(i.sourceItem.index) ||
        i.sourceItem.index < 0 ||
        i.sourceItem.text !== i.text
    )
  )
    return false
  if (
    new Set(source.map((i) => key(i.sourceItem))).size !== source.length ||
    new Set(source.map((i) => i.sourceItem.pageNumber)).size !== 1
  )
    return false
  const crop = table.cropRect,
    local = source.filter((i) => intersects(i.rect, crop))
  if (
    local.length < 14 ||
    local.some(
      (i) =>
        !i.horizontal ||
        i.rect[0] < crop[0] ||
        i.rect[1] < crop[1] ||
        i.rect[2] > crop[2] ||
        i.rect[3] > crop[3] ||
        Math.abs(i.rect[3] - i.baseline) > 0.02 ||
        Math.abs(i.rect[3] - i.rect[1] - i.height) > 0.02
    )
  )
    return false
  const em = local[0].height
  if (local.some((i) => Math.abs(i.height - em) > 0.02)) return false
  const rows = []
  for (const f of [...local].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = rows.at(-1)
    if (row && Math.abs(row[0].baseline - f.baseline) < 0.02) row.push(f)
    else rows.push([f])
  }
  if (rows.some((g) => g.length !== 2) || rows.length < 7) return false
  const pairs = rows.map((g) => [...g].sort((a, b) => a.rect[0] - b.rect[0]))
  const [first] = pairs,
    last = pairs.at(-1),
    heads = source.filter((i) => /^contents$/iu.test(i.text.trim()))
  if (heads.length !== 1) return false
  const heading = heads[0],
    band = [crop[0], heading.rect[1], crop[2], crop[3]]
  if (
    !heading.horizontal ||
    heading.rect[0] < crop[0] ||
    heading.rect[2] > crop[2] ||
    heading.rect[3] >= crop[1] ||
    heading.sourceItem.index >= first[0].sourceItem.index ||
    heading.height < em * 0.75 ||
    heading.height > em * 1.5 ||
    first[0].rect[1] - heading.rect[3] > em * 3 ||
    first[0].rect[1] - heading.rect[3] < em * 0.5
  )
    return false
  if (source.some((i) => i !== heading && !local.includes(i) && intersects(i.rect, band)))
    return false
  if (
    rules.some(
      (r) =>
        !Array.isArray(r) ||
        r.length !== 4 ||
        !r.every(Number.isFinite) ||
        r[0] > r[2] ||
        r[1] > r[3] ||
        intersects(r, band)
    )
  )
    return false
  if (
    graphics.some(
      (g) => !g || !['path', 'image'].includes(g.kind) || !rect(g.rect) || intersects(g.rect, band)
    )
  )
    return false
  if (
    pairs.some(
      ([label, page], n) =>
        !/^\d{1,4}$/u.test(page.text.trim()) ||
        Number(page.text.trim()) < 1 ||
        page.rect[0] < crop[0] + (crop[2] - crop[0]) * 0.8 ||
        page.rect[0] - label.rect[2] < em * 2 ||
        Math.abs(page.rect[2] - first[1].rect[2]) > em * 0.02 ||
        label.sourceItem.index >= page.sourceItem.index ||
        (n &&
          (Number(page.text) < Number(pairs[n - 1][1].text) ||
            pairs[n - 1][1].sourceItem.index >= label.sourceItem.index ||
            label.rect[1] <= pairs[n - 1][0].rect[3]))
    )
  )
    return false
  let parent = 0,
    child = 0,
    children = 0,
    majorLeft,
    childLeft
  for (const [n, [label]] of pairs.entries()) {
    if (n === 0 && /^references$/iu.test(label.text.trim())) continue
    const major = /^S([1-9]\d*)\.\s+\p{L}\S*(?:\s+\S+)*$/u.exec(label.text.trim()),
      nested = /^([1-9]\d*)\.([1-9]\d*)\.\s+\p{L}\S*(?:\s+\S+)*$/u.exec(label.text.trim())
    if (major) {
      if (Number(major[1]) !== parent + 1 || (parent && child === 0)) return false
      parent++
      child = 0
      majorLeft ??= label.rect[0]
      if (Math.abs(label.rect[0] - majorLeft) > 0.02) return false
    } else if (nested) {
      if (!parent || Number(nested[1]) !== parent || Number(nested[2]) !== child + 1) return false
      child++
      children++
      childLeft ??= label.rect[0]
      if (
        Math.abs(label.rect[0] - childLeft) > 0.02 ||
        childLeft - majorLeft < em * 0.25 ||
        childLeft - majorLeft > em
      )
        return false
    } else return false
  }
  if (parent < 3 || child === 0 || children < 3) return false
  if (/^references$/iu.test(first[0].text.trim()) && Math.abs(first[0].rect[0] - majorLeft) > 0.02)
    return false
  const claimed = new Set()
  for (const cell of table.cells) {
    if (
      !cell ||
      typeof cell.text !== 'string' ||
      !Array.isArray(cell.sourceItems) ||
      !Array.isArray(cell.sourceRects) ||
      cell.sourceItems.length !== cell.sourceRects.length ||
      (!cell.sourceItems.length && cell.text.trim())
    )
      return false
    const owned = []
    for (const [n, origin] of cell.sourceItems.entries()) {
      const matches = local.filter(
        (f) =>
          navigationSourceExact(f.sourceItem, origin) &&
          navigationSourceExact(f.rect, cell.sourceRects[n])
      )
      if (matches.length !== 1 || claimed.has(key(origin))) return false
      claimed.add(key(origin))
      owned.push(matches[0])
    }
    if (
      literal(cell.text) !==
      literal(
        [...owned]
          .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
          .map((f) => f.text)
          .join('')
      )
    )
      return false
    if (cell.sourceTokens !== undefined) {
      if (!Array.isArray(cell.sourceTokens) || cell.sourceTokens.length !== owned.length)
        return false
      const matched = new Set()
      for (const t of cell.sourceTokens) {
        const matches = owned.filter(
          (f) =>
            t?.text === f.text &&
            navigationSourceExact(t.rect, f.rect) &&
            t.baseline === f.baseline &&
            t.height === f.height &&
            (!t.sourceItem || navigationSourceExact(t.sourceItem, f.sourceItem))
        )
        if (matches.length !== 1 || matched.has(matches[0])) return false
        matched.add(matches[0])
      }
    }
  }
  const residual = local.filter((f) => !claimed.has(key(f.sourceItem)))
  if (
    !navigationSourceExact(residual.map((f) => f.text).sort(), [...table.unassigned].sort()) ||
    new Set(residual.map((f) => f.text)).size !== residual.length
  )
    return false
  return claimed.size + residual.length === local.length && last[1].rect[3] <= crop[3]
}

// Hierarchical contents pages are often emitted as a two-column table: the
// section label is followed by a dotted leader and a printed page number. A
// page-level Contents heading plus repeated navigation-shaped rows is a
// stronger non-table proof than detector confidence. Keep the test narrow so
// dotted values in a real data table are not discarded.
function isHierarchicalContentsDirectory(table, pageItems, sourceRules) {
  if (!table?.grid || table.grid.length < 5 || !Array.isArray(pageItems)) return false
  const rules = Array.isArray(sourceRules) ? sourceRules : []
  const horizontal = pageItems
    .filter((item) => item?.horizontal !== false && item?.text?.trim() && Array.isArray(item.rect))
    .sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
  const lines = []
  for (const item of horizontal) {
    const height = Number.isFinite(item.height) ? item.height : item.rect[3] - item.rect[1]
    const line = lines.find(
      (candidate) =>
        Math.abs(candidate[0].rect[1] - item.rect[1]) < Math.min(candidate[0].height, height) * 0.3
    )
    if (line) line.push({ ...item, height })
    else lines.push([{ ...item, height }])
  }
  const joinedLines = lines.map((line) =>
    line
      .sort((a, b) => a.rect[0] - b.rect[0])
      .map((item) => item.text.trim())
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
  )
  if (!joinedLines.some((text) => /^(?:table\s+of\s+)?contents$/i.test(text))) return false

  // Hierarchical navigation also occurs without leaders, between page-wide
  // outer separators. Prove native section/title/page lanes, a consecutive
  // major sequence and nested ordinals before allowing those outer strokes.
  if (table.cropRect) {
    const [left, top, right, bottom] = table.cropRect,
      width = right - left
    const titles = lines.filter((line) =>
      /^(?:table\s+of\s+)?contents$/i.test(line.map((i) => i.text.trim()).join(''))
    )
    const title = titles.length === 1 ? titles[0] : undefined
    const entries = lines.flatMap((line) => {
      const ordered = [...line].sort((a, b) => a.rect[0] - b.rect[0]),
        first = ordered[0],
        target = ordered.at(-1),
        label = ordered
          .slice(0, -1)
          .map((i) => i.text.trim())
          .join(' '),
        match = /^(\d+(?:\.\d+)*|[A-Z])\s+(.+)$/.exec(label)
      if (
        !match ||
        !target ||
        !title ||
        !/\p{L}{2}/u.test(match[2]) ||
        !/^\d{1,4}$/.test(target.text.trim()) ||
        first.rect[1] <= title[0].rect[1] ||
        first.rect[0] < left - first.height * 0.2 ||
        first.rect[1] < top ||
        target.rect[2] > right + target.height * 0.2 ||
        target.rect[3] > bottom ||
        target.rect[0] < left + width * 0.8 ||
        target.rect[0] - ordered.at(-2).rect[2] < target.height * 2
      )
        return []
      return [{ ordinal: match[1], page: Number(target.text.trim()), first, target }]
    })
    const majors = entries.filter((e) => /^\d+$/.test(e.ordinal)),
      nested = entries.filter((e) => /^\d+\.\d+$/.test(e.ordinal))
    const navigable =
      majors.length >= 4 &&
      nested.length >= 3 &&
      entries.length >= 9 &&
      entries.length >= table.grid.length * 0.8 &&
      title.every(
        (i) => i.rect[0] >= left - i.height * 0.2 && i.rect[2] <= right + i.height * 0.2
      ) &&
      entries[0].first.rect[1] - Math.max(...title.map((i) => i.rect[3])) <=
        entries[0].first.height * 4 &&
      Math.min(...title.map((i) => i.rect[1])) >= top - entries[0].first.height * 2 &&
      majors.every((e, n) => Number(e.ordinal) === n + 1) &&
      nested.every((e) =>
        majors.some(
          (m) => m.ordinal === e.ordinal.split('.')[0] && m.first.rect[1] < e.first.rect[1]
        )
      ) &&
      entries.every(
        (e, n) =>
          e.page > 0 &&
          (!n || e.page >= entries[n - 1].page) &&
          Math.abs(e.target.rect[2] - entries[0].target.rect[2]) <= e.target.height * 0.2
      )
    const interiorRule = rules.some(
      (r) =>
        Math.abs(r[3] - r[1]) < 1 &&
        r[2] - r[0] > width * 0.5 &&
        entries.length &&
        r[1] > entries[0].first.rect[1] &&
        r[1] < entries.at(-1).target.rect[3]
    )
    if (navigable && !interiorRule) return true
  }
  if (
    table.cropRect &&
    rules.some(
      (r) =>
        Math.abs(r[3] - r[1]) < 1 && r[2] - r[0] > (table.cropRect[2] - table.cropRect[0]) * 0.5
    )
  )
    return false

  const rows = table.grid.map((row) => row.map((text) => String(text ?? '').trim()).filter(Boolean))
  const leader = /(?:\.\s*){3,}|…{2,}/
  const pageNumber = /(?:^|\s)\d{1,4}$/
  const navigable = rows.filter((row) => {
    const text = row.join(' ').replace(/\s+/g, ' ').trim()
    return leader.test(text) && pageNumber.test(text)
  })
  if (navigable.length < 5 || navigable.length / rows.length < 0.7) return false

  const hierarchical = navigable.filter((row) => {
    const text = row.join(' ').trim()
    return /^(?:[A-Z]|\d+(?:\.\d+)*)(?:[.)]|\s)/.test(text)
  })
  // Require either a nested numeric section or several lettered/numbered
  // section markers. This prevents a captioned data table containing dotted
  // decimal values from being treated as a directory.
  const nested = navigable.some((row) => /^\d+\.\d+(?:\.|\s)/.test(row.join(' ').trim()))
  return nested || hierarchical.length >= 3
}

// Reject only a complete native list paragraph whose model cuts cross prose,
// one display and its whole continuation. A nearby caption must independently
// belong to a closed comparison; native table proofs retain priority.
function isNativeSingleDisplayParagraph(table, caption, items, rules, graphics = []) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const same = (a, b, tolerance) => Math.abs(a - b) <= tolerance
  const words = (text) => (text.match(/\p{L}{2,}/gu) ?? []).length
  if (!table || typeof table !== 'object' || !Array.isArray(table.cells)) return false
  if (
    table.cells.some(
      (cell) =>
        !cell ||
        typeof cell !== 'object' ||
        Array.isArray(cell) ||
        !Array.isArray(cell.rect) ||
        cell.rect.length !== 4 ||
        !cell.rect.every(Number.isFinite)
    )
  )
    return false
  if (
    !Array.isArray(items) ||
    items.some((i) => !i || typeof i !== 'object' || typeof i.text !== 'string')
  )
    return false
  if (!Array.isArray(graphics)) return false
  if (
    graphics.some(
      (graphic) =>
        !graphic ||
        typeof graphic !== 'object' ||
        Array.isArray(graphic) ||
        !['path', 'image'].includes(graphic.kind) ||
        !valid(graphic.rect)
    )
  )
    return false
  const explicitScale = table.sourceViewport?.scale
  const scale = explicitScale === undefined ? 1.5 : explicitScale
  if (!Number.isFinite(scale) || scale <= 0) return false
  if (
    caption &&
    (typeof caption !== 'object' ||
      !Array.isArray(caption.lines) ||
      caption.lines.length < 3 ||
      caption.lines.some((line) => typeof line !== 'string' || !line.trim()))
  )
    return false
  const crop = table.cropRect
  if (!valid(crop) || !Array.isArray(items) || !Array.isArray(rules)) return false
  const printed = items.filter((i) => i.text?.trim())
  if (
    printed.some(
      (i) =>
        !valid(i.rect) ||
        !i.horizontal ||
        !Number.isFinite(i.height) ||
        !Number.isFinite(i.baseline) ||
        Math.abs(i.height - (i.rect[3] - i.rect[1])) > 1e-7 ||
        Math.abs(i.baseline - i.rect[3]) > 1e-7
    )
  )
    return false
  if (rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)))
    return false
  if (
    printed.some((i, n) =>
      printed.slice(n + 1).some((j) => i.rect.every((v, k) => same(v, j.rect[k], 1e-7)))
    )
  )
    return false
  const openings = printed.filter(
    (i) => i.text === '•' && same(i.rect[1], crop[1], i.height * 0.02) && i.rect[2] < crop[0]
  )
  if (openings.length !== 1) return false
  const bullet = openings[0],
    em = bullet.height
  const next = printed
    .filter(
      (i) =>
        i.text === '•' &&
        i.rect[1] > bullet.rect[3] &&
        same(i.rect[0], bullet.rect[0], em * 0.02) &&
        same(i.height, em, 1e-7)
    )
    .sort((a, b) => a.rect[1] - b.rect[1])[0]
  if (!next) return false
  const programStart = printed.indexOf(bullet),
    programEnd = printed.indexOf(next)
  if (programStart >= programEnd) return false
  const program = printed.slice(programStart, programEnd)
  if (program.some((i) => i.rect[1] < bullet.rect[1] - em * 0.1 || i.rect[3] >= next.rect[1]))
    return false
  const whereCandidates = program.filter((i) => i.text === 'where' && same(i.height, em, 1e-7))
  if (whereCandidates.length !== 1) return false
  const where = whereCandidates[0],
    whereIndex = program.indexOf(where)
  const title = program[1]
  if (
    !title ||
    !/:$/.test(title.text) ||
    words(title.text) < 3 ||
    !same(title.baseline, bullet.baseline, 1e-7) ||
    title.rect[0] - bullet.rect[2] < 0 ||
    title.rect[0] - bullet.rect[2] > em
  )
    return false
  const intro = [bullet],
    introRows = [[bullet]],
    baselineTolerance = em * 0.01
  for (const item of program.slice(1, whereIndex)) {
    const row = introRows.at(-1),
      previousBaseline = row[0].baseline
    if (
      !same(item.height, em, 1e-7) ||
      item.baseline - previousBaseline > em * 1.5 ||
      item.baseline < previousBaseline - baselineTolerance
    )
      break
    if (same(item.baseline, previousBaseline, baselineTolerance)) row.push(item)
    else introRows.push([item])
    intro.push(item)
  }
  if (
    introRows.length !== 3 ||
    introRows.some((row) => words(row.map((i) => i.text).join(' ')) < 7)
  )
    return false
  const bodyLeft = introRows[1][0].rect[0],
    bodyRight = introRows[1].at(-1).rect[2]
  if (
    printed.some(
      (i) =>
        !program.includes(i) &&
        i.rect[0] < bodyRight &&
        i.rect[2] > bullet.rect[0] &&
        i.rect[1] < next.rect[1] &&
        i.rect[3] > bullet.rect[1]
    )
  )
    return false
  if (
    !same(title.rect[0], bodyLeft, em * 0.05) ||
    introRows.slice(1).some((row) => !same(row[0].rect[0], bodyLeft, em * 0.02)) ||
    introRows.some((row) => !same(row.at(-1).rect[2], bodyRight, em * 0.05))
  )
    return false
  if (
    introRows.some((row) =>
      row
        .slice(1)
        .some(
          (i, n) => i.rect[0] < row[n].rect[2] - em * 0.01 || i.rect[0] - row[n].rect[2] > em * 0.9
        )
    )
  )
    return false
  if (!same(where.rect[0], bodyLeft, em * 0.05)) return false
  const cuts = [
    ...new Set(
      (table.cells ?? [])
        .filter((c) => c.colSpan === 1 && valid(c.rect))
        .map((c) => c.rect[2])
        .filter((x) => x > crop[0] + em && x < crop[2] - em)
    )
  ]
  if (
    cuts.length < 2 ||
    crop[0] <= bodyLeft + em ||
    crop[2] >= bodyRight - em ||
    introRows.some(
      (row) => !row.some((i) => cuts.some((x) => i.rect[0] < x - em && i.rect[2] > x + em))
    )
  )
    return false
  const display = program.slice(intro.length, whereIndex),
    relations = display.filter((i) => /^[≤≥]$/.test(i.text))
  if (
    relations.length !== 3 ||
    !relations.every((i) => same(i.baseline, relations[0].baseline, 1e-7))
  )
    return false
  const relationBaseline = relations[0].baseline,
    introBottom = introRows.at(-1)[0].baseline
  if (
    relationBaseline - introBottom < em * 1.5 ||
    relationBaseline - introBottom > em * 3 ||
    display.length < 20 ||
    display.some(
      (i) =>
        words(i.text) >= 3 ||
        !(same(i.height, em, 1e-7) || same(i.height, em * 0.7, em * 0.001)) ||
        i.rect[0] <= bodyLeft ||
        i.rect[2] >= bodyRight ||
        i.rect[1] < introBottom - em * 0.1 ||
        i.rect[3] > relationBaseline + em * 0.5
    )
  )
    return false
  const displayBottom = display.reduce((bottom, i) => Math.max(bottom, i.rect[3]), -Infinity)
  if (where.rect[1] - displayBottom < em * 0.5 || where.rect[1] - displayBottom > em * 1.2)
    return false
  const localRules = rules.filter(
    (r) =>
      Math.min(r[1], r[3]) >= bullet.rect[1] &&
      Math.max(r[1], r[3]) < next.rect[1] &&
      Math.max(r[0], r[2]) > bodyLeft &&
      Math.min(r[0], r[2]) < bodyRight
  )
  if (
    localRules.some(
      (r) =>
        r[1] !== r[3] ||
        r[0] <= bodyLeft ||
        r[2] >= bodyRight ||
        r[2] - r[0] >= (bodyRight - bodyLeft) * 0.4
    )
  )
    return false
  const fractionRules = localRules.filter((r) => r[1] > introBottom && r[1] < displayBottom)
  if (fractionRules.length !== 4) return false
  const pairs = fractionRules.filter((r) =>
    fractionRules.some(
      (s) =>
        s !== r &&
        s[1] > r[1] &&
        s[1] - r[1] > em * 0.8 &&
        s[1] - r[1] < em * 1.3 &&
        same(r[0], s[0], em * 0.2) &&
        same(r[2], s[2], em * 0.2)
    )
  )
  if (
    pairs.length !== 2 ||
    pairs.some(
      (r) =>
        !display.some(
          (i) =>
            i.rect[0] >= r[0] && i.rect[2] <= r[2] + em * 0.1 && i.height < em && i.rect[1] >= r[1]
        )
    )
  )
    return false
  const continuation = program.slice(whereIndex),
    narrative = continuation.filter((i) => words(i.text) >= 3)
  const continuationRows = []
  for (const i of narrative) {
    const row = continuationRows.find((r) => same(r[0].baseline, i.baseline, 1e-7))
    if (row) row.push(i)
    else continuationRows.push([i])
  }
  continuationRows.sort((a, b) => a[0].baseline - b[0].baseline)
  if (
    continuationRows.length < 3 ||
    !same(continuationRows[0][0].baseline, where.baseline, 1e-7) ||
    continuationRows.some(
      (row, n) =>
        words(row.map((i) => i.text).join(' ')) < 4 ||
        !same(row[0].height, em, 1e-7) ||
        (n &&
          (row[0].baseline - continuationRows[n - 1][0].baseline < em * 0.8 ||
            row[0].baseline - continuationRows[n - 1][0].baseline > em * 1.5))
    )
  )
    return false
  const rowOwners = continuation.map((i) => {
    const sorted = continuationRows
      .map((row, index) => ({ index, distance: Math.abs(i.baseline - row[0].baseline) }))
      .sort((a, b) => a.distance - b.distance)
    return sorted[0].distance < em && sorted[1].distance - sorted[0].distance > em * 0.01
      ? sorted[0].index
      : undefined
  })
  if (
    rowOwners.some((owner) => owner === undefined) ||
    continuation.some(
      (i) =>
        i.rect[0] < bodyLeft - em * 0.05 ||
        i.rect[2] > bodyRight + em * 0.05 ||
        !(same(i.height, em, 1e-7) || same(i.height, em * 0.7, em * 0.001))
    )
  )
    return false
  for (const n of continuationRows.keys()) {
    const whole = continuation
      .filter((_, i) => rowOwners[i] === n)
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      !same(whole[0].rect[0], bodyLeft, em * 0.05) ||
      whole.some((i, k) => k && i.rect[0] - whole[k - 1].rect[2] > em * 0.9)
    )
      return false
  }
  if (
    graphics.some(
      (g) =>
        g.kind !== 'path' &&
        valid(g.rect) &&
        g.rect[2] > bodyLeft &&
        g.rect[0] < bodyRight &&
        g.rect[3] > bullet.rect[1] &&
        g.rect[1] < next.rect[1]
    )
  )
    return false
  if (caption) {
    if (
      !valid(caption.rect) ||
      caption.lines?.length < 3 ||
      !/^Table\s+\d+\s*:/i.test(caption.lines[0])
    )
      return false
    const nativeCaption = caption.rect.map((v) => v * scale)
    const captionStart = printed.filter(
      (i) =>
        /^Table\s+\d+\s*:/i.test(i.text) &&
        same(i.rect[0], nativeCaption[0], em * 0.02) &&
        same(i.rect[1], nativeCaption[1], em * 0.02)
    )
    if (captionStart.length !== 1 || nativeCaption[3] >= bullet.rect[1] - em) return false
    const completeCaption = printed.filter(
      (i) =>
        i.rect[2] > nativeCaption[0] &&
        i.rect[0] < nativeCaption[2] &&
        i.rect[3] > nativeCaption[1] &&
        i.rect[1] < nativeCaption[3]
    )
    if (
      completeCaption.some(
        (i) =>
          i.rect[0] < nativeCaption[0] - 1e-7 ||
          i.rect[2] > nativeCaption[2] + 1e-7 ||
          i.rect[1] < nativeCaption[1] - 1e-7 ||
          i.rect[3] > nativeCaption[3] + 1e-7
      )
    )
      return false
    const closing = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[2] - r[0] > (bodyRight - bodyLeft) * 0.8 &&
          r[1] <= captionStart[0].baseline &&
          captionStart[0].baseline - r[1] < em
      )
      .sort((a, b) => b[1] - a[1])[0]
    if (!closing) return false
    const frameRules = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          r[1] <= closing[1] &&
          same(r[0], closing[0], 1e-7) &&
          same(r[2], closing[2], 1e-7)
      )
      .sort((a, b) => a[1] - b[1])
    if (frameRules.length !== 3) return false
    const [opening, divider] = frameRules
    const header = printed.filter(
      (i) =>
        i.rect[1] > opening[1] &&
        i.rect[3] < divider[1] &&
        i.rect[0] >= opening[0] &&
        i.rect[2] <= opening[2]
    )
    const heads = header.filter((i) => same(i.baseline, header[0]?.baseline, 1e-7)),
      lower = header.filter((i) => !heads.includes(i))
    if (
      heads.length !== 4 ||
      lower.length !== 4 ||
      lower.some((i) => !same(i.baseline, lower[0].baseline, 1e-7)) ||
      heads.some(
        (i, n) =>
          !/\p{L}{2}/u.test(i.text) ||
          !/\p{L}{2}/u.test(lower[n].text) ||
          Math.max(i.rect[0], lower[n].rect[0]) >= Math.min(i.rect[2], lower[n].rect[2]) ||
          (n &&
            Math.min(i.rect[0], lower[n].rect[0]) <=
              Math.max(heads[n - 1].rect[2], lower[n - 1].rect[2]) + em)
      )
    )
      return false
    const recordLabels = printed.filter(
      (i) =>
        i.rect[1] >= divider[1] &&
        i.rect[3] < closing[1] &&
        i.rect[0] > opening[0] &&
        i.rect[2] < heads[0].rect[0] &&
        words(i.text) >= 2
    )
    if (
      recordLabels.length < 3 ||
      recordLabels.some(
        (i, n) =>
          !same(i.rect[0], recordLabels[0].rect[0], em * 0.02) ||
          (n && i.baseline - recordLabels[n - 1].baseline < em)
      )
    )
      return false
  }
  return true
}

// Foreign page citations cannot own a complete independently ruled grid. Keep
// all other non-table and crop-boundary guards; localize only reference context
// after every native font and literal cell has one complete source owner.
function nativeClosedTableReferenceItems(table, items, rules) {
  if (
    !Array.isArray(rules) ||
    table.unassigned?.length ||
    table.grid.length < 3 ||
    table.grid[0].length < 3 ||
    table.grid.some(
      (row) => row.length !== table.grid[0].length || row.some((text) => !text.trim())
    ) ||
    table.cells?.length !== table.grid.length * table.grid[0].length
  )
    return
  // A detector can stop before a rule endpoint while retaining every printed
  // field. The native frame still must uniquely enclose all and only the
  // assigned fonts; use it solely to localize the bibliography evidence below.
  const proof = proveNativeAssignedClosedTableFrame(table, items, rules, true)
  if (!proof) return
  if (
    proof.sourceTokens.some((item) => {
      const origin = item.sourceItem
      return (
        !origin ||
        origin.text !== item.text ||
        !Number.isSafeInteger(origin.pageNumber) ||
        origin.pageNumber < 1 ||
        !Number.isSafeInteger(origin.index) ||
        origin.index < 0 ||
        item.sourceSegment ||
        item.sourceToken ||
        items.some(
          (other) =>
            other !== item &&
            [
              other.sourceItem,
              other.sourceSegment,
              other.sourceToken,
              other.sourceToken?.sourceItem,
              other.sourceToken?.sourceSegment
            ].some(
              (reference) =>
                reference?.pageNumber === origin.pageNumber && reference?.index === origin.index
            )
        )
      )
    })
  )
    return
  const same = (a, b) =>
    a?.length === 4 && b?.length === 4 && a.every((v, n) => Math.abs(v - b[n]) < 0.02)
  const literal = (text) => text.replace(/\s/gu, '')
  const owners = new Set()
  const rowFonts = table.grid.map(() => [])
  for (const cell of table.cells) {
    if (
      !Number.isInteger(cell.row) ||
      !Number.isInteger(cell.column) ||
      cell.row < 0 ||
      cell.row >= table.grid.length ||
      cell.column < 0 ||
      cell.column >= table.grid[0].length ||
      cell.rowSpan !== 1 ||
      cell.colSpan !== 1 ||
      owners.has(`${cell.row}:${cell.column}`) ||
      !cell.sourceRects?.length ||
      cell.rect?.length !== 4 ||
      !cell.rect.every(Number.isFinite)
    )
      return
    owners.add(`${cell.row}:${cell.column}`)
    const fonts = cell.sourceRects.map((rect) =>
      proof.sourceTokens.find((item) => same(item.rect, rect))
    )
    if (
      fonts.some(
        (font) =>
          !font?.sourceItem ||
          literal(font.sourceItem.text) !== literal(font.text) ||
          font.rect[0] < cell.rect[0] - 0.02 ||
          font.rect[2] > cell.rect[2] + 0.02 ||
          !Number.isFinite(font.baseline)
      ) ||
      literal(fonts.map((font) => font.text).join('')) !== literal(cell.text) ||
      literal(cell.text) !== literal(table.grid[cell.row][cell.column])
    )
      return
    rowFonts[cell.row].push(...fonts)
  }
  // Model row boxes can shave off ascenders or a wrapped font. The complete
  // native row envelopes must still be independent, ordered and non-overlapping.
  const nativeRows = rowFonts.map((fonts) => [
    Math.min(...fonts.map((font) => font.rect[1])),
    Math.max(...fonts.map((font) => font.rect[3]))
  ])
  if (nativeRows.some((row, index) => index && row[0] <= nativeRows[index - 1][1] + 0.02)) return
  // A padded detector may touch a complete label or note outside the frame. It
  // cannot exclude a partial native font or text crossing the source frame.
  if (
    (table.clipped ?? []).some(
      (item) =>
        item.rect?.length !== 4 ||
        !item.rect.every(Number.isFinite) ||
        !(item.rect[3] < proof.cropRect[1] - 0.02 || item.rect[1] > proof.cropRect[3] + 0.02) ||
        !items.some(
          (font) => font.horizontal && same(font.rect, item.rect) && font.text === item.text
        )
    )
  )
    return
  return proof.sourceTokens
}

// Detection confidence alone also accepts affiliations and prose. Like the upstream
// content-supported row/column refinement, require evidence from source text.
// ponytail: uncaptioned single-column or single-row tables remain ambiguous with lists;
// retain them only with a reliable table caption until richer layout evidence is available.
// Local PDF links and the independently resolved outline can prove navigation
// without recognizing the heading's wording. Every native row and every claimed
// table source must close over that directory; an unrelated data row defeats it.
function isLinkedNativeDirectory(table, caption, items, rules, graphics, navigation) {
  const valid = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
    compact = (s) => s.replace(/\s/gu, '')
  if (
    caption ||
    !Array.isArray(rules) ||
    rules.length ||
    !Array.isArray(graphics) ||
    graphics.length ||
    !Number.isSafeInteger(navigation?.pageNumber) ||
    !Number.isSafeInteger(navigation.documentPages) ||
    navigation.pageNumber < 1 ||
    navigation.pageNumber > navigation.documentPages ||
    !Array.isArray(navigation.links) ||
    navigation.links.length < 3 ||
    !Array.isArray(navigation.outline) ||
    !Array.isArray(table.cells) ||
    !valid(table.cropRect)
  )
    return false
  const source = items.filter((i) => i.text?.trim()),
    byIndex = new Map()
  for (const item of source) {
    const s = item.sourceItem
    if (
      !item.horizontal ||
      !valid(item.rect) ||
      !Number.isFinite(item.height) ||
      item.height <= 0 ||
      !Number.isFinite(item.baseline) ||
      s?.pageNumber !== navigation.pageNumber ||
      !Number.isSafeInteger(s.index) ||
      s.index < 0 ||
      s.text !== item.text ||
      item.sourceSegment ||
      item.sourceToken ||
      item.sourceItems ||
      byIndex.has(s.index)
    )
      return false
    byIndex.set(s.index, item)
  }
  const rows = []
  for (const item of [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = rows.at(-1)
    if (row && Math.abs(row[0].baseline - item.baseline) < 0.02) row.push(item)
    else rows.push([item])
  }
  const linked = [],
    linkedItems = new Set()
  for (const link of navigation.links) {
    if (
      !valid(link.rect) ||
      link.destination == null ||
      !Number.isSafeInteger(link.targetPage) ||
      link.targetPage < 1 ||
      link.targetPage > navigation.documentPages
    )
      return false
    const matches = rows.filter(
      (row) => row[0].baseline >= link.rect[1] && row[0].baseline <= link.rect[3]
    )
    if (matches.length !== 1 || linked.includes(matches[0])) return false
    const row = matches[0],
      last = row.at(-1),
      labels = row.slice(0, -1),
      ordinal = row[0],
      label = /^([A-Z])\s+(.+)$/u.exec(labels.map((i) => i.text).join(' '))
    if (
      row.length < 2 ||
      !label ||
      !/^[1-9]\d*$/u.test(last.text) ||
      Number(last.text) !== link.targetPage ||
      labels.some((i) => i.rect[0] < link.rect[0] || i.rect[2] > link.rect[2]) ||
      last.rect[0] <= link.rect[2] ||
      row.some((i) => Math.abs(i.height - ordinal.height) > 0.02) ||
      row.some((i, n) => n && i.rect[0] < row[n - 1].rect[2])
    )
      return false
    const title = compact(label[2]),
      outline = navigation.outline.filter(
        (o) =>
          typeof o.title === 'string' &&
          compact(o.title) === title &&
          o.page === link.targetPage &&
          navigationSourceExact(o.destination, link.destination)
      )
    if (outline.length !== 1) return false
    linked.push(row)
    for (const i of row) linkedItems.add(i)
  }
  linked.sort((a, b) => a[0].baseline - b[0].baseline)
  if (
    linked.some(
      (row, i) =>
        (i > 0 && row[0].text.charCodeAt(0) !== linked[i - 1][0].text.charCodeAt(0) + 1) ||
        Math.abs(row[0].rect[0] - linked[0][0].rect[0]) > 0.02 ||
        Math.abs(row.at(-1).rect[2] - linked[0].at(-1).rect[2]) > 0.02
    )
  )
    return false
  const remainder = source.filter((i) => !linkedItems.has(i))
  if (
    remainder.length !== 2 ||
    remainder[0].rect[3] >= linked[0][0].rect[1] ||
    remainder[0].height < linked[0][0].height * 1.1 ||
    !/^\p{L}[\p{L}\s]+$/u.test(remainder[0].text) ||
    remainder[1].text !== String(navigation.pageNumber) ||
    remainder[1].rect[1] <= linked.at(-1)[0].rect[3]
  )
    return false
  const claimed = new Set()
  for (const cell of table.cells) {
    if (
      cell.sourceSegments?.length ||
      (cell.sourceItems?.length ?? 0) !== (cell.sourceRects?.length ?? 0)
    )
      return false
    const native = []
    for (const [n, claim] of (cell.sourceItems ?? []).entries()) {
      const item = byIndex.get(claim.index)
      if (
        !item ||
        !linkedItems.has(item) ||
        claimed.has(item) ||
        !navigationSourceExact(claim, item.sourceItem) ||
        !navigationSourceExact(cell.sourceRects[n], item.rect)
      )
        return false
      native.push(item)
      claimed.add(item)
    }
    if (
      typeof cell.text !== 'string' ||
      compact(cell.text) !== compact(native.map((i) => i.text).join(''))
    )
      return false
  }
  return (
    claimed.size >= 6 &&
    linked.filter((row) => row.some((i) => claimed.has(i))).length >= 3 &&
    (table.unassigned ?? []).every((text) => source.some((i) => i.text === text))
  )
}

export function hasTableEvidence(
  table,
  caption,
  pageItems = [],
  sourceRules,
  sourceGraphics = [],
  nativeNavigation
) {
  const populatedRows = table.grid.map((row) => row.filter((text) => text.trim()).length)
  if (!populatedRows.some((count) => count > 0)) return false
  if (
    isLinkedNativeDirectory(
      table,
      caption,
      pageItems,
      sourceRules,
      sourceGraphics,
      nativeNavigation
    )
  )
    return false
  // A detector can attach a nearby prose continuation to a caption-like
  // cross-reference (for example, "Table 7 and Figure 11").  A one-row crop
  // with at most two populated cells and several unresolved narrative lines is
  // not a table; retain the source text in the surrounding body instead.
  const captionText = [caption?.text, ...(caption?.lines ?? [])].filter(Boolean).join(' ')
  const unresolved = (table.unassigned ?? []).map((item) =>
    typeof item === 'string' ? item : String(item?.text ?? '')
  )
  if (
    table.grid.length <= 2 &&
    populatedRows.reduce((sum, count) => sum + count, 0) <= 2 &&
    unresolved.length >= 3 &&
    /\b(?:table|tab\.)\s*\d+\b[^.]{0,80}\b(?:and|with)\b\s*(?:figure|fig\.)\s*\d+\b/iu.test(
      captionText
    ) &&
    unresolved.filter((text) => /\p{L}{3,}/u.test(text) && /\s/u.test(text.trim())).length >= 3
  )
    return false
  if (isNativeTitledProcedure(table, caption, pageItems, sourceRules)) return false
  if (isNativeProseFootnoteOverlap(table, caption, pageItems, sourceRules ?? [])) return false
  const nativeCaption = caption?.rect
    ? { ...caption, rect: caption.rect.map((v) => v * (table.sourceViewport?.scale ?? 1.5)) }
    : undefined
  const literalFrame =
    nativeCaption &&
    sourceRules &&
    proveCaptionedNativeLiteralFrame(table, nativeCaption, pageItems, sourceRules)
  if (literalFrame && !isNativeClosedFrameOwnedByTable(table, literalFrame)) return false
  const nativeLeaves =
    nativeCaption &&
    sourceRules &&
    proveNativeClosedLeafHeader(table, pageItems, [nativeCaption], sourceRules)
  if (
    nativeLeaves &&
    table.grid.length === nativeLeaves.bodyRecords.length + 1 &&
    table.grid.every((row) => row.length === nativeLeaves.columns.length) &&
    nativeLeaves.headerCells.every(
      (c) => table.grid[0][c.column].replace(/\s/gu, '') === c.text.replace(/\s/gu, '')
    ) &&
    [...nativeLeaves.ownedTokens, ...nativeLeaves.originalBody].every((i) =>
      (table.cells ?? []).some((c) =>
        (c.sourceRects ?? []).some((r) => r.every((v, n) => Math.abs(v - i.rect[n]) < 0.02))
      )
    ) &&
    (table.cells ?? []).every(
      (c) =>
        c.rect?.length === 4 &&
        c.rect.every(Number.isFinite) &&
        c.rect[2] > c.rect[0] &&
        c.rect[3] > c.rect[1]
    )
  )
    return true
  const nativeDefinition =
    caption?.rect &&
    sourceRules &&
    proveCaptionedNativeDefinitionFrame(
      table,
      { ...caption, rect: caption.rect.map((v) => v * (table.sourceViewport?.scale ?? 1.5)) },
      pageItems,
      sourceRules
    )
  if (
    nativeDefinition?.kind === 'native-parameter-records' &&
    table.grid.length === nativeDefinition.bodyRecords.length &&
    table.grid.every((row) => row.length === 2 && row.every((text) => text.trim())) &&
    !table.unassigned?.length &&
    !table.clipped?.length &&
    nativeDefinition.sourceTokens.every((i) =>
      (table.cells ?? []).some((c) =>
        (c.sourceRects ?? []).some((r) => r.every((v, n) => Math.abs(v - i.rect[n]) < 0.02))
      )
    )
  )
    return true
  if (isNativeSingleDisplayParagraph(table, caption, pageItems, sourceRules, sourceGraphics))
    return false
  if (!caption && isHierarchicalContentsDirectory(table, pageItems, sourceRules)) return false
  if (!caption && isLetteredContentsDirectory(table, pageItems)) return false
  if (!caption && isFlatSupplementalContentsDirectory(table, pageItems, sourceRules ?? []))
    return false
  if (
    isNativeMixedSupplementalContentsDirectory(
      table,
      caption,
      pageItems,
      sourceRules ?? [],
      sourceGraphics
    )
  )
    return false
  // A supplementary-materials directory names several external tables. Its
  // neighboring entry is not a caption for the directory or nearby references.
  if (
    /^Supplementary Table/i.test(caption?.lines?.[0] ?? '') &&
    [...table.grid.map((row) => row.join(' ')), ...(table.unassigned ?? [])].filter((text) =>
      /^Supplementary Table S?\d+\s*[|:]/i.test(text)
    ).length >= 2
  )
    return false
  // A contents list has repeated numbered captions followed by page numbers.
  // A caption association to its first entry must not turn the list into a table.
  const contentsRows = table.grid.map((row) => row.join(' ').trim())
  if (
    contentsRows.filter((text) => /^(?:TABLE|FIGURE)\s+\d+\b.*\s\d+$/i.test(text)).length >= 3 &&
    table.grid.every((row) => row.filter((text) => text.trim()).length <= 3)
  )
    return false
  if (isNativeSingleColumnDerivation(table, caption, pageItems, sourceRules)) return false
  if (isNativeAssignedMatrixDisplay(table, caption, pageItems, sourceRules)) return false
  if (isNativeFormulaSystem(table, caption)) return false
  if (isNativeContinuousMathDisplay(table, caption, pageItems, sourceRules ?? [])) return false
  if (
    isDamagedNativeFormulaLayout(table, caption) &&
    !hasOnlyRuledFooterDamage(table, caption, pageItems, sourceRules)
  ) {
    const nativeFrame =
      nativeCaption &&
      sourceRules &&
      proveCaptionedNativeClosedTableFrame(table, nativeCaption, pageItems, sourceRules)
    // A complete notation frame proves the visual enclosure, while its
    // unresolved formulas still lack independent cell semantics.
    if (nativeDefinition?.kind === 'native-notation-visual' || !nativeFrame?.headerTokens?.length)
      return false
  }
  if (isCaptionedNarrativeCard(table, caption)) return false
  if (isImageBackedNonTable(table, caption, sourceGraphics)) return false
  if (isNativeCodeListing(table, caption, pageItems)) return false
  if (isCaptionlessRuledActionListing(table, caption, pageItems, sourceRules)) return false
  if (caption) return true
  if (isNativeBibliographyWithAffiliationMarkers(table, pageItems)) return false
  if (hasNativeNonTableLayout(table, pageItems, sourceRules)) return false
  if (
    table.repairs?.some((r) =>
      ['closed-numeric-grid-recovered', 'wrapped-count-grid-recovered'].includes(r)
    )
  )
    return true
  const sourceText = pageItems.map((item) => item.text).join(' ')
  // Preserve an explicitly labelled, completely assigned native glossary.
  // A distant mention of abbreviations is not enough to admit an arbitrary list.
  if (
    table.cropRect &&
    table.grid.length >= 4 &&
    !table.unassigned?.length &&
    table.grid.every(
      (row) =>
        row.length === 2 &&
        /^[A-Z][A-Za-z\d/&–-]{0,15}$/.test(row[0].trim()) &&
        /\p{L}/u.test(row[1])
    ) &&
    pageItems.some(
      (i) =>
        i.horizontal &&
        /^(?:List of )?Abbreviations\s*:?$/i.test(i.text.trim()) &&
        i.rect[3] <= table.cropRect[1] + i.height * 0.2 &&
        table.cropRect[1] - i.rect[3] < i.height * 2 &&
        i.rect[0] >= table.cropRect[0] - i.height &&
        i.rect[0] < table.cropRect[2]
    )
  )
    return true
  const cropText = [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
  const compactText = cropText.replace(/\s/g, '')
  const words = (text) => (text.trim() ? text.trim().split(/\s+/).length : 0)
  if (
    /\bAuthor contributions\b/i.test(sourceText) &&
    table.grid.every((row) => row.length === 2) &&
    table.grid[0].some((text) => /^Author Initials$/i.test(text.trim())) &&
    /conception|design|final approval/i.test(cropText)
  )
    return false
  const measurement = (text) => /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(text.trim())
  const hasMeasurement = table.grid.some((row) => row.some(measurement))
  if (hasContinuousNativeProse(table, pageItems) || isNumberedNativeDisplay(table, pageItems))
    return false
  // Repeated affiliation markers, institutions and contact addresses identify
  // an author footer even when word-spaced prose became many model columns.
  if (
    !hasMeasurement &&
    (cropText.match(/[†‡§¶]/g) ?? []).length >= 3 &&
    (cropText.match(/\b(?:Department|University|Institute|College)\b/gi) ?? []).length >= 3 &&
    (cropText.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) ?? []).length >= 2
  )
    return false
  // Article metadata can form a false stub beside the abstract. Receipt and
  // acceptance dates plus a DOI or a complete history/keywords heading identify
  // that publication block independently of the neighboring abstract.
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    /\bReceived\s+\d/i.test(cropText) &&
    /\bAccepted\s+\d/i.test(cropText) &&
    (/\bDOI\s*:\s*10\./i.test(cropText) ||
      (/\bArticle history\s*:/i.test(cropText) &&
        /\bAvailable online\b/i.test(cropText) &&
        /\bKeywords\s*:/i.test(cropText)))
  )
    return false
  // Abstract headings and clipped paragraph tails do not become a table
  // merely because the detector aligns the headings into a stub column.
  if (
    table.grid.length >= 3 &&
    table.grid.every((row) => row.length === 2) &&
    table.grid.filter((row) =>
      /^(?:Background|Methods?|Results?|Conclusions?|Objectives?)[:.]?$/i.test(row[0].trim())
    ).length >= 3 &&
    table.grid.every((row) => !measurement(row[1])) &&
    (table.clipped?.length >= 3 || table.issues?.includes('text-crosses-crop-boundary'))
  )
    return false
  // Numbered affiliation blocks can have an extra model column containing
  // only affiliation ordinals. Require institutional prose on both sides.
  if (
    table.grid.length >= 2 &&
    table.grid.every((row) => row.length <= 3 && row.filter(measurement).length <= 1) &&
    table.grid.filter(
      (row) =>
        row.filter((text) =>
          /\b(?:Department|University|Institute|Hospital|College|Unit)\b/i.test(text)
        ).length >= 2
    ).length >= 2 &&
    table.grid.filter((row) => /^\d+\s+\p{L}/u.test(row[0])).length >= 2
  )
    return false
  // A lone citation plus a page number may be entirely inside its crop.
  // Publication year/volume/page syntax and an author list are independent
  // evidence; the page number must not masquerade as a measured data row.
  if (
    table.grid.length <= 4 &&
    table.grid.every((row) => row.length <= 2) &&
    /^\d+\.\s+\p{Lu}[\p{L} '-]+\s+[A-Z][, .]/u.test(cropText.trim()) &&
    /\bet al\./i.test(cropText) &&
    /\b(?:19|20)\d{2};\d+(?::|\()[A-Z]*\d+[–-]\d+/.test(cropText) &&
    table.grid.filter((row) => row.some(measurement)).length <= 1
  )
    return false
  // Author-year bibliographies may fill the crop without clipping a single
  // line. Repeated parenthesized years and journal volume/page ranges together
  // identify the prose columns; measured or captioned tables remain eligible.
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    (cropText.match(/\((?:19|20)\d{2}[a-z]?\)/g) ?? []).length >= 3 &&
    (cropText.match(/\b\d{1,4}\s*,\s*\d+[–-]\d+[.]/g) ?? []).length >= 3
  )
    return false
  // Author blocks repeat personal names followed by affiliations in both page
  // columns. Neither particular institutions nor country names prove ownership.
  // Preserve captioned tables above and measured comparisons below.
  const populatedCells = table.grid.flat().filter((text) => text.trim())
  const authorAffiliations = populatedCells.filter((text) =>
    /^(?:(?:\p{Lu}[\p{L}’'-]+|\p{Lu}\.)\s+){2,6}(?:University|College|School|Institute|Hospital|Center)\b/u.test(
      text.trim()
    )
  )
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    authorAffiliations.length >= 4 &&
    authorAffiliations.length >= populatedCells.length * 0.6
  )
    return false
  // Publication sidebars can cross into an abstract. A DOI split across native
  // lines leaves an apparently numeric last cell, so require publication and
  // licensing anchors together instead of treating that fragment as a value.
  if (
    table.grid.every((row) => row.length <= 2 && row.filter(measurement).length < 2) &&
    /Acceptedon/i.test(compactText) &&
    /published(?:at|on|online)/i.test(compactText) &&
    /\bDOI\b/i.test(cropText) &&
    /(?:org\/|DOI:)10\./i.test(compactText) &&
    /(?:CreativeCommons|©)/i.test(compactText)
  )
    return false
  // Section outlines contain numbered prose headings, sometimes with a
  // completely empty detector column. Those ordinals are not measurements.
  if (
    table.grid.length <= 4 &&
    table.grid.length >= 2 &&
    table.grid.every(
      (row) =>
        /^\d+(?:\.\d+)*\.$/.test(row[0]?.trim() ?? '') &&
        row.slice(1).filter((text) => text.trim()).length === 1 &&
        row.slice(1).some((text) => /^[\p{L} -]+$/u.test(text.trim()))
    ) &&
    table.issues?.includes('text-crosses-crop-boundary')
  )
    return false
  // A detector can turn a reference column or a prose section outline into a
  // two-column grid. These candidates commonly cross the crop boundary and
  // leave source text unassigned. Keep a measured comparison or a captioned
  // table above, but reject the unstructured shapes before they reach output.
  const referenceItems = nativeClosedTableReferenceItems(table, pageItems, sourceRules) ?? pageItems
  const referenceText = referenceItems.map((item) => item.text).join(' ')
  const referenceHeading = referenceItems.some((item) =>
    /^(?:References|Bibliography)\s*:?$/i.test(item.text.trim())
  )
  const numberedReferenceMarkers = referenceItems.filter((item) =>
    /^\d+[.)]?$/.test(item.text.trim())
  ).length
  const sourceReferenceMarkers = (referenceText.match(/(?:^|\s)\d+\.\s/g) ?? []).length
  const citationYears = (referenceText.match(/\b(?:19|20)\d{2}\b/g) ?? []).length
  const citationUrls = (cropText.match(/https?:\/\/|doi\.org/gi) ?? []).length
  const referenceLikeGrid = table.grid.every((row) => row.length <= 6)
  const numberedCitationRows = table.grid.filter((row) => {
    const marker = row[0]?.trim() ?? ''
    const citation = row.slice(1).join(' ').trim()
    return (
      /^\d+[.)]?$/.test(marker) &&
      words(citation) >= 8 &&
      /(?:19|20)\d{2}\b/.test(citation) &&
      /\b(?:Journal|Cancer|BMJ|Eur|doi|et al\.)\b/i.test(citation)
    )
  }).length
  if (
    !hasMeasurement &&
    referenceLikeGrid &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    ((referenceHeading && numberedReferenceMarkers >= 3) ||
      (numberedReferenceMarkers >= 3 && citationYears >= 3) ||
      (citationUrls >= 2 && citationYears >= 2) ||
      (sourceReferenceMarkers >= 3 && citationYears >= 3))
  )
    return false
  // A two-column detector crop can also treat a short bibliography tail as a
  // table. Numeric-only left cells are ordinals in this shape, not measured
  // values; require every row to carry a long citation before rejecting it.
  if (
    !caption &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    numberedCitationRows >= 2 &&
    numberedCitationRows === table.grid.length
  )
    return false
  // Multi-column review questions often resemble a sparse table because each
  // answer option lands in a separate detector column. Repeated question
  // numbers, option markers, and question punctuation identify the outline;
  // measured or captioned tables remain eligible.
  const questionRows = table.grid.filter((row) => /\b\d+\.\s+/u.test(row.join(' '))).length
  const questionMarks = (cropText.match(/\?/g) ?? []).length
  const optionCount = (cropText.match(/(?:^|\s)[a-c][.)]\s/giu) ?? []).length
  if (
    !caption &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    !hasMeasurement &&
    questionRows >= 2 &&
    (questionMarks >= 2 || (questionMarks === 1 && questionRows >= 4)) &&
    optionCount >= 6
  )
    return false
  // Detector spans can merge footnotes or prose notes into a wide cell and
  // then split the following paragraph into two columns. Without a caption or
  // measured records, a majority of full-width model spans is stronger
  // evidence of a page note than of a data table. Keep this generic so real
  // qualitative tables with a coherent row grid remain eligible.
  if (
    !caption &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    table.issues?.includes('unassigned-source-text') &&
    table.cells?.length &&
    table.grid.length >= 4 &&
    table.grid.length <= 12 &&
    !hasMeasurement
  ) {
    const columnCount = Math.max(...table.grid.map((row) => row.length))
    const fullWidthSpanRows = new Set(
      table.cells
        .filter((cell) => cell.origin === 'model-span' && (cell.colSpan ?? 1) >= columnCount)
        .map((cell) => cell.row)
    )
    const longProseRows = table.grid.filter((row) => row.some((text) => words(text) >= 8)).length
    if (
      fullWidthSpanRows.size >= 3 &&
      fullWidthSpanRows.size >= Math.ceil(table.grid.length * 0.5) &&
      longProseRows >= 2
    )
      return false
  }
  // A small detector crop at the end of a prose column can look like a two
  // column table when the adjacent sentence and journal furniture are split
  // into separate cells. Require a caption or measured content for this
  // ambiguous shape; quoted narrative tables remain eligible.
  if (
    !caption &&
    table.cropRect &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    table.issues?.includes('unassigned-source-text') &&
    table.grid.length <= 3 &&
    table.grid.every((row) => row.length <= 2 && !row.some(measurement)) &&
    (table.unassigned?.length ?? 0) >= 2
  ) {
    const populated = table.grid.flat().filter((text) => text.trim())
    const hasQuotedNarrative = populated.some((text) => /^[“"']/u.test(text.trim()))
    if (!hasQuotedNarrative && populated.filter((text) => words(text) >= 4).length >= 2)
      return false
  }
  // A displayed equation followed by parameter bullets is explanatory prose.
  // Require repeated bullet markers, a mathematical expression, long prose
  // cells and no measured record; retain captioned and numeric tables above.
  if (
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    table.grid.filter((row) => /^[•◦]$/.test(row[0]?.trim() ?? '')).length >= 3 &&
    table.grid.filter((row) => row.some((text) => words(text) >= 8)).length >= 3 &&
    /[=∈]/u.test(cropText) &&
    (cropText.match(/[α-ω]/gu) ?? []).length >= 3
  )
    return false
  const sectionLabelRows = table.grid.filter(
    (row) => !row[0]?.trim() || /^\d+\.\d+(?:\.\d+)*$/.test(row[0].trim())
  ).length
  const sectionProseRows = table.grid.filter((row) => words(row[1] ?? '') >= 8).length
  if (
    table.grid.length >= 3 &&
    table.grid.every((row) => row.length === 2) &&
    !table.grid.some((row) => measurement(row[1])) &&
    sectionLabelRows >= table.grid.length * 0.6 &&
    sectionProseRows >= table.grid.length * 0.6
  )
    return false
  // Quoted callouts are frequently boxed like a small two-column table. Keep
  // them in the source document unless a real table caption or measurement
  // column provides explicit structure evidence.
  const quotedRows = table.grid.filter((row) => /^[“”"']/.test((row[0] ?? '').trim()))
  if (
    !caption &&
    !hasMeasurement &&
    table.grid.length <= 4 &&
    table.grid.every((row) => row.length <= 2) &&
    quotedRows.length > 0 &&
    words(table.grid.flat().join(' ')) >= 6
  )
    return false
  // Article title/author blocks can align into two detector columns and may
  // contain a journal year or page range. They have no table caption and no
  // measured data, so discard the structural false positive.
  if (
    !caption &&
    !hasMeasurement &&
    table.grid.every((row) => row.length <= 2) &&
    /\b(?:Department|University|Institute)\b/i.test(
      [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
    ) &&
    /(?:©|\b(?:19|20)\d{2}\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+[–-]\d+)/u.test(
      [...table.grid.flat(), ...(table.unassigned ?? [])].join(' ')
    )
  )
    return false
  if (table.cropRect && table.grid.every((r) => r.length <= 2 && !r.some(measurement))) {
    const [left, top, right, bottom] = table.cropRect
    const prose = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[1] >= top - i.height &&
        i.rect[3] <= bottom + i.height &&
        i.text.trim().split(/\s+/).length >= 5
    )
    // A short detector box can cut into the left article column while its right
    // edge happens to coincide with the other column's margin.
    if (
      table.grid.length <= 6 &&
      prose.filter((i) => i.rect[0] < left - i.height && i.rect[2] > left).length >= 3 &&
      prose.filter(
        (i) => i.rect[0] > left + (right - left) * 0.4 && Math.abs(i.rect[2] - right) < i.height
      ).length >= 3 &&
      pageItems.filter(
        (i) =>
          i.horizontal &&
          i.rect[1] < bottom &&
          i.rect[3] > bottom &&
          i.text.trim().split(/\s+/).length >= 5
      ).length >= 2
    )
      return false
    // A clipped questionnaire outline can leave most of the predicted table
    // empty. Its repeated source bullets outside the crop establish list prose.
    if (
      prose.length >= 6 &&
      Math.max(...prose.map((i) => i.rect[3])) < top + (bottom - top) * 0.4 &&
      pageItems.filter(
        (i) =>
          /^[•◦]$/.test(i.text) &&
          i.rect[0] < left &&
          i.rect[0] >= left - i.height * 3 &&
          i.rect[1] >= top &&
          i.rect[3] < bottom
      ).length >= 3
    )
      return false
  }
  if (
    !table.grid.some((row) => row.filter(measurement).length >= 2) &&
    ((/Prepublication history/i.test(cropText) &&
      /supplemental\s+material/i.test(cropText) &&
      /doi(?:[.:]|\.org)/i.test(cropText)) ||
      (/Acknowledgements/i.test(cropText) &&
        table.grid.filter(
          (row) =>
            /^[A-Z][A-Za-z]{1,8}$/.test(row[0]) &&
            row.slice(1).some((text) => text.split(/\s+/).length >= 2)
        ).length >= 3) ||
      (table.grid.every((row) => row.length <= 3) &&
        (cropText.match(/\b(?:Department|University|Institute|College|School)\b/g) ?? []).length >=
          5 &&
        (cropText.match(/\b(?:UK|USA|Ukraine|Korea|Belarus|Federation)\b/g) ?? []).length >= 3))
  )
    return false

  if (
    /Full protocol available at:/i.test(cropText) &&
    /Raw data available at:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    !table.grid.some((r) => r.some(measurement))
  )
    return false
  // Tiny detections across two prose columns contain clipped sentences rather
  // than independently measured records. Require source overhang on both sides.
  if (
    table.cropRect &&
    table.grid.length <= 3 &&
    table.grid.every((r) => r.length <= 2 && !r.some(measurement))
  ) {
    const prose = pageItems.filter(
      (i) =>
        i.horizontal &&
        i.rect[1] >= table.cropRect[1] - i.height &&
        i.rect[3] <= table.cropRect[3] &&
        i.text.trim().split(/\s+/).length >= 7
    )
    if (
      prose.some(
        (i) => i.rect[0] < table.cropRect[0] - i.height && i.rect[2] > table.cropRect[0]
      ) &&
      prose.some((i) => i.rect[0] < table.cropRect[2] && i.rect[2] > table.cropRect[2] + i.height)
    )
      return false
  }

  // A numbered parameter list has punctuation on each ordinal and one prose
  // field. Ordinals alone must not count as a measurement column.
  if (
    table.grid.every(
      (row) => row.length === 2 && (!row[0].trim() || /^\d+\.$/.test(row[0].trim()))
    ) &&
    table.grid.filter((row) => /^\d+\.$/.test(row[0].trim()) && /\p{L}/u.test(row[1])).length >=
      4 &&
    !table.grid.some((row) => measurement(row[1]))
  )
    return false
  // A small detection across several empty model columns is a prose fragment
  // when native sentences cross its edges and it contains no measured records.
  if (
    table.cropRect &&
    table.grid.length <= 3 &&
    table.grid[0]?.length >= 3 &&
    table.grid.every((row) => row.filter((s) => s.trim()).length <= 4 && !row.some(measurement)) &&
    pageItems.filter(
      (i) =>
        i.text.length > 40 &&
        i.rect[1] < table.cropRect[3] &&
        i.rect[3] > table.cropRect[1] &&
        (i.rect[0] < table.cropRect[0] || i.rect[2] > table.cropRect[2])
    ).length >= 2
  )
    return false

  // Short metadata and bibliography fragments may produce plausible-looking
  // columns. Require explicit publication anchors and no measured data pairs.
  if (
    table.grid.every((row) => row.length <= 3 && row.filter(measurement).length < 2) &&
    ((/\bKey words?:/i.test(cropText) && table.grid.length <= 3) ||
      ((cropText.match(/\((?:19|20)\d{2}\)\s*:/g) ?? []).length >= 3 &&
        /\b(?:Ophthalmol|Cancer|Journ?al)\b/i.test(cropText)))
  )
    return false
  // Disclosure directories align names and relationship labels in columns.
  // Require several explicit relationship labels and no measurement columns;
  // a captioned research table has already been accepted above.
  if (
    table.grid.every((row) => row.length <= 2 && !row.some(measurement)) &&
    (
      cropText.match(
        /\b(?:Consulting or Advisory Role|Research Funding|Honoraria|Speakers[’'] Bureau|Uncompensated Relationships|Travel, Accommodations, Expenses)\s*:/g
      ) ?? []
    ).length >= 3
  )
    return false
  if (
    table.grid.every((row) => row.filter(measurement).length <= 1) &&
    ((/Published Online:/i.test(cropText) && /doi:\s*10\./i.test(cropText)) ||
      ((
        cropText.match(
          /\b(?:Department of|Clinic of|Clinical Epidemiology|College of|Medical School|Epidemiology Division)\b/gi
        ) ?? []
      ).length >= 3 &&
        table.grid.every((row) => row.length <= 3)) ||
      (/\b(?:PhD|MD)\b/.test(cropText) &&
        /\bJournal of\b/.test(cropText) &&
        /\bDOI:\s*10\./i.test(sourceText) &&
        /©/.test(sourceText) &&
        table.grid.length <= 3 &&
        table.grid.every((row) => row.length <= 2)))
  )
    return false
  if (
    /Corresponding Author\s*:/i.test(cropText) &&
    /E-mail\s*:\s*\S+@\S+/i.test(cropText) &&
    /doi\s*:\s*10\./i.test(cropText) &&
    /(?:Creative Commons|Published by)/i.test(cropText)
  )
    return false
  if (
    /Reprints and permission/i.test(cropText) &&
    /DOI:\s*10\./i.test(cropText) &&
    /https?:\/\//.test(cropText) &&
    table.grid.every((r) => r.length <= 2)
  )
    return false
  // Citation prose may use volume, page range and a parenthesized year instead of semicolons.
  if (
    (cropText.match(/\d+,?\s+\d+[–-]\d+\s*\((?:19|20)\d{2}\)/g) ?? []).length >= 2 &&
    /\bet al\b/i.test(cropText) &&
    table.grid.every((r) => r.length <= 2)
  )
    return false
  // Small fragments of a bibliography may contain only one citation. Require
  // multiple complete journal references in the source and no numeric columns.
  const journalReference = /\b(?:19|20)\d{2}\s*;\s*\d+(?:\(\d+\))?\s*:\s*\d+/g
  const journalCitations = (cropText.match(journalReference) ?? []).length
  if (
    journalCitations >= 3 &&
    table.issues?.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length <= 3) &&
    table.grid.every((row) =>
      row.filter((text) => measurement(text)).every((text) => /^\d{1,3}$/.test(text.trim()))
    ) &&
    table.grid.filter((row) => row.some((text) => words(text) >= 20)).length >= 2
  )
    return false
  if (
    table.grid.length <= 3 &&
    table.grid.every((r) => r.length <= 3) &&
    (sourceText.match(journalReference) ?? []).length >= 3 &&
    journalReference.test(cropText) &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some((r) => r.some((c) => /^[-−+]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(c.trim())))
  )
    return false

  if (
    /Updated version/i.test(sourceText) &&
    /Reprints and/i.test(sourceText) &&
    /Permissions/i.test(sourceText) &&
    /(?:most recent (?:version|supplemental material)|free email-alerts)/i.test(cropText)
  )
    return false
  if (
    /Search (?:profile|strategy)/i.test(sourceText) &&
    (cropText.match(/\d+\s+(?:OR|AND)\s+\d+/g) ?? []).length >= 2 &&
    table.grid.every((row) => row.length <= 2)
  )
    return false
  // Structured abstracts align section labels with prose, not measurements.
  const abstractLabels =
    /^(?:background|purpose|objectives?|patients and methods|methods|results|conclusions?)\s*:?$/i
  const sections = pageItems.filter((item) => abstractLabels.test(item.text.trim()))
  if (
    sections.length >= 3 &&
    sections.some((item) => /conclusion/i.test(item.text)) &&
    table.grid.every((row) => row.length <= 3) &&
    table.grid.some((row) => row.some((text) => text.length > 100)) &&
    sections.some((item) => inside(table.cropRect, item))
  )
    return false
  if (
    /\b(?:Tel\.|Telephone|Fax)\s*:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((text) => /^[-+−]?\d+(?:\.\d+)?$/.test(text.trim())).length >= 2
    )
  )
    return false
  if (
    /ARTICLE TOOLS/i.test(cropText) &&
    /PERMISSIONS/i.test(cropText) &&
    /https?:\/\//.test(cropText)
  )
    return false
  if (
    /Email alerting service/i.test(cropText) &&
    /Receive free email alerts/i.test(cropText) &&
    /https?:\/\//.test(cropText)
  )
    return false
  // R/knitr console output is preformatted statistical text, not a predicted
  // cell grid. Keep it in the original PDF instead of publishing a broken grid.
  if (pageItems.filter((i) => /^##/.test(i.text.trim())).length >= 3) return false
  if (/\bAbstract\b/i.test(cropText) && /\bK\s*E\s*Y\s*W\s*O\s*R\s*D\s*S\b/i.test(sourceText))
    return false
  if (
    (cropText.match(/\b(?:19|20)\d{2}\s*;/g) ?? []).length >= 3 &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some((r) => r.filter((c) => /^\d+(?:\.\d+)?$/.test(c.trim())).length >= 2)
  )
    return false
  if (
    table.grid.length <= 4 &&
    table.grid.every((r) => r.length >= 2) &&
    /\b(?:ethics committee|ethics decision|ethics decisi-)\b/i.test(cropText) &&
    /\b(?:approval|approved)\b/i.test(sourceText)
  )
    return false
  if (
    /(?:通讯作者|通訊作者)/.test(compactText) &&
    /(?:收到|收稿|修订|接受|电子邮[件箱]|電子郵件|orcid\.org)/i.test(compactText)
  )
    return false
  if (
    table.grid[0]?.length >= 2 &&
    (compactText.match(/\p{Script=Han}/gu) ?? []).length > 30 &&
    (/(?:参考文献|參考文獻|orcid\.org)/i.test(compactText) ||
      (compactText.match(/(?:19|20)\d{2}[；;年]/g) ?? []).length >= 2)
  )
    return false
  if (
    (/\bPII\s*:/i.test(cropText) ||
      (cropText.match(/\b(?:Received|Revised|Accepted) Date:/g) ?? []).length >= 2) &&
    /\bDOI\s*:/i.test(cropText) &&
    /\b(?:Reference|To appear in)\s*:/i.test(cropText)
  )
    return false
  if (
    /\S+@\S+/.test(cropText) &&
    table.grid.length <= 6 &&
    table.grid.every(
      (row) =>
        row.length === 2 &&
        /^\d+$/.test(row[0]) &&
        /\b(?:Department|Division|University|Hospital|School)\b/i.test(row[1])
    )
  )
    return false
  if (
    (cropText.match(/\[\d+\]/g) ?? []).length >= 3 &&
    (cropText.match(/\b(?:19|20)\d{2}\s*[;:,]/g) ?? []).length >= 3 &&
    !table.grid.some(
      (row) => row.filter((cell) => /^[-−+]?\d+(?:\.\d+)?$/.test(cell.trim())).length >= 2
    )
  )
    return false
  if (
    /Edited by\s*:/i.test(sourceText) &&
    /Reviewed by\s*:/i.test(sourceText) &&
    /(?:Reviewed by|University|Correspondence|Received|doi\s*:)/i.test(cropText)
  )
    return false
  if (
    /Academic Editor\s*:/i.test(sourceText) &&
    /Received\s*:/i.test(sourceText) &&
    /(?:doi\.org|Keywords\s*:|Academic Editor)/i.test(cropText)
  )
    return false
  const columnText = pageItems
    .filter(
      (item) =>
        !table.cropRect ||
        (item.rect?.[0] >= table.cropRect[0] &&
          item.rect?.[2] <= table.cropRect[2] &&
          item.rect[1] <= table.cropRect[1] + (item.rect[3] - item.rect[1]) * 2 &&
          item.rect[3] >= table.cropRect[1] - (item.rect[3] - item.rect[1]) * 6)
    )
    .map((item) => item.text)
    .join(' ')
  if (
    /A\s*R\s*T\s*I\s*C\s*L\s*E\s+I\s*N\s*F\s*O/i.test(columnText) &&
    /A\s*B\s*S\s*T\s*R\s*A\s*C\s*T/i.test(columnText) &&
    /Keywords\s*:/i.test(cropText)
  )
    return false
  if (
    table.grid[0]?.length === 2 &&
    table.grid.some((row) => /^\s*\*\s*$/.test(row[0]) && /\S+@\S+/.test(row[1])) &&
    table.grid.some(
      (row) => /^\d+$/.test(row[0]) && /\b(?:Department|University|School)\b/i.test(row[1])
    )
  )
    return false
  if (
    /\b(?:Abbreviations|Nomenclature)\b/i.test(sourceText + ' ' + cropText) &&
    table.grid.length >= 4 &&
    table.grid.every(
      (row) => row.length >= 2 && row[0].length < 35 && row.slice(2).every((s) => !s.trim())
    ) &&
    table.grid.filter(
      ([key, value]) => /^[A-Z][A-Za-z\d-]{1,15}$/.test(key) && /\p{L}/u.test(value)
    ).length >= 4 &&
    !table.grid.some((row) => row.some((value) => /^[-−+]?\d+(?:\.\d+)?$/.test(value.trim())))
  )
    return false
  // Publishers lay out abbreviation keys in two parallel key/description lists.
  // Require the heading and repeated acronym pairs, not merely a four-column grid.
  if (
    /\bAbbreviations\b/i.test(cropText) &&
    table.grid.every((row) => row.length === 4) &&
    table.grid
      .flatMap((row) => [
        [row[0], row[1]],
        [row[2], row[3]]
      ])
      .filter(([key, value]) => /^[A-Z][A-Z\d–-]{1,15}$/.test(key) && /\p{L}/u.test(value))
      .length >= 6 &&
    !table.grid.some((row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value)).length >= 2)
  )
    return false
  if (
    pageItems.some((item) => /^Affiliations\s*$/i.test(item.text)) &&
    (cropText.match(/\b(?:University|Hospital|College|Department)\b/g) ?? []).length >= 4 &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  if (
    table.grid.length >= 3 &&
    table.grid.filter((row) => row.some((text) => /^\[\d+\]$/.test(text.trim()))).length >=
      table.grid.length * 0.7 &&
    /(?:Data availability|Informed consent)/i.test(cropText)
  )
    return false
  if (
    populatedRows.filter((n) => n === 0).length >= table.grid.length / 2 &&
    table.grid.some((row) => row.some((text) => /\bFig\.\s*\d/.test(text)))
  )
    return false
  // Parallel correspondence blocks are metadata even when addresses contain numbers.
  if (
    /\bCorresponding author[.:]/i.test(cropText) &&
    /\bE-?mail(?: address)?\s*:/i.test(cropText) &&
    /\S+@\S+/.test(cropText) &&
    /\b(?:Department|University|Hospital|Oncology|Therapy)\b/i.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  // Some journals print author initials and years without DOI links. Require
  // repeated citation anchors, volume/page ranges and long prose, not bare dates.
  if (
    table.grid.every((row) => row.length <= 3) &&
    (cropText.match(/\b[A-Z]{1,3}\s+(?:19|20)\d{2}\b/g) ?? []).length >= 3 &&
    (cropText.match(/\b\d+\s+\d+[–-]\d+/g) ?? []).length >= 2 &&
    table.grid.flat().filter((text) => text.split(/\s+/).length >= 8).length >= 3 &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  // Author-year reference lists may have no numbered margin. Repeated DOI
  // anchors and publication years distinguish them from uncaptained data.
  if (
    table.grid.every((row) => row.length <= 3) &&
    (cropText.match(/\bdoi\s*:\s*10\./gi) ?? []).length >= 3 &&
    (cropText.match(/\b(?:19|20)\d{2}\b/g) ?? []).length >= 3 &&
    /\bet al\b/i.test(cropText) &&
    !table.grid.some(
      (row) => row.filter((value) => /^\d+(?:\.\d+)?$/.test(value.trim())).length >= 2
    )
  )
    return false
  if (
    table.grid[0]?.length >= 2 &&
    table.grid[0].every((_, column) => {
      const text = table.grid.map((row) => row[column]).join(' ')
      return /\bE-?mail\s*:/i.test(text) && /\b(?:Tel\.?|Telephone|Fax)\s*:/i.test(text)
    })
  )
    return false
  // Inspect source citation anchors as well as the reconstructed grid: a poor
  // grid can absorb the numbers into author names or lose whole reference rows.
  const cropItems = pageItems.filter((item) => table.cropRect && inside(table.cropRect, item))
  const possibleNumbers = cropItems.filter(
    (item) =>
      /^\d+$/.test(item.text.trim()) &&
      item.rect[0] < table.cropRect[0] + (table.cropRect[2] - table.cropRect[0]) * 0.12
  )
  const numberLeft = Math.min(...possibleNumbers.map((item) => item.rect[0]))
  const marginNumbers = possibleNumbers
    .filter((item) => Math.abs(item.rect[0] - numberLeft) < item.height * 0.3)
    .sort((a, b) => a.baseline - b.baseline)
  if (
    marginNumbers.length >= 5 &&
    !proveNativeAssignedClosedTableFrame(table, pageItems, sourceRules ?? []) &&
    marginNumbers.every(
      (item, i) => !i || Number(item.text) === Number(marginNumbers[i - 1].text) + 1
    ) &&
    marginNumbers.filter((number) => {
      const text = cropItems
        .filter(
          (item) =>
            item.horizontal &&
            item.rect[0] > number.rect[2] &&
            item.height >= number.height * 0.9 &&
            Math.abs(item.baseline - number.baseline) < number.height * 0.4
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
        .map((item) => item.text)
        .join(' ')
      return text.length >= 40 && text.split(/\s+/).length >= 8
    }).length >=
      marginNumbers.length * 0.6
  )
    return false
  const possibleAnchors = cropItems.filter((item) => /^\d+\.$/.test(item.text.trim()))
  const anchorLeft = Math.min(...possibleAnchors.map((item) => item.rect[0]))
  const citationAnchors = possibleAnchors
    .filter((item) => Math.abs(item.rect[0] - anchorLeft) < item.height * 0.5)
    .sort((a, b) => a.baseline - b.baseline)
  if (
    citationAnchors.length >= 3 &&
    citationAnchors.every(
      (item, i) =>
        !i ||
        (Math.abs(item.rect[0] - citationAnchors[0].rect[0]) < item.height &&
          Number.parseInt(item.text) === Number.parseInt(citationAnchors[i - 1].text) + 1)
    ) &&
    (
      cropItems
        .map((item) => item.text)
        .join(' ')
        .match(/\b(?:19|20)\d{2}\./g) ?? []
    ).length >= 3
  )
    return false
  // Publisher disclosure forms contain aligned fields and checklists, not research
  // tables. Require the template marker and a form section, not common row labels.
  if (
    pageItems.some((item) =>
      /^nature(?: portfolio| research)?\s*\|\s*(?:life sciences )?reporting summary$/i.test(
        item.text.trim()
      )
    ) &&
    pageItems.some((item) =>
      /^(?:Experimental design|Field-specific reporting|Life sciences study design|Reporting for specific materials, systems and methods)$/i.test(
        item.text.trim()
      )
    )
  )
    return false
  if (table.issues.includes('overlapping-predicted-columns')) return false
  // Parallel prose columns also produce confident multi-column predictions. A crop cutting
  // through paragraph text, with long prose in most cells of most rows, lacks row evidence.
  // Keep captioned tables and tables with short row labels/numeric or sequence values.
  if (
    (table.unassigned ?? []).some((text) => /^abbreviations\s*:?$/i.test(text.trim())) &&
    table.grid.length >= 3 &&
    table.grid.every(
      (row) => row.length === 2 && /^[\p{L}\d‒–-]+$/u.test(row[0]) && words(row[1]) >= 2
    )
  )
    return false
  const publicationSidebar = table.grid.map((row) => row[0] ?? '')
  if (
    publicationSidebar.some((text) => /^Received:\s+.*\b(?:19|20)\d{2}\b/i.test(text)) &&
    publicationSidebar.some((text) => /^Accepted:\s+.*\b(?:19|20)\d{2}\b/i.test(text)) &&
    publicationSidebar.some((text) => /^(?:Published online:|Check for updates)/i.test(text)) &&
    table.grid.some((row) => row.slice(1).some((text) => words(text) >= 60))
  )
    return false
  // Bibliography continuations may have no section heading. Their numbered entries
  // form a hanging-indent list, with publication years/author citations in prose.
  const referenceNumber = (row) => row[0]?.trim().match(/^[-–−]?\s*(\d+)[.)]?(?:\s+\p{L}+)?$/u)?.[1]
  const numbered = table.grid.filter((row) => referenceNumber(row))
  if (
    numbered.length >= 3 &&
    numbered.length >= populatedRows.filter((count) => count >= 2).length * 0.7 &&
    numbered.every(
      (row, i) => !i || Number(referenceNumber(row)) > Number(referenceNumber(numbered[i - 1]))
    ) &&
    numbered.filter(
      (row, i) => i && Number(referenceNumber(row)) === Number(referenceNumber(numbered[i - 1])) + 1
    ).length >=
      (numbered.length - 1) * 0.7 &&
    numbered.filter((row) => words(row.slice(1).join(' ')) >= 12).length >= numbered.length * 0.7 &&
    (
      [...numbered.flatMap((row) => row.slice(1)), ...(table.unassigned ?? [])]
        .join(' ')
        .match(/(?:\bet al\.|\((?:19|20)\d{2}\)|\b(?:19|20)\d{2};\d)/g) ?? []
    ).length >= 3 &&
    !table.grid
      .slice(0, table.grid.indexOf(numbered[0]))
      .some((row) => row.filter((text) => /\p{L}/u.test(text)).length >= 2)
  )
    return false
  // Captionless reference pages can be mistaken for two-column tables when
  // bracketed citation keys occupy the first model column. Require a dense
  // sequence of citation keys, reference-length prose, and bibliography
  // anchors; measured or captioned tables remain eligible.
  const citationKeyRows = table.grid.filter((row) =>
    /^\s*\[[^\]]{2,16}\](?:\s+\[[^\]]{2,16}\])?\s*$/u.test(row[0]?.trim() ?? '')
  )
  const citationProseRows = citationKeyRows.filter((row) => words(row.slice(1).join(' ')) >= 8)
  const citationText = [
    ...citationKeyRows.flatMap((row) => row.slice(1)),
    ...(table.unassigned ?? [])
  ].join(' ')
  if (
    !caption &&
    table.grid.flat().filter(measurement).length <= 2 &&
    table.grid.length >= 8 &&
    citationKeyRows.length >= Math.max(8, table.grid.length * 0.55) &&
    citationProseRows.length >= citationKeyRows.length * 0.65 &&
    (citationText.match(/(?:\b(?:19|20)\d{2}\b|\bet al\.|\barXiv:|\bdoi\b|https?:\/\/)/gi) ?? [])
      .length >= 3
  )
    return false
  // Short references-page tails can contain only four or five rows after a
  // page crop, so the long-list guard above intentionally does not cover
  // them.  Keep the fallback strict: every row must carry a bracketed
  // citation key and reference-length prose, with several publication
  // anchors.  Captioned or measured tables continue through this path.
  if (
    !caption &&
    table.grid.length <= 7 &&
    table.grid.flat().filter(measurement).length <= 2 &&
    citationKeyRows.length >= 4 &&
    citationKeyRows.length >= table.grid.length * 0.75 &&
    citationProseRows.length >= citationKeyRows.length * 0.75 &&
    (citationText.match(/(?:\b(?:19|20)\d{2}\b|\bet al\.|\barXiv:|\bdoi\b|https?:\/\/)/gi) ?? [])
      .length >= 3
  )
    return false
  // Boxed pseudocode is unstructured algorithm content, not a data grid.
  // Require an explicit Algorithm heading and numbered instruction rows so a
  // measured table with a numbered first column remains eligible.
  const algorithmHeading = [
    ...(table.grid[0] ?? []).filter(Boolean),
    ...(table.unassigned ?? [])
  ].some((text) => /^\s*Algorithm\b/i.test(text.trim()))
  const algorithmRows = table.grid
    .slice(1)
    .filter((row) => /^\s*\d+[.:)]\s*/u.test(row.find((text) => text.trim())?.trim() ?? ''))
  if (
    !caption &&
    table.grid.flat().filter(measurement).length === 0 &&
    algorithmHeading &&
    algorithmRows.length >= 3 &&
    algorithmRows.length >= (table.grid.length - 1) * 0.6
  )
    return false
  // Some boxed procedures omit the literal Algorithm heading. A numbered
  // instruction lane with repeated control-flow vocabulary is still
  // pseudocode, not a data grid; require several independent witnesses so a
  // labelled prose table remains eligible.
  const numberedProcedureRows = table.grid.filter((row) =>
    /^\s*\d+(?:\s+\d+)?\s*$/u.test(row.find((text) => text.trim())?.trim() ?? '')
  )
  const procedureRows = table.grid.filter((row) =>
    /\b(?:while|if|then|for\b[^\n]{0,60}\bdo|plan|sub-?goals?|node\s*\(|re-?enter)\b/iu.test(
      row.join(' ')
    )
  )
  if (
    !caption &&
    table.grid.flat().filter(measurement).length === 0 &&
    numberedProcedureRows.length >= 3 &&
    procedureRows.length >= 3 &&
    procedureRows.length >= table.grid.length * 0.5
  )
    return false
  // A ruled article-info/abstract panel is not a table, even when the whole prose
  // fits inside the crop. Require both the keyword sidebar and a nearby ABSTRACT
  // heading. A heading clipped by the upper edge also needs its paired ARTICLE
  // INFO label, so a cell mentioning an abstract remains valid.
  const keywordColumn = table.grid[0]?.findIndex((text) => /^key\s*words?\s*:?$/i.test(text.trim()))
  if (
    keywordColumn >= 0 &&
    table.grid.some((row) =>
      row.some((text, column) => column !== keywordColumn && words(text) >= 80)
    ) &&
    pageItems.some(
      (item) =>
        /^abstract:?$/i.test(item.text.replace(/\s+/g, '')) &&
        table.cropRect &&
        item.rect[0] >= table.cropRect[0] &&
        item.rect[2] <= table.cropRect[2] &&
        ((item.rect[3] <= table.cropRect[1] &&
          table.cropRect[1] - item.rect[3] <= 4 * (item.rect[3] - item.rect[1])) ||
          (Math.abs(item.rect[1] - table.cropRect[1]) <= item.rect[3] - item.rect[1] &&
            pageItems
              .filter(
                (other) =>
                  other.rect[0] >= table.cropRect[0] &&
                  other.rect[2] < item.rect[0] &&
                  Math.abs(other.rect[3] - item.rect[3]) < (item.rect[3] - item.rect[1]) * 0.5
              )
              .sort((a, b) => a.rect[0] - b.rect[0])
              .map((other) => other.text.replace(/\s+/g, ''))
              .join('')
              .toLowerCase() === 'articleinfo'))
    )
  )
    return false
  // A standalone bibliography heading plus a numbered, linked citation is prose,
  // even when the detector splits just one reference across several short columns.
  // A References column beside other headers is not a section heading.
  if (
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.some(
      (row) =>
        row.filter((text) => text.trim()).length === 1 &&
        row.some((text) => /^(?:references|bibliography)\s*:?$/i.test(text.trim()))
    ) &&
    table.grid.some((row) =>
      /^\s*(?:\d+[.)]|\[\d+\])\s+\p{L}/u.test(row.find((text) => text.trim()) ?? '')
    ) &&
    [...table.grid.flat(), ...(table.unassigned ?? [])].some((text) => /https?:\/\//i.test(text))
  )
    return false
  const mostlyUnassigned =
    words((table.unassigned ?? []).join(' ')) > words(table.grid.flat().join(' '))
  // A predicted divider through an ordinary paragraph has word-sized gaps on
  // both sides, not a stable column gutter. Require repeated prose rows and actual
  // source positions, so compact numeric tables and captioned prose tables survive.
  // Whole source lines can cross both the crop edge and its first divider.
  // Two such prose lines prove that a narrow three-column prediction cuts
  // ordinary paragraphs; do not reject captioned tables or numeric records.
  if (
    table.cropRect &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length === 3 && !row.some(measurement)) &&
    (table.cells ?? []).filter(
      (cell) =>
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (item) =>
            item.rect &&
            words(item.text) >= 5 &&
            inside(cell.rect, item) &&
            item.rect[0] < table.cropRect[0] - item.height &&
            item.rect[2] > cell.rect[2] + item.height
        )
    ).length >= 2
  )
    return false
  // A crop starting inside a native prose column can leave an unrelated
  // paragraph or list marker in its second model column. Reassemble only
  // word-spaced source lines, and require repeated long lines crossing the
  // left crop edge; isolated overhanging labels remain eligible.
  if (
    table.cropRect &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.every((row) => row.length === 2 && !row.some(measurement))
  ) {
    const [left, top, right, bottom] = table.cropRect
    const lines = []
    for (const item of pageItems
      .filter((i) => i.horizontal && i.rect[1] >= top && i.rect[3] <= bottom)
      .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
      const line = lines.find((g) => Math.abs(g[0].baseline - item.baseline) < item.height * 0.3)
      if (line) line.push(item)
      else lines.push([item])
    }
    const crossed = lines.filter((line) => {
      const chunks = []
      for (const item of line.sort((a, b) => a.rect[0] - b.rect[0])) {
        const prior = chunks.at(-1)
        if (prior && item.rect[0] - prior.at(-1).rect[2] < item.height) prior.push(item)
        else chunks.push([item])
      }
      return chunks.some(
        (g) =>
          g[0].rect[0] < left - 1 &&
          g.at(-1).rect[2] > left + (right - left) * 0.6 &&
          g.at(-1).rect[2] < right - g[0].height * 2 &&
          words(g.map((i) => i.text).join(' ')) >= 6
      )
    })
    if (crossed.length >= 2 && crossed.length >= lines.length * 0.6) return false
  }
  // A detector can split a long paragraph into one populated cell per row
  // while leaving the neighboring model column empty. Without a caption or
  // measured values this is unstructured page prose, not a table.
  if (
    !caption &&
    table.issues.includes('text-crosses-crop-boundary') &&
    table.grid.length >= 8 &&
    table.grid.filter((row) => row.filter((text) => text.trim()).length === 1).length >=
      table.grid.length * 0.75 &&
    table.grid.filter(
      (row) => row.filter((text) => text.trim()).length === 1 && words(row.join(' ')) >= 4
    ).length >=
      table.grid.length * 0.75 &&
    !table.grid.some((row) => row.some(measurement))
  )
    return false
  const proseRecords = table.grid.filter((row) => row.filter((text) => text.trim()).length >= 2)
  const dividedProse =
    proseRecords.length >= 2 &&
    table.grid.every(
      (row) => row.filter((text) => text.trim()).length <= 2 && !row.some(measurement)
    ) &&
    proseRecords.filter(
      (row) =>
        row.some((text) => /\p{L}/u.test(text)) && row.reduce((n, text) => n + words(text), 0) >= 7
    ).length >=
      proseRecords.length * 0.6
  if (dividedProse) {
    const crossed = (table.cells ?? []).filter(
      (cell) =>
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (a) =>
            a.rect &&
            inside(cell.rect, a) &&
            pageItems.some(
              (b) =>
                b.rect &&
                (b.rect[0] + b.rect[2]) / 2 >= cell.rect[2] &&
                b.rect[0] - a.rect[2] >= 0 &&
                b.rect[0] - a.rect[2] < a.height * 1.5 &&
                Math.abs(a.baseline - b.baseline) < a.height * 0.35
            )
        )
    )
    if (crossed.length >= 2 && crossed.length >= proseRecords.length * 0.6) return false
    // A detector can start in the tail of the neighboring prose column. The
    // apparent stub continues text outside the crop rather than naming a row.
    const paragraphTails = (table.cells ?? []).filter(
      (cell) =>
        table.cropRect &&
        cell.column === 0 &&
        cell.colSpan === 1 &&
        pageItems.some(
          (item) =>
            item.rect &&
            inside(cell.rect, item) &&
            pageItems.some(
              (before) =>
                before.rect &&
                before.rect[0] < table.cropRect[0] - item.height * 2 &&
                before.rect[2] <= item.rect[0] &&
                item.rect[0] - before.rect[2] < item.height * 1.5 &&
                Math.abs(before.baseline - item.baseline) < item.height * 0.35 &&
                /\p{L}/u.test(before.text)
            )
        )
    )
    if (paragraphTails.length >= 2 && paragraphTails.length >= proseRecords.length * 0.6)
      return false
  }
  const proseRows = table.grid.filter((row) => {
    const counts = row.map(words)
    return (
      row.length >= 2 &&
      (counts.every((count) => count >= 6) ||
        (mostlyUnassigned &&
          !row.some((text) => /^\s*[<>≤≥~±+−-]?(?:\d|[.,]\d)/u.test(text)) &&
          // A detached citation number is a prose continuation, not a numeric data column.
          counts.every((count, index) => count >= 2 || /^\[\d+\]$/.test(row[index].trim())) &&
          counts.some((count) => count >= 6) &&
          counts.reduce((sum, count) => sum + count, 0) >= 8))
    )
  })
  if (
    table.issues.includes('text-crosses-crop-boundary') &&
    proseRows.length > table.grid.length / 2
  )
    return false
  return populatedRows.filter((count) => count >= 2).length >= 2
}

// The fonts must be original whole native tokens, uniquely referenced across the
// complete page inventory. Source-bearing aliases outside a crop still compete.
export function proveNativeUniqueWholeFonts(fonts, inventory) {
  if (!Array.isArray(fonts) || !fonts.length || !Array.isArray(inventory)) return false
  const identity = (o) =>
    o &&
    Number.isInteger(o.pageNumber) &&
    o.pageNumber > 0 &&
    Number.isInteger(o.index) &&
    o.index >= 0
  const key = (o) => `${o.pageNumber}:${o.index}`
  const sourceKeys = new Set([
    'sourceItem',
    'sourceItems',
    'sourceSegment',
    'sourceSegments',
    'sourceToken',
    'sourceTokens'
  ])
  const walk = (value, visit, ancestors = new Set(), depth = 0) => {
    if (!value || typeof value !== 'object') return true
    if (depth > 16 || ancestors.has(value)) return false
    const next = new Set(ancestors)
    next.add(value)
    return visit(value) && Object.values(value).every((v) => walk(v, visit, next, depth + 1))
  }
  const counts = new Map()
  for (const item of inventory) {
    if (
      !walk(item, (o) => {
        if (identity(o)) counts.set(key(o), (counts.get(key(o)) ?? 0) + 1)
        return true
      })
    )
      return false
  }
  const present = new Set(inventory),
    used = new Set()
  return fonts.every((font) => {
    const origin = font?.sourceItem
    if (
      !present.has(font) ||
      !identity(origin) ||
      typeof origin.text !== 'string' ||
      !origin.text.trim() ||
      font.text !== origin.text ||
      counts.get(key(origin)) !== 1 ||
      used.has(key(origin)) ||
      !Array.isArray(font.rect) ||
      font.rect.length !== 4 ||
      !font.rect.every(Number.isFinite) ||
      font.rect[2] <= font.rect[0] ||
      font.rect[3] <= font.rect[1] ||
      !font.horizontal ||
      !Number.isFinite(font.baseline) ||
      !Number.isFinite(font.height) ||
      font.height <= 0
    )
      return false
    if (
      !Object.entries(font).every(
        ([name, value]) =>
          name === 'sourceItem' ||
          (!sourceKeys.has(name) &&
            walk(value, (o) => !Object.keys(o).some((k) => sourceKeys.has(k)) && !identity(o)))
      )
    )
      return false
    used.add(key(origin))
    return true
  })
}
