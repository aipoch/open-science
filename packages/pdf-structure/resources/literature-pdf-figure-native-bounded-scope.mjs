/* eslint-disable @typescript-eslint/explicit-function-return-type */
import {
  createNativeBoundedFigurePixelCertificate,
  nativeBoundedFigurePixelCertificateData
} from './literature-pdf-figure-native-plot-labels.mjs'
import { retainNativeRecoveryInputs } from './literature-pdf-native-figure-recovery-profile.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'

const plans = new WeakMap(),
  NONE = 0xffffffff,
  MIN_SCALE = 1.5,
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  finite = (r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite),
  inside = (a, b, epsilon = 1e-7) =>
    b.every((n, i) => (i < 2 ? n >= a[i] - epsilon : n <= a[i] + epsilon)),
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  expand = (r, d) => r.map((n, i) => n + (i < 2 ? -d : d)),
  compact = (s) => s.normalize('NFD').replace(/\s/gu, ''),
  opaque = (g) =>
    g.textPaint?.fillAlpha === 1 &&
    /^#[0-9a-f]{6}$/iu.test(g.textPaint.fillColor) &&
    g.textPaint.fillColor.toLowerCase() !== '#ffffff',
  belongs = (scope, i) => i > scope.begin && i < scope.end

function add(a, b) {
  if (!a) return [...b]
  for (let i = 0; i < 4; i++) a[i] = i < 2 ? Math.min(a[i], b[i]) : Math.max(a[i], b[i])
  return a
}

// The physical stroke/device envelope is computed before intersecting the
// potential clip. A curved clip supplies only an upper bound, never visibility.
function potential(raw, floor, clipState, envelope, scale) {
  if (!finite(raw) || !Number.isFinite(floor) || floor < 0 || !clipState)
    throw Error('Unknown paint.')
  if (clipState.tag === 'Empty') return undefined
  if (clipState.tag !== 'Bounded' || !valid(envelope)) throw Error('Unknown clip.')
  const r = expand(raw, (floor + 1) / scale),
    b = [
      Math.max(r[0], envelope[0]),
      Math.max(r[1], envelope[1]),
      Math.min(r[2], envelope[2]),
      Math.min(r[3], envelope[3])
    ]
  return valid(b) ? b : undefined
}

// Each inventory is in original operator order. The cursor traverses each
// scope once and does not allocate a row or a point array per original path.
function scopeCursor(scopes) {
  let next = 0,
    previous = -1
  const stack = []
  return (i) => {
    if (!Number.isSafeInteger(i) || i < previous) throw Error('Unordered inventory.')
    previous = i
    while (next < scopes.length && scopes[next].begin < i) {
      const n = next++
      while (stack.length && scopes[stack.at(-1)].end <= scopes[n].begin) stack.pop()
      if (scopes[n].end > i) stack.push(n)
    }
    while (stack.length && scopes[stack.at(-1)].end <= i) stack.pop()
    return stack.at(-1) ?? NONE
  }
}

function visit(data, scale, fn) {
  const program = data.program,
    scopes = program.scopes,
    glyphScope = scopeCursor(scopes),
    imageScope = scopeCursor(scopes)
  for (const g of data.glyphs) {
    if (g.rendererSkipped) {
      fn(g.i, undefined, 'glyph', glyphScope(g.i))
      continue
    }
    fn(
      g.i,
      potential(g.ink, 0, g.clipState, g.potentialClipEnvelope, scale),
      'glyph',
      glyphScope(g.i)
    )
  }
  for (const row of program.evidence.paths.values()) {
    const b = row.paints
      ? potential(row.fullInk, row.floor, row.clipState, row.potentialClipEnvelope, scale)
      : undefined
    fn(row.operationIndex, b, 'path', row.scope)
  }
  for (const image of program.evidence.images) {
    fn(
      image.operationIndex,
      potential(image.fullInk, 0, image.clipState, image.potentialClipEnvelope, scale),
      'image',
      imageScope(image.operationIndex)
    )
  }
}

function completeCaption(data, cap) {
  const records = data.records.filter((r) => inside(cap.rect, r.rect))
  if (
    !records.length ||
    compact(records.map((r) => r.r.str).join('')) !== compact(cap.lines.join(''))
  )
    return
  let text = '',
    first = Infinity
  const glyphs = new Set()
  for (const record of records) {
    if (!record.part.length || record.advanceComplete === false) return
    for (const { c, g } of record.part) {
      // Core binds each original literal character to its complete glyph.
      // Ligatures repeat that glyph in part; they do not print it twice.
      text += c
      if (glyphs.has(g)) continue
      glyphs.add(g)
      if (
        !valid(g.advance) ||
        !inside(cap.rect, g.advance, 0.02) ||
        g.rendererSkipped ||
        !opaque(g) ||
        !valid(g.exactClip) ||
        !inside(g.exactClip, g.advance) ||
        !inside(g.exactClip, g.ink)
      )
        return
      first = Math.min(first, g.i)
    }
  }
  return compact(text) === compact(cap.lines.join('')) ? { first, records } : undefined
}

export function nativeBoundedProgramPixelCrop(
  page,
  figure,
  captions,
  tables,
  tokens,
  context,
  peers,
  originalRect
) {
  try {
    const cap = figure?.caption,
      current = retainNativeRecoveryInputs([figure, captions, tables, peers, originalRect])
    if (
      !current ||
      !valid(figure?.rect) ||
      !valid(originalRect) ||
      !valid(cap?.rect) ||
      !Array.isArray(cap.lines) ||
      !cap.lines.every((s) => typeof s === 'string') ||
      cap.page !== page.pageNumber ||
      !Array.isArray(captions) ||
      captions.filter((c) => c === cap).length !== 1 ||
      !Array.isArray(tables) ||
      !tables.every(valid) ||
      !Array.isArray(peers) ||
      peers.some((f) => !valid(f.rect)) ||
      figure.parts ||
      figure.cropRects ||
      figure.sourceItems?.length ||
      figure.fallbackFigure ||
      figure.headerRaster ||
      !/^(?:Figure|Fig\.?)\s+[A-Z]?\d+[.:]/u.test(cap.lines[0] ?? '') ||
      !/[.!?]$/u.test(cap.lines.at(-1) ?? '') ||
      page.rotation !== 0 ||
      (page.renderRotation ?? 0) !== 0 ||
      page.invalidGraphicsBounds !== 0
    )
      return
    const handle = createNativeBoundedFigurePixelCertificate(page, tokens, context),
      data = nativeBoundedFigurePixelCertificateData(handle, page, tokens, context)
    if (!data || !data.current() || !Array.isArray(data.records) || !Array.isArray(data.glyphs))
      return
    const scopes = data.program.scopes,
      caption = completeCaption(data, cap)
    if (!caption || !scopes.length || scopes.length > 256) return
    const aggregates = scopes.map(() => ({ rect: undefined, glyphs: 0, paths: 0, witness: false }))
    visit(data, MIN_SCALE, (_i, b, kind, scope) => {
      if (scope === NONE || !b) return
      const a = aggregates[scope]
      if (!a) throw Error('Unknown scope.')
      a.rect = add(a.rect, b)
      if (kind === 'glyph') a.glyphs++
      if (kind === 'path') a.paths++
    })
    // A whole original literal, including its full advance and all its glyphs,
    // must supply the missing-content witness under genuine exact clips.
    const locate = scopeCursor(scopes)
    for (const r of data.records) {
      if (!r.part.length) continue
      const first = r.part[0].g,
        scope = locate(first.i)
      if (
        scope === NONE ||
        r.advanceComplete === false ||
        !r.part.every(
          ({ g }) =>
            !g.rendererSkipped &&
            opaque(g) &&
            valid(g.ink) &&
            valid(g.advance) &&
            valid(g.exactClip) &&
            inside(g.exactClip, g.ink) &&
            inside(g.exactClip, g.advance)
        ) ||
        !r.part.some(({ g }) => !inside(originalRect, g.ink))
      )
        continue
      let n = scope
      const last = Math.max(...r.part.map(({ g }) => g.i))
      while (n !== NONE && !belongs(scopes[n], last)) n = scopes[n].parent
      if (n !== NONE) aggregates[n].witness = true
    }
    for (let n = scopes.length - 1; n >= 0; n--) {
      const parent = scopes[n].parent
      if (parent === NONE) continue
      const a = aggregates[n],
        p = aggregates[parent]
      if (!p || parent >= n) return
      if (a.rect) p.rect = add(p.rect, a.rect)
      p.glyphs += a.glyphs
      p.paths += a.paths
      p.witness ||= a.witness
    }
    const qualifies = scopes.map(
        (s, n) =>
          s.end < caption.first &&
          aggregates[n].glyphs > 0 &&
          aggregates[n].paths > 0 &&
          aggregates[n].witness &&
          valid(aggregates[n].rect) &&
          aggregates[n].rect[3] < cap.rect[1] &&
          hit(aggregates[n].rect, originalRect)
      ),
      roots = []
    for (let n = 0; n < scopes.length; n++) {
      if (!qualifies[n]) continue
      let parent = scopes[n].parent,
        covered = false
      while (parent !== NONE) {
        if (qualifies[parent]) {
          covered = true
          break
        }
        parent = scopes[parent].parent
      }
      if (!covered) roots.push(n)
    }
    if (roots.length !== 1) return
    const owner = scopes[roots[0]],
      rect = expand(add([...aggregates[roots[0]].rect], originalRect), 2 / MIN_SCALE)
    if (
      !inside([0, 0, page.width, page.height], rect) ||
      rect[3] >= cap.rect[1] ||
      tables.some((r) => hit(rect, r)) ||
      captions.some((c) => c !== cap && c.page === page.pageNumber && hit(rect, c.rect)) ||
      peers.some((f) => f !== figure && hit(rect, f.rect))
    )
      return
    for (const r of data.records) {
      const owned = r.part.filter(({ g }) => belongs(owner, g.i)).length
      if (owned && owned !== r.part.length) return
    }
    let safe = true
    visit(data, MIN_SCALE, (i, b) => {
      if (!b) return
      if (
        belongs(owner, i)
          ? !inside(rect, expand(b, 1 / MIN_SCALE))
          : hit(rect, expand(b, 2 / MIN_SCALE))
      )
        safe = false
    })
    if (!safe || !current() || !data.current()) return
    const plan = Object.freeze({ rect }),
      outputCurrent = retainNativeRecoveryInputs([plan])
    if (!outputCurrent) return
    plans.set(plan, { page, tokens, context, handle, data, owner, current, outputCurrent })
    return plan
  } catch {
    return
  }
}

export function nativeBoundedProgramPixelPngSafe(plan, png, rect, page) {
  const p = plans.get(plan)
  if (!p) return
  try {
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (
      page !== p.page ||
      rect !== plan.rect ||
      !p.current() ||
      !p.outputCurrent() ||
      nativeBoundedFigurePixelCertificateData(p.handle, page, p.tokens, p.context) !== p.data ||
      !p.data.current() ||
      !raster ||
      raster.scaleLower < MIN_SCALE
    )
      return false
    let safe = true
    visit(p.data, raster.scaleLower, (i, b) => {
      if (!b) return
      if (
        belongs(p.owner, i)
          ? !inside(rect, expand(b, 1 / raster.scaleLower))
          : hit(raster.protection, expand(b, 2 / raster.scaleLower))
      )
        safe = false
    })
    return safe
  } catch {
    return false
  }
}
