/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Source table tokens expose their page-space bounds through item.rect.
export const inside = (rect, item) => {
  const x = (item.rect[0] + item.rect[2]) / 2,
    y = (item.rect[1] + item.rect[3]) / 2
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]
}
export const union = (items) => [
  Math.min(...items.map((i) => i.rect[0])),
  Math.min(...items.map((i) => i.rect[1])),
  Math.max(...items.map((i) => i.rect[2])),
  Math.max(...items.map((i) => i.rect[3]))
]

// Place the caption cut in native whitespace, preserving any top border.
// Model row padding can start inside caption glyphs, so use owned source text.
export function tableCaptionCropTop(table, captionBottom, rules) {
  const source = table.cells.flatMap((cell) => cell.sourceRects)
  if (table.unassigned.length || !source.length)
    return Math.max(table.cropRect[1], captionBottom + 1.5)
  const firstText = Math.min(...source.map((r) => r[1]))
  if (firstText <= captionBottom) return table.cropRect[1]
  let top = (captionBottom + firstText) / 2
  for (const rule of rules) {
    if (
      rule[1] === rule[3] &&
      rule[1] > captionBottom &&
      rule[1] < top &&
      rule[0] <= table.cropRect[0] + 12 &&
      rule[2] >= table.cropRect[2] - 12
    )
      top = rule[1]
  }
  return Math.max(table.cropRect[1], top)
}

// Geometry shared by script assignment and row recovery. A baseline offset
// alone is insufficient: the glyph must tightly adjoin a larger source token.
export function isAdjacentTableScript(item, anchor) {
  const gap = item.rect[0] - anchor.rect[2]
  const shift = Math.abs(item.baseline - anchor.baseline)
  return (
    item.horizontal &&
    anchor.horizontal &&
    (item.height < anchor.height * 0.8 ||
      (/^[a-z]$/.test(item.text) && item.height < anchor.height * 0.9) ||
      ((item.inlineSymbol || /^[′″]$/.test(item.text)) &&
        !anchor.inlineSymbol &&
        item.height <= anchor.height * 1.1)) &&
    shift > anchor.height * 0.08 &&
    shift <= anchor.height * 0.5 &&
    gap >=
      -Math.max(
        anchor.height * 0.1,
        Math.min(anchor.height * 0.15, (item.rect[2] - item.rect[0]) * 0.5)
      ) &&
    gap <= anchor.height * 0.35
  )
}

// Model boxes are crop-relative. Keep their page-space positions invariant
// whenever native source evidence corrects a detector crop.
export function rebaseTableCrop(table, cropRect) {
  return {
    ...table,
    cropRect,
    structure: {
      ...table.structure,
      objects: table.structure.objects.map((object) => ({
        ...object,
        rect: object.rect.map((v, i) => v + table.cropRect[i % 2] - cropRect[i % 2])
      }))
    }
  }
}
