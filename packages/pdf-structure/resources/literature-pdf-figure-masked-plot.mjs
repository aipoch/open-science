/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { area, intersection, union } from './literature-pdf-page-geometry.mjs'

// Some vector exporters paint every axis label as a one-bit image. The normal
// graphic clustering deliberately excludes small masks (also used as page
// decoration). Recover them only around one independently framed, ticked plot.
export function nativeMaskedPlotBounds(page, figure, captions, tables, frames, rules, context) {
  if (!figure.rect || !context?.operators || context.viewport?.scale !== 1) return
  const plotFrames = [...frames]
  // An open right spine is common. The two equal horizontal axes and their
  // shared full-height left spine still independently establish all extents.
  for (const bottom of rules) {
    if (bottom[2] - bottom[0] < 80 || Math.abs(bottom[3] - bottom[1]) > 0.1) continue
    for (const top of rules) {
      if (
        bottom[1] - top[1] < 80 ||
        Math.abs(top[3] - top[1]) > 0.1 ||
        Math.abs(top[0] - bottom[0]) > 0.1 ||
        Math.abs(top[2] - bottom[2]) > 0.1
      )
        continue
      if (
        !rules.some(
          (r) =>
            Math.abs(r[0] - bottom[0]) < 0.1 &&
            Math.abs(r[2] - bottom[0]) < 0.1 &&
            Math.abs(r[1] - top[1]) < 0.1 &&
            Math.abs(r[3] - bottom[1]) < 0.1
        )
      )
        continue
      const r = [top[0], top[1], bottom[2], bottom[3]]
      if (!plotFrames.some((f) => f.every((v, i) => Math.abs(v - r[i]) < 0.1))) plotFrames.push(r)
    }
  }
  const owners = plotFrames.filter(
    (r) => area(r) > 6400 && intersection(r, figure.rect) / area(r) > 0.98
  )
  if (owners.length !== 1) return
  const frame = owners[0],
    width = frame[2] - frame[0],
    height = frame[3] - frame[1]
  const masks = [],
    stack = []
  const maskOperations = new Set()
  let transform = [1, 0, 0, 1, 0, 0]
  const { fnArray, argsArray } = context.operators
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i],
      args = argsArray[i]
    // Without the active clipping/transparency state, a transformed unit
    // square is not evidence of the visible mask. Keep the existing crop.
    if (
      [
        OPS.clip,
        OPS.eoClip,
        OPS.paintFormXObjectBegin,
        OPS.beginGroup,
        OPS.endGroup,
        OPS.beginAnnotation,
        OPS.endAnnotation,
        OPS.paintImageMaskXObjectRepeat,
        OPS.paintImageMaskXObjectGroup
      ].includes(op) ||
      (op === OPS.constructPath && [OPS.clip, OPS.eoClip].includes(args[0]))
    )
      return
    if (
      op === OPS.setGState &&
      (!Array.isArray(args[0]) ||
        args[0].some((entry) => !Array.isArray(entry) || !(entry[0] === 'TR' && entry[1] === null)))
    )
      return
    if (op === OPS.save) stack.push([...transform])
    else if (op === OPS.restore) {
      if (!stack.length) return
      transform = stack.pop()
    } else if (op === OPS.transform) transform = Util.transform(transform, args)
    else if (op === OPS.paintImageMaskXObject) {
      maskOperations.add(i)
      const mask = args[0]
      if (!(mask?.data instanceof Uint8Array) && typeof mask?.data !== 'string') return
      if (!(mask.width > 0 && mask.height > 0)) return
      const matrix = Util.transform(context.viewport.transform, transform)
      if (!matrix.every(Number.isFinite)) return
      const corners = [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1]
      ]
      for (const corner of corners) Util.applyTransform(corner, matrix)
      const r = [
        Math.min(...corners.map((p) => p[0])),
        Math.min(...corners.map((p) => p[1])),
        Math.max(...corners.map((p) => p[0])),
        Math.max(...corners.map((p) => p[1]))
      ]
      if (area(r) > 0) masks.push(r)
    }
  }
  if (stack.length || masks.length < 6) return
  const near = masks
  const ticked = (vertical) => {
    const ticks = rules.filter((r) =>
      vertical
        ? Math.abs(r[0] - frame[0]) < 0.5 &&
          r[2] > r[0] &&
          r[2] - r[0] < width / 20 &&
          Math.abs(r[1] - r[3]) < 0.1
        : Math.abs(r[3] - frame[3]) < 0.5 &&
          r[3] > r[1] &&
          r[3] - r[1] < height / 20 &&
          Math.abs(r[0] - r[2]) < 0.1
    )
    const labels = near.filter((r) =>
      vertical
        ? r[2] < frame[0] &&
          frame[0] - r[2] < r[3] - r[1] &&
          ticks.some((t) => t[1] >= r[1] && t[1] <= r[3])
        : r[1] > frame[3] &&
          r[1] - frame[3] < r[3] - r[1] &&
          ticks.some((t) => t[0] >= r[0] && t[0] <= r[2])
    )
    const centers = new Set(
      labels.map((r) => Math.round(vertical ? (r[1] + r[3]) / 2 : (r[0] + r[2]) / 2))
    )
    return centers.size >= 3 ? labels : undefined
  }
  const leftTicks = ticked(true),
    bottomTicks = ticked(false)
  if (!leftTicks || !bottomTicks) return
  const em = [...leftTicks, ...bottomTicks].map((r) => r[3] - r[1]).sort((a, b) => a - b)
  const font = em[Math.floor(em.length / 2)]
  const outside = near.filter((r) => intersection(r, frame) / area(r) < 0.98)
  const owned = new Set([...leftTicks, ...bottomTicks])
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const vertical = side === 'left' || side === 'right'
    const axis = vertical ? 1 : 0,
      cross = vertical ? 0 : 1
    const edge =
      side === 'left'
        ? frame[0]
        : side === 'right'
          ? frame[2]
          : side === 'top'
            ? frame[1]
            : frame[3]
    const sign = side === 'left' || side === 'top' ? -1 : 1
    const strip = outside.filter(
      (r) =>
        sign * ((r[cross] + r[cross + 2]) / 2 - edge) > 0 &&
        Math.abs((r[cross] + r[cross + 2]) / 2 - edge) < font * 5
    )
    const groups = []
    for (const r of strip) {
      const connected = groups.filter((group) =>
        group.some(
          (p) =>
            Math.max(p[axis], r[axis]) - Math.min(p[axis + 2], r[axis + 2]) < font * 1.5 &&
            Math.min(p[cross + 2], r[cross + 2]) > Math.max(p[cross], r[cross])
        )
      )
      const group = [r, ...connected.flat()]
      for (const old of connected) groups.splice(groups.indexOf(old), 1)
      groups.push(group)
    }
    for (const group of groups) {
      const r = union(group)
      const ticks = rules.filter((t) =>
        vertical
          ? Math.abs(t[0] - t[2]) > 0.1 &&
            Math.abs(t[1] - t[3]) < 0.1 &&
            Math.min(Math.abs(t[0] - edge), Math.abs(t[2] - edge)) < 0.5 &&
            Math.abs(t[2] - t[0]) < width / 20
          : Math.abs(t[0] - t[2]) < 0.1 &&
            Math.abs(t[1] - t[3]) > 0.1 &&
            Math.min(Math.abs(t[1] - edge), Math.abs(t[3] - edge)) < 0.5 &&
            Math.abs(t[3] - t[1]) < height / 20
      )
      const tickLabel =
        r[cross + 2] - r[cross] < font * 2 &&
        Math.min(Math.abs(r[cross] - edge), Math.abs(r[cross + 2] - edge)) < font &&
        ticks.some((t) => t[axis] >= r[axis] && t[axis] <= r[axis + 2])
      const title =
        ticks.length >= 3 &&
        r[cross + 2] - r[cross] < font * 2 &&
        Math.abs((r[axis] + r[axis + 2] - frame[axis] - frame[axis + 2]) / 2) < font * 2 &&
        r[axis + 2] - r[axis] > font * 3 &&
        r[axis + 2] - r[axis] < (frame[axis + 2] - frame[axis]) * 2
      if (tickLabel || title) for (const p of group) owned.add(p)
    }
  }
  // A nearby but unproved mask cannot be silently discarded from a supposedly
  // complete figure. In particular, keep long axis titles whole or abstain.
  if (outside.some((r) => !owned.has(r))) return
  const target = union([figure.rect, ...near])
  if (
    target[0] < 0 ||
    target[1] < 0 ||
    target[2] > page.width ||
    target[3] > page.height ||
    tables.some((r) => intersection(r, target) > 0) ||
    captions.some((c) => intersection(c.rect, target) > 0) ||
    plotFrames.some((r) => r !== frame && area(r) > 6400 && intersection(r, target) > 0) ||
    page.lines.some((l) => intersection([l.x, l.y, l.x + l.width, l.y + l.height], target) > 0) ||
    (page.graphicsBounds ?? []).some(
      (g) =>
        g.kind === 'image' &&
        !maskOperations.has(g.operationIndex) &&
        intersection(
          g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
          target
        ) > 0
    )
  )
    return
  return target
}
