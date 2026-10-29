/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeFractionInkPacket } from './literature-pdf-figure-native-plot-labels.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { union } from './literature-pdf-page-geometry.mjs'

const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, n) => r.map((v, i) => v + (i < 2 ? -n : n)),
  compact = (s) => s.normalize('NFD').replace(/\s/gu, '')

// A separate contract for complete two/three-line paragraphs following each
// native panel. Ordinary short-label ownership and packet guards stay strict.
// This certificate preserves original pixels; it creates no translation owners.
export function nativeWrappedPanelSubcaptionCrop(
  page,
  f,
  captions,
  tables,
  tokens,
  ctx,
  pathPaint
) {
  try {
    const v = ctx?.viewport
    if (
      !f?.rect ||
      !f.caption?.rect ||
      f.reason ||
      f.fallbackFigure ||
      f.formCropRaster ||
      f.headerRaster ||
      f.parts ||
      f.cropRects ||
      page.rotation ||
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      v?.scale !== 1 ||
      v.rotation !== 0 ||
      v.width !== page.width ||
      v.height !== page.height ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height])
    )
      return
    const keys = tokens.filter((t) => /^\([a-c]\)(?:\s|$)/u.test(t.text))
    if (keys.length < 2 || keys.length > 3) return
    const p = nativeFractionInkPacket(
      page,
      tokens,
      ctx,
      keys.map((t) => t.sourceItem)
    )
    if (!p) return
    const { o, evidence, valid, finite, box } = p,
      markers = keys.map((t) => p.records.find((r) => r.index === t.sourceItem.index)),
      em = markers[0]?.r.height,
      bound = (r) => {
        const style = ctx.content.styles[r.r.fontName]
        if (
          !(style?.ascent > 0) ||
          !Number.isFinite(style.ascent) ||
          !Number.isFinite(style.descent) ||
          style.vertical
        )
          return
        const metric = nativeFigureLabelBounds(r.r, style, v)
        return valid(metric) && valid(r.rect) && valid(r.ink)
          ? union([r.rect, r.ink, metric])
          : undefined
      }
    if (
      !(em > 0) ||
      !valid(f.rect) ||
      !valid(f.caption.rect) ||
      markers.some(
        (r, n) =>
          !r ||
          !r.r.str.startsWith('(' + String.fromCharCode(97 + n) + ')') ||
          r.r.height !== em ||
          !valid(bound(r)) ||
          (n && r.index <= markers[n - 1].index)
      )
    )
      return
    const cap = p.records.filter((r) => hit(r.ink, f.caption.rect))
    if (
      !cap.length ||
      compact(cap.map((r) => r.r.str).join('')) !== compact(f.caption.lines.join(''))
    )
      return
    const capStart = Math.min(...cap.flatMap((r) => r.part.map((z) => z.g.i))),
      forms = [],
      stack = []
    let matrix = [1, 0, 0, 1, 0, 0],
      active
    for (let i = 0; i < o.fnArray.length; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
        stack.push({ op, matrix, active })
        if (op === OPS.paintFormXObjectBegin) {
          if (a[0]) {
            if (!finite(a[0], 6)) return
            matrix = Util.transform(matrix, a[0])
          }
          if (!finite(a[1], 4)) return
          const form = {
            start: i,
            parent: active,
            rect: box(a[1], Util.transform(v.transform, matrix))
          }
          if (!valid(form.rect)) return
          forms.push(form)
          active = form
        }
      } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
        if (op === OPS.paintFormXObjectEnd && active) active.end = i
        const s = stack.pop()
        if (!s || s.op !== (op === OPS.restore ? OPS.save : OPS.paintFormXObjectBegin)) return
        ;({ matrix, active } = s)
      } else if (op === OPS.transform) matrix = Util.transform(matrix, a)
    }
    if (stack.length || forms.some((s) => !Number.isInteger(s.end))) return
    const images = evidence.images,
      roots = forms.filter((s) => !s.parent),
      raster = images.length > 0
    let panels
    if (raster) {
      if (
        images.length !== markers.length ||
        forms.length ||
        evidence.paths.size ||
        o.fnArray.some((op) => [OPS.clip, OPS.eoClip].includes(op)) ||
        page.graphicsBounds.length !== images.length ||
        page.graphicsBounds.some((g) => g.kind !== 'image')
      )
        return
      panels = images.map((im) => ({
        start: im.operationIndex,
        end: im.operationIndex,
        rect: im.rect
      }))
    } else {
      if (roots.length !== 2 || markers.length !== 2 || evidence.paths.size > 4096) return
      panels = roots
    }
    panels.sort((a, b) => a.start - b.start)
    if (
      panels.some(
        (s, n) =>
          !valid(s.rect) ||
          s.rect[2] - s.rect[0] < em * 8 ||
          s.rect[3] - s.rect[1] < em * 6 ||
          Math.abs(s.rect[0] - panels[0].rect[0]) > em / 8 ||
          Math.abs(s.rect[2] - panels[0].rect[2]) > em / 8 ||
          Math.abs(s.rect[3] - s.rect[1] - panels[0].rect[3] + panels[0].rect[1]) > em / 8 ||
          (n && (s.start <= panels[n - 1].end || s.rect[1] <= panels[n - 1].rect[3])) ||
          !inside(expand(f.rect, em / 2), s.rect)
      )
    )
      return
    const groups = [],
      plotRecords = []
    for (let n = 0; n < panels.length; n++) {
      const panel = panels[n],
        end = panels[n + 1]?.start ?? capStart,
        group = p.records.filter((r) => r.part.every((z) => z.g.i > panel.end && z.g.i < end)),
        plot = p.records.filter((r) => r.part.some((z) => z.g.i > panel.start && z.g.i < panel.end))
      if (
        !group.length ||
        group.length > 32 ||
        group[0] !== markers[n] ||
        !/[.!?]$/u.test(group.at(-1).r.str.trim()) ||
        group
          .map((r) => r.r.str)
          .join(' ')
          .split(/\s+/u).length < 6 ||
        (!raster &&
          (!plot.length ||
            plot.some((r) => !r.part.every((z) => z.g.i > panel.start && z.g.i < panel.end))))
      )
        return
      const regular = group.filter((r) => r.r.height >= em * 0.9 && r.r.height <= em * 1.05),
        rows = []
      for (const r of regular) {
        const baseline = page.height - r.r.transform[5],
          previous = rows.at(-1)
        if (previous === undefined || Math.abs(baseline - previous) > em / 16) rows.push(baseline)
      }
      if (
        rows.length < 2 ||
        rows.length > 3 ||
        rows.some((y, i) => i && (y - rows[i - 1] < em || y - rows[i - 1] > em * 1.5))
      )
        return
      // A closed sentence ends this paragraph. A later nearby sentence is not
      // a wrapped continuation, even when its font and column happen to match.
      const rowOf = (r) => {
        const baseline = page.height - r.r.transform[5]
        return rows.reduce(
          (best, y, i) => (Math.abs(y - baseline) < Math.abs(rows[best] - baseline) ? i : best),
          0
        )
      }
      if (
        rows.slice(0, -1).some((_, i) =>
          /[.!?]$/u.test(
            group
              .filter((r) => rowOf(r) === i)
              .at(-1)
              ?.r.str.trim() ?? ''
          )
        )
      )
        return
      if (
        group.some(
          (r, i) =>
            !r.advanceComplete ||
            !valid(bound(r)) ||
            r.r.transform[0] <= 0 ||
            r.r.transform[1] !== 0 ||
            r.r.transform[2] !== 0 ||
            r.r.height < em * 0.6 ||
            r.r.height > em * 1.05 ||
            Math.min(...rows.map((y) => Math.abs(page.height - r.r.transform[5] - y))) > em * 0.6 ||
            (i && r.index <= group[i - 1].index) ||
            r.part.some(
              ({ g }) =>
                g.textPaint?.fillAlpha !== 1 ||
                !/^#[\da-f]{6}$/iu.test(g.textPaint?.fillColor) ||
                g.textPaint.fillColor.toLowerCase() === '#ffffff'
            )
        )
      )
        return
      const envelope = union(group.map(bound))
      if (
        envelope[1] < panel.rect[3] ||
        envelope[1] - panel.rect[3] > em * 2.5 ||
        envelope[0] < panel.rect[0] - em / 2 ||
        envelope[2] > panel.rect[2] + em / 2 ||
        envelope[2] - envelope[0] < (panel.rect[2] - panel.rect[0]) / 2 ||
        envelope[3] >= (panels[n + 1]?.rect[1] ?? f.caption.rect[1])
      )
        return
      groups.push(group)
      plotRecords.push(...plot)
    }
    const owned = new Set([...groups.flat(), ...plotRecords])
    if (
      owned.size > 64 ||
      !nativeFractionInkPacket(
        page,
        tokens,
        ctx,
        [...owned].map((r) => r.r.sourceItem)
      )
    )
      return
    const rect = union([f.rect, ...panels.map((s) => s.rect), ...[...owned].map(bound)]),
      scale = Math.ceil(page.width * 1.5) / page.width,
      padded = expand(rect, 2 / scale)
    if (
      !valid(rect) ||
      rect[3] <= f.rect[3] ||
      rect[3] - f.rect[3] > em * 3 ||
      !inside(expand(f.rect, em * 3), rect) ||
      !inside([0, 0, page.width, page.height], padded) ||
      tables.some((t) => hit(padded, t)) ||
      captions.some((c) => c.page === page.pageNumber && hit(padded, c.rect))
    )
      return
    const foreignPaints = []
    for (const r of p.records) {
      if (owned.has(r)) continue
      const b = bound(r)
      if (!valid(b) || hit(padded, expand(b, 2 / scale))) return
      foreignPaints.push({ rect: b, floor: 0 })
    }
    for (const [i, state] of evidence.paths) {
      if (o.argsArray[i][0] === OPS.endPath) continue
      const owners = panels.filter((s) => i > s.start && i < s.end),
        paint = pathPaint(p, i, state)
      if (
        raster ||
        owners.length !== 1 ||
        !paint ||
        !inside(f.rect, paint.rect) ||
        state.strokeAlpha !== 1 ||
        state.fillAlpha !== 1
      )
        return
    }
    foreignPaints.push(
      ...captions
        .filter((c) => c.page === page.pageNumber)
        .map((c) => ({ rect: c.rect, floor: 0 })),
      ...tables.map((t) => ({ rect: t, floor: 0 }))
    )
    return {
      rect,
      formCropRaster: {
        ownedRects: [
          f.rect,
          ...panels.map((s) => s.rect),
          ...groups.map((g) => union(g.map(bound)))
        ],
        foreignPaints
      }
    }
  } catch {
    return
  }
}
