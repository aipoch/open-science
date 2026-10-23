/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeTypedPlotPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { collectTableRules } from './literature-pdf-graphics.mjs'
import { nativeFigureLabelBounds } from './literature-pdf-figure-crop-geometry.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const equal = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
const union = (boxes) => [
  Math.min(...boxes.map((b) => b[0])),
  Math.min(...boxes.map((b) => b[1])),
  Math.max(...boxes.map((b) => b[2])),
  Math.max(...boxes.map((b) => b[3]))
]
const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
const intersection = (a, b) =>
  area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])])
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))

// Complete source/font/glyph/clip evidence is mandatory;
// native Form ownership, not a padded rectangle, owns each continued axis row.
function openAxisBottomProof(page, figure, captions, tables, tokens, context) {
  try {
    if (!context?.type3GlyphPrograms?.length) return
    const paintBounds = new Map(),
      rules = collectTableRules(context.operators, context.viewport, paintBounds)
    const inventory = nativeTypedPlotPacketInventory(
      page,
      figure,
      captions,
      tables,
      rules,
      tokens,
      context
    )
    if (!inventory || figure.caption.regions) return
    const { records, glyphs, evidence, o, v, box } = inventory
    const keys = records
      .filter((r) => /^\([abc]\)$/.test(r.r.str))
      .sort((a, b) => a.rect[0] - b.rect[0])
    if (keys.length !== 3 || keys.map((r) => r.r.str).join('') !== '(a)(b)(c)') return
    const em = keys[0].r.height,
      first = keys[0],
      caption = figure.caption
    const keyQuads = []
    for (const key of keys) {
      const r = key.r,
        style = context.content.styles[r.fontName]
      if (
        r.fontName !== first.r.fontName ||
        r.height !== em ||
        r.transform[0] !== em ||
        r.transform[1] !== 0 ||
        r.transform[2] !== 0 ||
        r.transform[3] !== em ||
        Math.abs(key.rect[1] - first.rect[1]) > em * 0.05 ||
        !inside([figure.rect[0], 0, figure.rect[2], page.height], key.rect) ||
        key.rect[3] <= figure.rect[3] ||
        key.rect[1] < figure.rect[3] - em ||
        key.rect[1] - figure.rect[3] > em * 4 ||
        key.rect[3] >= caption.rect[1] ||
        !Number.isFinite(style?.ascent) ||
        !(style.ascent > 0 && style.ascent <= 1) ||
        !Number.isFinite(style.descent) ||
        style.descent > 0
      )
        return
      const quad = nativeFigureLabelBounds(r, style, context.viewport)
      keyQuads.push(union([key.rect, quad, ...key.part.map((z) => z.g.ink)]))
    }
    const rect = union([figure.rect, ...keyQuads])
    if (rect[0] !== figure.rect[0] || rect[1] !== figure.rect[1] || rect[2] !== figure.rect[2])
      return
    const padding = 2 / (Math.ceil(page.width * 1.5) / page.width),
      oldPaint = figure.rect.map((n, i) => n + (i < 2 ? -padding : padding)),
      newPaint = rect.map((n, i) => n + (i < 2 ? -padding : padding))
    if (
      !inside([0, 0, page.width, page.height], newPaint) ||
      newPaint[3] >= caption.rect[1] ||
      tables.some((t) => intersection(t, newPaint) > 0) ||
      captions.some(
        (c) => c.page === page.pageNumber && c !== caption && intersection(c.rect, newPaint) > 0
      )
    )
      return
    const added = (r) => intersection(r, newPaint) - intersection(r, oldPaint) > 1e-7
    const formStack = [],
      formsForOp = new Map()
    for (let i = 0; i < o.fnArray.length; i++) {
      if (o.fnArray[i] === OPS.paintFormXObjectBegin) formStack.push(i)
      else if (o.fnArray[i] === OPS.paintFormXObjectEnd) {
        if (!formStack.length) return
        formStack.pop()
      } else formsForOp.set(i, [...formStack])
    }
    if (formStack.length) return
    const directForm = (i) => {
      const ancestors = formsForOp.get(i)
      return ancestors?.length === 1 ? ancestors[0] : undefined
    }
    const lineSource = (rule) => {
      const found = []
      for (const [i, state] of evidence.paths) {
        const args = o.argsArray[i],
          p = args?.[1]?.[0]
        if (
          args?.[0] !== OPS.stroke ||
          !finite(p, 6) ||
          p[0] !== 0 ||
          p[3] !== 1 ||
          state.strokeAlpha !== 1 ||
          !state.solidStroke ||
          ![0, 2].includes(state.lineCap) ||
          !(state.lineWidth > 0)
        )
          continue
        const transform = Util.transform(v.transform, state.transform),
          points = [
            [p[1], p[2]],
            [p[4], p[5]]
          ]
        points.forEach((p) => Util.applyTransform(p, transform))
        const line = [
          Math.min(...points.map((p) => p[0])),
          Math.min(...points.map((p) => p[1])),
          Math.max(...points.map((p) => p[0])),
          Math.max(...points.map((p) => p[1]))
        ]
        if (equal(line, rule)) found.push({ i, state, form: directForm(i) })
      }
      return found.length === 1 ? found[0] : undefined
    }
    const axes = []
    for (const key of keys) {
      const choices = []
      for (const horizontal of rules) {
        if (
          horizontal[1] !== horizontal[3] ||
          horizontal[2] - horizontal[0] < em * 6 ||
          key.rect[0] < horizontal[0] ||
          key.rect[2] > horizontal[2] ||
          key.rect[1] <= horizontal[1] ||
          key.rect[1] - horizontal[1] > em * 4
        )
          continue
        const verticals = rules.filter(
          (r) =>
            r[0] === r[2] &&
            r[0] === horizontal[0] &&
            r[3] === horizontal[1] &&
            r[3] - r[1] >= em * 6
        )
        if (verticals.length !== 1) continue
        const vertical = verticals[0],
          h = lineSource(horizontal),
          l = lineSource(vertical),
          hp = paintBounds.get(horizontal.join(',')),
          lp = paintBounds.get(vertical.join(','))
        if (
          !h ||
          !l ||
          h.form === undefined ||
          h.form !== l.form ||
          !equal(h.state.transform, l.state.transform) ||
          !finite(hp, 4) ||
          !finite(lp, 4) ||
          !inside(figure.rect, hp) ||
          !inside(figure.rect, lp)
        )
          continue
        const form = o.argsArray[h.form]
        if (!Array.isArray(form) || form.length !== 2 || form[0] !== null || !finite(form[1], 4))
          continue
        const clip = box(Array.from(form[1]), Util.transform(v.transform, h.state.transform))
        if (!equal(clip, h.state.clip) || !equal(clip, l.state.clip)) continue
        choices.push({ horizontal, vertical, h, l, hp, lp, clip, key })
      }
      if (choices.length !== 1) return
      axes.push(choices[0])
    }
    if (
      new Set(axes.map((a) => a.h.form)).size !== 3 ||
      axes.some((a, i) => i && a.horizontal[0] <= axes[i - 1].horizontal[2])
    )
      return
    const type3Fonts = new Set(context.type3GlyphPrograms.map((f) => f.fontName)),
      selected = [...keys],
      labels = []
    for (const record of records.filter(
      (r) => r.part.some((z) => added(z.g.ink)) && !keys.includes(r)
    )) {
      const owners = axes.filter(
        (a) =>
          record.part.every((z) => directForm(z.g.i) === a.h.form) &&
          inside([a.horizontal[0], a.horizontal[1], a.horizontal[2], a.key.rect[1]], record.rect) &&
          record.part.every((z) =>
            inside([a.horizontal[0], a.horizontal[1], a.horizontal[2], a.key.rect[1]], z.g.ink)
          )
      )
      if (owners.length !== 1 || !type3Fonts.has(record.r.fontName)) return
      const owner = owners[0],
        ticks = records.filter(
          (r) =>
            /^[−-]?\d+(?:\.\d+)?$/.test(r.r.str) &&
            r.r.fontName === record.r.fontName &&
            r.part.every((z) => directForm(z.g.i) === owner.h.form) &&
            r.rect[1] >= owner.horizontal[1] &&
            r.rect[1] - owner.horizontal[1] < r.r.height &&
            r.rect[0] >= owner.horizontal[0] - r.r.height &&
            r.rect[2] <= owner.horizontal[2] + r.r.height
        )
      if (ticks.length < 3) return
      labels.push({ record, owner, ticks })
      selected.push(record)
    }
    if (labels.length !== 3 || axes.some((a) => labels.filter((l) => l.owner === a).length !== 1))
      return
    const ownedGlyphs = new Set(selected.flatMap((r) => r.part.map((z) => z.g)))
    if (
      glyphs.some((g) => added(g.ink) && !ownedGlyphs.has(g)) ||
      evidence.images.some((im) => !finite(im.rect, 4) || added(im.rect))
    )
      return
    const backgrounds = [],
      paints = []
    for (const [i, state] of evidence.paths) {
      const args = o.argsArray[i]
      if ([OPS.endPath, OPS.clip, OPS.eoClip].includes(args?.[0])) continue
      if (!finite(args?.[2], 4)) return
      const stroke = [
          OPS.stroke,
          OPS.closeStroke,
          OPS.fillStroke,
          OPS.eoFillStroke,
          OPS.closeFillStroke,
          OPS.closeEOFillStroke
        ].includes(args[0]),
        pad = stroke ? (state.lineWidth * Math.max(1, inventory.strokeMargins.get(i) ?? 10)) / 2 : 0
      const q = box(
        Array.from(args[2], (n, k) => n + (k < 2 ? -pad : pad)),
        Util.transform(v.transform, state.transform)
      )
      const clip = state.clip,
        painted = clip
          ? [
              Math.max(q[0], clip[0]),
              Math.max(q[1], clip[1]),
              Math.min(q[2], clip[2]),
              Math.min(q[3], clip[3])
            ]
          : q
      paints.push({ operationIndex: i, rect: painted })
      if (!added(painted)) continue
      const owner = axes.filter((a) => directForm(i) === a.h.form),
        p = args[1]?.[0]
      if (
        owner.length !== 1 ||
        args[0] !== OPS.fill ||
        state.fillAlpha !== 1 ||
        !finite(p, 13) ||
        p[0] !== 0 ||
        p[3] !== 1 ||
        p[6] !== 1 ||
        p[9] !== 1 ||
        p[12] !== 4 ||
        p[1] !== p[10] ||
        p[2] !== p[5] ||
        p[4] !== p[7] ||
        p[8] !== p[11] ||
        !equal(q, owner[0].clip) ||
        !equal(painted, owner[0].clip) ||
        i >= owner[0].h.i ||
        i >= owner[0].l.i ||
        labels
          .filter((l) => l.owner === owner[0])
          .some((l) => [l.record, ...l.ticks].some((r) => r.part.some((z) => z.g.i <= i)))
      )
        return
      backgrounds.push({ operationIndex: i, form: owner[0].h.form, rect: painted })
    }
    if (
      backgrounds.length !== 3 ||
      axes.some((a) => backgrounds.filter((b) => b.form === a.h.form).length !== 1)
    )
      return
    return { rect, inventory, labels, backgrounds, paints, directForm }
  } catch {
    return
  }
}

// Keep crop completion independent from optional native text ownership. The
// existing API never promises visibility outside the newly exposed crop strip.
export function nativeOpenAxisBottomBounds(page, figure, captions, tables, tokens, context) {
  return openAxisBottomProof(page, figure, captions, tables, tokens, context)?.rect
}

// A fixed ownership contract over exactly the same proved continuation rows.
// All whole role witnesses, including already retained keys and ticks, must be
// independently visible before any optional source claims are published.
export function nativeOpenAxisBottomEvidence(page, figure, captions, tables, tokens, context) {
  const proof = openAxisBottomProof(page, figure, captions, tables, tokens, context)
  if (!proof) return
  const result = { rect: proof.rect }
  try {
    const { inventory, labels, backgrounds, paints } = proof
    const witnesses = labels.flatMap((l) => [l.owner.key, l.record, ...l.ticks])
    if (new Set(witnesses).size !== witnesses.length) return result
    const ownershipPaints = paints.map((paint) => ({
      ...paint,
      rect: nativeButtTickStripe(proof, paint, context, witnesses) ?? paint.rect
    }))
    for (const label of labels) {
      const group = [label.owner.key, label.record, ...label.ticks]
      const background = backgrounds.filter((b) => b.form === label.owner.h.form)
      if (
        background.length !== 1 ||
        group.some((r) => r.part.some((p) => p.g.i <= background[0].operationIndex))
      )
        return result
      for (const record of group) {
        const style = context.content.styles[record.r.fontName]
        if (
          !Number.isFinite(style?.ascent) ||
          style.ascent <= 0 ||
          style.ascent > 1 ||
          !Number.isFinite(style.descent) ||
          style.descent > 0 ||
          style.descent < -1
        )
          return result
        const font = nativeFigureLabelBounds(record.r, style, context.viewport)
        if (
          !font ||
          !inside(proof.rect, font) ||
          !inside(proof.rect, record.rect) ||
          record.part.some((p) => !inside(proof.rect, p.g.ink))
        )
          return result
        const glyphs = new Set(record.part.map((p) => p.g))
        const touches = (r) => record.part.some((p) => intersection(r, p.g.ink) > 1e-7)
        if (
          inventory.glyphs.some((g) => !glyphs.has(g) && touches(g.ink)) ||
          inventory.evidence.images.some((image) => touches(image.rect)) ||
          ownershipPaints.some(
            (paint) => touches(paint.rect) && paint.operationIndex !== background[0].operationIndex
          )
        )
          return result
      }
    }
    const firstRows = nativeOpenAxisFirstRows(proof, page, captions, tables, context)
    const headerRaster = nativeOpenAxisHeaderRaster(proof, page, figure, captions, tables, context)
    return {
      ...result,
      sourceItems: [...labels.map(({ record }) => ({ ...record.r.sourceItem })), ...firstRows].sort(
        (a, b) => a.index - b.index
      ),
      ...(headerRaster ? { headerRaster } : {})
    }
  } catch {
    return result
  }
}

const validBox = (r) => finite(r, 4) && r[2] >= r[0] && r[3] >= r[1]
const positiveBox = (r) => validBox(r) && r[2] > r[0] && r[3] > r[1]
const separation = (a, b) => Math.max(0, a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3])
const sourceFont = (record, context) => {
  const style = context.content.styles[record.r.fontName]
  if (
    !Number.isFinite(style?.ascent) ||
    style.ascent <= 0 ||
    style.ascent > 1 ||
    !Number.isFinite(style.descent) ||
    style.descent > 0 ||
    style.descent < -1
  )
    return
  const rect = nativeFigureLabelBounds(record.r, style, context.viewport)
  return positiveBox(rect) ? rect : undefined
}

// The only exempt paint beneath a new text owner must be known opaque white.
// Crop completion and previously published continuation claims keep their
// original contract; these additional roles require contrast evidence too.
const whiteOwnerBackground = (proof, background) => {
  const paint = proof.inventory.evidence.paths.get(background.operationIndex)?.fillPaint
  return (
    paint &&
    Object.keys(paint).sort().join(',') === 'fillAlpha,fillColor' &&
    typeof paint.fillColor === 'string' &&
    paint.fillColor.toLowerCase() === '#ffffff' &&
    paint.fillAlpha === 1
  )
}

// A complete first row is owned by its already proved continuation, not merely
// by their common Form. Protect every blank and the full interline band too.
function nativeOpenAxisFirstRows(proof, page, captions, tables, context) {
  const sources = []
  try {
    const { inventory, labels, paints, backgrounds, directForm } = proof
    for (const { record: continuation, owner, ticks } of labels) {
      const em = continuation.r.height,
        baseline = continuation.rect[3]
      const choices = inventory.records.filter(
        (r) =>
          r !== continuation &&
          r.r.fontName === continuation.r.fontName &&
          r.r.height === em &&
          r.r.transform[0] === em &&
          r.r.transform[1] === 0 &&
          r.r.transform[2] === 0 &&
          r.r.transform[3] === em &&
          /\p{L}/u.test(r.r.str) &&
          baseline - r.rect[3] >= em &&
          baseline - r.rect[3] <= em * 1.4 &&
          Math.abs(r.rect[0] + r.rect[2] - continuation.rect[0] - continuation.rect[2]) <=
            em * 0.1 &&
          r.part.every((p) => directForm(p.g.i) === owner.h.form)
      )
      if (choices.length !== 1) continue
      const first = choices[0],
        records = [first, continuation],
        fonts = records.map((r) => sourceFont(r, context))
      if (fonts.some((r) => !r)) continue
      const body = union([
        ...fonts,
        ...records.map((r) => r.rect),
        ...records.flatMap((r) => r.part.map((p) => p.g.ink))
      ])
      const band = [owner.horizontal[0], body[1], owner.horizontal[2], body[3]]
      const tickFonts = ticks.map((r) => sourceFont(r, context))
      if (
        tickFonts.some((r) => !r) ||
        !inside(band, body) ||
        !inside(proof.rect, band) ||
        Math.max(
          ...tickFonts.map((r) => r[3]),
          ...ticks.flatMap((r) => [r.rect[3], ...r.part.map((p) => p.g.ink[3])])
        ) >= band[1] ||
        tables.some((r) => intersection(r, band) > 0) ||
        captions.some((c) => c.page === page.pageNumber && intersection(c.rect, band) > 0)
      )
        continue
      const background = backgrounds.filter((b) => b.form === owner.h.form),
        own = new Set(records.flatMap((r) => r.part.map((p) => p.g)))
      if (
        background.length !== 1 ||
        !whiteOwnerBackground(proof, background[0]) ||
        records.some((r) => r.part.some((p) => p.g.i <= background[0].operationIndex)) ||
        inventory.records.some((r) => !records.includes(r) && intersection(r.rect, band) > 1e-7) ||
        inventory.glyphs.some((g) => !own.has(g) && intersection(g.ink, band) > 1e-7) ||
        inventory.evidence.images.some(
          (im) => !validBox(im.rect) || intersection(im.rect, band) > 1e-7
        ) ||
        paints.some(
          (p) =>
            !validBox(p.rect) ||
            (p.operationIndex !== background[0].operationIndex && intersection(p.rect, band) > 1e-7)
        )
      )
        continue
      sources.push({ ...first.r.sourceItem })
    }
  } catch {
    return []
  }
  return sources
}

const strokeOps = new Set([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke
])

// The native source bound remains conservative for arbitrary cap/join shapes.
// PDF.js can enlarge a subpixel stroke. Its CTM norm/determinant formula gives
// an additional coefficient/scale bound without guessing the crop's scale.
function headerPaintBounds(proof, context) {
  const paints = []
  for (const paint of proof.paints) {
    const i = paint.operationIndex,
      args = proof.inventory.o.argsArray[i],
      state = proof.inventory.evidence.paths.get(i)
    if (
      !validBox(paint.rect) ||
      !state ||
      !finite(state.transform, 6) ||
      !positiveBox(state.clip) ||
      !finite(args?.[2], 4)
    )
      return
    const matrix = Util.transform(context.viewport.transform, state.transform)
    const det = Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2])
    if (!finite(matrix, 6) || !(det > 0)) return
    let rect = paint.rect,
      floor = 0
    if (strokeOps.has(args[0])) {
      const miter = proof.inventory.strokeMargins.get(i)
      if (
        !Number.isFinite(state.lineWidth) ||
        state.lineWidth <= 0 ||
        ![0, 1, 2].includes(state.lineCap) ||
        !Number.isFinite(miter) ||
        miter < 1 ||
        typeof state.solidStroke !== 'boolean' ||
        !Number.isFinite(state.strokeAlpha) ||
        state.strokeAlpha < 0 ||
        state.strokeAlpha > 1
      )
        return
      // A diagonal square cap can reach sqrt(2) radii even with miterLimit=1.
      const margin = Math.max(state.lineCap === 2 ? Math.SQRT2 : 1, miter),
        pad = (state.lineWidth * margin) / 2
      const q = proof.inventory.box(
        Array.from(args[2], (n, k) => n + (k < 2 ? -pad : pad)),
        matrix
      )
      const clipped = [
        Math.max(q[0], state.clip[0]),
        Math.max(q[1], state.clip[1]),
        Math.min(q[2], state.clip[2]),
        Math.min(q[3], state.clip[3])
      ]
      if (!validBox(clipped)) return
      rect = union([rect, clipped])
      const nx = Math.hypot(matrix[0], matrix[1]),
        ny = Math.hypot(matrix[2], matrix[3])
      floor =
        (margin / 2) *
        Math.max(
          (Math.abs(matrix[0]) * ny + Math.abs(matrix[2]) * nx) / det,
          (Math.abs(matrix[1]) * ny + Math.abs(matrix[3]) * nx) / det
        )
      if (!Number.isFinite(floor)) return
    }
    paints.push({ operationIndex: i, rect, floor })
  }
  return paints
}

function exactHeaderAxis(proof, context, source) {
  const args = proof.inventory.o.argsArray[source.i],
    p = args?.[1]?.[0],
    state = source.state
  if (
    args?.[0] !== OPS.stroke ||
    !Array.isArray(args[1]) ||
    args[1].length !== 1 ||
    !finite(p, 6) ||
    p[0] !== 0 ||
    p[3] !== 1 ||
    (p[1] === p[4]) === (p[2] === p[5]) ||
    !finite(args[2], 4) ||
    !equal(Array.from(args[2]), [
      Math.min(p[1], p[4]),
      Math.min(p[2], p[5]),
      Math.max(p[1], p[4]),
      Math.max(p[2], p[5])
    ]) ||
    ![0, 2].includes(state.lineCap) ||
    state.solidStroke !== true ||
    state.strokeAlpha !== 1 ||
    !Number.isFinite(state.lineWidth) ||
    state.lineWidth <= 0 ||
    !positiveBox(state.clip)
  )
    return
  const matrix = Util.transform(context.viewport.transform, state.transform)
  if (
    !finite(matrix, 6) ||
    matrix[1] !== 0 ||
    matrix[2] !== 0 ||
    matrix[0] <= 0 ||
    matrix[3] >= 0 ||
    matrix[0] !== -matrix[3]
  )
    return
  return state.lineWidth * matrix[0]
}

function nativeOpenAxisHeaderRaster(proof, page, figure, captions, tables, context) {
  try {
    const { inventory, labels, directForm } = proof,
      cap = figure.caption
    if (
      captions.filter((c) => c.page === page.pageNumber).length !== 1 ||
      inventory.records.some((r) => !positiveBox(r.rect)) ||
      inventory.glyphs.some((g) => !validBox(g.ink) || !positiveBox(g.advance)) ||
      inventory.evidence.images.some((im) => !positiveBox(im.rect))
    )
      return
    const paints = headerPaintBounds(proof, context)
    if (!paints) return
    const capRecords = inventory.records.filter((r) => inside(cap.rect, r.rect)),
      keys = (s) => [...s.matchAll(/\(([a-z])\)/g)].map((m) => m[1]).join('')
    if (
      !capRecords.length ||
      inventory.records.some(
        (r) => intersection(r.rect, cap.rect) > 1e-7 && !inside(cap.rect, r.rect)
      ) ||
      keys(capRecords.map((r) => r.r.str).join('')) !== 'abc' ||
      keys(cap.lines.join(' ')) !== 'abc'
    )
      return
    const witnesses = []
    for (const r of capRecords)
      for (let j = 0; j < r.part.length - 2; j++) {
        const part = r.part.slice(j, j + 3)
        if (part[0].c !== '(' || !/^[a-z]$/.test(part[1].c) || part[2].c !== ')') continue
        if (
          part.some(
            (p) =>
              p.g.text !== p.c ||
              p.g.fontName !== r.r.fontName ||
              typeof p.g.textPaint?.fillColor !== 'string' ||
              !/^#[a-f0-9]{6}$/iu.test(p.g.textPaint.fillColor) ||
              p.g.textPaint.fillColor.toLowerCase() === '#ffffff' ||
              p.g.textPaint.fillAlpha !== 1 ||
              Math.abs(p.g.height - r.r.height) > 0.02 ||
              Math.abs(p.g.advance[3] - r.rect[3]) > 0.02 ||
              !inside(cap.rect, p.g.advance) ||
              !inside(cap.rect, p.g.ink)
          )
        )
          return
        const own = new Set(part.map((p) => p.g)),
          touches = (rect) => part.some((p) => intersection(rect, p.g.ink) > 1e-7)
        if (
          inventory.glyphs.some((g) => !own.has(g) && touches(g.ink)) ||
          inventory.evidence.images.some((im) => touches(im.rect)) ||
          paints.some((p) => touches(p.rect))
        )
          return
        witnesses.push(part[1].c)
      }
    if (witnesses.join('') !== 'abc') return
    const selected = [],
      thresholds = [],
      protectedRects = new Map()
    for (const { owner } of labels) {
      const local = inventory.records.filter((r) =>
        r.part.every((p) => directForm(p.g.i) === owner.h.form)
      )
      const horizontal = local.filter(
        (r) =>
          r.r.transform[0] > 0 &&
          r.r.transform[1] === 0 &&
          r.r.transform[2] === 0 &&
          r.r.transform[3] > 0 &&
          /\p{L}/u.test(r.r.str)
      )
      const em = Math.max(...horizontal.map((r) => r.r.height)),
        largest = horizontal.filter((r) => r.r.height === em)
      if (!Number.isFinite(em) || em <= 0 || largest.length !== 1) return
      const record = largest[0],
        font = sourceFont(record, context)
      // Only the fixed Type3 packet proves opaque, nonwhite parent paint.
      // Its font names are disjoint from ordinary fonts and every occurrence
      // is bound to a complete program; ordinary outline bounds prove no paint.
      if (!context.type3GlyphPrograms.some((f) => f.fontName === record.r.fontName)) return
      if (!font) return
      const body = union([record.rect, font, ...record.part.map((p) => p.g.ink)]),
        band = [owner.horizontal[0], owner.clip[1], owner.horizontal[2], owner.lp[1]]
      if (
        !inside(band, body) ||
        !inside(proof.rect, body) ||
        Math.abs(record.rect[0] + record.rect[2] - owner.horizontal[0] - owner.horizontal[2]) >
          em * 0.1 ||
        (selected.length &&
          (selected[0].r.height !== em ||
            Math.abs(selected[0].rect[3] - record.rect[3]) > em * 0.01)) ||
        tables.some((r) => intersection(r, band) > 0)
      )
        return
      const own = new Set(record.part.map((p) => p.g)),
        bg = proof.backgrounds.filter((b) => b.form === owner.h.form)
      if (
        bg.length !== 1 ||
        !whiteOwnerBackground(proof, bg[0]) ||
        record.part.some((p) => p.g.i <= bg[0].operationIndex) ||
        inventory.records.some((r) => r !== record && intersection(r.rect, band) > 1e-7) ||
        inventory.glyphs.some((g) => !own.has(g) && intersection(g.ink, band) > 1e-7) ||
        inventory.evidence.images.some((im) => intersection(im.rect, band) > 1e-7)
      )
        return
      for (const paint of paints) {
        if (paint.operationIndex === bg[0].operationIndex) continue
        const axis =
          paint.operationIndex === owner.h.i
            ? 'h'
            : paint.operationIndex === owner.l.i
              ? 'l'
              : undefined
        if (axis) {
          const width = exactHeaderAxis(proof, context, owner[axis]),
            centerline = axis === 'h' ? owner.horizontal : owner.vertical
          if (!width || intersection(owner[axis + 'p'], band) > 1e-7) return
          const d = separation(body, centerline)
          if (!(d > width / 2)) return
          thresholds.push(Math.max(2 / (d - width / 2), 2.5 / d))
        } else {
          if (intersection(paint.rect, band) > 1e-7) return
          const d = separation(body, paint.rect)
          if (!(d > 0)) return
          thresholds.push((paint.floor + 2) / d)
        }
      }
      for (const glyph of inventory.glyphs)
        if (!own.has(glyph) && area(glyph.ink) > 0) {
          const d = separation(body, glyph.ink)
          if (!(d > 0)) return
          thresholds.push(2 / d)
        }
      for (const image of inventory.evidence.images) {
        const d = separation(body, image.rect)
        if (!(d > 0)) return
        thresholds.push(2 / d)
      }
      selected.push(record)
      protectedRects.set(record.index, body)
    }
    const minimumScaleExclusive = Math.max(...thresholds) * (1 + 32 * Number.EPSILON)
    if (
      selected.length !== 3 ||
      !Number.isFinite(minimumScaleExclusive) ||
      minimumScaleExclusive <= 0
    )
      return
    return {
      sourceItems: selected.map((r) => ({ ...r.r.sourceItem })).sort((a, b) => a.index - b.index),
      protectedRects: selected
        .map((r) => r.index)
        .sort((a, b) => a - b)
        .map((i) => [...protectedRects.get(i)]),
      minimumScaleExclusive
    }
  } catch {
    return
  }
}

// This internal candidate certificate never enters Worker output. Actual PNG
// dimensions, including byte-limit retries, decide only the optional headers.
export function nativeOpenAxisHeaderSourceItems(png, rect, page, candidate, tokens) {
  try {
    const proof = candidate?.headerRaster
    if (
      !proof ||
      Object.keys(proof).sort().join(',') !== 'minimumScaleExclusive,protectedRects,sourceItems' ||
      !Array.isArray(proof.sourceItems) ||
      proof.sourceItems.length !== 3 ||
      !Array.isArray(proof.protectedRects) ||
      proof.protectedRects.length !== 3 ||
      proof.protectedRects.some((r) => !positiveBox(r) || !inside(rect, r)) ||
      !Number.isFinite(proof.minimumScaleExclusive) ||
      proof.minimumScaleExclusive <= 0 ||
      !positiveBox(rect) ||
      !Number.isSafeInteger(page.pageNumber) ||
      !Array.isArray(tokens)
    )
      return
    const raster = getPdfCropRasterProtectionFromPng(png, rect, page)
    if (!raster || raster.scaleLower <= proof.minimumScaleExclusive) return
    const seen = new Set()
    for (const source of proof.sourceItems) {
      if (
        !source ||
        Object.keys(source).sort().join(',') !== 'index,pageNumber,text' ||
        source.pageNumber !== page.pageNumber ||
        !Number.isSafeInteger(source.index) ||
        source.index < 0 ||
        typeof source.text !== 'string' ||
        !source.text.trim() ||
        seen.has(source.index)
      )
        return
      seen.add(source.index)
      const matching = tokens.filter(
        (t) =>
          t.sourceItem?.pageNumber === source.pageNumber && t.sourceItem?.index === source.index
      )
      if (
        matching.length !== 1 ||
        matching[0].sourceItem.text !== source.text ||
        matching[0].text !== source.text ||
        !positiveBox(matching[0].rect) ||
        !positiveBox(matching[0].nativeLabelRect) ||
        !inside(rect, matching[0].rect) ||
        !inside(rect, matching[0].nativeLabelRect) ||
        candidate.sourceItems?.some(
          (s) =>
            s.pageNumber === source.pageNumber && s.index === source.index && s.text !== source.text
        )
      )
        return
    }
    return proof.sourceItems.map((s) => ({ ...s }))
  } catch {
    return
  }
}

// One vertical, butt-capped axis tick has no join and no longitudinal stroke
// expansion. A degenerate fillStroke also has no filled area. Use the complete
// clip width rather than promising a device-scale-dependent stroke width: even
// PDF.js minimum-pixel widening stays within this conservative horizontal band.
// This refinement is private to source ownership; crop paint bounds stay intact.
function nativeButtTickStripe(proof, paint, context, witnesses) {
  const { inventory, labels, directForm } = proof,
    i = paint.operationIndex,
    args = inventory.o.argsArray[i],
    state = inventory.evidence.paths.get(i),
    path = args?.[1]?.[0]
  if (
    args?.[0] !== OPS.fillStroke ||
    !Array.isArray(args[1]) ||
    args[1].length !== 1 ||
    !finite(path, 6) ||
    path[0] !== 0 ||
    path[3] !== 1 ||
    path[1] !== path[4] ||
    path[2] === path[5] ||
    !finite(args[2], 4) ||
    !equal(Array.from(args[2]), [
      path[1],
      Math.min(path[2], path[5]),
      path[1],
      Math.max(path[2], path[5])
    ]) ||
    !state ||
    state.lineCap !== 0 ||
    state.solidStroke !== true ||
    state.strokeAlpha !== 1 ||
    state.fillAlpha !== 1 ||
    !Number.isFinite(state.lineWidth) ||
    state.lineWidth <= 0 ||
    !finite(state.transform, 6) ||
    state.transform[0] <= 0 ||
    state.transform[3] <= 0 ||
    state.transform[1] !== 0 ||
    state.transform[2] !== 0 ||
    !finite(state.clip, 4)
  )
    return
  const matrix = Util.transform(context.viewport.transform, state.transform)
  if (
    !finite(matrix, 6) ||
    matrix[1] !== 0 ||
    matrix[2] !== 0 ||
    matrix[0] === 0 ||
    matrix[3] === 0
  )
    return
  const points = [
    [path[1], path[2]],
    [path[4], path[5]]
  ]
  points.forEach((p) => Util.applyTransform(p, matrix))
  const line = [
    points[0][0],
    Math.min(points[0][1], points[1][1]),
    points[0][0],
    Math.max(points[0][1], points[1][1])
  ]
  if (!inside(state.clip, line)) return
  const physicalWidth = state.lineWidth * Math.abs(matrix[0])
  if (physicalWidth > (line[3] - line[1]) / 2) return
  const bindings = labels.flatMap((label) =>
    label.ticks.filter(
      (tick) =>
        directForm(i) === label.owner.h.form &&
        equal(state.transform, label.owner.h.state.transform) &&
        equal(state.clip, label.owner.clip) &&
        Math.abs(line[1] - label.owner.horizontal[1]) < 1e-6 &&
        line[0] >= label.owner.horizontal[0] &&
        line[0] <= label.owner.horizontal[2] &&
        line[0] >= tick.rect[0] &&
        line[0] <= tick.rect[2] &&
        physicalWidth < tick.r.height &&
        line[3] - line[1] <= tick.r.height &&
        tick.part.every((p) => i < p.g.i)
    )
  )
  if (bindings.length !== 1) return
  const stripe = [state.clip[0], line[1], state.clip[2], line[3]]
  return witnesses.some((record) => record.part.some((p) => intersection(stripe, p.g.ink) > 1e-7))
    ? undefined
    : stripe
}
