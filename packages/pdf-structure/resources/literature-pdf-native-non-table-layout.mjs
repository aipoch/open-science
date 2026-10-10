/* eslint-disable @typescript-eslint/explicit-function-return-type */

// These proofs use native paragraph/ordinal ownership, never detector confidence.
// A caption or a spanning native table rule remains the caller's stronger evidence.
function wholeNativeRows(frame, items, rules) {
  if (
    frame.length !== 4 ||
    !frame.every(Number.isFinite) ||
    frame[2] <= frame[0] ||
    frame[3] <= frame[1] ||
    rules.some((r) => r.length !== 4 || !r.every(Number.isFinite)) ||
    // Unknown coordinates cannot prove that a meaningful native field is
    // external to this crop. Check them before selecting the owned subset.
    items.some((i) => i.text?.trim() && (i.rect?.length !== 4 || !i.rect.every(Number.isFinite)))
  )
    return undefined
  const source = items.filter(
    (i) =>
      i.rect?.length === 4 &&
      i.rect[2] > frame[0] &&
      i.rect[0] < frame[2] &&
      i.rect[3] > frame[1] &&
      i.rect[1] < frame[3]
  )
  if (
    !source.length ||
    source.some(
      (i) =>
        !i.horizontal ||
        !i.text?.trim() ||
        !i.rect.every(Number.isFinite) ||
        !Number.isFinite(i.height) ||
        !Number.isFinite(i.baseline) ||
        i.height <= 0 ||
        i.rect[2] <= i.rect[0] ||
        Math.abs(i.height - (i.rect[3] - i.rect[1])) > 1e-7 ||
        Math.abs(i.baseline - i.rect[3]) > 1e-7 ||
        i.rect[0] < frame[0] ||
        i.rect[1] < frame[1] ||
        i.rect[2] > frame[2] ||
        i.rect[3] > frame[3]
    ) ||
    source.some((i, n) =>
      source
        .slice(n + 1)
        .some((p) => p.text === i.text && p.rect.every((v, k) => Math.abs(v - i.rect[k]) < 1e-7))
    )
  )
    return undefined
  const rows = []
  for (const i of [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = rows.find(
      (r) => Math.abs(r[0].baseline - i.baseline) < Math.min(r[0].height, i.height) * 0.15
    )
    if (row) row.push(i)
    else rows.push([i])
  }
  rows.forEach((r) => r.sort((a, b) => a.rect[0] - b.rect[0]))
  return rows
}

function hasWholeFontContents(rows, left, width) {
  if (
    !rows ||
    rows[0].length !== 1 ||
    !/^Contents$/i.test(rows[0][0].text.trim()) ||
    rows.slice(1).some((r) => r.length !== 2)
  )
    return false
  const entries = rows.slice(1).map((r) => ({
    title: r[0],
    target: r[1],
    match: /^([A-Z])(\d+)\.\s+(.+)$/u.exec(r[0].text.trim())
  }))
  if (
    entries.length < 4 ||
    entries.some(
      (r) => !r.match || !/\p{L}{2}/u.test(r.match[3]) || !/^\d+$/.test(r.target.text.trim())
    )
  )
    return false
  const em = entries[0].title.height
  return entries.every(
    (r, n) =>
      Math.abs(r.title.height - em) < 1e-7 &&
      Math.abs(r.target.height - em) < 1e-7 &&
      r.title.rect[0] <= left + width * 0.2 &&
      r.target.rect[0] >= left + width * 0.8 &&
      r.target.rect[0] - r.title.rect[2] >= em * 3 &&
      Math.abs(r.target.rect[2] - entries[0].target.rect[2]) <= em * 0.2 &&
      Math.abs(r.title.rect[0] - entries[0].title.rect[0]) <= em * 0.6 &&
      (!n ||
        (r.match[1] === entries[0].match[1] &&
          Number(r.match[2]) === Number(entries[n - 1].match[2]) + 1 &&
          Number(r.target.text) >= Number(entries[n - 1].target.text) &&
          r.title.baseline - entries[n - 1].title.baseline >= em * 1.2 &&
          r.title.baseline - entries[n - 1].title.baseline <= em * 3.5))
  )
}

function hasWholeFontNumberedReferences(rows, table, left, width) {
  if (!rows) return false
  const starts = rows.filter((r) => /^\d+\.$/.test(r[0].text.trim()) && r.length >= 2)
  if (starts.length < 3 || starts[0] !== rows[0]) return false
  const em = starts[0][0].height,
    margin = starts[0][0].rect[0],
    bodyLeft = starts[0][1].rect[0]
  if (
    starts.some(
      (r, n) =>
        Math.abs(r[0].rect[0] - margin) > em * 0.2 ||
        Math.abs(r[1].rect[0] - bodyLeft) > em * 0.2 ||
        r[1].rect[0] - r[0].rect[2] < em ||
        bodyLeft - margin < em * 2 ||
        bodyLeft - margin > em * 4 ||
        (n && Number(r[0].text.slice(0, -1)) !== Number(starts[n - 1][0].text.slice(0, -1)) + 1)
    )
  )
    return false
  const paragraphs = []
  for (const row of rows) {
    if (row.some((i) => Math.abs(i.height - em) > 1e-7)) return false
    if (starts.includes(row)) paragraphs.push([row.slice(1)])
    else {
      const paragraph = paragraphs.at(-1),
        previous = paragraph?.at(-1)
      if (!paragraph) return false
      // An isolated last page ordinal is external to the citation paragraphs.
      // Require its complete font, common margin and independent lower gap.
      if (
        row.length === 1 &&
        /^\d+$/.test(row[0].text.trim()) &&
        row === rows.at(-1) &&
        Math.abs(row[0].rect[0] - margin) < em * 0.2 &&
        row[0].baseline - previous[0].baseline > em * 3
      )
        continue
      if (
        Math.abs(row[0].rect[0] - margin) > em * 0.2 ||
        row[0].baseline - previous[0].baseline < em * 1.5 ||
        row[0].baseline - previous[0].baseline > em * 3
      )
        return false
      paragraph.push(row)
    }
  }
  if (
    paragraphs.some((paragraph) => {
      const text = paragraph.map((r) => r.map((i) => i.text).join('')).join(' ')
      return (
        !/^\p{Lu}[\p{L}’'-]+,\s*\p{Lu}\./u.test(text) ||
        (text.match(/\p{L}{2,}/gu) ?? []).length < 5 ||
        !(
          /\((?:19|20)\d{2}[a-z]?\)\.?\s*$/.test(text) ||
          /https:\/\/(?:dx\.)?doi\.org\/10\.\d+\/[\w./-]+\.?\s*$/.test(text)
        ) ||
        paragraph[0].at(-1).rect[2] - bodyLeft < width * 0.5 ||
        paragraph.some((r) =>
          r.some(
            (i, n) => n && (i.rect[0] - r[n - 1].rect[2] > em * 0.9 || i.rect[0] < r[n - 1].rect[0])
          )
        )
      )
    })
  )
    return false
  const cuts = [
    ...new Set(
      (table.cells ?? [])
        .filter((c) => c.colSpan === 1)
        .map((c) => c.rect?.[2])
        .filter((x) => Number.isFinite(x) && x > left + em && x < left + width - em)
    )
  ]
  // A complete continuation crosses the detector's cell division. No font or
  // fragment may be sliced into an independent citation comparison field.
  return paragraphs.some((paragraph) =>
    paragraph
      .slice(1)
      .some((r) => r.some((i) => cuts.some((x) => i.rect[0] < x - em && i.rect[2] > x + em)))
  )
}

export function hasNativeNonTableLayout(table, items, rules) {
  if (!table.cropRect || !Array.isArray(rules)) return false
  const [left, top, right, bottom] = table.cropRect,
    width = right - left
  const source = items.filter(
    (i) =>
      i.horizontal &&
      i.height > 0 &&
      i.rect[3] > top &&
      i.rect[1] < bottom &&
      i.rect[2] > left &&
      i.rect[0] < right
  )
  if (
    !source.length ||
    rules.some(
      (r) => Math.abs(r[3] - r[1]) < 1 && r[1] >= top && r[3] <= bottom && r[2] - r[0] > width * 0.5
    )
  )
    return false
  // Some directories print each section ordinal and its entire title as one
  // native font. Preserve that whole font; two complete lanes and all repeated
  // navigation roles must close before treating the page numbers as prose.
  const wholeRows = wholeNativeRows(table.cropRect, items, rules)
  if (hasWholeFontContents(wholeRows, left, width)) return true
  if (hasWholeFontNumberedReferences(wholeRows, table, left, width)) return true
  const rows = []
  for (const item of [...source].sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    const row = rows.find(
      (r) =>
        Math.abs(r[0].baseline - item.baseline) < Math.min(r[0].height, item.height) * 0.2 &&
        Math.min(r[0].height, item.height) > Math.max(r[0].height, item.height) * 0.8
    )
    if (row) row.push(item)
    else rows.push([item])
  }
  const chains = rows.flatMap((row) => {
    const groups = []
    for (const item of row.sort((a, b) => a.rect[0] - b.rect[0])) {
      const group = groups.at(-1),
        previous = group?.at(-1)
      if (
        previous &&
        item.rect[0] - previous.rect[2] < Math.min(item.height, previous.height) * 0.9
      )
        group.push(item)
      else groups.push([item])
    }
    return groups
  })
  const paragraphs = chains.map((chain) => ({
    text: chain.map((i) => i.text).join(''),
    left: chain[0].rect[0],
    right: chain.at(-1).rect[2],
    y: chain[0].rect[1],
    bottom: chain[0].rect[3],
    em: chain[0].height
  }))
  // Page ordinals in a section directory are navigation targets, not measured
  // records. Require the native title and independently printed section/title/
  // page lanes before the scalar-record escape below; ruled tables declined above.
  const contentsTitle = source.filter((i) => /^Contents$/i.test(i.text.trim()))
  if (contentsTitle.length === 1) {
    const entries = rows.flatMap((row) => {
      const ordered = [...row].sort((a, b) => a.rect[0] - b.rect[0]),
        ordinal = ordered[0],
        target = ordered.at(-1),
        middle = ordered.slice(1, -1)
      if (
        !ordinal ||
        !target ||
        !middle.length ||
        !/^\d+\.$/.test(ordinal.text.trim()) ||
        !/^\d+$/.test(target.text.trim()) ||
        ordinal.baseline <= contentsTitle[0].baseline ||
        target.rect[0] < left + width * 0.8 ||
        target.rect[0] - middle.at(-1).rect[2] < target.height ||
        !middle.some((i) => /\p{L}{2}/u.test(i.text))
      )
        return []
      return [{ ordinal: Number(ordinal.text.slice(0, -1)), page: Number(target.text), target }]
    })
    if (
      entries.length >= 4 &&
      entries.every(
        (entry, n) =>
          !n ||
          (entry.ordinal === entries[n - 1].ordinal + 1 &&
            entry.page >= entries[n - 1].page &&
            Math.abs(entry.target.rect[2] - entries[0].target.rect[2]) < entry.target.height)
      )
    )
      return true
  }
  const independentScalars = (table.cells ?? []).filter(
    (cell) =>
      /^[-+−]?\d+(?:\.\d+)?(?:\s*\([^)]*\))?$/.test(cell.text.trim()) &&
      source.some(
        (i) =>
          i.text.trim() === cell.text.trim() &&
          i.rect[0] >= cell.rect[0] &&
          i.rect[2] <= cell.rect[2] &&
          source.some(
            (peer) =>
              peer !== i &&
              Math.abs(peer.baseline - i.baseline) < Math.min(i.height, peer.height) * 0.2 &&
              Math.min(peer.height, i.height) >= Math.max(peer.height, i.height) * 0.8 &&
              peer.rect[2] <= cell.rect[0] &&
              i.rect[0] - peer.rect[2] > i.height * 2
          )
      )
  )
  const cuts = [
    ...new Set(
      (table.cells ?? [])
        .filter((c) => c.colSpan === 1)
        .map((c) => c.rect[2])
        .filter((x) => x > left + 2 && x < right - 2)
    )
  ]
  const citations = paragraphs.filter(
    (p) =>
      /^\p{Lu}[\p{L}’'-]+,\s*\p{Lu}\./u.test(p.text) &&
      /\b(?:19|20)\d{2}[a-z]?(?:,|\s)/.test(p.text) &&
      (p.text.match(/\p{L}{2,}/gu) ?? []).length >= 5 &&
      p.right - p.left > width * 0.25
  )
  // Independent citation fields in a comparison do not form long, repeated
  // author/year paragraphs at each native prose-column margin.
  const citationMargins = []
  for (const p of citations) {
    const margin = citationMargins.find((g) => Math.abs(g[0].left - p.left) < p.em * 0.3)
    if (margin) margin.push(p)
    else citationMargins.push([p])
  }
  const proseScalar = (cell) =>
    citationMargins.some(
      (g) =>
        g.length >= 3 &&
        source.some(
          (i) =>
            i.text.trim() === cell.text.trim() &&
            i.rect[0] >= g[0].left &&
            i.rect[2] <= Math.max(...g.map((p) => p.right)) + i.height &&
            i.rect[1] >= Math.min(...g.map((p) => p.y)) &&
            i.rect[3] <= Math.max(...g.map((p) => p.bottom)) + i.height * 2
        )
    )
  const measured = independentScalars.filter((cell) => !proseScalar(cell))
  if (
    measured.some((cell) =>
      measured.some((peer) => peer.row !== cell.row && peer.column === cell.column)
    )
  )
    return false
  if (
    citationMargins.some((g) => {
      if (
        g.length < 3 ||
        g.length <
          paragraphs.filter(
            (p) => Math.abs(p.left - g[0].left) < p.em * 0.3 && p.right - p.left > width * 0.25
          ).length *
            0.6
      )
        return false
      const independentPeers = paragraphs.filter(
        (p) =>
          !citations.includes(p) &&
          !(p.right > right + p.em * 2 && right - p.left < (p.right - p.left) * 0.2) &&
          !citationMargins.some(
            (m) =>
              m.length >= 3 &&
              p.left >= m[0].left &&
              p.left < m[0].left + p.em * 2 &&
              p.right <= Math.max(...m.map((c) => c.right)) + p.em
          ) &&
          (p.text.match(/\p{L}{2,}/gu) ?? []).length >= 3 &&
          g.some(
            (c) =>
              Math.abs(c.y - p.y) < c.em * 0.2 &&
              (p.left > c.right + c.em * 2 || c.left > p.right + c.em * 2)
          )
      )
      return independentPeers.length < 3
    })
  )
    return true

  const labels = source.filter(
    (i) => /^\((?:[A-Z]\.)?\d+(?:\.\d+)*\)$/.test(i.text.trim()) && i.rect[0] > left + width * 0.8
  )
  const text = table.grid.flat().join(' ')
  const alignedLabels =
    labels.length >= 2 &&
    labels.every(
      (i) =>
        Math.abs(i.rect[0] - labels[0].rect[0]) < i.height * 0.2 && text.includes(i.text.trim())
    )
  const crossedMathRows = chains.filter(
    (g) =>
      cuts.some((x) => g[0].rect[0] < x - g[0].height && g.at(-1).rect[2] > x + g[0].height) &&
      g.some((i) => /[=≤≥⪰∥∇⇒]/.test(i.text))
  )
  const introductions = paragraphs.filter(
    (p) =>
      /^(?:\p{L}+\s+){2}\p{L}+/u.test(p.text) &&
      p.left < left + width * 0.1 &&
      p.right - p.left > width * 0.16
  )
  if (
    alignedLabels &&
    crossedMathRows.length >= 2 &&
    introductions.length >= 2 &&
    labels.every((label) =>
      source.some(
        (i) =>
          /[=≤≥⪰∥∇⇒]/.test(i.text) &&
          Math.abs(i.baseline - label.baseline) < label.height * 5 &&
          i.rect[2] < label.rect[0] - label.height * 2
      )
    )
  )
    return true

  // Parallel page footnotes have short separators, smaller raised ordinals,
  // indented opening prose and a following line at the separator's left edge.
  // A small numeric detector cell does not establish an independent record.
  const noteRules = rules.filter(
    (r) =>
      Math.abs(r[3] - r[1]) < 1 &&
      r[1] >= top &&
      r[1] <= bottom &&
      r[2] - r[0] > width * 0.2 &&
      r[2] - r[0] < width * 0.5
  )
  const nativeNotes = noteRules.filter((r) => {
    const marker = source.find(
      (i) =>
        /^\d{1,3}$/.test(i.text.trim()) &&
        Math.abs(i.rect[0] - r[0]) < i.height * 0.3 &&
        i.rect[1] >= r[1] &&
        i.rect[1] - r[1] < i.height * 0.4
    )
    if (!marker) return false
    return (
      source.some(
        (i) =>
          i.height > marker.height * 1.4 &&
          Math.abs(i.rect[1] - marker.rect[1]) < marker.height * 0.2 &&
          i.rect[0] > marker.rect[2] &&
          i.rect[0] - marker.rect[2] < i.height &&
          (i.text.match(/\p{L}{2,}/gu) ?? []).length >= 5
      ) &&
      source.some(
        (i) =>
          i.height > marker.height * 1.4 &&
          Math.abs(i.rect[0] - r[0]) < i.height * 0.2 &&
          i.rect[1] > marker.rect[1] + marker.height &&
          i.rect[1] < marker.rect[1] + marker.height * 3 &&
          /\p{L}/u.test(i.text)
      )
    )
  })
  return (
    nativeNotes.length >= 1 &&
    noteRules.length >= 2 &&
    table.grid.length <= 3 &&
    table.grid.every((row) => row.length <= 2) &&
    paragraphs.filter(
      (p) => (p.text.match(/\p{L}{2,}/gu) ?? []).length >= 5 && p.right - p.left > width * 0.6
    ).length >= 2
  )
}
