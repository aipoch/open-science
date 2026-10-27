/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, d) => r.map((v, i) => v + (i < 2 ? -d : d)),
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ]
export function nativePairedScopedSubcaptions(page, f, captions, tables, tokens, ctx, pathPaint) {
  try {
    if (!f?.rect || !f.caption?.rect || f.fallbackFigure) return
    const view = ctx?.viewport
    if (
      view?.scale !== 1 ||
      view.rotation !== 0 ||
      view.width !== page.width ||
      view.height !== page.height ||
      JSON.stringify(view.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height]) ||
      ctx.operators.fnArray.includes(OPS.paintFormXObjectBegin)
    )
      return
    const p = nativePageTextPacketInventory(page, tokens, ctx, true)
    if (!p || p.evidence.images.length || p.evidence.paths.size > 4096) return
    const { o, v, finite, valid, evidence } = p,
      args = o.argsArray.slice(),
      rectOps = new Set(),
      scopes = [],
      stack = [],
      paints = new Map(),
      strokeColors = new Map()
    let strokeColor = '#000000',
      color = '#000000',
      alpha = 1
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) {
        const s = { start: i, parent: stack.at(-1)?.scope, color, alpha, strokeColor }
        scopes.push(s)
        stack.push({ scope: s, color, alpha, strokeColor })
      } else if (op === OPS.restore) {
        const s = stack.pop()
        if (!s) return
        s.scope.end = i
        color = s.color
        strokeColor = s.strokeColor
        alpha = s.alpha
      } else if (op === OPS.paintFormXObjectBegin || op === OPS.paintFormXObjectEnd) return
      else if (op === OPS.setFillRGBColor) color = a[0]
      else if (op === OPS.setStrokeRGBColor) strokeColor = a[0]
      else if (op === OPS.setGState) {
        for (const [k, n] of a[0]) if (k === 'ca') alpha = n
      } else if (op === OPS.showText) paints.set(i, { color, alpha })
      if (op === OPS.constructPath) strokeColors.set(i, strokeColor)
      if (op !== OPS.constructPath || a[0] !== OPS.stroke) continue
      const path = a[1]?.[0]
      if (
        path?.length !== 16 ||
        path[0] !== 0 ||
        path[15] !== 4 ||
        ![3, 6, 9, 12].every((k) => path[k] === 1) ||
        !Array.from(path).every(Number.isFinite) ||
        path[13] !== path[1] ||
        path[14] !== path[2]
      )
        continue
      const pts = [1, 4, 7, 10].map((k) => [path[k], path[k + 1]])
      if (
        new Set(pts.map((p) => p.join(','))).size !== 4 ||
        pts.some((p, n) => {
          const q = pts[(n + 1) % 4]
          return !((p[0] === q[0]) !== (p[1] === q[1]))
        })
      )
        continue
      args[i] = [a[0], [Array.from(path).slice(0, 12).concat(4)], a[2]]
      rectOps.add(i)
    }
    if (stack.length) return
    const frameProof = {
      images: [],
      paths: new Map(),
      texts: new Map(),
      frames: new Map()
    }
    collectClosedFigureFrames({ ...o, argsArray: args }, v, frameProof)
    const roots = scopes.filter((s) => !s.parent),
      keys = p.records
        .filter(
          (r) =>
            /^\([ab]\)\s+\S/.test(r.r.str) &&
            r.rect[1] > f.rect[3] &&
            r.rect[3] < f.caption.rect[1] &&
            inside([f.rect[0], 0, f.rect[2], page.height], r.rect)
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
    if (
      keys.length !== 2 ||
      !keys[0].r.str.startsWith('(a) ') ||
      !keys[1].r.str.startsWith('(b) ') ||
      keys[0].r.fontName !== keys[1].r.fontName ||
      keys[0].r.height !== keys[1].r.height
    )
      return
    const em = keys[0].r.height
    if (!(em > 0) || Math.abs(keys[0].rect[1] - keys[1].rect[1]) > em / 32) return
    const faces = [...frameProof.frames]
      .filter(
        ([i, r]) =>
          rectOps.has(i) && inside(f.rect, r) && r[2] - r[0] > em * 8 && r[3] - r[1] > em * 4
      )
      .sort((a, b) => a[1][0] - b[1][0])
    if (faces.length !== 2) return
    const selected = []
    for (let n = 0; n < 2; n++) {
      const [i, face] = faces[n],
        state = evidence.paths.get(i),
        owners = roots.filter((s) => i > s.start && i < s.end)
      if (
        owners.length !== 1 ||
        !state?.solidStroke ||
        !/^#[0-9a-f]{6}$/i.test(strokeColors.get(i)) ||
        strokeColors.get(i).toLowerCase() === '#ffffff' ||
        !valid(state.clip) ||
        state.strokeAlpha !== 1 ||
        !(state.lineWidth > 0) ||
        !finite(state.transform, 6) ||
        state.transform[1] !== 0 ||
        state.transform[2] !== 0 ||
        state.transform[0] <= 0 ||
        state.transform[0] !== state.transform[3]
      )
        return
      const scope = owners[0],
        next = roots.find((s) => s.start > scope.end)?.start ?? o.fnArray.length,
        group = p.records.filter(
          (r) =>
            r.part.every((z) => z.g.i > scope.end && z.g.i < next) &&
            Math.abs(r.rect[1] - keys[n].rect[1]) < em / 32
        ),
        plotRecords = p.records.filter((r) =>
          r.part.some((z) => z.g.i > scope.start && z.g.i < scope.end)
        )
      if (!group.length || group[0] !== keys[n] || group.length > 24 || !plotRecords.length) return
      if (
        group.some(
          (r, k) =>
            r.r.height !== em ||
            Math.abs(r.rect[3] - keys[n].rect[3]) > em / 32 ||
            !inside([f.rect[0], 0, f.rect[2], f.caption.rect[1]], r.rect) ||
            r.part.some((z) => {
              const s = paints.get(z.g.i)
              return (
                !s ||
                s.alpha !== 1 ||
                !/^#[0-9a-f]{6}$/i.test(s.color) ||
                s.color.toLowerCase() === '#ffffff'
              )
            }) ||
            (k > 0 &&
              (r.index <= group[k - 1].index ||
                r.rect[0] < group[k - 1].rect[2] - 1e-6 ||
                r.rect[0] - group[k - 1].rect[2] > em))
        )
      )
        return
      const bound = union(group.flatMap((r) => [r.rect, ...r.part.map((z) => z.g.ink)])),
        plotBound = union(plotRecords.flatMap((r) => [r.rect, ...r.part.map((z) => z.g.ink)]))
      if (
        bound[1] < plotBound[3] ||
        bound[1] - plotBound[3] > em * 2 ||
        Math.abs((bound[0] + bound[2] - plotBound[0] - plotBound[2]) / 2) > em
      )
        return
      selected.push({
        scope,
        group,
        bound,
        face,
        frameOp: i,
        frame: {
          rect: face,
          clip: state.clip,
          strokeWidth: state.lineWidth * state.transform[0],
          joinFactor: Math.max(Math.SQRT2, p.strokeMargins.get(i) ?? 10)
        }
      })
    }
    if (
      selected[0].scope === selected[1].scope ||
      selected[0].scope.end >= selected[1].scope.start ||
      faces[0][1][2] >= faces[1][1][0] ||
      Math.abs(faces[0][1][1] - faces[1][1][1]) > em / 2 ||
      Math.abs(faces[0][1][3] - faces[1][1][3]) > em / 2
    )
      return
    const rect = union([f.rect, ...selected.map((s) => s.bound)])
    if (
      rect[0] !== f.rect[0] ||
      rect[1] !== f.rect[1] ||
      rect[2] !== f.rect[2] ||
      rect[3] <= f.rect[3]
    )
      return
    const scale = Math.ceil(page.width * 1.5) / page.width,
      old = expand(f.rect, 2 / scale),
      padded = expand(rect, 2 / scale)
    if (
      !inside([0, 0, page.width, page.height], padded) ||
      tables.some((t) => hit(t, padded)) ||
      captions.some((c) => c.page === page.pageNumber && hit(c.rect, padded))
    )
      return
    const owned = new Set(selected.flatMap((s) => s.group)),
      foreignPaints = [],
      retainedPaints = []
    for (const r of p.records) {
      if (owned.has(r)) continue
      for (const { g } of r.part) {
        if (inside(old, g.ink)) {
          retainedPaints.push({ rect: g.ink, floor: 0 })
          continue
        }
        foreignPaints.push({ rect: g.ink, floor: 0 })
        if (hit(padded, expand(g.ink, 2 / scale))) return
      }
    }
    for (const [i, s] of evidence.paths) {
      const a = o.argsArray[i]
      if (a[0] === OPS.endPath) continue
      // PDFjs constructs an empty Path2D for exactly this null stroke payload.
      // Geometry/clip state still comes from the complete original inventory.
      if (
        a[0] === OPS.stroke &&
        a.length === 3 &&
        a[1]?.length === 1 &&
        a[1][0] === null &&
        a[2] === null
      )
        continue
      const paint = pathPaint(p, i, s)
      if (!paint) return
      const { rect: r, floor } = paint
      if (inside(old, r)) {
        retainedPaints.push({ rect: r, floor })
        continue
      }
      foreignPaints.push({ rect: r, floor })
      if (hit(padded, expand(r, (floor + 2) / scale))) return
    }
    if (retainedPaints.length > 4096) return
    return {
      rect,
      formCropRaster: {
        ownedRects: [f.rect, ...selected.map((s) => s.bound)],
        nativeTail: {
          labels: selected.map((s) => s.bound),
          frames: selected.map((s) => s.frame),
          paints: retainedPaints
        },
        foreignPaints
      }
    }
  } catch {
    return
  }
}
