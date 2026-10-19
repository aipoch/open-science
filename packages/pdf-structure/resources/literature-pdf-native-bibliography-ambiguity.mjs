/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'

// A complete pair of hanging citations can resemble a two-row table. Preserve
// the detected image and literal fields, but do not impose row-major ownership
// on a native stream that proves two independent bibliographic records.
export function hasNativeBibliographyAmbiguity(proof, table, inventory, rules, captions) {
  if (
    !proof ||
    table.grid.length !== 2 ||
    table.grid.some((row) => row.length !== 2) ||
    table.cells.length !== 4 ||
    proof.proved.length !== 4 ||
    proof.proved.some(
      ({ cell, fonts }) =>
        fonts.length !== 1 ||
        cell.rowSpan !== 1 ||
        cell.colSpan !== 1 ||
        cell.text !== fonts[0].text
    )
  )
    return false
  const lanes = [0, 1].map((column) =>
    proof.proved
      .filter(({ cell }) => cell.column === column)
      .sort((a, b) => a.cell.row - b.cell.row)
      .map(({ fonts }) => fonts[0])
  )
  if (lanes.some((lane) => lane.length !== 2)) return false
  const fonts = lanes.flat(),
    h = fonts[0].height,
    box = [
      Math.min(...fonts.map((i) => i.rect[0])),
      Math.min(...fonts.map((i) => i.rect[1])),
      Math.max(...fonts.map((i) => i.rect[2])),
      Math.max(...fonts.map((i) => i.rect[3]))
    ],
    overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
  if (
    fonts.some((i) => Math.abs(i.height - h) > h * 0.05) ||
    new Set(fonts.map((i) => i.sourceItem.pageNumber)).size !== 1 ||
    fonts.some((i, n) => n && i.sourceItem.index <= fonts[n - 1].sourceItem.index) ||
    Math.max(...lanes[0].map((i) => i.rect[2])) + h * 2 >= lanes[1][0].rect[0] ||
    lanes.some(([head, tail]) => {
      const indent = tail.rect[0] - head.rect[0],
        rhythm = tail.baseline - head.baseline
      return (
        !/^\p{L}[\p{L}\p{M}'’.-]+,\s+\p{Lu}\./u.test(head.text) ||
        !/\b(?:19|20)\d{2},/u.test(head.text) ||
        !/\bdoi:\s*10\.\d{4,9}\/[A-Z0-9._;()/:-]+\s*$/iu.test(tail.text) ||
        head.rect[2] - head.rect[0] < h * 12 ||
        tail.rect[2] >= head.rect[2] ||
        indent < h * 0.4 ||
        indent > h * 1.5 ||
        rhythm < h ||
        rhythm > h * 2 ||
        tail.rect[1] <= head.rect[3]
      )
    }) ||
    lanes[0].some((i, row) => Math.abs(i.baseline - lanes[1][row].baseline) > h * 0.05) ||
    Math.abs(
      lanes[0][1].rect[0] - lanes[0][0].rect[0] - (lanes[1][1].rect[0] - lanes[1][0].rect[0])
    ) >
      h * 0.1
  )
    return false
  const headings = inventory.filter(
    (i) =>
      /^(?:References|Bibliography)$/iu.test(i.text ?? '') &&
      i.rect?.[3] < box[1] &&
      box[1] - i.rect[3] < h * 3 &&
      i.height >= h &&
      i.height <= h * 1.5 &&
      Math.abs((i.rect[0] + i.rect[2]) / 2 - (box[0] + box[2]) / 2) < h &&
      i.sourceItem?.index < fonts[0].sourceItem.index
  )
  if (headings.length !== 1) return false
  const heading = headings[0],
    owned = [...fonts, heading],
    envelope = [box[0], heading.rect[1], box[2], box[3]]
  return (
    proveNativeUniqueWholeFonts(owned, inventory) &&
    heading.sourceItem.pageNumber === fonts[0].sourceItem.pageNumber &&
    (table.unassigned ?? []).every((text) => text === heading.text) &&
    !inventory.some(
      (i) =>
        i.text?.trim() && !owned.includes(i) && (!proof.rect(i.rect) || overlaps(i.rect, envelope))
    ) &&
    !rules.some((rule) => overlaps(rule, envelope)) &&
    !captions.some(
      (caption) =>
        /^Table\b/iu.test(caption.lines?.[0] ?? '') &&
        (!caption.rect ||
          overlaps(caption.rect, [box[0], envelope[1] - h * 5, box[2], box[3] + h * 5]))
    )
  )
}
