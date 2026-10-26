/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { completeNativeNodeGlyphProgram } from './literature-pdf-figure-native-plot-bands.mjs'
import { collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'
import { intersection } from './literature-pdf-page-geometry.mjs'

const finite = (a, n) =>
  (Array.isArray(a) || ArrayBuffer.isView(a)) &&
  a.length === n &&
  Array.from(a).every(Number.isFinite)
const valid = (r) => finite(r, 4) && r[0] < r[2] && r[1] < r[3]
const inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] - 1e-6 : n <= a[i] + 1e-6))
const near = (a, b) => Math.abs(a - b) < 1e-6
const rgb = (s) => typeof s === 'string' && /^#[0-9a-f]{6}$/iu.test(s)
const header = (s) => /^@@\s+\S[^\r\n]*\s+@@$/u.test(s)

function prove(
  page,
  candidate,
  context,
  options,
  fontFacts,
  capturedGraphics = true,
  referencePaints
) {
  if (
    !page ||
    !context ||
    candidate?.page !== page.pageNumber ||
    !new RegExp('^p' + page.pageNumber + '-graphical-table-\\d+$', 'u').test(candidate.id) ||
    candidate.thumbnail !== `thumbnails/${candidate.id}.png` ||
    candidate.caption ||
    !['grid', 'cells', 'unassigned'].every(
      (k) => Array.isArray(candidate[k]) && candidate[k].length === 0
    ) ||
    JSON.stringify(candidate.issues) !== JSON.stringify(['no-source-cell-grid']) ||
    !valid(candidate.region) ||
    !inside([0, 0, 1, 1], candidate.region) ||
    context.pageNumber !== page.pageNumber ||
    !/^[a-f0-9]{64}$/iu.test(context.sourceSha256 ?? '') ||
    JSON.stringify(page.graphicsBounds) !== JSON.stringify(context.graphicsBounds) ||
    !Array.isArray(options?.competingRects) ||
    !options.competingRects.every(valid) ||
    !Array.isArray(options?.captions) ||
    !Array.isArray(fontFacts)
  )
    return
  const v = context.viewport,
    o = context.operators,
    rect = candidate.region.map((n, i) => n * (i % 2 ? page.height : page.width))
  if (
    !valid(rect) ||
    v?.rotation !== 0 ||
    v.scale !== 1 ||
    !finite(v.transform, 6) ||
    candidate.sourceViewport?.scale !== 1.5 ||
    candidate.sourceViewport.width !== page.width * 1.5 ||
    candidate.sourceViewport.height !== page.height * 1.5 ||
    options.competingRects.some((r) => intersection(r, rect) > 0) ||
    options.captions.some(
      (c) => c.page === page.pageNumber && (!valid(c.rect) || intersection(c.rect, rect) > 0)
    )
  )
    return
  const viewport = {
      ...v,
      convertToViewportPoint: (x, y) => [
        v.transform[0] * x + v.transform[2] * y + v.transform[4],
        v.transform[1] * x + v.transform[3] * y + v.transform[5]
      ]
    },
    tokens = context.content.items.flatMap((r) =>
      r.str?.trim() ? [tableTextToken(r, viewport, 0)] : []
    ),
    selected = new Set(
      tokens.filter((t) => valid(t.rect) && inside(rect, t.rect)).map((t) => t.sourceItem.index)
    )
  if (!selected.size || selected.size > 512) return
  const proofContext = { ...context, viewport },
    inv = nativePageTextPacketInventory(page, tokens, proofContext, false, selected)
  if (
    !inv ||
    !completeNativeNodeGlyphProgram(page, tokens, collectClosedFigureFrames(o, v), proofContext)
  )
    return
  const records = inv.records.filter((r) => selected.has(r.index)),
    first = records[0],
    font = first?.r.fontName,
    facts = fontFacts.filter((f) => f?.fontName === font),
    height = first?.r.height
  if (
    !records.length ||
    !header(first.r.str) ||
    facts.length !== 1 ||
    facts[0].isMonospace !== true ||
    ['missingFile', 'isType3Font', 'isInvalidPDFjsFont'].some((k) => facts[0][k] !== false) ||
    context.content.styles?.[font]?.fontFamily !== 'monospace' ||
    !(height > 0) ||
    records.some(
      (r) =>
        r.r.fontName !== font ||
        !near(r.r.height, height) ||
        !r.advanceComplete ||
        Array.from(r.r.str).some(
          (c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127 || c.codePointAt(0) === 0xfffd
        ) ||
        !inside(rect, r.rect) ||
        r.part.some((p) => !valid(p.g.ink) || !inside(rect, p.g.ink))
    )
  )
    return
  // A crop containing just a header and the signed prefix is not a whole
  // packet. Keep every native run in this page's same mono face and size;
  // unselected context below a crop cannot become an unrelated foreign row.
  if (
    inv.records.some(
      (r) => r.r.fontName === font && near(r.r.height, height) && !selected.has(r.index)
    )
  )
    return
  const owned = new Set(records.flatMap((r) => r.part.map((p) => p.g))),
    step = [...owned][0].advance[2] - [...owned][0].advance[0]
  if (
    !(step > 0) ||
    [...owned].some((g) => !near(g.advance[2] - g.advance[0], step) || !near(g.height, height))
  )
    return
  let fill = '#000000',
    stroke = '#000000'
  const stack = [],
    colors = new Map(),
    fillColors = new Map()
  for (const [i, op] of o.fnArray.entries()) {
    const a = o.argsArray[i]
    if (op === OPS.save) stack.push({ fill, stroke })
    else if (op === OPS.restore) {
      const s = stack.pop()
      if (!s) return
      ;({ fill, stroke } = s)
    } else if (op === OPS.setFillRGBColor) fill = a[0]
    else if (op === OPS.setStrokeRGBColor) stroke = a[0]
    else if (op === OPS.showText) colors.set(i, fill)
    else if (op === OPS.constructPath) fillColors.set(i, fill)
  }
  if (
    stack.length ||
    [...owned].some((g) => !rgb(colors.get(g.i)) || colors.get(g.i).toLowerCase() === '#ffffff')
  )
    return
  const paths = [],
    captured = new Map(page.graphicsBounds.map((g) => [g.operationIndex, g]))
  if (captured.size !== page.graphicsBounds.length) return
  for (const [id, state] of inv.evidence.paths) {
    const a = o.argsArray[id]
    if (a[0] === OPS.endPath) continue
    if (
      (capturedGraphics && captured.get(id)?.kind !== 'path') ||
      !finite(a[2], 4) ||
      !finite(state.transform, 6) ||
      !valid(state.clip)
    )
      return
    const tr = Util.transform(v.transform, state.transform),
      strokePaint = ![OPS.fill, OPS.eoFill].includes(a[0]),
      pad = strokePaint ? (state.lineWidth * Math.max(1, inv.strokeMargins.get(id) ?? 10)) / 2 : 0
    if (!Number.isFinite(pad) || pad < 0 || (strokePaint && !(state.lineWidth > 0))) return
    const b = inv.box(
        Array.from(a[2], (n, i) => n + (i < 2 ? -pad : pad)),
        tr
      ),
      box = [
        Math.max(b[0], state.clip[0]),
        Math.max(b[1], state.clip[1]),
        Math.min(b[2], state.clip[2]),
        Math.min(b[3], state.clip[3])
      ]
    if (!valid(box)) return
    let background
    const q = a[1]?.[0]
    if (
      a[0] === OPS.fill &&
      a[1]?.length === 1 &&
      finite(q, 13) &&
      q[0] === 0 &&
      q[12] === 4 &&
      [3, 6, 9].every((i) => q[i] === 1)
    ) {
      const corners = [0, 3, 6, 9].map((i) => [q[i + 1], q[i + 2]])
      for (const p of corners) Util.applyTransform(p, tr)
      const xs = [...new Set(corners.map((p) => p[0]))],
        ys = [...new Set(corners.map((p) => p[1]))]
      if (
        xs.length === 2 &&
        ys.length === 2 &&
        new Set(corners.map((p) => p.join(','))).size === 4 &&
        corners.every((p, i) => {
          const n = corners[(i + 1) % 4]
          return (p[0] === n[0]) !== (p[1] === n[1])
        })
      ) {
        const actual = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
          color = fillColors.get(id)
        if (
          valid(actual) &&
          inside(state.clip, actual) &&
          state.fillAlpha === 1 &&
          rgb(color) &&
          color.toLowerCase() !== '#ffffff'
        )
          background = {
            rect: actual,
            color: color.toLowerCase(),
            signature: [
              color.toLowerCase(),
              state.clip,
              [0, 3, 6, 9].flatMap((i) => {
                const p = [q[i + 1], q[i + 2]]
                Util.applyTransform(p, state.transform)
                return p.map(Math.fround)
              })
            ],
            captureIsPdfCoordinates: state.transform.every((n, i) => n === [1, 0, 0, 1, 0, 0][i])
          }
      }
    }
    paths.push({ id, box, background })
  }
  if (
    (capturedGraphics && paths.length !== captured.size) ||
    inv.evidence.images.some((i) => !valid(i.rect) || intersection(i.rect, rect) > 0)
  )
    return
  const ownPaint = paths.filter((p) => intersection(p.box, rect) > 0)
  if (!ownPaint.length || ownPaint.some((p) => !p.background)) return
  const paintSignatures = ownPaint.map((p) => p.background.signature),
    boundPaints =
      !capturedGraphics &&
      referencePaints &&
      JSON.stringify(referencePaints) === JSON.stringify(paintSignatures)
  if (referencePaints && !boundPaints) return
  // Each exact native row fill must cover visible code ink; margin strips
  // can meet a source row without inventing contact across Float32 gaps.
  if (
    [...owned].some(
      (g) =>
        !ownPaint.some(
          (p) =>
            p.id < g.i &&
            inside(p.background.rect, g.ink) &&
            p.background.color !== colors.get(g.i).toLowerCase()
        ) || ownPaint.some((p) => p.id > g.i && intersection(p.background.rect, g.ink) > 0)
    )
  )
    return
  const rows = []
  for (const r of records) {
    let row = rows.at(-1)
    if (!row || !near(row[0].rect[3], r.rect[3])) {
      if (row && r.rect[1] < row[0].rect[3] - 1e-6) return
      rows.push((row = []))
    }
    if (row.length && r.rect[0] < row.at(-1).rect[2] - 1e-6) return
    row.push(r)
  }
  const packets = []
  for (const row of rows) {
    const text = row.map((r) => r.r.str).join('')
    if (header(text)) {
      if (row.length !== 1) return
      packets.push({ rows: [row], minus: false, plus: false })
    } else {
      const packet = packets.at(-1)
      if (!packet) return
      packet.rows.push(row)
      if (/^-\S/u.test(text) || /^-$/.test(text) || /^-\s/u.test(text)) packet.minus = true
      if (/^\+\S/u.test(text) || /^\+$/.test(text) || /^\+\s/u.test(text)) packet.plus = true
    }
  }
  if (
    !packets.length ||
    packets.length > 8 ||
    packets.some((p) => p.rows.length < 3 || !p.minus || !p.plus)
  )
    return
  if (new Set(packets.map((p) => p.rows[0][0].r.str)).size !== packets.length) return
  const bands = new Map()
  for (const paint of ownPaint) {
    const r = paint.background.rect,
      key = JSON.stringify([r[1], r[3]])
    if (!bands.has(key)) bands.set(key, [])
    bands.get(key).push(paint)
  }
  if (new Set(ownPaint.map((p) => p.background.color)).size !== 1) return
  const rowBands = new Map()
  for (const row of rows) {
    const gs = row.flatMap((r) => r.part.map((p) => p.g)),
      matches = [...bands.values()].filter((b) =>
        gs.every((g) => g.ink[1] >= b[0].background.rect[1] && g.ink[3] <= b[0].background.rect[3])
      )
    if (matches.length !== 1 || [...rowBands.values()].includes(matches[0])) return
    const b = matches[0],
      ordered = b.map((p) => p.background.rect).sort((a, b) => a[0] - b[0])
    let right = ordered[0][2]
    for (const r of ordered.slice(1)) {
      if (r[0] > right) return
      right = Math.max(right, r[2])
    }
    rowBands.set(row, b)
  }
  for (const band of bands.values()) {
    if ([...rowBands.values()].includes(band)) continue
    if (band.length !== 1) return
    const r = band[0].background.rect,
      matches = packets.filter((p) => {
        const first = rowBands.get(p.rows[0])[0].background.rect,
          last = rowBands.get(p.rows.at(-1))[0].background.rect,
          glyphs = p.rows.flat(2).flatMap((row) => row.part.map((z) => z.g)),
          firstInk = Math.min(...p.rows[0].flatMap((row) => row.part.map((z) => z.g.ink[1]))),
          lastInk = Math.max(...p.rows.at(-1).flatMap((row) => row.part.map((z) => z.g.ink[3]))),
          top = r[1] < first[1] && r[3] >= first[1] && r[3] <= firstInk,
          bottom = r[3] > last[3] && r[1] <= last[3] && r[1] >= lastInk
        return (top || bottom) && glyphs.every((g) => r[0] <= g.ink[0] && r[2] >= g.ink[2])
      })
    // Float32 display optimization can move a decorative edge across the
    // exact Float64 contact point. Borrow only its earlier native membership
    // when every whole primitive, color, clip and PDF-coordinate corner has
    // the same Float32 representation and order. Current glyphs and all
    // foreign paint remain independently proved; this asserts no ink contact.
    if (matches.length !== 1 && !boundPaints) return
  }
  const ownIds = new Set(ownPaint.map((p) => p.id)),
    foreignRecords = inv.records.filter((r) => !selected.has(r.index)),
    outsideInk = [
      ...inv.glyphs.filter((g) => !owned.has(g)).map((g) => g.ink),
      ...foreignRecords.map((r) => r.rect),
      ...paths.filter((p) => !ownIds.has(p.id)).map((p) => p.box),
      ...inv.evidence.images.map((i) => i.rect),
      ...options.competingRects,
      ...options.captions.filter((c) => c.page === page.pageNumber).map((c) => c.rect)
    ]
  if (!outsideInk.every((r) => finite(r, 4) && intersection(r, rect) === 0)) return
  return {
    id: candidate.id,
    page: candidate.page,
    region: [...candidate.region],
    thumbnail: candidate.thumbnail,
    issue: 'native-diff-code-packet',
    sourceItems: records.map((r) => ({
      pageNumber: page.pageNumber,
      index: r.index,
      text: r.r.str
    })),
    diffCodeProof: {
      rect,
      bounds: { width: page.width, height: page.height },
      outsideInk,
      packetSources: packets.map((p) => p.rows.flat().map((r) => r.index)),
      ownedPaintIndices: [...ownIds],
      ownedPaintSignatures:
        ownPaint.every((p) => p.background.captureIsPdfCoordinates) || !capturedGraphics
          ? paintSignatures
          : undefined
    }
  }
}

export function proveNativeDiffCodeFigure(page, candidate, context, options, fontFacts) {
  try {
    const native = prove(page, candidate, context, options, fontFacts),
      current = options?.current,
      same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
    if (
      !native ||
      !current ||
      current.pageNumber !== context.pageNumber ||
      current.sourceSha256 !== context.sourceSha256 ||
      !Array.isArray(current.content?.items) ||
      current.content.items.length !== context.content.items.length ||
      ['width', 'height', 'scale', 'rotation', 'transform'].some(
        (k) => !same(current.viewport?.[k], context.viewport[k])
      ) ||
      context.skippedSpaceGlyphs?.length
    )
      return
    const forward = new Map(),
      reverse = new Map()
    for (let index = 0; index < context.content.items.length; index++) {
      const a = context.content.items[index],
        b = current.content.items[index],
        facts = fontFacts.filter((f) => f?.fontName === a.fontName)
      if (
        !b ||
        ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => a[k] !== b[k]) ||
        !same(a.transform, b.transform) ||
        !same(a.sourceItem, b.sourceItem) ||
        !context.content.styles?.[a.fontName] ||
        !same(context.content.styles[a.fontName], current.content.styles?.[b.fontName]) ||
        facts.length !== 1 ||
        facts[0].loadedFontName !== b.fontName ||
        (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
        (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
      )
        return
      forward.set(a.fontName, b.fontName)
      reverse.set(b.fontName, a.fontName)
    }
    const currentContext = {
      ...context,
      viewport: current.viewport,
      content: {
        ...current.content,
        items: current.content.items.map((r) => ({ ...r, fontName: reverse.get(r.fontName) })),
        styles: Object.fromEntries(
          [...reverse].map(([loaded, native]) => [native, current.content.styles[loaded]])
        )
      },
      operators: {
        ...current.operators,
        argsArray: current.operators.argsArray.map((a, i) =>
          current.operators.fnArray[i] === OPS.setFont ? [reverse.get(a[0]), ...a.slice(1)] : a
        )
      }
    }
    // The render API may preserve row-fill wrappers omitted by the captured
    // display program. Prove the whole current program independently; its
    // path indices must never borrow the earlier capture's operation owners.
    const rendered = prove(
      page,
      candidate,
      currentContext,
      options,
      fontFacts,
      false,
      native.diffCodeProof.ownedPaintSignatures
    )
    if (
      !rendered ||
      ['id', 'page', 'region', 'thumbnail', 'issue', 'sourceItems'].some(
        (k) => !same(native[k], rendered[k])
      ) ||
      !same(native.diffCodeProof.packetSources, rendered.diffCodeProof.packetSources)
    )
      return
    native.diffCodeProof.outsideInk.push(...rendered.diffCodeProof.outsideInk)
    native.diffCodeProof.currentOwnedPaintIndices = rendered.diffCodeProof.ownedPaintIndices
    return native
  } catch {
    return undefined
  }
}

export function acceptsNativeDiffCodePng(png, figure) {
  const proof = figure?.diffCodeProof,
    raster = getPdfCropRasterProtectionFromPng(png, proof?.rect, proof?.bounds)
  return (
    !!raster &&
    Array.isArray(proof.outsideInk) &&
    proof.outsideInk.every((r) => finite(r, 4) && intersection(r, raster.protection) === 0)
  )
}
