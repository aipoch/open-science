/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { area, intersection, union } from './literature-pdf-page-geometry.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'

// A diagram's framed nodes own enclosed native text. Separate annotation fonts
// must be complete page-local packets, aligned to those nodes and close to the
// existing graphic; a font that continues in prose cannot prove ownership.
export function nativeNodeFigureLabels(page, figure, captions, tables, frames, tokens, context) {
  const bound = figure.rect
  if (!bound || !figure.caption || !context?.content?.items || page.rotation !== 0) return
  const contains = (outer, inner) =>
    inner.every((v, i) => (i < 2 ? v >= outer[i] - 0.01 : v <= outer[i] + 0.01))
  const inventory = tokens.filter(
    (t) =>
      t.sourceItem?.pageNumber === page.pageNumber && t.text === t.sourceItem.text && t.text.trim()
  )
  const nodes = frames.filter(
    (r) =>
      contains(bound, r) &&
      area(r) < area(bound) * 0.8 &&
      inventory.some((t) => contains(r, t.rect))
  )
  if (
    nodes.length < 3 ||
    nodes.some((r, i) => nodes.some((s, j) => i !== j && intersection(r, s) > 0)) ||
    page.graphicsBounds.some(
      (g) =>
        g.kind === 'image' &&
        intersection(
          g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
          bound
        ) > 0
    )
  )
    return
  const font = (t) => context.content.items[t.sourceItem.index]?.fontName
  const groups = new Map()
  for (const token of inventory) {
    const native = context.content.items[token.sourceItem.index]
    if (!native?.fontName || native.str !== token.text) return
    if (!groups.has(native.fontName)) groups.set(native.fontName, [])
    groups.get(native.fontName).push(token)
  }
  const conflict = (r) =>
    tables.some((t) => intersection(t, r) > 0) ||
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, r) > 0)
  const near = (t) => {
    if (!t.horizontal || !(t.height > 0) || conflict(t.rect)) return false
    if (contains(bound, t.rect)) return true
    const [left, top, right, bottom] = t.rect,
      h = t.height
    const side =
      top >= bound[1] &&
      bottom <= bound[3] &&
      ((right <= bound[0] + 0.5 && bound[0] - right <= h * 2) ||
        (left >= bound[2] - 0.5 && left - bound[2] <= h * 2)) &&
      nodes.some((r) => (top + bottom) / 2 >= r[1] && (top + bottom) / 2 <= r[3])
    const above =
      left >= bound[0] &&
      right <= bound[2] &&
      bottom <= bound[1] &&
      bound[1] - bottom <= h * 2 &&
      nodes.some((r) => (left + right) / 2 >= r[0] && (left + right) / 2 <= r[2])
    return side || above
  }
  const centre = (t) => (t.rect[0] + t.rect[2]) / 2
  const enclosing = frames.filter(
    (r) =>
      contains(bound, r) &&
      area(r) >= area(bound) * 0.8 &&
      nodes.every((n) => n.every((v, i) => (i < 2 ? v >= r[i] - 0.5 : v <= r[i] + 0.5)))
  )
  const packets = [...groups.values()].filter((group) => {
    if (
      !group.every(near) ||
      context.content.items.filter((i) => i.str?.trim() && i.fontName === font(group[0])).length !==
        group.length
    )
      return false
    const above = group.filter((t) => t.rect[3] <= bound[1])
    const inside = group.filter((t) => contains(bound, t.rect))
    const sides = group.filter((t) => !contains(bound, t.rect) && !above.includes(t))
    const rowNode = (t) =>
      nodes.find((r) => (t.rect[1] + t.rect[3]) / 2 >= r[1] && (t.rect[1] + t.rect[3]) / 2 <= r[3])
    if (
      sides.some(
        (t) =>
          !inside.some((peer) => Math.abs(t.height - peer.height) <= 0.01) &&
          !sides.some(
            (peer) =>
              peer !== t && rowNode(peer) !== rowNode(t) && Math.abs(t.height - peer.height) <= 0.01
          )
      )
    )
      return false
    // An independent heading font is not sufficient: require the title of an
    // enclosing frame, or repeated columns matching titles inside the diagram.
    return above.every(
      (t) =>
        enclosing.some((r) => Math.abs(centre(t) - (r[0] + r[2]) / 2) <= t.height * 0.2) ||
        (above.length >= 2 &&
          inside.length >= 2 &&
          inside.some(
            (peer) =>
              Math.abs(centre(t) - centre(peer)) <= t.height * 0.2 &&
              Math.abs(t.height - peer.height) <= 0.01
          ))
    )
  })
  const labels = packets.flat()
  if (!labels.some((t) => !contains(bound, t.rect))) return
  const rect = union([bound, ...labels.map((t) => t.rect)])
  if (conflict(rect)) return
  // Every newly included native item must belong to a complete proved packet.
  if (
    tokens.some(
      (t) => intersection(t.rect, rect) > intersection(t.rect, bound) + 0.01 && !labels.includes(t)
    )
  )
    return
  const owned = inventory.filter(
    (t) => contains(rect, t.rect) && (labels.includes(t) || nodes.some((r) => contains(r, t.rect)))
  )
  if (!proveNativeUniqueWholeFonts(owned, tokens)) return
  const sourceItems = [...(figure.sourceItems ?? [])]
  for (const token of owned) {
    if (
      !sourceItems.some(
        (s) => s.pageNumber === token.sourceItem.pageNumber && s.index === token.sourceItem.index
      )
    )
      sourceItems.push(token.sourceItem)
  }
  return {
    rect,
    sourceItems: sourceItems.sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
  }
}
