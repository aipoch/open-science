/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, version } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { nativeClosedRuleFrames } from './literature-pdf-figure-connectivity.mjs'
import { area, intersection, union, lineRect } from './literature-pdf-page-geometry.mjs'
export function nativeCaptionedPlotBand(
  page,
  caption,
  captions,
  tables,
  rules,
  closedFrames = [],
  nativeTokens = [],
  existingOwnedRect,
  operatorContext
) {
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((f) => f > 0)
  )
  if (!Number.isFinite(font)) return
  // A compact faceted bar plate needs independent outer/carrier/strip frames,
  // whole fonts and whole measured paint, plus a known complete native program.
  // Missing context keeps every legacy selector and its six-em gate unchanged.
  if (operatorContext && Array.isArray(closedFrames) && closedFrames.length >= 9) {
    const compact = nativeCompactFacetedNinePlots(
      page,
      caption,
      captions,
      tables,
      closedFrames,
      nativeTokens,
      existingOwnedRect
    )
    if (
      compact &&
      supportsCompactFacetedOperatorContext(page, nativeTokens, closedFrames, operatorContext)
    )
      return compact
  }
  const ownCaps = captions.filter((c) => c.page === page.pageNumber)
  const sharedLegend = nativeClosedSharedLegend(
    page,
    caption,
    ownCaps,
    tables,
    closedFrames,
    nativeTokens,
    font,
    existingOwnedRect
  )
  if (sharedLegend) return sharedLegend
  const positioned = nativePositionedThreeClosedPlots(
    page,
    caption,
    captions,
    tables,
    rules,
    closedFrames,
    nativeTokens
  )
  if (positioned) return positioned
  const allFrames = nativeClosedRuleFrames(rules).filter(
    (r) => r[3] < caption.rect[1] && !tables.some((t) => intersection(t, r) > 0)
  )
  // Merged native wavelength ticks can be longer than a paragraph. Their
  // complete numeric sequence and unique closed-face baseline prove an axis;
  // mixed text, nonmonotonic values and numbers inside the plot do not.
  const numericAxis = (line, frames = allFrames) => {
    const words = line.text.trim().split(/\s+/)
    if (
      words.length < 6 ||
      !words.every((s) => /^[−-]?\d+(?:\.\d+)?$/.test(s)) ||
      !(line.fontSize > 0) ||
      line.fontSize > font ||
      ![line.x, line.y, line.width, line.height].every(Number.isFinite) ||
      line.height <= 0
    )
      return false
    const values = words.map((s) => Number(s.replace('−', '-'))),
      step = values[1] - values[0]
    if (
      !(step > 0) ||
      values.slice(1).some((v, n) => Math.abs(v - values[n] - step) > Math.max(1e-6, step * 0.01))
    )
      return false
    return (
      frames.filter(
        (r) =>
          line.x >= r[0] - line.fontSize * 2 &&
          line.x + line.width <= r[2] + line.fontSize * 2 &&
          line.width >= (r[2] - r[0]) * 0.8 &&
          Math.abs(line.x + line.width / 2 - (r[0] + r[2]) / 2) <= line.fontSize * 2 &&
          line.y >= r[3] - line.fontSize * 0.2 &&
          line.y + line.height <= r[3] + line.fontSize * 2
      ).length === 1
    )
  }
  const unequal = nativeCaptionedUnequalClosedGrid(
    page,
    caption,
    ownCaps,
    tables,
    closedFrames,
    nativeTokens,
    font
  )
  const translated = nativeTranslatedThreeRowClosedGrid(
    page,
    caption,
    ownCaps,
    tables,
    closedFrames,
    nativeTokens,
    font
  )
  const keyed =
    unequal ??
    translated?.frames ??
    nativeTitledTwoRowClosedGrid(page, caption, ownCaps, tables, allFrames, nativeTokens, font)
  const frames = keyed ?? allFrames.filter((r) => caption.rect[1] - r[3] < font * 6)
  // Grow only through aligned, equally sized closed faces. A caption, table
  // or full-size prose row breaks the corridor even when the next plot aligns.
  for (let pass = 0; !keyed && pass < allFrames.length; pass++) {
    const next = allFrames.filter(
      (r) =>
        !frames.includes(r) &&
        frames.some((f) => {
          const vertical =
            Math.abs(r[0] - f[0]) < font * 0.5 &&
            Math.abs(r[2] - f[2]) < font * 0.5 &&
            f[1] >= r[3] &&
            f[1] - r[3] < font * 8
          const horizontal =
            Math.abs(r[1] - f[1]) < font * 0.15 &&
            Math.abs(r[3] - f[3]) < font * 0.15 &&
            Math.max(r[0], f[0]) - Math.min(r[2], f[2]) < font * 8
          const corridor = union([r, f])
          return (
            (vertical || horizontal) &&
            !ownCaps.some((c) => c !== caption && intersection(c.rect, corridor) > 0) &&
            !tables.some((t) => intersection(t, corridor) > 0) &&
            !page.lines.some(
              (l) =>
                l.text.length >= 60 &&
                l.fontSize >= font * 0.65 &&
                !numericAxis(l) &&
                intersection(lineRect(l), corridor) > 0
            )
          )
        })
    )
    if (!next.length) break
    frames.push(...next)
  }
  if (frames.length < 2 || frames.length > 24) return
  const b = union(frames)
  const horizontal = frames.every(
      (r) =>
        Math.abs(r[1] - frames[0][1]) < font * 0.1 && Math.abs(r[3] - frames[0][3]) < font * 0.1
    ),
    vertical = frames.every(
      (r) =>
        Math.abs(r[0] - frames[0][0]) < font * 0.5 && Math.abs(r[2] - frames[0][2]) < font * 0.5
    )
  const rows = []
  for (const r of frames.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const row = rows.find((items) => Math.abs(items[0][1] - r[1]) < font * 0.15)
    if (row) row.push(r)
    else rows.push([r])
  }
  const grid =
    rows.length >= 2 &&
    rows.every(
      (row) =>
        row.length === rows[0].length &&
        row.length >= 2 &&
        row
          .slice()
          .sort((a, b) => a[0] - b[0])
          .every((r, i) => {
            const anchor = rows[0].slice().sort((a, b) => a[0] - b[0])[i]
            return (
              Math.abs(r[0] - anchor[0]) < font * 0.5 && Math.abs(r[2] - anchor[2]) < font * 0.5
            )
          })
    )
  if (
    (!keyed && !horizontal && !vertical && !grid) ||
    ownCaps.some((c) => c !== caption && intersection(c.rect, b) > 0)
  )
    return
  if (
    frames.some((r) => {
      const ticks = page.lines.filter(
        (l) =>
          /^[−-]?\d+(?:\.\d+)?$/.test(l.text.trim()) &&
          l.y >= r[1] &&
          l.y + l.height <= r[3] + font * 2 &&
          l.x >= r[0] - font * 4 &&
          l.x + l.width <= r[2] + font * 2
      )
      const padded = [
        r[0] - page.width / 256,
        r[1] - page.height / 256,
        r[2] + page.width / 256,
        r[3] + page.height / 256
      ]
      const inside = (page.graphicsBounds ?? [])
        .filter((g) => g.kind === 'path')
        .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
        .filter(
          (x) =>
            intersection(x, padded) / area(x) > 0.95 &&
            area(x) < area(r) * 0.9 &&
            x[2] - x[0] > font * 3 &&
            x[3] - x[1] > font * 0.3
        )
      return ticks.length < (unequal ? 1 : 4) || inside.length < 3
    })
  )
    return
  const labels = page.lines.filter(
    (l) =>
      l.fontSize > 0 &&
      l.fontSize <= font * 1.5 &&
      (l.text.length < 60 || l.fontSize < font * 0.65 || numericAxis(l, frames)) &&
      l.x >= b[0] - font * 5 &&
      l.x + l.width <= b[2] + font * 3 &&
      l.y >= b[1] - font * 4 &&
      l.y + l.height < caption.rect[1] &&
      l.y + l.height <= b[3] + font * 5 &&
      !ownCaps.some((c) => intersection(c.rect, lineRect(l)) > 0)
  )
  const owned = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter(
      (r) =>
        r[1] >= b[1] - font * 4 &&
        r[3] <= Math.min(caption.rect[1] - font * 0.5, b[3] + font * 3) &&
        r[0] >= b[0] - font * 5 &&
        r[2] <= b[2] + font * 3 &&
        (frames.some((f) => intersection(f, r) / area(r) > 0.9) ||
          labels.some((l) => intersection(lineRect(l), r) > 0))
    )
  const rect = union([
    b,
    ...owned,
    ...labels.map(lineRect),
    ...(translated?.legend ? [translated.legend] : [])
  ])
  if (
    tables.some((t) => intersection(t, rect) > 0) ||
    page.lines.some(
      (l) =>
        l.text.length >= 60 &&
        l.fontSize >= font * 0.65 &&
        !numericAxis(l, frames) &&
        intersection(lineRect(l), rect) > 0
    )
  )
    return
  const measured = vertical
    ? nativeRepeatedPlotMeasurementTails(
        page,
        caption,
        ownCaps,
        tables,
        frames,
        nativeTokens,
        rect,
        font
      )
    : undefined
  return { caption, rect: measured ?? rect, graphicsCount: frames.length }
}

function completeNativePlotLine(line, tokens) {
  const r = lineRect(line),
    glyphs = (s) => s.replace(/\s/gu, '')
  if (![...r, line.fontSize].every(Number.isFinite) || !(line.fontSize > 0) || area(r) <= 0)
    return false
  const parts = tokens
    .filter(
      (t) =>
        t.rect?.length === 4 &&
        t.rect.every(Number.isFinite) &&
        t.rect.every((v, i) => (i < 2 ? v >= r[i] - 1e-7 : v <= r[i] + 1e-7))
    )
    .sort((a, b) => a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1])
  return (
    parts.length > 0 &&
    Math.abs(Math.max(...parts.map((t) => t.height)) - line.fontSize) < 1e-7 &&
    parts.every(
      (t) =>
        [t.height, t.baseline].every(Number.isFinite) &&
        typeof t.horizontal === 'boolean' &&
        t.height > 0 &&
        Math.abs(t.baseline - t.rect[3]) < 1e-7 &&
        (t.horizontal
          ? Math.abs(t.rect[3] - t.rect[1] - t.height) < 1e-7
          : // A nearly vertical source transform can add a small advance-width
            // projection. Its whole box must still exactly match the native line.
            Math.min(t.rect[2] - t.rect[0], t.rect[3] - t.rect[1]) >= t.height - 1e-7 &&
            Math.min(t.rect[2] - t.rect[0], t.rect[3] - t.rect[1]) <= t.height * 1.005)
    ) &&
    union(parts.map((t) => t.rect)).every((v, i) => Math.abs(v - r[i]) < 1e-7) &&
    glyphs(parts.map((t) => t.text).join('')) === glyphs(line.text)
  )
}

// Three position-keyed plots may have small independent layout offsets. Every
// whole native font and measured path must have one closed-face lane; complete
// axes and traces distinguish this plate from neighboring ruled text or tables.
function nativePositionedThreeClosedPlots(
  page,
  caption,
  captions,
  tables,
  rules,
  closedFrames,
  tokens
) {
  const valid = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && area(r) > 0
  const contains = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 1e-7 : v <= a[n] + 1e-7))
  if (
    ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
    page.invalidGraphicsBounds !== 0 ||
    caption.page !== page.pageNumber ||
    !valid(caption.rect) ||
    !tokens.length
  )
    return
  const own = captions.filter((c) => c.page === page.pageNumber)
  if (
    own.length !== 1 ||
    own[0] !== caption ||
    !/\bLeft:[\s\S]+\bCent(?:er|re):[\s\S]+\bRight:/u.test(caption.lines.join(' '))
  )
    return
  const captionRows = caption.lines.map((text) =>
    page.lines.filter((l) => l.text === text && contains(caption.rect, lineRect(l)))
  )
  if (captionRows.some((rows) => rows.length !== 1 || !completeNativePlotLine(rows[0], tokens)))
    return
  const font = Math.max(...captionRows.map((rows) => rows[0].fontSize))
  const frames = nativeClosedRuleFrames(rules)
    .filter((r) => r[3] < caption.rect[1])
    .sort((a, b) => a[0] - b[0])
  if (
    frames.length !== 3 ||
    closedFrames.length !== 3 ||
    closedFrames.some((f) => !valid(f)) ||
    frames.some(
      (f) => closedFrames.filter((r) => r.every((v, n) => Math.abs(v - f[n]) < 1e-7)).length !== 1
    )
  )
    return
  if (
    frames.some(
      (f, n) =>
        f[2] - f[0] < font * 6 ||
        f[3] - f[1] < font * 6 ||
        Math.abs(f[1] - frames[0][1]) > font * 0.2 ||
        Math.abs(f[3] - frames[0][3]) > font * 0.2 ||
        Math.abs(f[2] - f[0] - frames[0][2] + frames[0][0]) > font * 0.2 ||
        (n && (f[0] <= frames[n - 1][2] || f[0] - frames[n - 1][2] > font * 8))
    )
  )
    return
  const lanes = frames.map((f) => [
    f[0] - font * 2,
    f[1] - font * 0.5,
    f[2] + font,
    f[3] + font * 2
  ])
  if (page.graphicsBounds.some((g) => g.kind !== 'path' || !valid(g.normalizedRect))) return
  const paint = page.graphicsBounds.map((g) =>
    g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width))
  )
  const paintOwners = paint.map((r) =>
    lanes.map((lane, n) => (contains(lane, r) ? n : -1)).filter((n) => n >= 0)
  )
  if (paintOwners.some((owners) => owners.length !== 1)) return
  const byFace = frames.map((_, n) => paint.filter((r, j) => paintOwners[j][0] === n))
  const wholePlate = union([...frames, ...paint])
  if (
    wholePlate[1] < 0 ||
    wholePlate[0] < 0 ||
    wholePlate[2] > page.width ||
    wholePlate[3] > caption.rect[1] - font * 0.2 ||
    caption.rect[1] - wholePlate[3] > font * 3 ||
    tables.some((t) => !valid(t) || intersection(t, wholePlate) > 0)
  )
    return
  const lines = page.lines.filter(
    (l) => l.text?.trim() && intersection(lineRect(l), wholePlate) > 0
  )
  const lineOwners = lines.map((l) =>
    lanes.map((lane, n) => (contains(lane, lineRect(l)) ? n : -1)).filter((n) => n >= 0)
  )
  if (
    lines.some(
      (l, n) =>
        !completeNativePlotLine(l, tokens) ||
        l.fontSize >= font * 0.5 ||
        l.text.length >= 60 ||
        lineOwners[n].length !== 1 ||
        !contains(wholePlate, lineRect(l))
    )
  )
    return
  if (
    tokens.some(
      (t) =>
        t.text?.trim() &&
        (!valid(t.rect) ||
          (intersection(t.rect, wholePlate) > 0 &&
            lines.filter((l) => contains(lineRect(l), t.rect)).length !== 1))
    )
  )
    return
  const axes = frames.map((f, n) => {
    const ownLines = lines.filter((_, j) => lineOwners[j][0] === n)
    const numerical = (l) =>
      l.text
        .trim()
        .split(/\s+/u)
        .every((s) => /^[−-]?\d+(?:\.\d+)?$/u.test(s))
    const y = ownLines.filter(
      (l) =>
        numerical(l) &&
        lineRect(l)[2] < f[0] &&
        l.y >= f[1] - l.fontSize &&
        lineRect(l)[3] <= f[3] + l.fontSize
    )
    const x = ownLines.filter(
      (l) =>
        numerical(l) &&
        l.y >= f[3] &&
        lineRect(l)[3] <= f[3] + l.fontSize * 2 &&
        l.x >= f[0] - l.fontSize &&
        lineRect(l)[2] <= f[2] + l.fontSize
    )
    const xlabel = ownLines.filter(
      (l) =>
        !numerical(l) &&
        l.y >= f[3] &&
        lineRect(l)[3] <= f[3] + l.fontSize * 3 &&
        l.x >= f[0] &&
        lineRect(l)[2] <= f[2]
    )
    const ylabel = ownLines.filter(
      (l) =>
        !numerical(l) &&
        lineRect(l)[2] < f[0] &&
        l.y >= f[1] &&
        lineRect(l)[3] <= f[3] &&
        tokens.filter((t) => contains(lineRect(l), t.rect)).every((t) => t.horizontal === false)
    )
    const traces = byFace[n].filter(
      (r) =>
        intersection(r, f) / area(r) > 0.9 &&
        area(r) < area(f) * 0.9 &&
        r[2] - r[0] > font * 3 &&
        r[3] - r[1] > font * 0.3
    )
    return { y, x, xlabel, ylabel, traces }
  })
  // A lane alone cannot own arbitrary crossing paint. Apart from a complete
  // enclosing carrier, require the measured path to stay inside the native
  // face/font union plus one recorded graphics cell on each side.
  if (
    frames.some((f, n) => {
      const fontBounds = union([f, ...lines.filter((_, j) => lineOwners[j][0] === n).map(lineRect)])
      const measured = [
        fontBounds[0] - page.width / 128,
        fontBounds[1] - page.height / 128,
        fontBounds[2] + page.width / 128,
        fontBounds[3] + page.height / 128
      ]
      return byFace[n].some((r) => !contains(r, f) && !contains(measured, r))
    })
  )
    return
  const monotonic = (values) =>
    values.length >= 4 &&
    values.every(Number.isFinite) &&
    values.slice(1).every((v, n) => (v - values[n]) * (values[1] - values[0]) > 0)
  if (
    axes.some(
      (a) =>
        a.y.length < 4 ||
        a.x.reduce((n, l) => n + l.text.trim().split(/\s+/u).length, 0) < 4 ||
        a.xlabel.length !== 1 ||
        a.ylabel.length !== 1 ||
        a.traces.length < 3 ||
        !monotonic(
          a.y
            .slice()
            .sort((a, b) => a.y - b.y)
            .map((l) => Number(l.text.replace('−', '-')))
        ) ||
        !monotonic(
          a.x
            .slice()
            .sort((a, b) => a.x - b.x)
            .flatMap((l) =>
              l.text
                .trim()
                .split(/\s+/u)
                .map((s) => Number(s.replace('−', '-')))
            )
        ) ||
        a.x.some((l) => Math.abs(l.y + l.height - a.x[0].y - a.x[0].height) > l.fontSize * 0.001)
    )
  )
    return
  return { caption, rect: wholePlate, graphicsCount: 3 }
}

// Complete an already associated row of three closed plots only with its
// independently closed common legend and complete native fonts. Crossed paint
// is included whole, including the finite enclosing plate; its color is not
// observable here and never supplies ownership or a reason to ignore bounds.
function nativeClosedSharedLegend(page, caption, captions, tables, frames, tokens, font, owned) {
  const validRect = (r) =>
      Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && area(r) > 0,
    contains = (a, b) => b.every((v, n) => (n < 2 ? v >= a[n] - 1e-7 : v <= a[n] + 1e-7)),
    numeric = (t) => /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim())
  if (
    !validRect(owned) ||
    ![page.width, page.height].every((n) => Number.isFinite(n) && n > 0) ||
    page.invalidGraphicsBounds !== 0 ||
    !validRect(caption.rect) ||
    caption.page !== page.pageNumber ||
    captions.length !== 1 ||
    captions[0] !== caption ||
    frames.length !== 4 ||
    frames.some((r) => !validRect(r))
  )
    return
  const legends = frames.filter((r) => r[3] - r[1] < font * 3 && r[2] - r[0] > page.width * 0.5),
    legend = legends[0],
    faces = frames.filter((r) => r !== legend).sort((a, b) => a[0] - b[0])
  if (
    legends.length !== 1 ||
    faces.length !== 3 ||
    faces.some(
      (r, n) =>
        r[2] - r[0] < font * 6 ||
        r[3] - r[1] < font * 6 ||
        !contains(owned, r) ||
        Math.abs(r[1] - faces[0][1]) > font * 0.001 ||
        Math.abs(r[3] - faces[0][3]) > font * 0.001 ||
        Math.abs(r[2] - r[0] - faces[0][2] + faces[0][0]) > font * 0.001 ||
        (n && r[0] <= faces[n - 1][2])
    )
  )
    return
  const b = union(faces)
  if (
    legend[3] >= b[1] ||
    b[1] - legend[3] > font * 3 ||
    legend[0] < b[0] - font * 2 ||
    legend[2] > b[2] + font * 2 ||
    legend[2] - legend[0] < (b[2] - b[0]) * 0.8 ||
    legend[1] >= owned[1]
  )
    return
  const graphics = page.graphicsBounds ?? []
  if (
    graphics.some((g) => !['path', 'image'].includes(g.kind) || !validRect(g.normalizedRect)) ||
    tokens.some((t) => typeof t.text !== 'string' || !validRect(t.rect))
  )
    return
  const paths = graphics
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)))
  const metrics = (t) =>
    validRect(t.rect) &&
    [t.height, t.baseline].every(Number.isFinite) &&
    t.height > 0 &&
    typeof t.horizontal === 'boolean' &&
    Math.abs(t.baseline - t.rect[3]) < 1e-7 &&
    (!t.horizontal || Math.abs(t.rect[3] - t.rect[1] - t.height) < 1e-7)
  const axes = faces.map((f) => {
    const numbers = tokens.filter((t) => numeric(t) && metrics(t)),
      x = numbers.filter(
        (t) =>
          t.rect[0] >= f[0] - font * 0.3 &&
          t.rect[2] <= f[2] + font * 0.3 &&
          t.rect[1] > f[3] &&
          t.rect[3] <= f[3] + font * 2
      ),
      y = numbers.filter(
        (t) =>
          t.rect[2] < f[0] && t.rect[0] >= f[0] - font * 3 && t.rect[1] >= f[1] && t.rect[3] <= f[3]
      ),
      groups = [],
      padded = [
        f[0] - page.width / 256,
        f[1] - page.height / 256,
        f[2] + page.width / 256,
        f[3] + page.height / 256
      ]
    for (const t of y) {
      const group = groups.find((g) => Math.abs(g[0].baseline - t.baseline) < font * 0.001)
      if (group) group.push(t)
      else groups.push([t])
    }
    const paint = paths.filter(
      (r) =>
        intersection(r, padded) / area(r) > 0.95 &&
        area(r) < area(f) * 0.9 &&
        r[2] - r[0] > font * 3 &&
        r[3] - r[1] > font * 0.3
    )
    return { x, groups, paint }
  })
  if (
    axes.some(
      (a) =>
        a.x.length < 3 ||
        a.groups.length < 3 ||
        a.x.some((t) => Math.abs(t.baseline - a.x[0].baseline) > font * 0.001) ||
        a.paint.length < 3
    )
  )
    return
  const legendLines = page.lines.filter((l) => intersection(lineRect(l), legend) > 0)
  if (
    legendLines.length < 2 ||
    legendLines.some((l) => !contains(legend, lineRect(l)) || !completeNativePlotLine(l, tokens))
  )
    return
  let full = union([owned, legend])
  const baseline = full
  for (let pass = 0; pass <= paths.length; pass++) {
    const next = union([full, ...paths.filter((r) => intersection(r, full) > 0)])
    if (
      next[0] < baseline[0] - font * 2 ||
      next[1] < baseline[1] - font * 2 ||
      next[2] > baseline[2] + font * 2 ||
      next[3] > baseline[3] + font * 2 ||
      next[3] >= caption.rect[1] - font * 0.3
    )
      return
    const fixed = next.every((v, n) => v === full[n])
    full = next
    if (fixed) break
    if (pass === paths.length) return
  }
  if (
    tables.some((r) => intersection(r, full) > 0) ||
    graphics.some(
      (g) =>
        g.kind === 'image' &&
        intersection(
          g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)),
          full
        ) > 0
    )
  )
    return
  const lines = page.lines.filter((l) => l.text.trim() && intersection(lineRect(l), full) > 0),
    fonts = tokens.filter((t) => validRect(t.rect) && intersection(t.rect, full) > 0)
  if (
    lines.some(
      (l) =>
        !contains(full, lineRect(l)) ||
        l.fontSize > font * 1.5 ||
        !completeNativePlotLine(l, tokens)
    ) ||
    fonts.some(
      (t) =>
        !metrics(t) ||
        !contains(full, t.rect) ||
        lines.filter((l) => contains(lineRect(l), t.rect)).length !== 1
    )
  )
    return
  // A grouped native line may join the three column titles. Establish each
  // original whole font's centered, repeated baseline without splitting it.
  const titles = faces.map((f) =>
      fonts.filter(
        (t) =>
          t.horizontal &&
          t.rect[3] <= f[1] &&
          t.rect[1] >= f[1] - font * 3 &&
          t.rect[0] >= f[0] - font * 0.5 &&
          t.rect[2] <= f[2] + font * 0.5
      )
    ),
    mainTitles = titles.map((ts) => {
      let height = -Infinity
      for (const t of ts) height = Math.max(height, t.height)
      return ts.filter((t) => Math.abs(t.height - height) < 1e-7)
    })
  if (
    titles.some((ts) => !ts.length) ||
    mainTitles.some((ts) => ts.length !== 1) ||
    mainTitles.some(
      (ts) =>
        Math.abs(ts[0].height - mainTitles[0][0].height) > 1e-7 ||
        Math.abs(ts[0].baseline - mainTitles[0][0].baseline) > font * 0.001
    ) ||
    titles.some((ts, i) => {
      const r = union(ts.map((t) => t.rect)),
        main = mainTitles[i][0]
      return (
        Math.abs((r[0] + r[2] - faces[i][0] - faces[i][2]) / 2) > font * 0.5 ||
        ts.some(
          (t) =>
            t !== main &&
            (t.height > main.height * 0.8 ||
              t.rect[1] < main.rect[1] ||
              t.rect[3] > main.rect[3] + font * 0.3)
        )
      )
    })
  )
    return
  const labels = faces.map((f) =>
    fonts.filter(
      (t) =>
        t.horizontal &&
        !numeric(t) &&
        t.rect[1] >= f[3] &&
        t.rect[3] <= f[3] + font * 3 &&
        t.rect[0] >= f[0] &&
        t.rect[2] <= f[2]
    )
  )
  if (
    labels.some((ts) => ts.length !== 1) ||
    labels.some(
      (ts, i) =>
        Math.abs(ts[0].baseline - labels[0][0].baseline) > font * 0.001 ||
        Math.abs(ts[0].height - labels[0][0].height) > 1e-7 ||
        Math.abs((ts[0].rect[0] + ts[0].rect[2] - faces[i][0] - faces[i][2]) / 2) > font * 0.5 ||
        ts[0].rect[2] - ts[0].rect[0] > font * 4
    )
  )
    return
  if (
    fonts.some((t) => {
      if (contains(legend, t.rect)) return false
      return (
        faces.filter(
          (f, i) =>
            contains(f, t.rect) ||
            titles[i].includes(t) ||
            labels[i].includes(t) ||
            axes[i].x.includes(t) ||
            (t.rect[2] <= f[0] &&
              t.rect[0] >= f[0] - font * 4 &&
              t.rect[1] >= f[1] - font &&
              t.rect[3] <= f[3] + font &&
              (!t.horizontal || /^[−-]?\d*\.?\d*$/.test(t.text.trim())))
        ).length !== 1
      )
    })
  )
    return
  const crossed = paths.filter((r) => intersection(r, full) > 0),
    containers = crossed.filter((r) => frames.every((f) => contains(r, f))),
    padded = (f) => [
      f[0] - (page.width * 3) / 256,
      f[1] - (page.height * 3) / 256,
      f[2] + (page.width * 3) / 256,
      f[3] + (page.height * 3) / 256
    ]
  if (containers.length !== 1) return
  const strokes = crossed.filter(
    (r) => r !== containers[0] && contains(r, legend) && contains(padded(legend), r)
  )
  if (
    strokes.length !== 1 ||
    crossed.some(
      (r) =>
        !contains(full, r) ||
        (r !== containers[0] &&
          r !== strokes[0] &&
          !contains(legend, r) &&
          faces.filter((f) => intersection(f, r) > 0 && contains(padded(f), r)).length !== 1)
    )
  )
    return
  return { caption, rect: full, graphicsCount: faces.length }
}

// A complete three-by-three array can repeat a small per-column vertical
// translation. Require that same translation on all three rows, equal closed
// painted faces and complete native fonts. Do not widen ordinary row grouping.
function nativeTranslatedThreeRowClosedGrid(
  page,
  caption,
  captions,
  tables,
  closedFrames,
  tokens,
  font
) {
  const frames = closedFrames.filter(
    (r) =>
      r?.length === 4 &&
      r.every(Number.isFinite) &&
      r[2] - r[0] >= font * 6 &&
      r[3] - r[1] >= font * 6 &&
      r[3] < caption.rect[1]
  )
  if (frames.length !== 9) return
  const columns = []
  for (const r of frames.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const column = columns.find(
      (c) => Math.abs(c[0][0] - r[0]) < font * 0.001 && Math.abs(c[0][2] - r[2]) < font * 0.001
    )
    if (column) column.push(r)
    else columns.push([r])
  }
  if (columns.length !== 3 || columns.some((c) => c.length !== 3)) return
  const anchor = columns[0][0],
    step = columns[0][1][1] - anchor[1],
    b = union(frames)
  if (
    columns.some((c, i) =>
      c.some(
        (r, j) =>
          Math.abs(r[2] - r[0] - anchor[2] + anchor[0]) > font * 0.001 ||
          Math.abs(r[3] - r[1] - anchor[3] + anchor[1]) > font * 0.001 ||
          Math.abs(r[1] - c[0][1] - j * step) > font * 0.001 ||
          Math.abs(r[1] - columns[0][j][1] - c[0][1] + anchor[1]) > font * 0.001 ||
          Math.abs(c[0][1] - anchor[1]) > font * 0.25 ||
          (j && (r[1] <= c[j - 1][3] || r[1] - c[j - 1][3] > font * 8)) ||
          (i && (r[0] <= columns[i - 1][j][2] || r[0] - columns[i - 1][j][2] > font * 8))
      )
    ) ||
    caption.rect[1] - b[3] > font * 6 ||
    closedFrames.some((r) => !frames.includes(r) && intersection(r, b) > 0) ||
    tables.some((r) => intersection(r, b) > 0) ||
    captions.some((c) => c !== caption && intersection(c.rect, b) > 0)
  )
    return
  const labels = page.lines.filter(
    (l) =>
      l.fontSize > 0 &&
      l.fontSize <= font * 1.5 &&
      l.x >= b[0] - font * 5 &&
      l.x + l.width <= b[2] + font * 3 &&
      l.y >= b[1] - font * 4 &&
      l.y + l.height <= b[3] + font * 5 &&
      l.y + l.height < caption.rect[1]
  )
  if (labels.some((l) => !completeNativePlotLine(l, tokens))) return
  const legends = closedFrames.filter(
    (r) =>
      !frames.includes(r) &&
      r.every(Number.isFinite) &&
      r[0] >= b[0] - font &&
      r[2] <= b[2] + font &&
      r[2] - r[0] > (b[2] - b[0]) * 0.5 &&
      r[3] - r[1] > 0 &&
      r[3] - r[1] < font * 3 &&
      r[3] < b[1] &&
      b[1] - r[3] < font * 4
  )
  if (legends.length > 1) return
  const legend = legends[0]
  const legendLines = []
  if (legend) {
    const contents = page.lines.filter((l) => intersection(lineRect(l), legend) > 0),
      full = union([b, legend])
    if (
      !contents.length ||
      contents.some(
        (l) =>
          l.text.length >= 60 ||
          !completeNativePlotLine(l, tokens) ||
          !lineRect(l).every((v, i) => (i < 2 ? v >= legend[i] - 1e-7 : v <= legend[i] + 1e-7))
      ) ||
      closedFrames.some(
        (r) => r !== legend && !frames.includes(r) && intersection(r, legend) > 0
      ) ||
      tables.some((r) => intersection(r, full) > 0) ||
      captions.some((c) => c !== caption && intersection(c.rect, full) > 0) ||
      page.lines.some(
        (l) => l.y < b[1] - font * 4 && intersection(lineRect(l), full) > 0 && !contents.includes(l)
      )
    )
      return
    legendLines.push(...contents)
  } else if (
    page.lines.some(
      (l) =>
        l.y < b[1] - font * 4 &&
        l.y + l.height > b[1] - font * 8 &&
        l.x < b[2] &&
        l.x + l.width > b[0]
    )
  )
    return
  const full = union([b, ...(legend ? [legend] : []), ...labels.map(lineRect)])
  if (
    tokens.some(
      (t) =>
        t.rect?.length === 4 &&
        intersection(t.rect, full) > 0 &&
        ![...labels, ...legendLines].some((l) =>
          t.rect.every((v, i) => (i < 2 ? v >= lineRect(l)[i] - 1e-7 : v <= lineRect(l)[i] + 1e-7))
        )
    )
  )
    return
  return { frames, legend }
}

// Eight independently painted closed faces can use slightly different widths
// in their two rows. A complete serial title set must select each face once;
// centers, row geometry, populated faces and the ordinary source barriers
// remain independent witnesses. Open axes and unkeyed grids do not qualify.
function nativeTitledTwoRowClosedGrid(page, caption, captions, tables, frames, tokens, font) {
  const glyphs = (text) => text.replace(/\s/gu, '')
  const keys = page.lines
    .filter(
      (l) =>
        /^[a-h]\)\s+\S/u.test(l.text.trim()) &&
        [l.x, l.y, l.width, l.height, l.fontSize].every(Number.isFinite) &&
        l.y >= 0 &&
        l.y + l.height < caption.rect[1] &&
        l.fontSize >= font * 0.5 &&
        l.fontSize <= font &&
        l.width > 0 &&
        l.height > 0 &&
        Math.abs(l.height - l.fontSize) <= 1e-8
    )
    .filter((l) => {
      const parts = tokens
        .filter(
          (t) =>
            t.horizontal &&
            t.rect?.length === 4 &&
            t.rect.every(Number.isFinite) &&
            [t.height, t.baseline].every(Number.isFinite) &&
            t.height > 0 &&
            Math.abs(t.height - l.fontSize) <= 1e-8 &&
            Math.abs(t.rect[3] - t.rect[1] - t.height) <= 1e-8 &&
            Math.abs(t.baseline - t.rect[3]) <= 1e-8 &&
            t.rect[0] >= l.x - 1e-8 &&
            t.rect[2] <= l.x + l.width + 1e-8 &&
            Math.abs(t.rect[1] - l.y) < l.fontSize * 0.05 &&
            t.rect[3] <= l.y + l.height + 1e-8
        )
        .sort((a, b) => a.rect[0] - b.rect[0])
      return (
        parts.length > 0 &&
        union(parts.map((part) => part.rect)).every(
          (value, i) => Math.abs(value - lineRect(l)[i]) <= 1e-8
        ) &&
        parts.every((p, i) => !i || p.rect[0] >= parts[i - 1].rect[2] - l.fontSize * 0.1) &&
        glyphs(parts.map((t) => t.text).join(' ')) === glyphs(l.text)
      )
    })
    .map((l) => ({ text: l.text, rect: lineRect(l) }))
  const owned = []
  for (let i = 0; i < 8; i++) {
    const matches = keys.filter((t) => t.text.trim().startsWith(String.fromCharCode(97 + i) + ')'))
    if (matches.length !== 1) return
    const key = matches[0],
      owners = frames.filter(
        (r) =>
          r.every(Number.isFinite) &&
          r[2] - r[0] >= font * 6 &&
          r[3] - r[1] >= font * 6 &&
          key.rect[0] >= r[0] &&
          key.rect[2] <= r[2] &&
          key.rect[3] <= r[1] &&
          r[1] - key.rect[3] <= font * 2 &&
          Math.abs((key.rect[0] + key.rect[2] - r[0] - r[2]) / 2) < font * 2
      )
    if (owners.length !== 1 || owned.includes(owners[0])) return
    owned.push(owners[0])
  }
  const upper = owned.slice(0, 4),
    lower = owned.slice(4),
    b = union(owned)
  if (
    [upper, lower].some((row) =>
      row.some(
        (r, i) =>
          Math.abs(r[1] - row[0][1]) > font * 0.1 ||
          Math.abs(r[3] - row[0][3]) > font * 0.1 ||
          Math.abs((r[2] - r[0]) / (row[0][2] - row[0][0]) - 1) > 0.03 ||
          (i && (r[0] <= row[i - 1][2] || r[0] - row[i - 1][2] > font * 8))
      )
    ) ||
    lower.some(
      (r, i) =>
        r[1] <= upper[i][3] ||
        r[1] - upper[i][3] > font * 8 ||
        Math.abs((r[0] + r[2] - upper[i][0] - upper[i][2]) / 2) > font * 0.4 ||
        Math.abs((r[2] - r[0]) / (upper[i][2] - upper[i][0]) - 1) > 0.12 ||
        Math.abs((r[3] - r[1]) / (upper[i][3] - upper[i][1]) - 1) > 0.1
    ) ||
    b[0] < caption.rect[0] - font ||
    b[2] > caption.rect[2] + font ||
    caption.rect[1] - b[3] > font * 6 ||
    frames.some((r) => !owned.includes(r) && intersection(r, b) > 0) ||
    tables.some((r) => intersection(r, b) > 0) ||
    captions.some((c) => c !== caption && intersection(c.rect, b) > 0) ||
    page.lines.some(
      (l) => l.text.length >= 60 && l.fontSize >= font * 0.65 && intersection(lineRect(l), b) > 0
    )
  )
    return
  return owned
}

// A complete populated stack can repeat the same measured height sequence at
// its right edge: native number, raised arcsecond mark and parenthesized km
// value. Prove every chain on every face before taking its full glyph boxes;
// a nearby parenthesis or small body row alone supplies no ownership.
function nativeRepeatedPlotMeasurementTails(
  page,
  caption,
  captions,
  tables,
  frames,
  tokens,
  rect,
  font
) {
  if (
    frames.length < 2 ||
    frames.length > 6 ||
    !/\barcseconds?\b/i.test(caption.lines.join(' ')) ||
    !/\bkm\b/.test(caption.lines.join(' '))
  )
    return
  const source = tokens.filter(
    (t) =>
      t.horizontal &&
      t.rect?.length === 4 &&
      t.rect.every(Number.isFinite) &&
      area(t.rect) > 0 &&
      t.height > 0 &&
      Number.isFinite(t.height) &&
      Number.isFinite(t.baseline) &&
      t.rect[0] >= 0 &&
      t.rect[1] >= 0 &&
      t.rect[2] <= page.width &&
      t.rect[3] < caption.rect[1]
  )
  const groups = []
  for (const frame of frames) {
    const tails = source
      .filter(
        (t) =>
          /^\(\d+(?:\.\d+)?\s+km\)$/.test(t.text.trim()) &&
          t.rect[0] > frame[2] &&
          t.rect[2] <= frame[2] + t.height * 10 &&
          t.rect[1] >= frame[1] - t.height * 0.5 &&
          t.rect[3] <= frame[3] + t.height * 0.5 &&
          t.height <= font * 0.65
      )
      .sort((a, b) => a.rect[1] - b.rect[1])
    if (tails.length < 4 || tails.length > 64) return
    const chains = []
    for (const tail of tails) {
      const numbers = source.filter(
        (t) =>
          /^\d+(?:\.\d+)?$/.test(t.text.trim()) &&
          Math.abs(t.height - tail.height) <= tail.height * 0.01 &&
          Math.abs(t.baseline - tail.baseline) <= tail.height * 0.02 &&
          Math.abs(t.rect[3] - tail.rect[3]) <= tail.height * 0.02 &&
          t.rect[0] >= frame[2] &&
          t.rect[0] - frame[2] <= tail.height * 2 &&
          t.rect[2] <= tail.rect[0] &&
          tail.rect[0] - t.rect[2] <= tail.height
      )
      if (numbers.length !== 1) return
      const number = numbers[0]
      const quotes = source.filter(
        (t) =>
          /^(?:′′|″)$/.test(t.text.trim()) &&
          t.height >= tail.height * 0.5 &&
          t.height <= tail.height * 0.85 &&
          number.baseline - t.baseline >= tail.height * 0.2 &&
          number.baseline - t.baseline <= tail.height * 0.5 &&
          t.rect[0] >= number.rect[2] - tail.height * 0.01 &&
          t.rect[0] - number.rect[2] <= tail.height * 0.25 &&
          t.rect[2] <= tail.rect[0] &&
          tail.rect[0] - t.rect[2] <= tail.height * 0.6
      )
      if (quotes.length !== 1) return
      chains.push([number, quotes[0], tail])
    }
    if (
      chains.some(
        (chain, n) =>
          Math.abs(chain[0].rect[0] - chains[0][0].rect[0]) > chain[0].height * 0.1 ||
          (n &&
            (Number(chain[0].text) <= Number(chains[n - 1][0].text) ||
              Number(chain[2].text.match(/\d+(?:\.\d+)?/)[0]) <=
                Number(chains[n - 1][2].text.match(/\d+(?:\.\d+)?/)[0])))
      )
    )
      return
    groups.push(chains)
  }
  if (
    groups.some(
      (chains) =>
        chains.length !== groups[0].length ||
        chains.some(
          (chain, n) =>
            chain[0].text !== groups[0][n][0].text || chain[2].text !== groups[0][n][2].text
        )
    )
  )
    return
  const owned = groups.flat(2),
    expanded = union([rect, ...owned.map((t) => t.rect)])
  if (expanded[2] <= rect[2]) return
  const strip = [rect[2], expanded[1], expanded[2], expanded[3]]
  const contexts = (page.graphicsBounds ?? []).map((g) => {
    const r = (g.paintedNormalizedRect ?? g.normalizedRect).map(
      (v, n) => v * (n % 2 ? page.height : page.width)
    )
    const owners =
      g.kind === 'path'
        ? frames.filter(
            (f) =>
              intersection(r, f) / area(f) > 0.95 &&
              area(r) <= area(f) * 2 &&
              r.every((v, n) => Math.abs(v - f[n]) <= font * 6)
          )
        : []
    return { r, owners }
  })
  if (
    captions.some((c) => c !== caption && intersection(c.rect, expanded) > 0) ||
    tables.some((r) => intersection(r, expanded) > 0) ||
    tokens.some(
      (t) => t.rect?.every(Number.isFinite) && !owned.includes(t) && intersection(t.rect, strip) > 0
    ) ||
    contexts.some(({ r, owners }) => {
      if (intersection(r, strip) <= 0) return false
      // A quantized path extent already surrounds exactly one populated
      // owned face. Require the reverse unique correspondence in the added
      // strip too; a second container is independent paint, not a new frame.
      return (
        owners.length !== 1 ||
        contexts.filter(
          (other) => intersection(other.r, strip) > 0 && other.owners.includes(owners[0])
        ).length !== 1
      )
    })
  )
    return
  const normalized = (s) => s.replace(/\s+/g, '')
  if (
    page.lines.some((l) => {
      const r = lineRect(l)
      if (intersection(r, strip) <= 0) return false
      // Merged main-baseline lines can omit the small raised quote's top; its
      // native full box is already owned by the independently proved chain.
      const items = owned
        .filter((t) => intersection(t.rect, r) / area(t.rect) > 0.85)
        .sort((a, b) => a.rect[0] - b.rect[0])
      return normalized(items.map((t) => t.text).join('')) !== normalized(l.text)
    })
  )
    return
  return expanded
}

function nativeCaptionedUnequalClosedGrid(page, caption, captions, tables, frames, tokens, font) {
  const text = caption.lines.join(' ')
  if (!/\(a\)[\s\S]*\(d\)[\s\S]*\(e\)[\s\S]*\(f\)/.test(text)) return
  const keys = tokens.filter(
    (t) =>
      t.horizontal &&
      /^\([a-f]\)$/.test(t.text.trim()) &&
      t.rect?.every(Number.isFinite) &&
      t.rect[1] < caption.rect[1] &&
      t.rect[3] - t.rect[1] > 0 &&
      t.rect[3] - t.rect[1] <= font * 1.5
  )
  const candidates = frames.filter(
    (r) =>
      r.every(Number.isFinite) &&
      r[0] >= 0 &&
      r[1] >= 0 &&
      r[2] <= page.width &&
      r[3] < caption.rect[1] &&
      r[2] - r[0] >= 30 &&
      r[3] - r[1] >= 30
  )
  const owned = []
  for (let n = 0; n < 6; n++) {
    const marks = keys.filter((k) => k.text.trim() === `(${String.fromCharCode(97 + n)})`)
    if (marks.length !== 1) return
    const key = marks[0],
      matches = candidates.filter(
        (r) =>
          key.rect[0] >= r[0] - font * 0.25 &&
          key.rect[2] <= r[2] &&
          Math.abs(key.rect[1] - r[1]) < font * 1.5 &&
          key.rect[3] <= r[1] + font * 2
      )
    if (matches.length !== 1 || owned.includes(matches[0])) return
    owned.push(matches[0])
  }
  const upper = owned.slice(0, 4),
    lower = owned.slice(4),
    b = union(owned),
    top = union(upper)
  if (
    upper.some(
      (r, n) =>
        Math.abs(r[1] - upper[0][1]) > font * 0.15 ||
        Math.abs(r[3] - upper[0][3]) > font * 0.15 ||
        Math.abs((r[2] - r[0]) / (upper[0][2] - upper[0][0]) - 1) > 0.1 ||
        (n && r[0] <= upper[n - 1][2])
    )
  )
    return
  if (
    lower.some(
      (r) =>
        Math.abs(r[0] - lower[0][0]) > font * 0.25 ||
        Math.abs(r[2] - lower[0][2]) > font * 0.25 ||
        Math.abs((r[3] - r[1]) / (lower[0][3] - lower[0][1]) - 1) > 0.1 ||
        r[2] - r[0] < (upper[0][2] - upper[0][0]) * 3 ||
        Math.abs((r[0] + r[2] - top[0] - top[2]) / 2) > font * 2
    )
  )
    return
  if (
    lower[0][1] < top[3] ||
    lower[0][1] - top[3] > font * 8 ||
    lower[1][1] < lower[0][3] ||
    lower[1][1] - lower[0][3] > font * 8 ||
    caption.rect[1] - lower[1][3] > font * 6
  )
    return
  if (
    tables.some((r) => intersection(r, b) > 0) ||
    captions.some((c) => c !== caption && intersection(c.rect, b) > 0) ||
    page.lines.some(
      (l) => l.text.length >= 60 && l.fontSize >= font * 0.65 && intersection(lineRect(l), b) > 0
    )
  )
    return
  return owned
}

export function nativeDisjointPlotColumn(page, caption, captions, tables, tokens = []) {
  const ownCaps = captions.filter((c) => c.page === page.pageNumber)
  if (
    ownCaps.length < 2 ||
    !ownCaps.some(
      (c) => c !== caption && (c.rect[2] < caption.rect[0] || c.rect[0] > caption.rect[2])
    ) ||
    ownCaps.some(
      (c) =>
        c !== caption &&
        c.rect[0] < caption.rect[2] &&
        c.rect[2] > caption.rect[0] &&
        c.rect[1] < caption.rect[3]
    )
  )
    return
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((f) => f > 0)
  )
  if (!Number.isFinite(font)) return
  const graphics = page.graphicsBounds
    .map((g) => ({
      kind: g.kind,
      rect: (g.paintedNormalizedRect ?? g.normalizedRect).map(
        (v, i) => v * (i % 2 ? page.height : page.width)
      )
    }))
    .filter(
      (g) =>
        g.rect[0] >= caption.rect[0] - font * 0.5 &&
        g.rect[2] <= caption.rect[2] + font * 0.5 &&
        g.rect[3] < caption.rect[1] &&
        g.rect[1] > page.height * 0.045
    )
  const frames = graphics.filter(
    (g) =>
      g.kind === 'path' && g.rect[2] - g.rect[0] > font * 10 && g.rect[3] - g.rect[1] > font * 5
  )
  const outer = frames.filter(
    (g, i) =>
      !frames.some(
        (o, j) =>
          j !== i &&
          (area(o.rect) > area(g.rect) * 1.05 || (area(o.rect) === area(g.rect) && j < i)) &&
          intersection(o.rect, g.rect) / area(g.rect) > 0.95
      )
  )
  if (!outer.length || outer.length > 4) return
  const source = tokens.filter(
    (t) => t.rect?.every(Number.isFinite) && area(t.rect) > 0 && t.height > 0
  )
  if (
    outer.some((g) => {
      const ticks = source.filter(
        (t) =>
          /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
          t.rect[0] >= g.rect[0] - font * 3 &&
          t.rect[2] <= g.rect[2] + font &&
          t.rect[1] >= g.rect[1] - font &&
          t.rect[3] <= g.rect[3] + font * 2
      )
      return (
        ticks.length < 4 ||
        graphics.filter(
          (o) => o !== g && o.kind === 'path' && intersection(o.rect, g.rect) / area(o.rect) > 0.95
        ).length < 3
      )
    })
  )
    return
  let b = union(outer.map((g) => g.rect))
  for (let i = 0; i < graphics.length; i++) {
    const adjacent = graphics.filter(
      (g) =>
        g.kind === 'image' &&
        intersection([b[0] - font, b[1] - font * 4, b[2] + font, b[3] + font * 4], g.rect) > 0
    )
    const next = union([b, ...adjacent.map((g) => g.rect)])
    if (next.every((v, j) => v === b[j])) break
    b = next
  }
  const supported = graphics.filter((g) => intersection(g.rect, b) / area(g.rect) > 0.9)
  const labels = source.filter(
    (t) =>
      t.text.length < 60 &&
      t.height <= font * 1.5 &&
      t.rect[0] >= caption.rect[0] - font * 0.5 &&
      t.rect[2] <= caption.rect[2] + font * 0.5 &&
      t.rect[1] >= b[1] - font * 2 &&
      t.rect[3] <= Math.min(caption.rect[1] - font * 0.5, b[3] + font * 3) &&
      !ownCaps.some((c) => intersection(c.rect, t.rect) > 0)
  )
  const rect = union([b, ...supported.map((g) => g.rect), ...labels.map((t) => t.rect)])
  if (
    caption.rect[1] - rect[3] > font * 6 ||
    tables.some((t) => intersection(t, rect) > 0) ||
    source.some((t) => t.text.length >= 60 && intersection(t.rect, rect) > 0)
  )
    return
  return { caption, rect, graphicsCount: supported.length }
}

// A printed page number and an independent opposite running title share one
// baseline above a shallow full-width separator. Without a separator, require
// independent native items, a tightly centered short title and a separate paired
// diagram below an empty margin gap. A numbered figure title cannot qualify.
export function nativeFigureRunningHead(page, captions, tokens = [], rules = [], tables = []) {
  const source = tokens.length
    ? tokens
        .filter((t) => t.horizontal && t.rect?.every(Number.isFinite) && area(t.rect) > 0)
        .map((t) => ({
          text: t.text,
          x: t.rect[0],
          y: t.rect[1],
          width: t.rect[2] - t.rect[0],
          height: t.rect[3] - t.rect[1],
          fontSize: t.height
        }))
    : page.lines
  const numbers = source.filter(
    (l) =>
      l.text.trim() === String(page.pageNumber) &&
      l.y < page.height * 0.125 &&
      l.fontSize > 0 &&
      (l.x < page.width * 0.15 || l.x > page.width * 0.8)
  )
  if (numbers.length !== 1) return
  const number = numbers[0],
    font = number.fontSize
  const titles = source.filter(
    (l) =>
      l !== number &&
      l.text.length >= 3 &&
      l.text.length <= 100 &&
      l.fontSize > 0 &&
      l.fontSize <= font * 1.1 &&
      Math.abs(l.y + l.height - number.y - number.height) < font * 0.1 &&
      (number.x < page.width * 0.15 ? l.x > page.width * 0.4 : l.x + l.width < page.width * 0.85)
  )
  if (titles.length !== 1) return
  const lines = [number, titles[0]],
    bottom = Math.max(...lines.map((l) => l.y + l.height))
  const bars = page.graphicsBounds.filter((g) => {
    const r = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
    return (
      g.kind === 'path' &&
      r[2] - r[0] > page.width * 0.65 &&
      r[3] - r[1] < font &&
      r[1] >= bottom &&
      r[1] - bottom < font * 1.5 &&
      r[3] < page.height * 0.125 &&
      lines.every((l) => l.x >= r[0] - font && l.x + l.width <= r[2] + font)
    )
  })
  const nativeBars = rules.filter(
    (r) =>
      r[1] === r[3] &&
      r[2] - r[0] > page.width * 0.65 &&
      r[1] >= bottom &&
      r[1] - bottom < font * 1.5 &&
      r[3] < page.height * 0.125 &&
      lines.every((l) => l.x >= r[0] - font && l.x + l.width <= r[2] + font)
  )
  if (
    bars.length > 1 ||
    (!bars.length && nativeBars.length > 1) ||
    captions.some((c) => c.rect[1] <= bottom)
  )
    return
  const unruled = !bars.length && !nativeBars.length
  if (unruled) {
    const title = titles[0]
    const body = page.graphicsBounds.filter((g) => {
      const b = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      return (
        area(g.normalizedRect) > 0.05 &&
        b[2] - b[0] > page.width * 0.6 &&
        b[3] - b[1] > font * 8 &&
        b[1] > bottom + font * 0.8 &&
        b[1] < bottom + font * 2
      )
    })
    const panelKeys = source.filter(
      (l) =>
        /^\([ab]\)$/.test(l.text.trim()) &&
        l.y > bottom + font * 0.8 &&
        l.y < bottom + font * 3 &&
        l.fontSize >= font * 0.8 &&
        l.fontSize <= font * 1.1 &&
        body.some(
          (g) =>
            intersection(
              lineRect(l),
              g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
            ) /
              area(lineRect(l)) >
            0.9
        )
    )
    const closedPair = nativeRunningHeadClosedPlotPair(
      page,
      captions,
      source,
      body,
      rules,
      tables,
      font,
      bottom
    )
    if (
      !tokens.length ||
      bottom >= page.height * 0.07 ||
      number.width > font + 1e-8 ||
      title.text.length > 40 ||
      !/^[\p{L}][\p{L}\s.'’−-]*$/u.test(title.text.trim()) ||
      /^(?:figure|fig|panel)\b/i.test(title.text.trim()) ||
      Math.abs(title.fontSize - font) > font * 0.01 ||
      Math.abs(title.x + title.width / 2 - page.width / 2) > font * (closedPair ? 0.6 : 0.5) ||
      Math.abs(title.y - number.y) > font * 0.05 ||
      body.length !== 1 ||
      (!closedPair &&
        (panelKeys.length !== 2 || new Set(panelKeys.map((l) => l.text.trim())).size !== 2)) ||
      source.some((l) => !lines.includes(l) && l.y < bottom + font * 0.8) ||
      page.graphicsBounds.some((g) => g.normalizedRect[1] * page.height <= bottom + font * 0.8)
    )
      return
  }
  const bar = bars[0],
    r = bar
      ? bar.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      : (nativeBars[0] ?? [0, bottom, page.width, bottom])
  if (
    page.graphicsBounds.some(
      (g) =>
        g !== bar &&
        (g.kind === 'image' || area(g.normalizedRect) > 0.01) &&
        lines.some(
          (l) =>
            intersection(
              lineRect(l),
              g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
            ) > 0
        )
    )
  )
    return
  if (
    !page.graphicsBounds.some(
      (g) =>
        g !== bar &&
        area(g.normalizedRect) > 0.01 &&
        g.normalizedRect[1] * page.height > r[3] + font * 0.5
    )
  )
    return
  const sourceRect = union(lines.map(lineRect))
  const decorations =
    nativeBars.length === 1
      ? page.graphicsBounds.filter((g) => {
          if (g === bar || g.kind !== 'path') return false
          const b = g.normalizedRect.map((v, n) => v * (n % 2 ? page.height : page.width)),
            y = nativeBars[0][1]
          return (
            b[2] - b[0] <= page.width / 128 + 0.5 &&
            b[1] >= sourceRect[1] - page.height / 128 &&
            b[3] <= r[3] + (bar ? 0 : page.height / 128) &&
            rules.some(
              (stroke) =>
                stroke[0] === stroke[2] &&
                stroke[0] >= b[0] &&
                stroke[0] <= b[2] &&
                stroke[1] >= sourceRect[1] - font * 0.1 &&
                stroke[3] - stroke[1] > font &&
                Math.abs(stroke[3] - y) < font * 0.1 &&
                stroke[1] >= b[1] &&
                stroke[3] <= b[3]
            )
          )
        })
      : []
  const printed = page.lines.filter(
    (l) =>
      intersection(lineRect(l), sourceRect) / area(lineRect(l)) > 0.95 &&
      l.text.replace(/\s/g, '') ===
        lines
          .slice()
          .sort((a, b) => a.x - b.x)
          .map((t) => t.text.replace(/\s/g, ''))
          .join('')
  )
  return { lines: printed.length ? printed : lines, bar, decorations }
}

// A captioned pair of closed, populated plots can use complete keyed titles
// rather than standalone panel letters. This witnesses page furniture only;
// the existing plot-band proof still owns all graphic and label boundaries.
function nativeRunningHeadClosedPlotPair(
  page,
  captions,
  source,
  body,
  rules,
  tables,
  font,
  bottom
) {
  if (body.length !== 1) return false
  const bounds = body[0].normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
  const titles = source.filter(
    (l) =>
      /^\([ab]\)[ \t]+\S/.test(l.text.trim()) &&
      l.text.length <= 48 &&
      l.fontSize >= font * 0.65 &&
      l.fontSize <= font * 0.8 &&
      l.y >= bounds[1] &&
      l.y + l.height <= bounds[1] + font * 1.5
  )
  if (
    titles.length !== 2 ||
    new Set(titles.map((l) => l.text.trim()[1])).size !== 2 ||
    Math.abs(titles[0].fontSize - titles[1].fontSize) > font * 0.01 ||
    Math.abs(titles[0].y + titles[0].height - titles[1].y - titles[1].height) > font * 0.05
  )
    return false
  const frames = nativeClosedRuleFrames(rules).filter(
    (r) =>
      r[0] >= bounds[0] &&
      r[2] <= bounds[2] &&
      r[1] >= bounds[1] &&
      r[3] <= bounds[3] &&
      r[2] - r[0] > page.width * 0.2 &&
      r[3] - r[1] > font * 8
  )
  if (
    frames.length !== 2 ||
    Math.abs(frames[0][1] - frames[1][1]) > font * 0.05 ||
    Math.abs(frames[0][3] - frames[1][3]) > font * 0.05 ||
    !frames.every(
      (r) =>
        titles.filter(
          (l) =>
            l.x >= r[0] &&
            l.x + l.width <= r[2] &&
            l.y + l.height <= r[1] &&
            r[1] - l.y - l.height < font &&
            Math.abs(l.x + l.width / 2 - (r[0] + r[2]) / 2) < font
        ).length === 1
    )
  )
    return false
  const owners = captions.filter(
    (c) =>
      c.page === page.pageNumber &&
      /^(?:figure|fig\.)\s+\d/i.test(c.lines[0] ?? '') &&
      /\(a\)(?:\s|[,.:;])/.test(c.lines.join(' ')) &&
      /\(b\)(?:\s|[,.:;])/.test(c.lines.join(' ')) &&
      c.rect[1] >= bounds[3] &&
      c.rect[1] - bounds[3] <= font * 2 &&
      c.rect[0] <= bounds[0] + font &&
      c.rect[2] >= bounds[2] - font
  )
  if (
    owners.length !== 1 ||
    tables.some((t) => intersection(t, bounds) > 0) ||
    captions.some(
      (c) =>
        c !== owners[0] &&
        c.page === page.pageNumber &&
        intersection(c.rect, [bounds[0], bottom, bounds[2], owners[0].rect[3]]) > 0
    )
  )
    return false
  return nativeCaptionedPlotBand(page, owners[0], captions, tables, rules)?.graphicsCount === 2
}

// Repeated category labels end at a closed native bar-chart face. This owns
// their full rotated font boxes and the single adjacent vertical axis title.
// A detached title, isolated label, prose block, or unclosed face cannot expand.
export function nativeClosedCategoryLabels(
  page,
  caption,
  captions,
  tables,
  rect,
  rules,
  tokens = []
) {
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((f) => f > 0)
  )
  if (!Number.isFinite(font)) return []
  const source = tokens.filter(
    (t) =>
      t.rect?.every(Number.isFinite) &&
      area(t.rect) > 0 &&
      t.height > 0 &&
      t.text.length < 40 &&
      !captions.some((c) => intersection(c.rect, t.rect) > 0) &&
      !tables.some((r) => intersection(r, t.rect) > 0)
  )
  const frames = nativeClosedRuleFrames(rules, font * 0.05)
    .filter((r) => intersection(r, rect) / area(r) > 0.9 && r[3] - r[1] > 30)
    .filter(
      (r, i, a) => !a.slice(0, i).some((p) => p.every((v, j) => Math.abs(v - r[j]) < font * 0.05))
    )
  const found = []
  for (const face of frames) {
    const column = frames.filter(
      (f) => Math.abs(f[0] - face[0]) < font * 0.05 && Math.abs(f[2] - face[2]) < font * 0.05
    )
    const b = union(column)
    const labels = source.filter(
      (t) =>
        /\p{L}/u.test(t.text) &&
        t.text.length >= 3 &&
        t.height < font &&
        t.rect[0] < b[0] &&
        Math.abs(t.rect[2] - b[0]) < t.height &&
        t.rect[1] >= b[1] - t.height * 2 &&
        t.rect[1] < b[3] &&
        t.rect[3] <= Math.min(caption.rect[1], b[3] + t.height * 6) &&
        t.rect[3] - t.rect[1] <= t.height * 8
    )
    if (
      labels.length < 3 ||
      labels.some((t) => Math.abs(t.height - labels[0].height) > 0.1) ||
      Math.max(...labels.map((t) => t.rect[1])) - Math.min(...labels.map((t) => t.rect[1])) <
        labels[0].height * 4
    )
      continue
    const ticks = source.filter(
      (t) =>
        /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
        t.rect[0] >= b[0] - t.height &&
        t.rect[2] <= b[2] + t.height &&
        column.some((f) => t.rect[1] >= f[3] && t.rect[1] - f[3] < t.height * 2)
    )
    if (ticks.length < 3) continue
    const lbox = union(labels.map((t) => t.rect))
    const titles = source.filter(
      (t) =>
        !t.horizontal &&
        Math.abs(t.rect[2] - t.rect[0] - t.height) < 0.02 &&
        t.rect[3] - t.rect[1] > t.height * 3 &&
        t.rect[0] <= lbox[0] &&
        lbox[0] - t.rect[2] > -t.height &&
        lbox[0] - t.rect[2] < t.height * 1.5 &&
        t.rect[1] >= b[1] - t.height * 2 &&
        t.rect[3] <= b[3] + t.height
    )
    if (titles.length !== 1) continue
    const title = titles[0],
      markers = source.filter(
        (t) =>
          t.horizontal &&
          /^[a-z]$/.test(t.text) &&
          t.height >= title.height &&
          t.height <= title.height * 1.5 &&
          Math.abs(t.rect[0] - title.rect[0]) < t.height &&
          t.rect[3] < b[1] &&
          b[1] - t.rect[3] < t.height * 3
      )
    const owned = [...labels, title, ...(markers.length === 1 ? markers : [])],
      expanded = union([rect, ...owned.map((t) => t.rect)])
    const strip = [expanded[0], expanded[1], rect[0], expanded[3]]
    if (
      tables.some((t) => intersection(t, strip) > 0) ||
      captions.some((c) => intersection(c.rect, strip) > 0) ||
      tokens.some(
        (t) => !owned.includes(t) && t.text.length >= 40 && intersection(t.rect, strip) > 0
      )
    )
      continue
    found.push(...owned.map((t) => t.rect))
  }
  return found
}

// Sparse native diagrams can consist entirely of equal small nodes and thin
// connectors. Aligned connector endpoints and repeated labels on both sides
// establish a complete chain without treating bare paragraph rules as figures.
export function nativeAlignedNodeFigure(page, caption, captions, tables, rules, tokens = []) {
  const font = Math.max(
    ...page.lines
      .filter((l) => intersection(lineRect(l), caption.rect) > 0)
      .map((l) => l.fontSize)
      .filter((f) => f > 0)
  )
  if (!Number.isFinite(font)) return
  const paths = page.graphicsBounds
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
  const nodes = paths.filter(
    (r) =>
      r[2] - r[0] >= font * 0.5 &&
      r[2] - r[0] <= font * 1.5 &&
      r[3] - r[1] >= font * 0.5 &&
      r[3] - r[1] <= font * 1.5 &&
      Math.abs(r[2] - r[0] - r[3] + r[1]) < font * 0.3 &&
      r[3] < caption.rect[1] &&
      caption.rect[1] - r[3] < font * 6
  )
  if (
    nodes.length < 4 ||
    nodes.length > 12 ||
    nodes.some(
      (r) => Math.abs(r[1] - nodes[0][1]) > font * 0.1 || Math.abs(r[3] - nodes[0][3]) > font * 0.1
    )
  )
    return
  const center = (nodes[0][1] + nodes[0][3]) / 2
  const edges = rules.filter(
    (r) => r[1] === r[3] && Math.abs(r[1] - center) < font * 0.3 && r[2] - r[0] > font * 2
  )
  if (
    edges.length < 3 ||
    nodes.some(
      (n) => !edges.some((e) => Math.min(Math.abs(e[0] - n[2]), Math.abs(e[2] - n[0])) < font * 0.5)
    )
  )
    return
  const bounds = union(nodes),
    owned = tokens.filter(
      (t) =>
        t.rect?.every(Number.isFinite) &&
        area(t.rect) > 0 &&
        t.text.length < 50 &&
        t.height <= font * 1.3 &&
        t.rect[0] >= bounds[0] - font * 2 &&
        t.rect[2] <= bounds[2] + font * 2 &&
        t.rect[1] >= bounds[1] - font * 3 &&
        t.rect[3] <= Math.min(caption.rect[1] - font * 0.5, bounds[3] + font * 3)
    )
  if (
    nodes.some(
      (n) =>
        !owned.some(
          (t) => t.rect[3] < n[1] && t.rect[0] < (n[0] + n[2]) / 2 && t.rect[2] > (n[0] + n[2]) / 2
        ) ||
        !owned.some((t) => t.rect[1] > n[3] && t.rect[0] < n[2] + font && t.rect[2] > n[0] - font)
    )
  )
    return
  const rect = union([bounds, ...edges, ...owned.map((t) => t.rect)])
  if (
    tables.some((t) => intersection(t, rect) > 0) ||
    captions.some(
      (c) => c !== caption && c.page === page.pageNumber && intersection(c.rect, rect) > 0
    ) ||
    tokens.some((t) => t.text.length >= 50 && intersection(t.rect, rect) > 0)
  )
    return
  return { caption, rect, graphicsCount: nodes.length + edges.length }
}

export function nativeTopParagraphTail(line, bounds, lines) {
  if (line.y + line.height > bounds[1] || line.fontSize <= 0 || line.text.length < 3) return false
  const owned = [line]
  let current = line
  for (let i = 0; i < 3; i++) {
    const peers = lines.filter(
      (l) =>
        l !== current &&
        l.text.length >= 3 &&
        l.height > 0 &&
        Math.abs(l.fontSize - line.fontSize) < 0.1 &&
        Math.abs(l.height - line.height) < line.height * 0.4 &&
        current.y - l.y - l.height >= -line.fontSize * 0.05 &&
        current.y - l.y - l.height < line.height * 0.8 &&
        current.y - l.y > line.fontSize * 0.8 &&
        Math.abs(l.x - line.x) < line.height * 2
    )
    if (peers.length !== 1) break
    current = peers[0]
    owned.push(current)
  }
  return (
    (owned.length >= 3 &&
      owned.filter((l) => l.text.length >= 60).length >= 2 &&
      current.y < bounds[1] - 24) ||
    (owned.length >= 2 &&
      /[.!?]$/.test(line.text.trim()) &&
      lines.some(
        (l) =>
          l.y >= bounds[1] &&
          l.y + l.height <= bounds[3] &&
          l.fontSize > 0 &&
          l.fontSize < line.fontSize * 0.8
      ) &&
      (owned.some((l) => l.text.length >= 60) || owned.every((l) => /^[•●]\s/.test(l.text.trim()))))
  )
}

function nativeCompactFacetedNinePlots(
  page,
  caption,
  captions,
  tables,
  closedFrames,
  tokens,
  existingOwnedRect
) {
  const valid = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && area(r) > 0
  const contains = (a, b, e = 1e-7) =>
    valid(a) && valid(b) && b.every((v, i) => (i < 2 ? v >= a[i] - e : v <= a[i] + e))
  const near = (a, b, e) => Math.abs(a - b) <= e
  const glyphs = (s) => s.replace(/\s/gu, '')
  const numeric = (s) => /^[−-]?\d+(?:\.\d+)?$/u.test(s)
  const number = (s) => Number(s.replace('−', '-'))
  const fullToken = (t) =>
    t &&
    typeof t.text === 'string' &&
    t.text.trim() &&
    valid(t.rect) &&
    t.horizontal === true &&
    [t.height, t.baseline].every(Number.isFinite) &&
    t.height > 0 &&
    near(t.baseline, t.rect[3], 1e-7) &&
    near(t.rect[3] - t.rect[1], t.height, 1e-7)

  function completeLine(line, tokens) {
    if (
      !line ||
      typeof line.text !== 'string' ||
      !line.text.trim() ||
      !valid(lineRect(line)) ||
      !(line.fontSize > 0) ||
      !Number.isFinite(line.fontSize)
    )
      return
    const r = lineRect(line),
      parts = tokens
        .filter((t) => fullToken(t) && contains(r, t.rect))
        .sort((a, b) => a.rect[0] - b.rect[0] || a.rect[1] - b.rect[1])
    if (
      !parts.length ||
      glyphs(parts.map((t) => t.text).join('')) !== glyphs(line.text) ||
      !near(Math.max(...parts.map((t) => t.height)), line.fontSize, 1e-7) ||
      !union(parts.map((t) => t.rect)).every((v, i) => near(v, r[i], 1e-7))
    )
      return
    return parts
  }

  // Independent closed outer/column/facet frames qualify the smaller panel font;
  // no old caption-font first-filter threshold is modified by this private branch.

  if (
    !page ||
    !caption ||
    !Array.isArray(page.lines) ||
    !Array.isArray(page.graphicsBounds) ||
    !Array.isArray(captions) ||
    !Array.isArray(tables) ||
    !Array.isArray(closedFrames) ||
    !Array.isArray(tokens)
  )
    return undefined
  if (
    ![page.width, page.height].every((n) => Number.isFinite(n) && n > 0) ||
    !Number.isInteger(page.pageNumber) ||
    page.pageNumber <= 0 ||
    page.renderRotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    caption.page !== page.pageNumber ||
    !valid(caption.rect) ||
    !valid(existingOwnedRect) ||
    !Array.isArray(caption.lines) ||
    !caption.lines.length ||
    caption.lines.some((t) => typeof t !== 'string' || !t.trim())
  )
    return undefined
  if (
    page.lines.some(
      (l) =>
        !l ||
        typeof l.text !== 'string' ||
        !valid(lineRect(l)) ||
        !Number.isFinite(l.fontSize) ||
        !(l.fontSize > 0)
    ) ||
    tokens.some((t) => !fullToken(t)) ||
    closedFrames.some((r) => !valid(r)) ||
    tables.some((r) => !valid(r))
  )
    return undefined
  const own = captions.filter((c) => c?.page === page.pageNumber)
  if (own.filter((c) => c === caption).length !== 1 || own.some((c) => !valid(c.rect)))
    return undefined
  const captionRows = caption.lines.map((text) =>
    page.lines.filter((l) => l.text === text && contains(caption.rect, lineRect(l)))
  )
  if (captionRows.some((rs) => rs.length !== 1 || !completeLine(rs[0], tokens))) return undefined
  const font = Math.max(...captionRows.map((rs) => rs[0].fontSize)),
    eps = font * 0.002
  const potential = closedFrames.filter(
    (r) => r[3] < caption.rect[1] && r[2] - r[0] >= font * 6 && r[3] - r[1] >= font * 2.5
  )
  if (potential.length < 9 || potential.length > 81) return undefined
  const groups = []
  for (const r of potential) {
    const group = groups.find(
      (g) => near(g[0][2] - g[0][0], r[2] - r[0], eps) && near(g[0][3] - g[0][1], r[3] - r[1], eps)
    )
    if (group) group.push(r)
    else groups.push([r])
  }
  const lattices = groups
    .filter((g) => g.length === 9)
    .map((g) => {
      const rows = []
      for (const r of g.slice().sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
        const row = rows.find((rs) => near(rs[0][1], r[1], eps))
        if (row) row.push(r)
        else rows.push([r])
      }
      if (rows.length !== 3 || rows.some((rs) => rs.length !== 3)) return
      rows.forEach((rs) => rs.sort((a, b) => a[0] - b[0]))
      if (
        rows.some((rs) =>
          rs.some((r, c) => !near(r[0], rows[0][c][0], eps) || !near(r[2], rows[0][c][2], eps))
        ) ||
        rows
          .slice(1)
          .some(
            (rs, i) =>
              !(rs[0][1] > rows[i][0][3]) ||
              !near(rs[0][1] - rows[i][0][1], rows[1][0][1] - rows[0][0][1], eps)
          ) ||
        rows.some((rs) => rs.slice(1).some((r, c) => r[0] <= rs[c][2]))
      )
        return
      return rows
    })
    .filter(Boolean)
  if (lattices.length !== 1) return undefined
  const rows = lattices[0],
    faces = rows.flat(),
    faceBounds = union(faces)
  const outerCandidates = closedFrames.filter(
    (r) =>
      contains(r, faceBounds) &&
      caption.rect[1] - r[3] > 0 &&
      caption.rect[1] - r[3] <= font * 2 &&
      r[0] >= caption.rect[0] - font &&
      r[2] <= caption.rect[2] + font &&
      r[1] < faceBounds[1] &&
      area(r) < page.width * page.height * 0.5
  )
  if (outerCandidates.length !== 1) return undefined
  const outer = outerCandidates[0],
    carriers = []
  for (let c = 0; c < 3; c++) {
    const column = rows.map((rs) => rs[c]),
      b = union(column)
    const matches = closedFrames.filter(
      (r) =>
        r !== outer &&
        contains(outer, r) &&
        contains(r, b) &&
        r[1] < b[1] - font &&
        r[3] > b[3] &&
        r[2] - r[0] < (faces[0][2] - faces[0][0]) * 1.4
    )
    if (matches.length !== 1) return undefined
    carriers.push(matches[0])
  }
  if (new Set(carriers).size !== 3 || carriers.slice(1).some((r, c) => r[0] < carriers[c][2] - eps))
    return undefined
  const strips = []
  for (const face of faces) {
    const matches = closedFrames.filter(
      (r) =>
        near(r[0], face[0], eps) &&
        near(r[2], face[2], eps) &&
        r[1] < face[1] &&
        near(r[3], face[1], eps) &&
        r[3] - r[1] < font * 2
    )
    if (matches.length !== 1) return undefined
    strips.push(matches[0])
  }
  const bars = faces.map((face) =>
    closedFrames
      .filter((r) => r !== face && contains(face, r) && r[2] - r[0] < (face[2] - face[0]) * 0.1)
      .sort((a, b) => a[0] - b[0])
  )
  if (
    bars.some(
      (rs, i) =>
        rs.length < 3 ||
        rs.some(
          (r, j) =>
            !near(r[3], rs[0][3], eps) ||
            !near(r[2] - r[0], rs[0][2] - rs[0][0], eps) ||
            (j && r[0] < rs[j - 1][2] - eps)
        ) ||
        faces[i][3] - rs[0][3] > font * 0.5
    )
  )
    return undefined
  const plateRows = page.lines.filter((l) => intersection(lineRect(l), outer) > 0),
    roleRows = new Set(),
    titleRows = [],
    stripRows = [],
    yTicks = [],
    xTicks = []
  const assign = (l) => {
    if (roleRows.has(l)) return false
    roleRows.add(l)
    return true
  }
  for (let c = 0; c < 3; c++) {
    const carrier = carriers[c],
      firstStrip = strips[c]
    const headings = plateRows.filter(
      (l) =>
        contains(carrier, lineRect(l)) &&
        l.y + l.height < firstStrip[1] &&
        l.y >= carrier[1] &&
        !numeric(l.text.trim())
    )
    if (
      headings.length !== 2 ||
      !near(headings[0].fontSize, headings[1].fontSize, 1e-7) ||
      headings.some(
        (l) =>
          Math.abs(l.x + l.width / 2 - (rows[0][c][0] + rows[0][c][2]) / 2) > font || !assign(l)
      )
    )
      return undefined
    titleRows.push(...headings)
    const columnTickRows = []
    for (let r = 0; r < 3; r++) {
      const face = rows[r][c],
        strip = strips[r * 3 + c]
      const titles = plateRows.filter((l) => contains(strip, lineRect(l)))
      if (titles.length !== 1 || !assign(titles[0])) return undefined
      stripRows.push(titles[0])
      const ticks = plateRows
        .filter(
          (l) =>
            numeric(l.text.trim()) &&
            l.x >= carrier[0] &&
            l.x + l.width < face[0] &&
            l.y + l.height / 2 >= face[1] &&
            l.y + l.height / 2 <= face[3]
        )
        .sort((a, b) => a.y - b.y)
      if (
        ticks.length < 3 ||
        ticks.some((l) => !near(l.fontSize, titles[0].fontSize, 1e-7) || !assign(l))
      )
        return undefined
      const values = ticks.map((l) => number(l.text.trim())),
        step = values[1] - values[0]
      if (
        !(step < 0) ||
        values
          .slice(1)
          .some((v, i) => !near(v - values[i], step, Math.max(1e-7, Math.abs(step) * 0.001)))
      )
        return undefined
      if (
        r &&
        (ticks.length !== columnTickRows[0].length ||
          ticks.some(
            (l, i) =>
              l.text !== columnTickRows[0][i].text ||
              !near(l.y - face[1], columnTickRows[0][i].y - rows[0][c][1], eps)
          ))
      )
        return undefined
      if (face[2] - face[0] < titles[0].fontSize * 12 || face[3] - face[1] < titles[0].fontSize * 8)
        return undefined
      columnTickRows.push(ticks)
      yTicks.push(...ticks)
    }
    const bottomFace = rows[2][c]
    const bottom = plateRows.filter(
      (l) =>
        l.y > bottomFace[3] &&
        contains(carrier, lineRect(l)) &&
        l.text.trim().split(/\s+/).length >= 3 &&
        l.text.trim().split(/\s+/).every(numeric)
    )
    if (
      bottom.length !== 1 ||
      !assign(bottom[0]) ||
      Math.abs(bottom[0].x + bottom[0].width / 2 - (bottomFace[0] + bottomFace[2]) / 2) > font ||
      bottom[0].width < (bottomFace[2] - bottomFace[0]) * 0.8
    )
      return undefined
    const values = bottom[0].text.trim().split(/\s+/).map(number),
      step = values[1] - values[0]
    if (
      !(step > 0) ||
      values
        .slice(1)
        .some((v, i) => !near(v - values[i], step, Math.max(1e-7, Math.abs(step) * 0.001)))
    )
      return undefined
    if (c && bottom[0].text !== xTicks[0].text) return undefined
    xTicks.push(bottom[0])
  }
  // Repeated facet labels are calibrated by the three independent columns,
  // without using any source-specific geographic names or title vocabulary.
  for (let r = 0; r < 3; r++) {
    const peers = [stripRows[r], stripRows[3 + r], stripRows[6 + r]]
    if (
      peers.some(
        (l) =>
          l.text !== peers[0].text ||
          !near(l.fontSize, peers[0].fontSize, 1e-7) ||
          !near(l.y, peers[0].y, eps)
      )
    )
      return undefined
  }
  if (roleRows.size !== plateRows.length) return undefined
  const fonts = []
  for (const line of roleRows) {
    const parts = completeLine(line, tokens)
    if (!parts) return undefined
    fonts.push(...parts)
  }
  const plateFonts = tokens.filter((t) => intersection(t.rect, outer) > 0)
  if (
    new Set(fonts).size !== fonts.length ||
    fonts.length !== plateFonts.length ||
    plateFonts.some((t) => !fonts.includes(t))
  )
    return undefined
  // No graphics copy/scan is constructed until a complete finite lattice and
  // all font roles exist, so ordinary large-vector legacy pages reject cheaply.
  const drawings = page.graphicsBounds.map((g, index) => ({
    g,
    index,
    rect: Array.isArray(g?.normalizedRect)
      ? g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      : undefined
  }))
  if (
    drawings.some(
      ({ g, rect }) =>
        !g ||
        !valid(rect) ||
        !['path', 'image'].includes(g.kind) ||
        !Number.isInteger(g.operationIndex)
    )
  )
    return undefined
  const permittedFrames = [outer, ...carriers, ...faces, ...strips],
    qx = page.width / 256,
    qy = page.height / 256
  const paints = drawings.filter(({ rect }) => intersection(rect, outer) > 0)
  const sourcePaintRect = union([outer, ...paints.map((p) => p.rect), ...fonts.map((t) => t.rect)])
  if (
    !contains(
      [outer[0] - font, outer[1] - font, outer[2] + font, outer[3] + font],
      existingOwnedRect
    ) ||
    !faces.some((f) => intersection(f, existingOwnedRect) > area(f) * 0.5)
  )
    return undefined
  // Preserve already-owned padding, then close every whole primitive crossed by
  // that rect below. Extra white area is not asserted to be painted ink.
  const rect = union([sourcePaintRect, existingOwnedRect])
  const closeFit = (r, f) =>
    contains(r, f, qx * 0.01) &&
    r.every((v, i) => Math.abs(v - f[i]) <= (i % 2 ? qy : qx) * 2 + 1e-7)
  const facetPadded = faces.map((f, i) => {
    const c = i % 3,
      carrier = carriers[c]
    const axisFonts = yTicks
      .filter(
        (l) =>
          l.x >= carrier[0] &&
          l.x + l.width < f[0] &&
          l.y + l.height / 2 >= f[1] &&
          l.y + l.height / 2 <= f[3]
      )
      .map(lineRect)
    const b = union([f, strips[i], ...axisFonts, ...(i >= 6 ? [lineRect(xTicks[c])] : [])])
    return [b[0] - qx * 2, b[1] - qy * 2, b[2] + qx * 2, b[3] + qy * 2]
  })

  for (const paint of paints) {
    if (paint.g.kind !== 'path' || !contains(rect, paint.rect)) return undefined
    const matched = permittedFrames.filter((f) => closeFit(paint.rect, f))
    const insideFacets = facetPadded
      .map((f, i) => (contains(f, paint.rect) ? i : undefined))
      .filter((i) => i !== undefined)
    // Full carriers/outer are included as whole measured paint, never ignored
    // because of color. Their exact source frames supply independent identity.
    if (!matched.length && !insideFacets.length) return undefined
  }
  if (drawings.filter((p) => intersection(p.rect, rect) > 0).length !== paints.length)
    return undefined
  if (
    closedFrames.some(
      (f) => intersection(f, outer) > 0 && !permittedFrames.includes(f) && !bars.flat().includes(f)
    )
  )
    return undefined
  if (
    own.some((c) => c !== caption && intersection(c.rect, rect) > 0) ||
    intersection(caption.rect, rect) > 0 ||
    tables.some((t) => intersection(t, rect) > 0)
  )
    return undefined
  if (
    page.lines.some((l) => intersection(lineRect(l), rect) > 0 && !roleRows.has(l)) ||
    tokens.some((t) => intersection(t.rect, rect) > 0 && !fonts.includes(t))
  )
    return undefined
  if (
    !contains(rect, existingOwnedRect) ||
    caption.rect[1] - rect[3] <= 0 ||
    caption.rect[1] - rect[3] > font * 2
  )
    return undefined
  return { caption, rect, graphicsCount: 9 }
}

function supportsCompactFacetedOperatorContext(page, tokens, frames, context) {
  const allowed = new Set(
    [
      'setFillRGBColor',
      'setStrokeRGBColor',
      'transform',
      'save',
      'restore',
      'paintFormXObjectBegin',
      'paintFormXObjectEnd',
      'setLineCap',
      'setLineJoin',
      'setMiterLimit',
      'clip',
      'constructPath',
      'setLineWidth',
      'setDash',
      'beginText',
      'endText',
      'dependency',
      'setFont',
      'setTextMatrix',
      'showText',
      'moveText'
    ].map((n) => OPS[n])
  )
  const numericContainer = (a) => Array.isArray(a) || a instanceof Float32Array
  const numeric = (a, n) => numericContainer(a) && a.length === n && a.every(Number.isFinite)
  const matrix = (a) => numeric(a, 6) && a[0] > 0 && a[3] > 0 && a[1] === 0 && a[2] === 0
  const pathProgram = (a) => {
    if (!numericContainer(a) || !a.length || a.some((v) => !Number.isFinite(v))) return false
    let current = false
    for (let i = 0; i < a.length;) {
      const op = a[i++],
        n = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 4 ? 0 : -1
      if (n < 0 || i + n > a.length || (op !== 0 && !current)) return false
      if (op === 0) current = true
      i += n
    }
    return true
  }
  const glyphs = (s) => s.replace(/\s/gu, '')
  const glyphKeys = new Set([
    'originalCharCode',
    'fontChar',
    'unicode',
    'accent',
    'width',
    'vmetric',
    'operatorListId',
    'isSpace',
    'isInFont'
  ])

  const o = context?.operators,
    v = context?.viewport
  if (version !== '5.4.624') return false
  if (
    !o ||
    !Array.isArray(o.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    !o.fnArray.length ||
    !v ||
    !numeric(v.transform, 6) ||
    v.rotation !== 0 ||
    v.width !== page?.width ||
    v.height !== page?.height ||
    v.transform.some((x, i) => x !== [1, 0, 0, -1, 0, page.height][i]) ||
    !Array.isArray(tokens) ||
    !Array.isArray(frames)
  )
    return false
  const stack = [],
    unicode = []
  let inText = false,
    currentFont = false
  for (let i = 0; i < o.fnArray.length; i++) {
    const code = o.fnArray[i],
      a = o.argsArray[i],
      name = Object.keys(OPS).find((key) => OPS[key] === code)
    if (!allowed.has(code)) return false
    if (
      ['save', 'restore', 'paintFormXObjectEnd', 'beginText', 'endText', 'clip'].includes(name) &&
      a !== null &&
      a !== undefined &&
      (!Array.isArray(a) || a.length)
    )
      return false
    if (name === 'save') stack.push('save')
    else if (name === 'restore') {
      if (stack.pop() !== 'save') return false
    } else if (name === 'paintFormXObjectBegin') {
      if (
        !Array.isArray(a) ||
        a.length !== 2 ||
        (a[0] !== null && !matrix(a[0])) ||
        !numeric(a[1], 4) ||
        a[1][0] >= a[1][2] ||
        a[1][1] >= a[1][3]
      )
        return false
      stack.push('form')
    } else if (name === 'paintFormXObjectEnd') {
      if (stack.pop() !== 'form') return false
    } else if (name === 'transform' && !matrix(a)) return false
    else if (
      ['setFillRGBColor', 'setStrokeRGBColor'].includes(name) &&
      (!Array.isArray(a) ||
        a.length !== 1 ||
        typeof a[0] !== 'string' ||
        !/^#[0-9a-f]{6}$/iu.test(a[0]))
    )
      return false
    else if (
      ['setLineCap', 'setLineJoin'].includes(name) &&
      (!numeric(a, 1) || !Number.isInteger(a[0]) || a[0] < 0 || a[0] > 2)
    )
      return false
    else if (['setLineWidth', 'setMiterLimit'].includes(name) && (!numeric(a, 1) || a[0] <= 0))
      return false
    else if (
      name === 'setDash' &&
      (!Array.isArray(a) ||
        a.length !== 2 ||
        !numericContainer(a[0]) ||
        a[0].some((n) => !Number.isFinite(n) || n < 0) ||
        !Number.isFinite(a[1]))
    )
      return false
    else if (name === 'constructPath') {
      if (
        !Array.isArray(a) ||
        a.length !== 3 ||
        ![OPS.stroke, OPS.fill, OPS.fillStroke, OPS.endPath].includes(a[0]) ||
        !Array.isArray(a[1]) ||
        a[1].length !== 1 ||
        !pathProgram(a[1][0]) ||
        !numeric(a[2], 4)
      )
        return false
    } else if (name === 'beginText') {
      if (inText) return false
      inText = true
      currentFont = false
    } else if (name === 'endText') {
      if (!inText) return false
      inText = false
      currentFont = false
    } else if (
      name === 'dependency' &&
      (!Array.isArray(a) || !a.length || a.some((s) => typeof s !== 'string' || !s))
    )
      return false
    else if (name === 'setFont') {
      if (
        !inText ||
        !Array.isArray(a) ||
        a.length !== 2 ||
        typeof a[0] !== 'string' ||
        !a[0] ||
        !Number.isFinite(a[1]) ||
        a[1] <= 0
      )
        return false
      currentFont = true
    } else if (
      name === 'setTextMatrix' &&
      (!inText || !currentFont || !Array.isArray(a) || a.length !== 1 || !matrix(a[0]))
    )
      return false
    else if (name === 'moveText' && (!inText || !currentFont || !numeric(a, 2))) return false
    else if (name === 'showText') {
      if (
        !inText ||
        !currentFont ||
        !Array.isArray(a) ||
        a.length !== 1 ||
        !Array.isArray(a[0]) ||
        !a[0].length
      )
        return false
      for (const g of a[0]) {
        if (typeof g === 'number') {
          if (!Number.isFinite(g)) return false
          continue
        }
        if (
          !g ||
          typeof g !== 'object' ||
          (g.operatorListId !== undefined && g.operatorListId !== null)
        )
          return false
        if (
          Object.keys(g).some((k) => !glyphKeys.has(k)) ||
          typeof g.unicode !== 'string' ||
          !g.unicode ||
          typeof g.fontChar !== 'string' ||
          !g.fontChar ||
          !Number.isInteger(g.originalCharCode) ||
          g.originalCharCode < 0 ||
          !Number.isFinite(g.width) ||
          g.width <= 0 ||
          (g.accent !== null && g.accent !== undefined) ||
          (g.vmetric !== undefined && g.vmetric !== null) ||
          typeof g.isSpace !== 'boolean' ||
          typeof g.isInFont !== 'boolean' ||
          (!g.isSpace && !g.isInFont)
        )
          return false
        unicode.push(g.unicode)
      }
    }
  }
  if (stack.length || inText) return false
  if (
    tokens.some((t) => !t || typeof t.text !== 'string') ||
    glyphs(unicode.join('')) !== glyphs(tokens.map((t) => t.text).join(''))
  )
    return false
  const rederived = collectClosedFigureFrames(o, v)
  if (JSON.stringify(rederived) !== JSON.stringify(frames)) return false
  return true
}
