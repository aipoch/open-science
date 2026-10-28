import {
  verifyNativeDualApiCertificate,
  completeNativeDualApiPacket,
  completeScopedNativeDualApiPacket
} from './literature-pdf-native-dual-api-certificate.mjs'
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util, normalizeUnicode } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  nativeFigureRecoveryProfileData,
  attachNativeRecoveryPaintProfile,
  createNativeForeignAccentProfile
} from './literature-pdf-native-figure-recovery-profile.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { nativeCompositingProfileData } from './literature-pdf-native-compositing-profile.mjs'
import { collectClosedFigureFrames, collectTableRules } from './literature-pdf-graphics.mjs'
import {
  closedPrintedFaceProfile,
  printedFaceStateEntry
} from './literature-pdf-native-printed-face-packet.mjs'
import { nativeClosedRuleFrames } from './literature-pdf-figure-connectivity.mjs'
import { area, intersection, union } from './literature-pdf-page-geometry.mjs'
import { joinHorizontalTableRules } from './literature-pdf-table-rules.mjs'

// Rotated source runs and keyed horizontal strokes establish ownership beyond
// a plot's crop. Numeric tick columns anchor axes; three aligned marker/text
// pairs anchor a common legend. Proximity alone does not own ordinary prose.
export function nativeAttachedPlotLabels(page, figure, captions, tables, rules, tokens) {
  if (!figure.rect?.every(Number.isFinite)) return figure
  const bounds = figure.rect
  const source = tokens.filter(
    (t) =>
      t.rect?.every(Number.isFinite) &&
      area(t.rect) > 0 &&
      t.height > 0 &&
      Number.isFinite(t.baseline) &&
      t.text.trim()
  )
  // The production extractor preserves original line geometry even when a
  // repaired text stream omits a short panel marker or legend run. Use those
  // lines only for the two narrowly proved boundary completions below; axis
  // ownership continues to require the stricter native token evidence.
  const lineSource = (page.lines ?? [])
    .filter(
      (line) =>
        line.text?.trim() &&
        Number.isFinite(line.x) &&
        Number.isFinite(line.y) &&
        Number.isFinite(line.width) &&
        Number.isFinite(line.height) &&
        line.width > 0 &&
        line.height > 0
    )
    .map((line) => ({
      text: line.text,
      rect: [line.x, line.y, line.x + line.width, line.y + line.height],
      horizontal: line.horizontal !== false,
      height: line.height,
      baseline: line.y + line.height
    }))
  const boundaryText = [...source, ...lineSource].filter(
    (token, index, all) =>
      all.findIndex(
        (other) =>
          other.text === token.text &&
          other.rect.every((value, axis) => Math.abs(value - token.rect[axis]) < 0.01)
      ) === index
  )
  const ticks = source.filter(
    (t) =>
      t.horizontal &&
      /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
      t.rect[0] >= bounds[0] - 0.01 &&
      t.rect[2] <= bounds[0] + t.height * 5 &&
      t.rect[1] >= bounds[1] - 0.01 &&
      t.rect[3] <= bounds[3] + 0.01
  )
  const columns = ticks.filter(
    (t) => ticks.filter((p) => Math.abs(t.rect[2] - p.rect[2]) < t.height * 0.6).length >= 3
  )
  const axes = source.filter(
    (t) =>
      t.horizontal === false &&
      t.rect[2] <= bounds[0] &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3] &&
      t.text.length < 60 &&
      columns.some(
        (p) =>
          p.rect[0] - t.rect[2] >= 0 &&
          p.rect[0] - t.rect[2] < Math.max(p.height, t.height) * 3 &&
          ((t.rect[1] < p.rect[3] && t.rect[3] > p.rect[1]) ||
            // A one-letter rotated axis can fit between neighboring ticks.
            // Require the same repeated tick column on both sides, within
            // the existing local label margin; distant rotated prose stays out.
            [true, false].every((above) =>
              columns.some(
                (q) =>
                  Math.abs(q.rect[2] - p.rect[2]) < p.height * 0.6 &&
                  (above ? q.rect[3] <= t.rect[1] : q.rect[1] >= t.rect[3]) &&
                  (above ? t.rect[1] - q.rect[3] : q.rect[1] - t.rect[3]) <
                    Math.max(p.height, t.height) * 3
              )
            ))
      )
  )
  // Script fragments can sit just beyond the main rotated baseline. They must
  // physically touch a proved rotated run, not merely share its vertical band.
  for (let pass = 0; pass < source.length; pass++) {
    const added = source.filter(
      (t) =>
        t.horizontal === false &&
        !axes.includes(t) &&
        t.rect[2] <= bounds[0] &&
        t.rect[1] >= bounds[1] &&
        t.rect[3] <= bounds[3] &&
        axes.some(
          (p) =>
            Math.min(p.rect[2], t.rect[2]) > Math.max(p.rect[0], t.rect[0]) &&
            Math.max(p.rect[1], t.rect[1]) - Math.min(p.rect[3], t.rect[3]) <
              Math.min(p.height, t.height) * 0.5
        )
    )
    if (!added.length) break
    axes.push(...added)
  }
  // Percentage ticks are a separate unit-consistent column. They must prove
  // distinct rows and a complete exterior title, without absorbing side prose.
  // Keep the existing plain-number and fragmented-axis proof unchanged.
  const percentageTicks = source.filter(
    (t) =>
      t.horizontal &&
      /^[−-]?\d+(?:\.\d+)?%$/.test(t.text.trim()) &&
      t.rect[0] >= bounds[0] &&
      t.rect[2] <= bounds[0] + t.height * 5 &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3]
  )
  const percentageColumns = percentageTicks.filter((t) => {
    const column = source.filter(
      (p) =>
        p.horizontal &&
        Math.abs(p.height - t.height) < t.height * 0.1 &&
        Math.abs(p.rect[2] - t.rect[2]) < t.height * 0.15 &&
        p.rect[1] >= bounds[1] &&
        p.rect[3] <= bounds[3]
    )
    return (
      column.every((p) => percentageTicks.includes(p)) &&
      new Set(column.map((p) => Math.round(p.baseline / t.height))).size >= 3 &&
      new Set(column.map((p) => p.text.trim())).size >= 3
    )
  })
  const percentageAxes = source.filter((t) => {
    if (
      t.horizontal !== false ||
      t.text.length >= 60 ||
      t.rect[2] > bounds[0] ||
      t.rect[1] < bounds[1] ||
      t.rect[3] > bounds[3] ||
      !percentageColumns.some(
        (p) =>
          p.rect[0] >= t.rect[2] &&
          p.rect[0] - t.rect[2] < Math.max(p.height, t.height) * 3 &&
          t.rect[1] < p.rect[3] &&
          t.rect[3] > p.rect[1]
      )
    )
      return false
    const target = union([bounds, t.rect])
    return !source.some(
      (p) => p !== t && intersection(p.rect, target) > intersection(p.rect, bounds) + 0.01
    )
  })
  // Right colorbars can have longer tick strings cut at the current edge.
  // Require a repeated native numeric column at that edge plus rotated text
  // beside it; neither an isolated number nor ordinary side prose is an owner.
  const rightTicks = source.filter(
    (t) =>
      t.horizontal &&
      /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim()) &&
      t.rect[0] >= bounds[2] - t.height &&
      t.rect[0] <= bounds[2] + t.height * 0.25 &&
      t.rect[2] - t.rect[0] <= t.height * 4 &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3]
  )
  const rightColumns = rightTicks.filter(
    (t) =>
      new Set(
        rightTicks
          .filter((p) => Math.abs(t.rect[0] - p.rect[0]) < t.height * 0.6)
          .map((p) => Math.round(p.baseline / t.height))
      ).size >= 3
  )
  const rightAxes = source.filter(
    (t) =>
      t.horizontal === false &&
      t.text.length < 60 &&
      t.rect[0] >= bounds[2] &&
      t.rect[1] >= bounds[1] &&
      t.rect[3] <= bounds[3] &&
      rightColumns.some(
        (p) =>
          t.rect[0] >= p.rect[2] &&
          t.rect[0] - p.rect[2] < Math.max(p.height, t.height) * 3 &&
          ((t.rect[1] < p.rect[3] && t.rect[3] > p.rect[1]) ||
            [true, false].every((above) =>
              rightColumns.some(
                (q) =>
                  Math.abs(q.rect[0] - p.rect[0]) < p.height * 0.6 &&
                  (above ? q.rect[3] <= t.rect[1] : q.rect[1] >= t.rect[3]) &&
                  (above ? t.rect[1] - q.rect[3] : q.rect[1] - t.rect[3]) <
                    Math.max(p.height, t.height) * 3
              )
            ))
      )
  )
  for (let pass = 0; pass < source.length; pass++) {
    const added = source.filter(
      (t) =>
        t.horizontal === false &&
        !rightAxes.includes(t) &&
        t.rect[0] >= bounds[2] &&
        t.rect[1] >= bounds[1] &&
        t.rect[3] <= bounds[3] &&
        rightAxes.some(
          (p) =>
            Math.min(p.rect[2], t.rect[2]) > Math.max(p.rect[0], t.rect[0]) &&
            Math.max(p.rect[1], t.rect[1]) - Math.min(p.rect[3], t.rect[3]) <
              Math.min(p.height, t.height) * 0.5
        )
    )
    if (!added.length) break
    rightAxes.push(...added)
  }
  const rightLabels = rightAxes.length ? [...rightColumns, ...rightAxes] : []
  if (rightLabels.length) {
    const target = union([bounds, ...rightLabels.map((t) => t.rect)])
    if (
      source.some(
        (t) =>
          !rightLabels.includes(t) &&
          intersection(t.rect, target) > intersection(t.rect, bounds) + 0.01
      )
    )
      rightLabels.length = 0
  }
  // Complete an already intersecting bottom legend only when two independent
  // labels have keyed native strokes. Adjacent segments are one painted key.
  const markerRules = joinHorizontalTableRules(rules)
  const bottomKeys = source
    .filter(
      (t) =>
        t.horizontal &&
        t.text.length >= 2 &&
        t.text.length < 60 &&
        t.rect[0] >= bounds[0] &&
        t.rect[2] <= bounds[2] &&
        t.rect[1] < bounds[3] &&
        t.rect[3] > bounds[3] &&
        t.rect[3] - bounds[3] <= t.height
    )
    .map((t) => ({
      token: t,
      markers: markerRules.filter(
        (r) =>
          r[2] - r[0] >= t.height &&
          r[2] - r[0] <= t.height * 4 &&
          r[0] >= bounds[0] &&
          r[2] <= t.rect[0] &&
          t.rect[0] - r[2] < t.height &&
          r[1] >= t.rect[1] &&
          r[1] <= t.rect[3]
      )
    }))
    .filter((p) => p.markers.length === 1)
  const bottomLegend = bottomKeys.filter((p) =>
    bottomKeys.some(
      (q) =>
        q !== p &&
        q.markers[0] !== p.markers[0] &&
        (q.token.rect[0] >= p.token.rect[2] || p.token.rect[0] >= q.token.rect[2]) &&
        Math.abs(p.token.baseline - q.token.baseline) < p.token.height * 0.1 &&
        Math.abs(p.token.height - q.token.height) < p.token.height * 0.1
    )
  )
  if (bottomLegend.length) {
    const target = union([bounds, ...bottomLegend.map((p) => p.token.rect)])
    if (
      source.some(
        (t) =>
          !bottomLegend.some((p) => p.token === t) &&
          intersection(t.rect, target) > intersection(t.rect, bounds) + 0.01
      )
    )
      bottomLegend.length = 0
  }
  const keyed = source
    .filter(
      (t) =>
        t.horizontal &&
        t.text.length >= 2 &&
        t.text.length < 40 &&
        t.rect[0] >= bounds[0] &&
        t.rect[2] <= bounds[2] &&
        t.rect[3] < bounds[1] &&
        bounds[1] - t.rect[3] < t.height * 4
    )
    .map((t) => ({
      token: t,
      markers: markerRules.filter(
        (r) =>
          r.every(Number.isFinite) &&
          Math.abs(r[3] - r[1]) < t.height * 0.05 &&
          r[2] - r[0] >= t.height &&
          r[2] - r[0] <= t.height * 4 &&
          r[2] <= t.rect[0] &&
          t.rect[0] - r[2] < t.height &&
          r[1] >= t.rect[1] &&
          r[1] <= t.rect[3]
      )
    }))
    .filter((p) => p.markers.length === 1)
  const legend = keyed.filter(
    (p) =>
      keyed.filter(
        (q) =>
          Math.abs(p.token.baseline - q.token.baseline) < p.token.height * 0.1 &&
          Math.abs(p.token.height - q.token.height) < p.token.height * 0.1
      ).length >= 3
  )
  if (legend.length) {
    const target = union([bounds, ...legend.flatMap((p) => [p.token.rect, p.markers[0]])])
    if (
      new Set(legend.map((p) => p.markers[0])).size !== legend.length ||
      source.some(
        (t) =>
          !legend.some((p) => p.token === t) &&
          intersection(t.rect, target) > intersection(t.rect, bounds) + 0.01
      )
    )
      legend.length = 0
  }
  const vertical = rules.filter(
    (r) =>
      r[0] === r[2] &&
      r[0] >= bounds[0] &&
      r[0] <= bounds[2] &&
      r[1] >= bounds[1] &&
      r[3] <= bounds[3] &&
      r[3] - r[1] > (bounds[3] - bounds[1]) * 0.4
  )
  const repeatedAxes = vertical.filter(
    (r) =>
      vertical.filter((p) => Math.abs(p[1] - r[1]) < 0.05 && Math.abs(p[3] - r[3]) < 0.05).length >=
      3
  )
  const containers = page.graphicsBounds
    .filter((g) => g.kind === 'path')
    .map((g) => g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)))
    .filter((r) => r[0] <= bounds[0] && r[2] >= bounds[2] && r[1] < bounds[1] && r[3] >= bounds[3])
  const titles = source.filter(
    (t) =>
      repeatedAxes.length >= 3 &&
      columns.length >= 3 &&
      t.horizontal &&
      t.text.length >= 15 &&
      t.text.length < 80 &&
      t.height <= Math.max(...columns.map((p) => p.height)) * 1.5 &&
      t.rect[3] < bounds[1] &&
      bounds[1] - t.rect[3] < t.height * 5 &&
      t.rect[0] > bounds[0] &&
      t.rect[2] < bounds[2] &&
      Math.abs((t.rect[0] + t.rect[2] - bounds[0] - bounds[2]) / 2) <
        (bounds[2] - bounds[0]) * 0.15 &&
      containers.some((r) => t.rect[0] >= r[0] && t.rect[1] >= r[1] && t.rect[2] <= r[2])
  )
  // Strict composite recognizers own the graphics before the broad label
  // completion pass. Recover a repeated row of short panel markers that sits
  // on the upper edge of that owned union; one isolated marker is not enough
  // to distinguish a figure label from nearby prose.
  const topMarkers = boundaryText.filter(
    (t) =>
      t.horizontal &&
      /^\([a-z]\)$/i.test(t.text.trim()) &&
      t.rect[1] < bounds[1] &&
      t.rect[3] > bounds[1] - t.height * 0.35 &&
      t.rect[0] >= bounds[0] - t.height * 2.5 &&
      t.rect[2] <= bounds[2] + t.height * 2.5
  )
  const panelMarkers =
    topMarkers.length >= 2 &&
    topMarkers.some((t) =>
      topMarkers.some(
        (other) =>
          other !== t &&
          Math.abs(other.baseline - t.baseline) < Math.max(other.height, t.height) * 0.35
      )
    )
      ? topMarkers
      : []
  // Some native raster/vector plates paint a legend row just across the
  // lower edge without marker rules. Keep only a compact, multi-label row;
  // ordinary paragraph lines and single tick labels remain excluded.
  const bottomTextLegend = /^native-raster-vector-/.test(figure.reason ?? '')
    ? boundaryText.filter(
        (t) =>
          t.horizontal &&
          t.text.trim().length >= 12 &&
          (t.text.trim().split(/\s+/u).length >= 3 || t.text.trim().length >= 24) &&
          t.rect[1] < bounds[3] &&
          t.rect[3] > bounds[3] &&
          t.rect[3] - bounds[3] <= t.height * 1.2 &&
          t.rect[0] >= bounds[0] - t.height &&
          t.rect[2] <= bounds[2] + t.height * 2
      )
    : []
  const labels = [
    ...nativeExternalFrameLabels(page, figure, captions, tables, rules, tokens),
    ...axes.map((t) => t.rect),
    ...percentageAxes.map((t) => t.rect),
    ...rightLabels.map((t) => t.rect),
    ...bottomLegend.flatMap((p) => [p.token.rect, p.markers[0]]),
    ...legend.flatMap((p) => [p.token.rect, p.markers[0]]),
    ...panelMarkers.map((t) => t.rect),
    ...bottomTextLegend.map((t) => t.rect),
    ...(titles.length === 1 ? [titles[0].rect] : [])
  ]
  if (!labels.length) return figure
  const rect = union([bounds, ...labels])
  if (
    tables.some((r) => intersection(r, rect) > 0) ||
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, rect) > 0)
  )
    return figure
  return { ...figure, rect }
}

// A complete native axis and repeated tick alignment own their exterior labels.
// Each returned run remains before the caption and must not meet unrelated prose.
function nativeExternalFrameLabels(page, figure, captions, tables, rules, tokens) {
  const valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
  const source = tokens.filter((t) => t.text.trim())
  if (
    !valid(figure.rect) ||
    source.some(
      (t) =>
        !valid(t.rect) ||
        !Number.isFinite(t.height) ||
        t.height <= 0 ||
        !Number.isFinite(t.baseline)
    )
  )
    return []
  const bounds = figure.rect,
    frames = nativeClosedRuleFrames(rules).filter(
      (r) => valid(r) && intersection(r, bounds) / area(r) > 0.95
    )
  if (!frames.length) return []
  const slim = (page.graphicsBounds ?? [])
    .filter((g) => g.kind === 'image' && g.imageHash)
    .map((g) => g.normalizedRect.map((x, n) => x * (n % 2 ? page.height : page.width)))
    .filter(
      (r) => valid(r) && r[3] - r[1] > 4 * (r[2] - r[0]) && intersection(r, bounds) / area(r) > 0.9
    )
  const owned = new Set(),
    numeric = (t) => t.horizontal && /^[−-]?\d+(?:\.\d+)?$/.test(t.text.trim())
  for (const f of [...frames, ...slim])
    for (const side of ['left', 'right', 'bottom']) {
      if (slim.includes(f) && side !== 'right') continue
      const candidates = source.filter(
        (t) =>
          numeric(t) &&
          t.height < (f[3] - f[1]) / 6 &&
          (side === 'bottom'
            ? t.rect[1] >= f[3] &&
              t.rect[1] - f[3] < t.height * 1.5 &&
              t.rect[0] >= f[0] - t.height &&
              t.rect[2] <= f[2] + t.height
            : t.rect[1] >= f[1] - t.height &&
              t.rect[3] <= f[3] + t.height &&
              (side === 'left'
                ? t.rect[2] <= f[0] && f[0] - t.rect[2] < t.height * 1.5
                : t.rect[0] >= f[2] && t.rect[0] - f[2] < t.height * 1.5))
      )
      const groups = []
      for (const t of candidates) {
        const axis = side === 'bottom' ? 3 : side === 'left' ? 2 : 0,
          group = groups.find(
            (g) =>
              Math.abs(g[0].rect[axis] - t.rect[axis]) < t.height * 0.15 &&
              Math.abs(g[0].height - t.height) < t.height * 0.1
          )
        if (group) group.push(t)
        else groups.push([t])
      }
      if (groups.length !== 1 || groups[0].length < 3) continue
      const ticks = groups[0],
        h = ticks[0].height,
        span = union(ticks.map((t) => t.rect))
      if (
        (side === 'bottom' ? span[2] - span[0] : span[3] - span[1]) <
        (side === 'bottom' ? f[2] - f[0] : f[3] - f[1]) * 0.4
      )
        continue
      ticks.forEach((t) => owned.add(t))
      for (const t of source) {
        if (t.height > h * 1.1 || t.text.length > 45 || numeric(t)) continue
        const title =
          side === 'bottom'
            ? t.horizontal &&
              t.rect[1] >= span[3] &&
              t.rect[1] - span[3] < h &&
              t.rect[0] >= f[0] &&
              t.rect[2] <= f[2] &&
              Math.abs((t.rect[0] + t.rect[2] - f[0] - f[2]) / 2) < h * 3
            : t.horizontal === false &&
              t.rect[1] >= f[1] &&
              t.rect[3] <= f[3] &&
              (side === 'left'
                ? t.rect[2] <= span[0] && span[0] - t.rect[2] < h * 3
                : t.rect[0] >= span[2] && t.rect[0] - span[2] < h * 3)
        if (title) owned.add(t)
      }
    }
  if (!owned.size) return []
  const result = union([bounds, ...[...owned].map((t) => t.rect)])
  if (
    tables.some((t) => intersection(t, result) > 0) ||
    captions.some((c) => c.page === page.pageNumber && intersection(c.rect, result) > 0) ||
    source.some(
      (t) =>
        !owned.has(t) &&
        t.text.length >= 40 &&
        intersection(t.rect, result) > intersection(t.rect, bounds) + 0.01
    )
  )
    return []
  return [...owned].map((t) => t.rect)
}

// Complete one scripted title only through its full native text packet,
// repeated axis ticks and exact same-render glyph paths. Never widen proximity.
export function nativePlotPacketInventory(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context,
  allowEmptyOutlineSpaces = false
) {
  const scope = nativePlotPacketScope(page, figure, captions, tables, rules)
  if (!scope) return
  const inventory = nativePageTextPacketInventory(page, tokens, context, allowEmptyOutlineSpaces)
  return inventory ? { ...inventory, ...scope } : undefined
}

// A clipped chart proof can bind opaque graphics-state resets inside BT/ET.
// Ordinary page/plot callers retain the stricter operator vocabulary.
export function nativeOpaqueTextPlotPacketInventory(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context
) {
  const scope = nativePlotPacketScope(page, figure, captions, tables, rules)
  if (!scope) return
  const inventory = nativePagePacketCore(
    page,
    tokens,
    context,
    false,
    undefined,
    false,
    false,
    undefined,
    true
  )
  return inventory ? { ...inventory, ...scope } : undefined
}

function nativePlotPacketScope(page, figure, captions, tables, rules) {
  const valid = (r) =>
    (Array.isArray(r) || ArrayBuffer.isView(r)) &&
    r.length === 4 &&
    Array.from(r).every(Number.isFinite) &&
    r[2] > r[0] &&
    r[3] > r[1]
  if (!valid(figure?.rect) || ![captions, tables, rules].every(Array.isArray)) return
  const caption = figure.caption,
    cap = captions.filter((c) => c.page === page.pageNumber)
  if (
    !cap.includes(caption) ||
    !cap.every((c) => valid(c.rect)) ||
    !tables.every(valid) ||
    !rules.every(
      (r) =>
        (Array.isArray(r) || ArrayBuffer.isView(r)) &&
        r.length === 4 &&
        Array.from(r).every(Number.isFinite)
    ) ||
    figure.rect[3] >= caption.rect[1]
  )
    return
  return { cap, caption }
}

export function nativePageTextPacketInventory(
  page,
  tokens,
  context,
  allowEmptyOutlineSpaces = false,
  scopedSources,
  allowForeignSourceNormalization = false
) {
  return nativePagePacketCore(
    page,
    tokens,
    context,
    allowEmptyOutlineSpaces,
    scopedSources,
    allowForeignSourceNormalization
  )
}

// Keep the public page contract strict. A whole-cell ink caller may retain a
// foreign coarse advance only after every source/glyph/font/clip is still bound.
function nativePagePacketCore(
  page,
  tokens,
  context,
  allowEmptyOutlineSpaces = false,
  scopedSources,
  allowForeignSourceNormalization = false,
  wholeClaimAdvanceOnly = false,
  typedPrograms,
  allowOpaqueTextState = false,
  groupedAxis = false,
  literalCertificate,
  printedFaceScope,
  recoveryProfile
) {
  const compositing =
    recoveryProfile === undefined
      ? undefined
      : nativeCompositingProfileData(recoveryProfile, page, tokens, context)
  const recovery =
    recoveryProfile === undefined || compositing
      ? undefined
      : nativeFigureRecoveryProfileData(recoveryProfile, page, tokens, context)
  if (recoveryProfile !== undefined && !recovery && !compositing) return
  const finite = (a, n) =>
      (Array.isArray(a) || ArrayBuffer.isView(a)) &&
      a.length === n &&
      Array.from(a).every(Number.isFinite),
    valid = (r) => finite(r, 4) && r[2] > r[0] && r[3] > r[1],
    inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6)),
    box = (r, m) => {
      const q = [
        [r[0], r[1]],
        [r[2], r[1]],
        [r[2], r[3]],
        [r[0], r[3]]
      ]
      for (const p of q) Util.applyTransform(p, m)
      return [
        Math.min(...q.map((p) => p[0])),
        Math.min(...q.map((p) => p[1])),
        Math.max(...q.map((p) => p[0])),
        Math.max(...q.map((p) => p[1]))
      ]
    }
  const o = context?.operators,
    v = context?.viewport,
    raw = context?.content?.items,
    fonts = typedPrograms ? (context?.partialFontGlyphBounds ?? []) : context?.glyphBounds
  if (
    (allowForeignSourceNormalization !== false && allowForeignSourceNormalization !== true) ||
    (allowForeignSourceNormalization && !(scopedSources instanceof Set)) ||
    (scopedSources !== undefined &&
      (!(scopedSources instanceof Set) ||
        (!scopedSources.size && !recovery) ||
        scopedSources.size > 4096 ||
        [...scopedSources].some((i) => !Number.isSafeInteger(i) || i < 0)))
  )
    return
  if (
    page.invalidGraphicsBounds !== 0 ||
    ![
      tokens,
      raw,
      page.graphicsBounds,
      context?.graphicsBounds,
      o?.fnArray,
      o?.argsArray,
      fonts
    ].every(Array.isArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    !finite(v?.transform, 6) ||
    v.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height
  )
    return
  const evidence = { images: [], paths: new Map(), texts: new Map(), frames: new Map() }
  if (groupedAxis) evidence.isolatedGroups = new Map()
  if (recovery) attachNativeRecoveryPaintProfile(evidence, recoveryProfile, page, tokens, context)
  collectClosedFigureFrames(o, v, evidence, compositing ? recoveryProfile : undefined)
  if (
    groupedAxis &&
    (evidence.invalidIsolatedGroups ||
      !evidence.isolatedGroups.size ||
      [...evidence.isolatedGroups.values()].some((group) => !Number.isSafeInteger(group.end)))
  )
    return
  const printedFace =
    printedFaceScope === undefined
      ? undefined
      : closedPrintedFaceProfile(page, context, evidence, printedFaceScope)
  if (printedFaceScope !== undefined && !printedFace) return
  let fontName,
    size,
    packet,
    miterLimit = 10,
    typedFillColor = '#000000',
    typedFillAlpha = 1,
    charSpacing = 0,
    wordSpacing = 0,
    tm = [1, 0, 0, 1, 0, 0],
    x = 0,
    y = 0,
    lx = 0,
    ly = 0
  const packets = [],
    stack = [],
    glyphs = [],
    strokeMargins = new Map()
  const skipped = new Map(),
    usedSkipped = new Set()
  if (context.skippedSpaceGlyphs !== undefined) {
    if (!Array.isArray(context.skippedSpaceGlyphs) || context.skippedSpaceGlyphs.length > 100000)
      return
    for (const p of context.skippedSpaceGlyphs) {
      if (
        !p ||
        !Number.isSafeInteger(p.operationIndex) ||
        p.operationIndex < 0 ||
        !Number.isSafeInteger(p.glyphIndex) ||
        p.glyphIndex < 0 ||
        typeof p.fontName !== 'string' ||
        typeof p.fontChar !== 'string' ||
        !Number.isFinite(p.width) ||
        p.width < 0 ||
        (p.isSpace !== undefined && typeof p.isSpace !== 'boolean')
      )
        return
      const key = p.operationIndex + ':' + p.glyphIndex
      if (skipped.has(key)) return
      skipped.set(key, p)
    }
  }
  const fontMap = new Map()
  for (const f of fonts) {
    if (!f || typeof f.fontName !== 'string' || fontMap.has(f.fontName) || !Array.isArray(f.glyphs))
      return
    const m = new Map()
    for (const g of f.glyphs) {
      if (
        !g ||
        typeof g.fontChar !== 'string' ||
        m.has(g.fontChar) ||
        !finite(g.bounds, 4) ||
        g.bounds[0] > g.bounds[2] ||
        g.bounds[1] > g.bounds[3]
      )
        return
      m.set(g.fontChar, g.bounds)
    }
    fontMap.set(f.fontName, m)
  }
  for (let i = 0; i < o.fnArray.length; i++) {
    // The original no-text program remains intact and is accounted for as a
    // separately bounded compositing paint. Its mask and tiling are rendered
    // unchanged; this inventory observes only exterior native text and paths.
    if (compositing && i >= compositing.begin && i <= compositing.end) {
      i = compositing.end
      continue
    }
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (groupedAxis && op === OPS.beginGroup) {
      const group = evidence.isolatedGroups.get(i)
      if (packet || !group || typedFillAlpha !== 1) return
      stack.push({
        fontName,
        size,
        miterLimit,
        typedFillColor,
        typedFillAlpha,
        charSpacing,
        wordSpacing,
        tm,
        x,
        y,
        lx,
        ly,
        groupEnd: group.end
      })
      continue
    } else if (groupedAxis && op === OPS.endGroup) {
      const state = stack.pop()
      if (packet || state?.groupEnd !== i) return
      ;({
        fontName,
        size,
        miterLimit,
        typedFillColor,
        typedFillAlpha,
        charSpacing,
        wordSpacing,
        tm,
        x,
        y,
        lx,
        ly
      } = state)
      continue
    } else if (op === OPS.save || op === OPS.paintFormXObjectBegin)
      stack.push({
        fontName,
        size,
        miterLimit,
        typedFillColor,
        typedFillAlpha,
        charSpacing,
        wordSpacing,
        tm,
        x,
        y,
        lx,
        ly
      })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      ;({
        fontName,
        size,
        miterLimit,
        typedFillColor,
        typedFillAlpha,
        charSpacing,
        wordSpacing,
        tm,
        x,
        y,
        lx,
        ly
      } = stack.pop())
    } else if (op === OPS.setFont) {
      if (typeof a?.[0] !== 'string' || !Number.isFinite(a[1]) || a[1] <= 0) return
      ;[fontName, size] = a
    } else if (op === OPS.setCharSpacing || op === OPS.setWordSpacing) {
      if (!finite(a, 1)) return
      if (op === OPS.setCharSpacing) charSpacing = a[0]
      else wordSpacing = a[0]
    } else if (op === OPS.setRenderingIntent) {
      // The pinned CanvasGraphics implementation is a no-op. Retain only
      // the complete native Name argument; do not admit other state entries.
      const intent = a?.[0],
        name = intent && Object.getOwnPropertyDescriptor(intent, 'name')
      if (
        !Array.isArray(a) ||
        a.length !== 1 ||
        !intent ||
        Object.getPrototypeOf(intent) !== Object.prototype ||
        Reflect.ownKeys(intent).length !== 1 ||
        !name ||
        !('value' in name) ||
        !['AbsoluteColorimetric', 'RelativeColorimetric', 'Saturation', 'Perceptual'].includes(
          name.value
        )
      )
        return
    } else if (op === OPS.beginText) {
      if (packet) return
      packet = { start: i, shows: [], glyphs: [] }
      tm = [1, 0, 0, 1, 0, 0]
      x = y = lx = ly = 0
    } else if (op === OPS.endText) {
      if (!packet) return
      packet.end = i
      if (packet.glyphs.length) packets.push(packet)
      packet = undefined
    } else if (packet) {
      if (op === OPS.moveText) {
        if (!finite(a, 2)) return
        x = lx += a[0]
        y = ly += a[1]
      } else if (op === OPS.setTextMatrix) {
        if (!finite(a?.[0], 6)) return
        tm = Array.from(a[0])
        x = y = lx = ly = 0
      } else if (op === OPS.showText) {
        const state = evidence.texts.get(i)
        if (
          !state?.clip ||
          !finite(state.transform, 6) ||
          !Array.isArray(a?.[0]) ||
          !fontName ||
          !size
        )
          return
        const m = Util.transform(v.transform, Util.transform(state.transform, tm))
        if (!finite(m, 6) || Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12) return
        const show = { i, fontName, size: size * m[0], glyphs: [] }
        for (const [glyphIndex, g] of a[0].entries()) {
          if (typeof g === 'number') {
            if (!Number.isFinite(g)) return
            x -= (g * size) / 1000
            if (!Number.isFinite(x)) return
            continue
          }
          const key = i + ':' + glyphIndex,
            proof = skipped.get(key),
            type3 = typedPrograms?.occurrences.get(key),
            type3Font = typedPrograms?.fonts.get(fontName)
          if (
            type3 &&
            (type3.fontName !== fontName ||
              g?.operatorListId !== type3.operatorListId ||
              g?.fontChar !== '' ||
              g?.unicode !== type3.unicode ||
              g?.width !== type3.width ||
              g?.isInFont !== true ||
              g.isSpace !== (type3.kind === 'empty-space') ||
              typedPrograms.used.has(key) ||
              typedFillAlpha !== 1 ||
              typeof typedFillColor !== 'string' ||
              !/^#[a-f0-9]{6}$/iu.test(typedFillColor) ||
              typedFillColor.toLowerCase() === '#ffffff')
          )
            return
          const rendererSkipped =
            allowEmptyOutlineSpaces &&
            proof &&
            proof.fontName === fontName &&
            proof.fontChar === g?.fontChar &&
            proof.width === g?.width &&
            g?.isInFont === false &&
            g.unicode === ' ' &&
            (g.isSpace === true || g.isSpace === false) &&
            (proof.isSpace === undefined ? g.isSpace === true : proof.isSpace === g.isSpace)
          const foreignClippedSpace =
            printedFace?.outside(state.clip) &&
            g?.unicode === ' ' &&
            g.isInFont === false &&
            (g.isSpace === true || g.isSpace === false)
          if (proof && !rendererSkipped) return
          if (
            typeof g?.unicode !== 'string' ||
            typeof g.fontChar !== 'string' ||
            !Number.isFinite(g.width) ||
            g.width < 0 ||
            (wordSpacing !== 0 && typeof g.isSpace !== 'boolean') ||
            (g.isInFont !== true &&
              !(
                rendererSkipped ||
                foreignClippedSpace ||
                (allowEmptyOutlineSpaces &&
                  g.unicode === ' ' &&
                  fontMap
                    .get(fontName)
                    ?.get(g.fontChar)
                    ?.every((n) => n === 0))
              )) ||
            (g.accent != null && !recovery?.accentGlyph(key, fontName, g)) ||
            (g.operatorListId != null && !type3) ||
            g.vmetric != null
          )
            return
          let b = type3
            ? type3.bounds.map((n, axis) => n * type3Font.fontMatrix[axis % 2 ? 3 : 0])
            : fontMap.get(fontName)?.get(g.fontChar)
          if (!b) return
          const compound = g.accent != null && recovery?.accentGlyph(key, fontName, g)
          if (compound) {
            const a = compound.bounds,
              { x: ox, y: oy } = compound.offset
            // Canvas showText's fontSizeScale cancels the paintChar scale.
            // Its negative canvas Y offset is positive in PDF font coordinates.
            b = [
              Math.min(b[0], a[0] + ox),
              Math.min(b[1], a[1] + oy),
              Math.max(b[2], a[2] + ox),
              Math.max(b[3], a[3] + oy)
            ]
          }
          const advanceWidth = type3
            ? g.width * size * type3Font.fontMatrix[0]
            : (g.width * size) / 1000
          const ink = box(
              rendererSkipped
                ? [x, y, x, y]
                : [x + b[0] * size, y + b[1] * size, x + b[2] * size, y + b[3] * size],
              m
            ),
            advance = box([x, y, x + advanceWidth, y + size], m)
          if (!finite(ink, 4) || (!inside(state.clip, ink) && !printedFace?.outside(state.clip)))
            return
          const z = {
            i,
            fontName,
            text: g.unicode,
            ink,
            advance,
            height: size * Math.hypot(m[0], m[1]),
            packet,
            show
          }
          z.textPaint = { fillColor: typedFillColor, fillAlpha: typedFillAlpha }
          if (compound) z.compoundAccent = true
          if (printedFace) {
            z.paintClip = [...state.clip]
            z.excludedByClosedFaceClip = printedFace.outside(state.clip)
          }
          if (rendererSkipped) {
            z.rendererSkipped = true
            usedSkipped.add(key)
          }
          if (type3) typedPrograms.used.add(key)
          packet.glyphs.push(z)
          show.glyphs.push(z)
          glyphs.push(z)
          // Canvas adds spacing once per operator glyph, including ligatures
          // and skipped blanks. It moves the next origin, not this glyph's
          // pure advance box; numeric TJ adjustments receive no spacing.
          x += advanceWidth + charSpacing + (g.isSpace ? wordSpacing : 0)
          if (!Number.isFinite(x)) return
        }
        packet.shows.push(show)
      } else if (op === OPS.setFillRGBColor) typedFillColor = a?.[0]
      else if (op === OPS.setGState && allowOpaqueTextState) {
        if (
          !Array.isArray(a?.[0]) ||
          !a[0].length ||
          a[0].some(
            (e) => !Array.isArray(e) || e.length !== 2 || !['CA', 'ca'].includes(e[0]) || e[1] !== 1
          )
        )
          return
        for (const e of a[0]) if (e[0] === 'ca') typedFillAlpha = e[1]
      } else if (recovery?.inertTextOperation(i)) {
        // No text paint can consume this leading or terminal line transition.
      } else if (![OPS.dependency, OPS.setStrokeRGBColor].includes(op)) return
    } else if (printedFace?.neutral.has(i)) {
      // The complete native clip/path certificate excludes this foreign state.
    } else if (op === OPS.setGState) {
      if (
        !Array.isArray(a?.[0]) ||
        a[0].some(
          (e) =>
            !Array.isArray(e) ||
            !(
              (['CA', 'ca'].includes(e[0]) && Number.isFinite(e[1]) && e[1] >= 0 && e[1] <= 1) ||
              (e[0] === 'SMask' && e[1] === false) ||
              ((recovery?.nested || recovery?.rasterOperation(i)) &&
                e[0] === 'BM' &&
                e[1] === 'source-over') ||
              (printedFace && printedFaceStateEntry(e))
            )
        )
      )
        return
      for (const e of a[0]) {
        if (e[0] === 'ca') typedFillAlpha = e[1]
        if (printedFace && e[0] === 'ML') miterLimit = e[1]
      }
    } else if (op === OPS.setFillRGBColor) typedFillColor = a?.[0]
    else if (op === OPS.setMiterLimit) {
      if (!Number.isFinite(a?.[0]) || a[0] < 1) return
      miterLimit = a[0]
    } else if (op === OPS.setLineJoin || op === OPS.setLineCap) {
      if (![0, 1, 2].includes(a?.[0])) return
    } else if (op === OPS.constructPath) {
      if (
        ![
          OPS.stroke,
          OPS.closeStroke,
          OPS.fill,
          OPS.eoFill,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke,
          OPS.endPath
        ].includes(a?.[0])
      )
        return
      strokeMargins.set(i, miterLimit)
      if (typedPrograms)
        evidence.paths.get(i).fillPaint = {
          fillColor: typedFillColor,
          fillAlpha: typedFillAlpha
        }
    } else if (
      ![
        OPS.dependency,
        OPS.transform,
        OPS.setFillRGBColor,
        OPS.setStrokeRGBColor,
        OPS.setLineWidth,
        OPS.setDash,
        OPS.clip,
        OPS.eoClip,
        OPS.paintImageXObject
      ].includes(op)
    )
      return
  }
  if (
    packet ||
    stack.length ||
    usedSkipped.size !== skipped.size ||
    (typedPrograms && typedPrograms.used.size !== typedPrograms.occurrences.size)
  )
    return
  // Canonical decomposition is comparison-only: keep source and painted glyph
  // literals unchanged, and still bind every item to its font and advance.
  // Compatibility characters are not equivalent.
  const visible = glyphs.flatMap((g) =>
    Array.from(g.text.normalize('NFD'))
      .filter((c) => !/\s/u.test(c))
      .map((c) => ({ c, g }))
  )
  let offset = 0
  const records = []
  const carrier = (value, counts = new Map(), active = new Set()) => {
    if (!value || typeof value !== 'object') return counts
    if (active.has(value)) return
    active.add(value)
    if (Number.isSafeInteger(value.pageNumber) && Number.isSafeInteger(value.index)) {
      const k = value.pageNumber + ':' + value.index
      counts.set(k, (counts.get(k) || 0) + 1)
    }
    for (const z of Object.values(value)) if (!carrier(z, counts, active)) return
    active.delete(value)
    return counts
  }
  const rc = carrier(context.content),
    tc = carrier(tokens)
  if (!rc || !tc) return
  for (let index = 0; index < raw.length; index++) {
    const r = raw[index]
    if (typeof r.str !== 'string') return
    const cs = Array.from(r.str.normalize('NFD')).filter((c) => !/\s/u.test(c))
    if (!cs.length) continue
    if (!Number.isFinite(r.width) || !Number.isFinite(r.height) || r.width < 0 || r.height <= 0)
      return
    const part = visible.slice(offset, offset + cs.length)
    offset += cs.length
    const certifiedLiteral = literalCertificate?.get(index),
      certifiedPair =
        certifiedLiteral &&
        r.str === certifiedLiteral.normal &&
        part.map((z) => z.c).join('') === certifiedLiteral.raw.normalize('NFD')
    const s = r.sourceItem,
      k = page.pageNumber + ':' + index,
      match = tokens.filter((t) => t.sourceItem?.index === index),
      paintedText = part.map((z) => z.c).join(''),
      sourceText = cs.join(''),
      // PDF.js normalizes text-content strings, but leaves operator glyphs
      // unchanged. This optional geometry-only bridge is restricted to
      // unclaimed, one-to-one foreign characters. Claimed literals stay exact;
      // neither the original source nor the painted glyph is rewritten.
      normalizedForeign =
        allowForeignSourceNormalization &&
        scopedSources &&
        !scopedSources.has(index) &&
        paintedText !== sourceText &&
        Array.from(paintedText).length === cs.length &&
        normalizeUnicode(paintedText).normalize('NFD') === sourceText
    if (
      s?.pageNumber !== page.pageNumber ||
      s.index !== index ||
      s.text !== r.str ||
      rc.get(k) !== 1 ||
      (tc.get(k) ?? 0) !== match.length ||
      match.length > 1 ||
      (paintedText !== sourceText && !normalizedForeign && !certifiedPair) ||
      part.some((z) => z.g.fontName !== r.fontName) ||
      !finite(r.transform, 6)
    )
      return
    const rect = tableTextToken(r, v, 0).rect,
      q = union(part.map((z) => z.g.advance)),
      compoundAdvance = recovery?.compoundSourceAdvance(index, r, part, rect, q) === true,
      advanceComplete = q.every((n, i) => Math.abs(n - rect[i]) <= 0.02) || compoundAdvance
    if (!finite(rect, 4) || !finite(q, 4)) return
    // A foreign overstrike can have no advance while still painting ink. Keep
    // that complete glyph in the exclusion inventory; claimed sources remain
    // subject to the existing positive-rectangle contract.
    const foreignZeroAdvance =
      scopedSources &&
      !scopedSources.has(index) &&
      advanceComplete &&
      r.width === 0 &&
      rect[0] === rect[2] &&
      rect[1] < rect[3] &&
      part.length === 1 &&
      part.every(
        ({ g }) => g.advance[0] === g.advance[2] && g.advance[1] < g.advance[3] && valid(g.ink)
      )
    if (
      ((!wholeClaimAdvanceOnly || scopedSources.has(index)) &&
        !compoundAdvance &&
        q.some(
          (n, i) =>
            Math.abs(n - rect[i]) > 0.02 &&
            // A foreign item's trailing source space may be a positioning gap.
            // Its actual glyph ink remains foreign and must be excluded by the
            // scoped caller. Claimed sources retain exact whole advance proof.
            (!scopedSources ||
              scopedSources.has(index) ||
              i !== 2 ||
              !/\s$/u.test(r.str) ||
              n > rect[i])
        )) ||
      match.some(
        (t) =>
          t.text !== r.str ||
          t.sourceItem.text !== r.str ||
          (!valid(t.rect) && !foreignZeroAdvance) ||
          t.rect.some((n, i) => Math.abs(n - rect[i]) > 1e-6)
      )
    )
      return
    records.push({
      r,
      part,
      rect,
      index,
      ...(normalizedForeign ? { foreignSourceNormalized: true } : {}),
      ...(scopedSources ? { ink: union(part.map((z) => z.g.ink)), advanceComplete } : {})
    })
  }
  if (
    (recovery &&
      records.some((r) => scopedSources?.has(r.index) && r.part.some((z) => z.g.compoundAccent))) ||
    offset !== visible.length ||
    tokens.some((t) => !records.some((r) => r.index === t.sourceItem?.index)) ||
    (scopedSources &&
      [...scopedSources].some((i) => !records.some((r) => r.index === i && r.advanceComplete)))
  )
    return
  for (const p of packets) {
    p.rect = union(p.glyphs.map((g) => g.advance))
    const painted = p.glyphs.filter((g) => !g.rendererSkipped)
    p.ink = painted.length
      ? union(painted.map((g) => g.ink))
      : [p.rect[0], p.rect[1], p.rect[0], p.rect[1]]
    p.text = p.glyphs.map((g) => g.text).join('')
    p.height = Math.max(...p.glyphs.map((g) => g.height))
  }
  return {
    finite,
    valid,
    inside,
    box,
    o,
    v,
    evidence,
    records,
    packets,
    glyphs,
    strokeMargins
  }
}

// Fixed whole-cell contract, not a switch that drops foreign evidence. Every
// exterior glyph remains literal/font/clip bound and available to the caller.
export function nativeWholeCellInkPacket(page, tokens, context, cell) {
  if (
    !cell ||
    cell.sourceSegments?.length ||
    !Array.isArray(cell.sourceItems) ||
    !cell.sourceItems.length ||
    cell.sourceItems.length > 4096 ||
    !Array.isArray(cell.sourceRects) ||
    cell.sourceRects.length !== cell.sourceItems.length ||
    typeof cell.text !== 'string' ||
    !cell.text.trim() ||
    cell.sourceItems
      .map((o) => o?.text ?? '')
      .join('')
      .replace(/\s/gu, '') !== cell.text.replace(/\s/gu, '')
  )
    return
  const claims = new Set()
  for (const o of cell.sourceItems) {
    const r = context?.content?.items?.[o?.index]
    if (
      !o ||
      o.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(o.index) ||
      o.index < 0 ||
      typeof o.text !== 'string' ||
      !o.text.trim() ||
      claims.has(o.index) ||
      r?.str !== o.text ||
      r.sourceItem?.pageNumber !== o.pageNumber ||
      r.sourceItem.index !== o.index ||
      r.sourceItem.text !== o.text
    )
      return
    claims.add(o.index)
  }
  return nativePagePacketCore(page, tokens, context, false, claims, false, true)
}

// A fraction relation may span several predicted cells. Retain every foreign
// glyph and require exact whole advances for the explicitly bound native owners.
export function nativeFractionInkPacket(page, tokens, context, sourceItems) {
  if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 64) return
  const claims = new Set()
  for (const o of sourceItems) {
    const r = context?.content?.items?.[o?.index]
    if (
      o?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(o.index) ||
      o.index < 0 ||
      typeof o.text !== 'string' ||
      !o.text.trim() ||
      claims.has(o.index) ||
      r?.str !== o.text ||
      r.sourceItem?.pageNumber !== o.pageNumber ||
      r.sourceItem.index !== o.index ||
      r.sourceItem.text !== o.text
    )
      return
    claims.add(o.index)
  }
  return nativePagePacketCore(page, tokens, context, true, claims, false, true)
}

// Explicit closed-program caller. Ordinary isolated groups use the existing
// complete group observer; all declared owners still require whole advances.
export function nativeClosedProgramInkPacket(page, tokens, context, sourceItems) {
  if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 64) return
  const claims = new Set()
  for (const item of sourceItems) {
    const raw = context?.content?.items?.[item?.index]
    if (
      item?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(item.index) ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      claims.has(item.index) ||
      raw?.str !== item.text ||
      JSON.stringify(raw.sourceItem) !== JSON.stringify(item)
    )
      return
    claims.add(item.index)
  }
  return nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    claims,
    false,
    true,
    undefined,
    false,
    context.operators.fnArray.includes(OPS.beginGroup)
  )
}

// Explicit recovery callers alone may supply an internally derived witness.
// The default whole-program, table and page contracts never acquire it.
export function nativeRecoveryFigureInkPacket(page, tokens, context, sourceItems, profile) {
  if (
    !nativeFigureRecoveryProfileData(profile, page, tokens, context) ||
    !Array.isArray(sourceItems) ||
    sourceItems.length > 64
  )
    return
  const claims = new Set()
  for (const item of sourceItems) {
    const raw = context?.content?.items?.[item?.index]
    if (
      item?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(item.index) ||
      typeof item.text !== 'string' ||
      !item.text.trim() ||
      claims.has(item.index) ||
      raw?.str !== item.text ||
      JSON.stringify(raw.sourceItem) !== JSON.stringify(item) ||
      tokens.filter(
        (t) =>
          t.sourceItem?.pageNumber === item.pageNumber &&
          t.sourceItem?.index === item.index &&
          t.sourceItem?.text === item.text &&
          t.text === item.text
      ).length !== 1
    )
      return
    claims.add(item.index)
  }
  const packet = nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    claims,
    false,
    true,
    undefined,
    false,
    context.operators.fnArray.includes(OPS.beginGroup),
    undefined,
    undefined,
    profile
  )
  if (!packet) return
  const owners = new Set()
  for (const record of packet.records)
    for (const glyph of new Set(record.part.map((part) => part.g))) {
      if (owners.has(glyph)) return
      owners.add(glyph)
    }
  return packet
}
export function nativeForeignCompoundInkPacket(page, tokens, context, sourceItems) {
  const profile = createNativeForeignAccentProfile(page, tokens, context)
  return profile && nativeRecoveryFigureInkPacket(page, tokens, context, sourceItems, profile)
}

export function nativeCompositingInkPacket(page, tokens, context, profile) {
  const scope = nativeCompositingProfileData(profile, page, tokens, context),
    anchor = scope && tokens.find((t) => t.sourceItem?.text?.trim())?.sourceItem
  if (!scope || !anchor) return
  const packet = nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    new Set([anchor.index]),
    false,
    true,
    undefined,
    false,
    false,
    undefined,
    undefined,
    profile
  )
  return packet && { packet, scope }
}

// Separate typed contract: partial ordinary fonts become usable only when every
// used font and every Type3 source/program/paint occurrence is independently closed.
export function nativeTypedPlotPacketInventory(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context
) {
  try {
    const scope = nativePlotPacketScope(page, figure, captions, tables, rules)
    const typed = completeType3PacketPrograms(context)
    if (!scope || !typed) return
    const inventory = nativePagePacketCore(
      page,
      tokens,
      context,
      true,
      undefined,
      false,
      false,
      typed
    )
    return inventory ? { ...inventory, ...scope } : undefined
  } catch {
    return undefined
  }
}

// Only the complete symbol-axis family admits isolated groups and unclaimed
// one-to-one PDF.js source normalization. Existing packet entries stay strict.
export function nativeGroupedAxisPacketInventory(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context,
  sourceItems
) {
  try {
    if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 128) return
    const claims = new Set()
    for (const source of sourceItems) {
      const record = context?.content?.items?.[source?.index]
      if (
        source?.pageNumber !== page.pageNumber ||
        !Number.isSafeInteger(source.index) ||
        source.index < 0 ||
        typeof source.text !== 'string' ||
        !source.text.trim() ||
        claims.has(source.index) ||
        record?.str !== source.text ||
        record.sourceItem?.pageNumber !== source.pageNumber ||
        record.sourceItem.index !== source.index ||
        record.sourceItem.text !== source.text
      )
        return
      claims.add(source.index)
    }
    const scope = nativePlotPacketScope(page, figure, captions, tables, rules),
      typed = completeType3PacketPrograms(context)
    if (!scope || !typed) return
    const inventory = nativePagePacketCore(
      page,
      tokens,
      context,
      true,
      claims,
      true,
      true,
      typed,
      false,
      true
    )
    return inventory ? { ...inventory, ...scope } : undefined
  } catch {
    return undefined
  }
}

function completeType3PacketPrograms(context) {
  const finite = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite),
    programs = context?.type3GlyphPrograms,
    ordinary = context?.partialFontGlyphBounds ?? [],
    raw = context?.content?.items,
    ops = context?.operators,
    fonts = new Map(),
    occurrences = new Map(),
    used = new Set(),
    names = new Set()
  if (
    !Array.isArray(programs) ||
    !programs.length ||
    programs.length > 64 ||
    context.glyphBounds !== undefined ||
    !Array.isArray(ordinary) ||
    !Array.isArray(raw) ||
    raw.length > 32768 ||
    !Array.isArray(ops?.fnArray) ||
    !Array.isArray(ops.argsArray) ||
    ops.fnArray.length !== ops.argsArray.length ||
    ops.fnArray.length > 100000
  )
    return
  for (const f of ordinary) {
    if (typeof f?.fontName !== 'string' || names.has(f.fontName)) return
    names.add(f.fontName)
  }
  let count = 0
  for (const f of programs) {
    const m = f?.fontMatrix,
      indices = raw.flatMap((r, index) =>
        r?.fontName === f?.fontName && typeof r.str === 'string' && r.str.length ? [index] : []
      ),
      style = context.content.styles?.[f?.fontName]
    if (
      typeof f?.fontName !== 'string' ||
      names.has(f.fontName) ||
      !style ||
      (style.vertical !== undefined && style.vertical !== false) ||
      !finite(m, 6) ||
      m[0] <= 0 ||
      m[3] <= 0 ||
      [1, 2, 4, 5].some((i) => m[i] !== 0) ||
      !indices.length ||
      !Array.isArray(f.sourceIndices) ||
      indices.length !== f.sourceIndices.length ||
      indices.some((n, i) => n !== f.sourceIndices[i]) ||
      !Array.isArray(f.glyphs) ||
      !f.glyphs.length
    )
      return
    names.add(f.fontName)
    fonts.set(f.fontName, f)
    const ids = new Set(),
      literals = new Set()
    for (const p of f.glyphs) {
      if (
        ++count > 4096 ||
        typeof p?.operatorListId !== 'string' ||
        !p.operatorListId.length ||
        p.operatorListId.length > 256 ||
        ids.has(p.operatorListId) ||
        typeof p.unicode !== 'string' ||
        [...p.unicode].length !== 1 ||
        literals.has(p.unicode) ||
        !Number.isFinite(p.width) ||
        p.width <= 0 ||
        !finite(p.bounds, 4) ||
        ![OPS.fill, OPS.eoFill].includes(p.paint) ||
        !Array.isArray(p.occurrences) ||
        !p.occurrences.length
      )
        return
      const empty = p.kind === 'empty-space'
      if (
        empty
          ? p.unicode !== ' ' || p.clip !== null || p.bounds.some((n) => n !== 0)
          : p.kind !== 'filled-path' ||
            p.unicode === ' ' ||
            !finite(p.clip, 4) ||
            p.bounds[2] <= p.bounds[0] ||
            p.bounds[3] <= p.bounds[1] ||
            p.clip.some((n, i) => n !== p.bounds[i])
      )
        return
      ids.add(p.operatorListId)
      literals.add(p.unicode)
      for (const o of p.occurrences) {
        if (
          !Number.isSafeInteger(o?.operationIndex) ||
          o.operationIndex < 0 ||
          !Number.isSafeInteger(o.glyphIndex) ||
          o.glyphIndex < 0 ||
          ops.fnArray[o.operationIndex] !== OPS.showText ||
          !Array.isArray(ops.argsArray[o.operationIndex]?.[0])
        )
          return
        const key = o.operationIndex + ':' + o.glyphIndex,
          g = ops.argsArray[o.operationIndex][0][o.glyphIndex]
        if (
          occurrences.size >= 100000 ||
          occurrences.has(key) ||
          g?.operatorListId !== p.operatorListId ||
          g?.fontChar !== '' ||
          g.unicode !== p.unicode ||
          g.width !== p.width ||
          g.isInFont !== true ||
          g.isSpace !== empty ||
          g.accent != null ||
          g.vmetric != null
        )
          return
        occurrences.set(key, { ...p, fontName: f.fontName })
      }
    }
  }
  const sourceFonts = new Set(
    raw.filter((r) => typeof r?.str === 'string' && r.str.length).map((r) => r.fontName)
  )
  if (names.size !== sourceFonts.size || [...sourceFonts].some((name) => !names.has(name))) return
  return { fonts, occurrences, used }
}

// The single-axis proof intentionally retains its original font-membership contract.
export function nativeAxisTitlePacket(
  page,
  figure,
  captions,
  tables,
  rules,
  tokens,
  context,
  foreignOwns = () => false
) {
  const inventory = nativePlotPacketInventory(
    page,
    figure,
    captions,
    tables,
    rules,
    tokens,
    context
  )
  if (!inventory) return
  const {
    finite,
    valid,
    inside,
    box,
    o,
    v,
    cap,
    caption,
    evidence,
    packets,
    glyphs,
    strokeMargins
  } = inventory
  const nativeRules = collectTableRules(o, v)
  const horizontal = rules.filter(
    (r) =>
      nativeRules.some((q) => q.every((n, i) => Math.abs(n - r[i]) < 1e-6)) &&
      r[1] === r[3] &&
      r[2] - r[0] > page.width * 0.2 &&
      inside(figure.rect, r) &&
      r[1] < figure.rect[3]
  )
  const paints = []
  for (const [i, state] of evidence.paths) {
    const a = o.argsArray[i]
    if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(a?.[0])) continue
    if (!finite(a?.[2], 4) || !finite(state.transform, 6)) return
    const pad = [
      OPS.stroke,
      OPS.closeStroke,
      OPS.fillStroke,
      OPS.eoFillStroke,
      OPS.closeFillStroke,
      OPS.closeEOFillStroke
    ].includes(a[0])
      ? (state.lineWidth * Math.max(1, strokeMargins.get(i) ?? 10)) / 2
      : 0
    if (!Number.isFinite(pad) || pad < 0) return
    const q = box(
      Array.from(a[2], (n, k) => n + (k < 2 ? -pad : pad)),
      Util.transform(v.transform, state.transform)
    )
    if (state.clip)
      paints.push([
        Math.max(q[0], state.clip[0]),
        Math.max(q[1], state.clip[1]),
        Math.min(q[2], state.clip[2]),
        Math.min(q[3], state.clip[3])
      ])
    else paints.push(q)
  }
  for (const im of evidence.images) {
    if (!valid(im.rect)) return
    paints.push(im.rect)
  }
  const plans = []
  for (const axis of horizontal) {
    const sides = [axis[0], axis[2]].map((x) =>
      nativeRules.filter(
        (r) =>
          r[0] === r[2] &&
          Math.abs(r[0] - x) < 0.05 &&
          Math.abs(r[3] - axis[1]) < 0.05 &&
          r[3] - r[1] > (axis[2] - axis[0]) * 0.2
      )
    )
    if (sides.some((s) => s.length !== 1)) continue
    const ticks = packets.filter(
      (p) =>
        /^[−-]?\d+(?:\.\d+)?$/u.test(p.text) &&
        p.rect[1] >= axis[1] &&
        p.rect[1] - axis[1] < p.height &&
        p.rect[0] >= axis[0] - p.height &&
        p.rect[2] <= axis[2] + p.height &&
        inside(figure.rect, p.rect)
    )
    if (
      ticks.length < 3 ||
      ticks.some(
        (t) =>
          Math.abs(t.rect[3] - ticks[0].rect[3]) > 0.01 ||
          Math.abs(t.height - ticks[0].height) > 0.01
      ) ||
      Math.max(...ticks.map((t) => t.rect[2])) - Math.min(...ticks.map((t) => t.rect[0])) <
        (axis[2] - axis[0]) * 0.5
    )
      continue
    const tickBottom = Math.max(...ticks.map((t) => t.rect[3]))
    const titles = packets.filter(
      (p) =>
        p.rect[3] > figure.rect[3] &&
        p.rect[1] >= tickBottom &&
        p.rect[1] - tickBottom < p.height &&
        p.rect[2] - p.rect[0] < (axis[2] - axis[0]) * 0.6 &&
        p.rect[0] >= axis[0] &&
        p.rect[2] <= axis[2] &&
        Math.abs((p.rect[0] + p.rect[2] - axis[0] - axis[2]) / 2) < p.height &&
        p.rect[3] < caption.rect[1] &&
        p.glyphs.some((g) => inside(figure.rect, g.advance))
    )
    if (titles.length !== 1) continue
    const p = titles[0],
      shows = p.shows.map((s) => ({
        advance: union(s.glyphs.map((g) => g.advance)),
        height: s.glyphs[0]?.height
      })),
      base = shows.filter((g) => Math.abs(g.height - p.height) < 1e-6),
      smaller = shows.filter((g) => g.height < p.height * 0.85 && g.height >= p.height * 0.5)
    if (
      !base.length ||
      !smaller.length ||
      base.some((g) => Math.abs(g.advance[3] - base[0].advance[3]) > 1e-6)
    )
      continue
    const attach = (g) =>
      base.some(
        (b) =>
          g.advance[0] >= b.advance[0] &&
          g.advance[0] - b.advance[2] < p.height * 0.2 &&
          g.advance[0] >= b.advance[2] - p.height * 0.1 &&
          g.advance[1] < b.advance[3] &&
          g.advance[3] > b.advance[1]
      )
    if (smaller.some((g) => !attach(g))) continue
    const rect = union([figure.rect, p.rect, p.ink]),
      padding = 2 / (Math.ceil(page.width * 1.5) / page.width),
      paint = [rect[0] - padding, rect[1] - padding, rect[2] + padding, rect[3] + padding],
      oldPaint = figure.rect.map((n, i) => n + (i < 2 ? -padding : padding))
    if (
      tables.some((t) => intersection(t, paint) > 0) ||
      foreignOwns(paint) ||
      cap.some((c) => c !== caption && intersection(c.rect, paint) > 0) ||
      glyphs.some(
        (g) => g.packet !== p && intersection(g.ink, paint) > intersection(g.ink, oldPaint) + 1e-7
      ) ||
      paints.some((q) => valid(q) && intersection(q, paint) > intersection(q, oldPaint) + 1e-7) ||
      context.graphicsBounds.some((g) => {
        if (!valid(g.normalizedRect) || !Number.isSafeInteger(g.operationIndex)) return true
        const q = g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width))
        return intersection(q, rect) > intersection(q, figure.rect) + 1e-7
      })
    )
      continue
    plans.push({
      rect,
      sourceItems: [],
      proof: {
        packetStart: p.start,
        packetEnd: p.end,
        advance: p.rect,
        ink: p.ink,
        axis,
        tickPackets: ticks.map((t) => t.start),
        padding,
        controlGlyphs: p.glyphs.filter((g) => /^\s+$/u.test(g.text) && area(g.ink) > 0).length
      }
    })
  }
  return plans.length === 1 ? plans[0] : undefined
}

// Explicit opt-in; the ordinary page, whole-cell and grouped-axis APIs remain strict.
export function nativePageTextPacketInventoryWithDualApiCertificate(
  page,
  tokens,
  context,
  evidence,
  allowEmptyOutlineSpaces = false
) {
  try {
    if (typeof allowEmptyOutlineSpaces !== 'boolean') return
    const certificate = verifyNativeDualApiCertificate(page, context, evidence)
    if (!certificate) return
    const claims = new Set(tokens.map((t) => t.sourceItem?.index))
    return completeNativeDualApiPacket(
      nativePagePacketCore(
        page,
        tokens,
        context,
        allowEmptyOutlineSpaces,
        claims,
        false,
        false,
        undefined,
        false,
        false,
        certificate
      ),
      certificate
    )
  } catch {
    return undefined
  }
}

// A page-control conflict owns one complete native source. It never grants
// table-body or figure ownership, nor changes any ordinary packet admission.
export function nativePageControlInkPacket(page, tokens, context, origin, evidence) {
  try {
    const raw = context?.content?.items?.[origin?.index]
    if (
      origin?.pageNumber !== page?.pageNumber ||
      !Number.isSafeInteger(origin.index) ||
      origin.index < 0 ||
      typeof origin.text !== 'string' ||
      !origin.text.trim() ||
      raw?.str !== origin.text ||
      !sameOrigin(raw.sourceItem, origin) ||
      tokens.filter((t) => sameOrigin(t.sourceItem, origin) && t.text === origin.text).length !== 1
    )
      return
    const certificate = evidence
      ? verifyNativeDualApiCertificate(page, context, evidence)
      : new Map()
    if (!certificate) return
    const packet = completeScopedNativeDualApiPacket(
      nativePagePacketCore(
        page,
        tokens,
        context,
        false,
        new Set([origin.index]),
        false,
        true,
        undefined,
        false,
        false,
        certificate
      ),
      certificate
    )
    const record = packet?.records.find((r) => r.index === origin.index)
    return record?.advanceComplete ? packet : undefined
  } catch {
    return
  }
}

function sameOrigin(a, b) {
  return a?.pageNumber === b.pageNumber && a?.index === b.index && a?.text === b.text
}

// A local printed-face contradiction needs every original source, glyph and
// paint. A foreign glyph may retain its nonempty outline outside a complete
// disjoint native clip; it is neither renderer-skipped nor replaced by empty ink.
export function nativeClosedPrintedFaceInkPacket(page, tokens, context, sourceItems, scope) {
  if (!Array.isArray(sourceItems) || !sourceItems.length || sourceItems.length > 64) return
  const claims = new Set()
  for (const o of sourceItems) {
    const r = context?.content?.items?.[o?.index]
    if (
      o?.pageNumber !== page.pageNumber ||
      !Number.isSafeInteger(o.index) ||
      o.index < 0 ||
      typeof o.text !== 'string' ||
      !o.text.trim() ||
      claims.has(o.index) ||
      r?.str !== o.text ||
      r.sourceItem?.pageNumber !== o.pageNumber ||
      r.sourceItem.index !== o.index ||
      r.sourceItem.text !== o.text
    )
      return
    claims.add(o.index)
  }
  const packet = nativePagePacketCore(
    page,
    tokens,
    context,
    true,
    claims,
    false,
    true,
    undefined,
    false,
    false,
    undefined,
    scope
  )
  if (
    !packet ||
    packet.records.some(
      (r) => claims.has(r.index) && r.part.some((z) => z.g.excludedByClosedFaceClip)
    )
  )
    return
  return packet
}
