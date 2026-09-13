/* eslint-disable @typescript-eslint/explicit-function-return-type */
const union = (rects) => [
  Math.min(...rects.map((r) => r[0])),
  Math.min(...rects.map((r) => r[1])),
  Math.max(...rects.map((r) => r[2])),
  Math.max(...rects.map((r) => r[3]))
]
const bounds = (table) => {
  const rows = union(table.rows.map((row) => row.rect))
  return [table.cropRect[0], rows[1], table.cropRect[2], rows[3]].map((v) => v / 1.5)
}
const lineRect = (line) => [line.x, line.y, line.x + line.width, line.y + line.height]

// Group only explicit, consecutive A/B/... sections on one page with a shared
// table caption. Column counts may differ: each part retains its own grid.
export function groupTableParts(tables, page) {
  const continued = [...tables]
  for (const first of [...continued]) {
    if (first.caption || !first.grid?.length) continue
    const rect = first.cropRect.map((v) => v / 1.5)
    const footer = page.lines.find(
      (line) =>
        /^\(Table\s+\d+\s+continued on next column\)$/i.test(line.text) &&
        line.x >= rect[0] &&
        line.x + line.width <= rect[2] &&
        Math.abs(line.y + line.height - rect[3]) <= line.height * 3
    )
    if (!footer) continue
    const number = footer.text.match(/Table\s+(\d+)/i)[1]
    const next = continued.find(
      (table) =>
        table !== first &&
        table.page === first.page &&
        table.caption?.text.match(/^Table\s+(\d+)\b/i)?.[1] === number &&
        table.grid?.[1]?.[0]?.trim() === '(Continued from previous column)' &&
        table.grid[1].slice(1).every((text) => !text) &&
        JSON.stringify(table.grid[0]) === JSON.stringify(first.grid[0]) &&
        table.cropRect[0] >= first.cropRect[2] &&
        table.cropRect[0] - first.cropRect[2] <= (first.cropRect[2] - first.cropRect[0]) * 0.25 &&
        Math.abs(table.cropRect[1] - first.cropRect[1]) <= 18
    )
    if (!next) continue
    const offset = first.grid.length - 2
    continued.splice(continued.indexOf(first), 1, {
      ...first,
      caption: next.caption,
      captionIssue: next.captionIssue,
      cropRect: union([first.cropRect, next.cropRect]),
      grid: [...first.grid, ...next.grid.slice(2)],
      cells: [
        ...first.cells,
        ...next.cells
          .filter((cell) => cell.row >= 2)
          .map((cell) => ({ ...cell, row: cell.row + offset }))
      ],
      rows: [...first.rows, ...next.rows.slice(2)],
      notes: [...(first.notes ?? []), ...(next.notes ?? [])],
      unassigned: [...first.unassigned, ...next.unassigned],
      issues: [...new Set([...first.issues, ...next.issues])]
    })
    continued.splice(continued.indexOf(next), 1)
  }
  // Side-by-side continuations repeat the header and explicitly identify the
  // same table. Source column order takes precedence over a slightly higher
  // top edge on the continuation column.
  for (const next of [...continued]) {
    const number = /^Table\s+(\d+)[.]?\s*\(?continued\)?[.]?$/i.exec(next.caption?.text ?? '')?.[1]
    if (!number || !next.grid?.length || next.parts) continue
    const candidates = continued.filter(
      (first) =>
        first !== next &&
        !first.parts &&
        first.page === next.page &&
        first.caption?.text.match(/^Table\s+(\d+)\b/i)?.[1] === number &&
        !/\bcontinued\b/i.test(first.caption.text) &&
        JSON.stringify(first.grid?.[0]) === JSON.stringify(next.grid[0]) &&
        first.cropRect[2] <= next.cropRect[0] &&
        next.cropRect[0] - first.cropRect[2] <= (first.cropRect[2] - first.cropRect[0]) * 0.3 &&
        Math.abs(first.cropRect[1] - next.cropRect[1]) <= 30 &&
        Math.min(first.cropRect[3], next.cropRect[3]) -
          Math.max(first.cropRect[1], next.cropRect[1]) >
          Math.min(first.cropRect[3] - first.cropRect[1], next.cropRect[3] - next.cropRect[1]) * 0.5
    )
    if (candidates.length !== 1) continue
    const first = candidates[0],
      offset = first.grid.length - 1
    // Once both columns establish the continuation, a matching footer below
    // the last source row is navigation text, even if PDF tokens split it.
    const footer =
      first.unassigned.join('').replace(/\s/g, '') === '(Continued)' &&
      page.lines.find(
        (line) =>
          /^\(Continued\s*\)$/i.test(line.text) &&
          line.y * 1.5 >= Math.max(...first.rows.map((row) => row.rect[3])) &&
          line.y * 1.5 - Math.max(...first.rows.map((row) => row.rect[3])) <= line.height * 3 &&
          line.x * 1.5 >= first.cropRect[0] &&
          (line.x + line.width) * 1.5 <= first.cropRect[2] + line.height &&
          Math.abs((line.y + line.height) * 1.5 - first.cropRect[3]) <= line.height * 3
      )
    const clipped = footer
      ? (first.clipped ?? []).filter((item) => {
          const rect = lineRect(footer).map((v) => v * 1.5)
          return (
            item.rect[0] < rect[0] - 1 ||
            item.rect[1] < rect[1] - 1 ||
            item.rect[2] > rect[2] + 1 ||
            item.rect[3] > rect[3] + 1
          )
        })
      : first.clipped
    continued.splice(continued.indexOf(first), 1, {
      ...first,
      cropRect: union([
        footer
          ? [
              first.cropRect[0],
              first.cropRect[1],
              first.cropRect[2],
              Math.min(first.cropRect[3], footer.y * 1.5 - 1)
            ]
          : first.cropRect,
        next.cropRect
      ]),
      grid: [...first.grid, ...next.grid.slice(1)],
      cells: [
        ...first.cells,
        ...next.cells.filter((c) => c.row >= 1).map((c) => ({ ...c, row: c.row + offset }))
      ],
      rows: [...first.rows, ...next.rows.slice(1)],
      notes: [...(first.notes ?? []), ...(next.notes ?? [])],
      unassigned: [...(footer ? [] : first.unassigned), ...next.unassigned],
      ...(footer ? { clipped: [...clipped, ...(next.clipped ?? [])] } : {}),
      issues: [
        ...new Set([
          ...first.issues.filter(
            (issue) =>
              !footer ||
              (issue !== 'unassigned-source-text' &&
                (issue !== 'text-crosses-crop-boundary' || clipped.length))
          ),
          ...next.issues
        ])
      ]
    })
    continued.splice(continued.indexOf(next), 1)
  }
  const ordered = continued.sort((a, b) => a.cropRect[1] - b.cropRect[1])
  const heading = (table) => {
    const rect = bounds(table)
    return page.lines
      .filter(
        (line) =>
          /^[A-Z][.)]\s+\p{L}/u.test(line.text) &&
          line.y + line.height <= rect[1] &&
          rect[1] - line.y <= line.height * 4 &&
          line.x >= rect[0] - 2 &&
          line.x + line.width <= rect[2] + 2
      )
      .sort((a, b) => b.y - a.y)[0]
  }
  const result = []
  for (let i = 0; i < ordered.length; i++) {
    const first = ordered[i]
    const firstHeading = first.rows.length && heading(first)
    if (
      !first.caption ||
      !firstHeading ||
      firstHeading.text[0] !== 'A' ||
      first.caption.rect[3] > firstHeading.y ||
      firstHeading.y - first.caption.rect[3] > 60
    ) {
      result.push(first)
      continue
    }
    const members = [first],
      headings = [firstHeading]
    while (i + members.length < ordered.length && members.length < 8) {
      const previous = members.at(-1),
        next = ordered[i + members.length]
      const label = next.rows.length && heading(next)
      const prior = bounds(previous),
        rect = bounds(next)
      if (
        previous.notes?.length ||
        next.page !== first.page ||
        next.caption ||
        !label ||
        label.text.charCodeAt(0) !== 65 + members.length ||
        label.y < prior[3] ||
        label.y - prior[3] > label.height * 4 ||
        Math.abs(rect[0] - prior[0]) > 12 ||
        (Math.min(rect[2], prior[2]) - Math.max(rect[0], prior[0])) /
          Math.max(rect[2] - rect[0], prior[2] - prior[0]) <
          0.85 ||
        page.lines.some(
          (line) =>
            line !== label &&
            line.y >= prior[3] &&
            line.y + line.height <= rect[1] &&
            line.x < rect[2] &&
            line.x + line.width > rect[0]
        )
      )
        break
      members.push(next)
      headings.push(label)
    }
    if (members.length === 1) {
      result.push(first)
      continue
    }
    const notes = members.at(-1).notes ?? []
    const rect = union([
      ...members.map((member) => member.cropRect.map((v) => v / 1.5)),
      first.caption.rect,
      ...headings.map(lineRect),
      ...notes.map((note) => note.rect)
    ])
    result.push({
      id: first.id,
      page: first.page,
      caption: first.caption,
      notes,
      cropRect: rect.map((v) => v * 1.5),
      parts: members.map((member, index) => ({
        title: headings[index].text,
        sourceViewport: member.sourceViewport,
        grid: member.grid,
        cells: member.cells,
        unassigned: member.unassigned,
        issues: member.issues,
        notes: []
      }))
    })
    i += members.length - 1
  }
  return result
}
