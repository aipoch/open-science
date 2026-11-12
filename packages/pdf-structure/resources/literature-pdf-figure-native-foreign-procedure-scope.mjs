/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { nativeWholeSourceGlyphObservations } from './literature-pdf-symbol-text.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'

const near = (a, b, e) => Math.abs(a - b) <= e,
  compact = (s) => s.replace(/\s/gu, ''),
  valid = (r) =>
    Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3],
  inside = (a, b) => b.every((n, i) => (i < 2 ? n >= a[i] : n <= a[i])),
  exactWhole = (p, advance = false) =>
    p.potentialClipEnvelope === undefined &&
    p.originalClipQuads === undefined &&
    valid(p.paintClip) &&
    valid(p.fullInk) &&
    inside(p.paintClip, p.fullInk) &&
    (!advance || (valid(p.advance) && inside(p.paintClip, p.advance))),
  union = (rs) => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

// An independently printed, closed procedure is foreign to an already proven
// drawing. This supplies only exclusions for the existing anti-panel guard;
// it never selects a drawing, supplies Source, or changes a paint envelope.
export function nativeForeignProcedureScopeExclusions(
  data,
  items,
  picked,
  page,
  figure,
  context,
  originalRect,
  pageCaps
) {
  try {
    const raw = context?.content?.items,
      o = context?.operators,
      v = context?.viewport
    if (
      picked?.kind !== 'complete-native-saved-picture' ||
      picked.excluded ||
      !Array.isArray(raw) ||
      raw.length > 4096 ||
      !Array.isArray(items) ||
      items.length > 65536 ||
      !Array.isArray(data?.pieces) ||
      data.pieces.length > 65536 ||
      page.rotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      v?.rotation !== 0 ||
      v.scale !== 1 ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height]) ||
      figure.caption?.page !== page.pageNumber ||
      !Array.isArray(figure.caption.lines) ||
      !Array.isArray(pageCaps) ||
      pageCaps.length !== 1 ||
      pageCaps[0] !== figure.caption
    )
      return
    if (
      /\b(?:algorithms?|procedures?|pseudocode)\b|(?:^|[\s:])\([a-z]\)/iu.test(
        figure.caption.lines.join(' ')
      )
    )
      return
    const observations = nativeWholeSourceGlyphObservations(context.content, o)
    if (
      !observations ||
      observations.records.length !== raw.length ||
      observations.glyphs.length > 65536
    )
      return
    const records = observations.records
        .filter((r) => r.source.str.trim())
        .map((r) => {
          const t = tableTextToken(r.source, v, 0)
          return { ...r, rect: t.rect, baseline: t.baseline, height: t.height }
        }),
      titles = records.filter((r) =>
        /^Algorithm\s+(?:[A-Z]\.)?\d+:\s*(?:\p{L}.*)?$/u.test(r.source.str)
      ),
      title = titles[0],
      em = title?.height
    if (!title || !(em > 0) || !observations.records.every((r) => r.source === raw[r.index])) return
    const chart = union(picked.own.map((p) => p.bound)),
      caption = records.filter(
        (r) => near(r.baseline, title.baseline, em * 0.02) && r.rect[2] < chart[0] - em * 2
      ),
      last = Math.max(...caption.map((r) => r.index)),
      prefix = records.filter((r) => r.index <= last),
      body = prefix.filter((r) => !caption.includes(r)),
      box = union(prefix.map((r) => r.rect)),
      font = title.source.fontName
    if (
      caption[0] !== title ||
      caption.filter((r) => titles.includes(r)).length !== 1 ||
      !/\p{L}/u.test(
        caption
          .map((r) => r.source.str)
          .join(' ')
          .replace(/^Algorithm\s+(?:[A-Z]\.)?\d+:\s*/u, '')
      ) ||
      box[2] > chart[0] - em * 2 ||
      !hit(box, originalRect) ||
      prefix.some(
        (r) =>
          !r.glyphs.length ||
          !r.rect.every(Number.isFinite) ||
          r.source.transform[1] !== 0 ||
          r.source.transform[2] !== 0 ||
          r.rect[0] < 0 ||
          r.rect[1] < 0 ||
          r.rect[2] > page.width ||
          r.rect[3] > page.height ||
          r.height < em * 0.6 ||
          r.height > em * 1.02 ||
          r.rect[2] <= r.rect[0]
      ) ||
      body.length < 16 ||
      title.baseline <= Math.max(...body.map((r) => r.baseline))
    )
      return
    if (
      prefix.some(
        ({ source: s, glyphs: gs, height }) =>
          !near(gs[0].start[0], s.transform[4], 0.02) ||
          !near(gs.at(-1).end[0], s.transform[4] + s.width, 0.02) ||
          gs.some(
            (g) =>
              g.fontName !== s.fontName ||
              g.hScale !== 1 ||
              !near(g.size, height, 0.02) ||
              !near(g.start[1], s.transform[5], 0.02) ||
              !near(g.end[1], s.transform[5], 0.02)
          )
      )
    )
      return
    const rows = []
    for (const r of body.filter((r) => r.height >= em * 0.9)) {
      let row = rows.find((q) => near(q.baseline, r.baseline, em * 0.02))
      if (!row) rows.push((row = { baseline: r.baseline, records: [] }))
      row.records.push(r)
    }
    rows.sort((a, b) => a.baseline - b.baseline)
    for (const row of rows) {
      row.records.sort((a, b) => a.rect[0] - b.rect[0])
      row.text = row.records.map((r) => r.source.str).join(' ')
      row.first = row.records[0]
      row.x = row.first.rect[0]
    }
    const input = rows[0],
      output = rows[1],
      numbers = body.filter(
        (r) =>
          /^\d+$/u.test(r.source.str) &&
          r.height >= em * 0.65 &&
          r.height <= em * 0.75 &&
          r.source.fontName === font &&
          r.rect[2] < input?.x
      ),
      steps = numbers.map((number) => ({
        number,
        row: rows.find((r) => near(r.baseline, number.baseline, em * 0.02))
      }))
    if (
      !input ||
      !output ||
      !/^Input\s*:\s*\S/u.test(input.text) ||
      !/^Output\s*:\s*\S/u.test(output.text) ||
      input.first.source.fontName !== font ||
      output.first.source.fontName !== font ||
      !near(input.x, output.x, em * 0.02) ||
      steps.length < 8 ||
      steps.length > 32 ||
      steps.some(
        (s, i) =>
          !s.row ||
          Number(s.number.source.str) !== i + 1 ||
          !near(s.number.rect[2], numbers[0].rect[2], em * 0.06) ||
          s.row.baseline <= output.baseline ||
          (i &&
            (s.row.baseline - steps[i - 1].row.baseline < em ||
              s.row.baseline - steps[i - 1].row.baseline > em * 2.8))
      )
    )
      return
    const loops = steps.filter((s) => /^(?:for|while)\b.+\bdo$/u.test(s.row.text)),
      ends = steps.filter((s) => /^end$/u.test(s.row.text)),
      functions = steps.filter((s) =>
        /^Function\s+\p{L}[\p{L}\d_]*\s*\([^()]+\)\s*:\s*$/u.test(s.row.text)
      ),
      loop = loops[0],
      close = ends[0],
      fn = functions[0],
      final = steps.at(-1)
    if (
      loops.length !== 1 ||
      ends.length !== 1 ||
      functions.length !== 1 ||
      ![loop, close, fn, final].every((s) => s.row.first.source.fontName === font) ||
      !/^return\s+\S/u.test(final.row.text) ||
      loop.number.index >= close.number.index ||
      close.number.index >= fn.number.index ||
      fn.number.index >= final.number.index ||
      !near(loop.row.x, input.x, em * 0.02) ||
      !near(close.row.x, input.x, em * 0.02) ||
      !near(fn.row.x, input.x, em * 0.02) ||
      title.rect[1] - final.row.baseline < em * 0.3 ||
      title.rect[1] - final.row.baseline > em * 2 ||
      Math.abs(
        (union(caption.map((r) => r.rect))[0] + union(caption.map((r) => r.rect))[2]) / 2 -
          (box[0] + box[2]) / 2
      ) >
        (box[2] - box[0]) * 0.2
    )
      return
    const loopBody = rows.filter(
        (r) => r.baseline > loop.row.baseline && r.baseline < close.row.baseline
      ),
      functionBody = rows.filter((r) => r.baseline > fn.row.baseline)
    if (
      !loopBody.length ||
      !functionBody.length ||
      [...loopBody, ...functionBody].some((r) => r.x < input.x + em * 1.3) ||
      rows.some(
        (r) =>
          r !== input &&
          r !== output &&
          !steps.some((s) => s.row === r) &&
          !loopBody.includes(r) &&
          !functionBody.includes(r)
      )
    )
      return
    const operations = new Set(prefix.flatMap((r) => r.glyphs.map((g) => g.operationIndex))),
      other = observations.records.filter(
        (r) => r.source.str.trim() && !prefix.some((p) => p.index === r.index)
      )
    if (other.some((r) => r.glyphs.some((g) => operations.has(g.operationIndex)))) return
    const excluded = items.filter((p) => p.kind === 'glyph' && operations.has(p.operationIndex)),
      original = observations.glyphs.filter(
        (g) => operations.has(g.operationIndex) && g.glyph.unicode.trim()
      ),
      painted = data.pieces.filter(
        (p) => p.kind === 'glyph' && operations.has(p.operationIndex) && p.text.trim()
      )
    // Literal completeness does not establish a visible procedure. A local
    // clip may hide its I/O or closure while leaving the original glyph stream
    // intact. Potential envelopes never supply this positive witness.
    if (
      painted.length !== excluded.filter((p) => p.text.trim()).length ||
      painted.some((p) => !exactWhole(p, true))
    )
      return
    if (
      !excluded.length ||
      original.length !== painted.length ||
      original.some((g, i) => {
        const p = painted[i]
        return (
          g.operationIndex !== p.operationIndex ||
          g.fontName !== p.fontName ||
          g.glyph.unicode !== p.text ||
          JSON.stringify(g.transform) !== '[1,0,0,1,0,0]' ||
          p.fillAlpha !== 1 ||
          p.fillColor !== '#000000'
        )
      })
    )
      return
    const capGlyphs = records.filter(
      (r) =>
        r.rect[0] >= figure.caption.rect[0] - 0.02 &&
        r.rect[2] <= figure.caption.rect[2] + 0.02 &&
        r.rect[1] >= figure.caption.rect[1] - 0.02 &&
        r.rect[3] <= figure.caption.rect[3] + 0.02
    )
    if (
      compact(capGlyphs.map((r) => r.source.str).join('')) !==
      compact(figure.caption.lines.join(''))
    )
      return
    const end = Math.max(...operations),
      paths = items.filter((p) => p.kind === 'path' && p.operationIndex < end),
      rails = [loopBody, functionBody].map((bodyRows, i) => {
        const opening = i ? fn.row : loop.row,
          first = bodyRows[0],
          last = bodyRows.at(-1)
        return paths.filter((p) => {
          const points = p.visiblePaintPoints
          if (
            points?.length !== 2 ||
            points.some((q) => !Array.isArray(q) || q.length !== 2 || !q.every(Number.isFinite)) ||
            !near(points[0][0], points[1][0], 1e-7) ||
            o.argsArray[p.operationIndex]?.[0] !== OPS.stroke
          )
            return false
          const x = points[0][0],
            top = Math.min(points[0][1], points[1][1]),
            bottom = Math.max(points[0][1], points[1][1])
          return (
            x > opening.x + em * 0.4 &&
            x < first.x - em * 0.4 &&
            top > opening.baseline + em * 0.1 &&
            top < first.baseline - em * 0.2 &&
            bottom > last.baseline + em * 0.1 &&
            bottom < last.baseline + em * 0.6
          )
        })
      })
    if (
      paths.length !== 2 ||
      paths.some((p) => !exactWhole(p)) ||
      rails.some((r) => r.length !== 1) ||
      rails[0][0] === rails[1][0]
    )
      return
    let stroke = '#000000'
    const stack = []
    for (let i = 0; i <= end; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) stack.push(stroke)
      else if (op === OPS.restore) {
        if (!stack.length) return
        stroke = stack.pop()
      } else if (op === OPS.setStrokeRGBColor) stroke = a?.[0]
      else if (
        op === OPS.setGState ||
        op === OPS.paintFormXObjectBegin ||
        op === OPS.beginGroup ||
        op === OPS.beginMarkedContentProps
      )
        return
      else if (paths.some((p) => p.operationIndex === i) && stroke !== '#000000') return
    }
    if (stack.length) return
    return [...excluded, ...paths]
  } catch {
    return
  }
}

// A separately framed, numbered procedure above a complete drawing can prove
// that its closing rule is foreign to the existing crop. This pixel-only
// relation preserves every chart member and its other three crop boundaries;
// it neither parses an algorithm owner nor supplies Source.
const framedAdvanceRect = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[0] <= r[2] && r[1] <= r[3]
const framedWhole = (p, advance = false) =>
  p.potentialClipEnvelope === undefined &&
  p.originalClipQuads === undefined &&
  valid(p.paintClip) &&
  valid(p.fullInk) &&
  inside(p.paintClip, p.fullInk) &&
  (!advance || (framedAdvanceRect(p.advance) && inside(p.paintClip, p.advance)))
export function nativeFramedForeignProcedureTopCrop(
  data,
  items,
  picked,
  page,
  figure,
  context,
  oldRect,
  captions
) {
  try {
    const raw = context?.content?.items,
      o = context?.operators,
      v = context?.viewport,
      minScale = 1.5
    if (
      picked?.kind !== 'complete-native-saved-picture' ||
      (picked.excluded !== undefined &&
        (!Array.isArray(picked.excluded) || !picked.excluded.length)) ||
      !Array.isArray(raw) ||
      raw.length > 4096 ||
      !Array.isArray(items) ||
      items.length > 65536 ||
      !Array.isArray(data?.pieces) ||
      data.pieces.length > 65536 ||
      page.rotation !== 0 ||
      page.invalidGraphicsBounds !== 0 ||
      v?.rotation !== 0 ||
      v.scale !== 1 ||
      JSON.stringify(v.transform) !== JSON.stringify([1, 0, 0, -1, 0, page.height]) ||
      captions.length !== 1 ||
      captions[0] !== figure.caption ||
      !valid(oldRect) ||
      !valid(figure.caption?.rect)
    )
      return
    if (!raw.some((r) => /^Procedure\s+(?:[A-Z]\.)?\d+$/u.test(r.str ?? ''))) return
    if (
      /\b(?:algorithms?|procedures?|pseudocode)\b|(?:^|[\s:])\([a-z]\)/iu.test(
        figure.caption.lines.join(' ')
      )
    )
      return
    const obs = nativeWholeSourceGlyphObservations(context.content, o)
    if (
      !obs ||
      obs.records.length !== raw.length ||
      obs.glyphs.length > 65536 ||
      !obs.records.every((r) => r.source === raw[r.index])
    )
      return
    const original = obs.glyphs.filter((g) => g.glyph.unicode.trim()),
      painted = data.pieces.filter((p) => p.kind === 'glyph' && p.text.trim())
    if (
      original.length !== painted.length ||
      original.some(
        (g, i) =>
          g.operationIndex !== painted[i].operationIndex ||
          g.fontName !== painted[i].fontName ||
          g.glyph.unicode !== painted[i].text
      )
    )
      return
    const pieceByGlyph = new Map(original.map((g, i) => [g, painted[i]])),
      itemBySerial = new Map(items.map((p) => [p.serial, p])),
      itemByPiece = new Map(data.pieces.map((p, i) => [p, itemBySerial.get(i)])),
      records = obs.records
        .filter((r) => r.source.str.trim())
        .map((r) => {
          const t = tableTextToken(r.source, v, 0),
            pieces = r.glyphs.filter((g) => g.glyph.unicode.trim()).map((g) => pieceByGlyph.get(g))
          return { ...r, rect: t.rect, baseline: t.baseline, height: t.height, pieces }
        })
    if (records.some((r) => !r.pieces.length || r.pieces.some((p) => !p))) return
    const titles = records.filter((r) => /^Procedure\s+(?:[A-Z]\.)?\d+$/u.test(r.source.str)),
      title = titles[0]
    if (titles.length !== 1 || !(title.height > 0)) return
    const em = title.height,
      own = new Set(picked.own),
      ownBounds = union(picked.own.map((p) => p.bound))
    const horizontal = items.filter((p) => {
      const a = o.argsArray[p.operationIndex],
        q = p.visiblePaintPoints,
        path = a?.[1]
      return (
        p.kind === 'path' &&
        a?.[0] === OPS.stroke &&
        path?.length === 1 &&
        ArrayBuffer.isView(path[0]) &&
        path[0].length === 6 &&
        path[0][0] === 0 &&
        path[0][3] === 1 &&
        q?.length === 2 &&
        q.flat().every(Number.isFinite) &&
        near(q[0][1], q[1][1], 1e-7) &&
        q[0][0] < q[1][0] &&
        framedWhole(p)
      )
    })
    const y = (p) => p.visiblePaintPoints[0][1],
      sameWidth = (p) =>
        near(p.visiblePaintPoints[0][0], title.rect[0], 0.02) &&
        near(p.visiblePaintPoints[1][0], ownBounds[2], 0.02)
    const rails = horizontal.filter(
      (p) =>
        sameWidth(p) &&
        y(p) < ownBounds[1] &&
        p.operationIndex < Math.min(...picked.own.map((p) => p.operationIndex))
    )
    if (rails.length !== 3 || rails.some((p, i) => i && y(p) <= y(rails[i - 1]))) return
    const [opening, divider, closing] = rails,
      box = [
        opening.visiblePaintPoints[0][0],
        y(opening),
        opening.visiblePaintPoints[1][0],
        y(closing)
      ]
    if (
      title.baseline <= y(opening) ||
      title.baseline >= y(divider) ||
      y(closing) + 2 / minScale >= ownBounds[1]
    )
      return
    const framedCompact = (s) => s.normalize('NFD').replace(/\s/gu, ''),
      framedExpand = (r, d) => r.map((x, i) => x + (i < 2 ? -d : d))
    let state = { stroke: '#000000', width: 1, cap: 0, dash: [], phase: 0 }
    const stack = []
    for (let i = 0; i <= closing.operationIndex; i++) {
      const op = o.fnArray[i],
        a = o.argsArray[i]
      if (op === OPS.save) stack.push({ ...state })
      else if (op === OPS.restore) {
        if (!stack.length) return
        state = stack.pop()
      } else if (op === OPS.setStrokeRGBColor) state.stroke = a?.[0]
      else if (op === OPS.setLineWidth) state.width = a?.[0]
      else if (op === OPS.setLineCap) state.cap = a?.[0]
      else if (op === OPS.setDash) {
        state.dash = a?.[0]
        state.phase = a?.[1]
      } else if (
        [
          OPS.setGState,
          OPS.paintFormXObjectBegin,
          OPS.beginGroup,
          OPS.beginMarkedContentProps,
          OPS.setStrokeColor,
          OPS.setStrokeColorN,
          OPS.setStrokeGray,
          OPS.setStrokeCMYKColor,
          OPS.setStrokeColorSpace
        ].includes(op)
      )
        return
      else if (rails.some((p) => p.operationIndex === i)) {
        if (
          state.stroke !== '#000000' ||
          !Number.isFinite(state.width) ||
          state.width <= 0 ||
          state.width > em * 0.2 ||
          state.cap !== 0 ||
          !Array.isArray(state.dash) ||
          state.dash.length ||
          state.phase !== 0
        )
          return
      }
    }
    // The horizontal rules are an ownership frame, not clips. Original italic
    // ink may overhang an advance endpoint. Never infer visibility from the frame.
    const blockRecords = records.filter(
        (r) =>
          r.baseline > box[1] &&
          r.baseline < box[3] &&
          r.rect[0] >= box[0] - 0.02 &&
          r.rect[2] <= box[2] + 0.02
      ),
      blockPieces = blockRecords.flatMap((r) => r.pieces),
      type3Fonts = new Set(
        [...(context.type3GlyphPrograms ?? []), ...(context.pixelType3Programs ?? [])].map(
          (f) => f.fontName
        )
      )
    if (
      !blockRecords.includes(title) ||
      blockRecords.some(
        (r) =>
          type3Fonts.has(r.source.fontName) ||
          r.pieces.some(
            (p) =>
              !framedWhole(p, true) ||
              p.fullInk[1] < box[1] ||
              p.fullInk[3] > box[3] ||
              p.fillAlpha !== 1 ||
              !/^#[a-f0-9]{6}$/iu.test(p.fillColor ?? '') ||
              /^#ffffff$/iu.test(p.fillColor)
          )
      ) ||
      blockPieces.some((p) => own.has(itemByPiece.get(p)))
    )
      return
    for (const r of blockRecords) {
      const s = r.source,
        gs = r.glyphs
      if (
        s.transform[1] !== 0 ||
        s.transform[2] !== 0 ||
        s.width < 0 ||
        !near(gs[0].start[0], s.transform[4], 0.02) ||
        !near(gs.at(-1).end[0], s.transform[4] + s.width, 0.02) ||
        gs.some(
          (g) =>
            g.fontName !== s.fontName ||
            g.hScale !== 1 ||
            !near(g.size, r.height, 0.02) ||
            !near(g.start[1], s.transform[5], 0.02) ||
            !near(g.end[1], s.transform[5], 0.02) ||
            JSON.stringify(g.transform) !== '[1,0,0,1,0,0]'
        )
      )
        return
    }
    const titleRecords = blockRecords.filter((r) => r.baseline < y(divider)),
      body = blockRecords.filter((r) => r.baseline > y(divider)),
      ordinals = body.filter((r) => /^\d+:$/u.test(r.source.str))
    if (
      titleRecords[0] !== title ||
      titleRecords.some((r) => r.baseline <= y(opening) || r.baseline >= y(divider)) ||
      titleRecords.length < 2 ||
      !titleRecords.slice(1).some((r) => /\p{L}/u.test(r.source.str)) ||
      blockRecords.length !== titleRecords.length + body.length ||
      ordinals.length < 4 ||
      ordinals.length > 32 ||
      ordinals.some(
        (r, i) =>
          Number(r.source.str.slice(0, -1)) !== i + 1 ||
          r.source.fontName !== ordinals[0].source.fontName ||
          !near(r.height, ordinals[0].height, 0.02) ||
          r.rect[2] - r.rect[0] > em * 1.5 ||
          (i &&
            (r.baseline - ordinals[i - 1].baseline < em * 0.9 ||
              r.baseline - ordinals[i - 1].baseline > em * 2.8))
      )
    )
      return
    const rows = ordinals.map((n, i) => ({
      number: n,
      records: body.filter(
        (r) => r.index >= n.index && (i === ordinals.length - 1 || r.index < ordinals[i + 1].index)
      )
    }))
    if (
      rows.reduce((n, r) => n + r.records.length, 0) !== body.length ||
      rows.some(
        (r, i) =>
          r.records[0] !== r.number ||
          r.records.length < 2 ||
          r.records
            .slice(1)
            .some(
              (s) =>
                s.rect[0] <= r.number.rect[2] ||
                s.baseline < r.number.baseline - em * 0.6 ||
                (i < rows.length - 1 && s.baseline >= rows[i + 1].number.baseline - em * 0.3)
            )
      ) ||
      !/^procedure\s+\p{L}[\s\S]*\(/iu.test(
        rows[0].records
          .slice(1)
          .map((r) => r.source.str)
          .join(' ')
      ) ||
      !/^return\s+\S/iu.test(
        rows
          .at(-1)
          .records.slice(1)
          .map((r) => r.source.str)
          .join(' ')
      )
    )
      return
    const allowedBlock = new Set([...blockPieces.map((p) => itemByPiece.get(p)), ...rails]),
      blockEnvelope = union([
        ...blockPieces.map((p) => p.fullInk),
        ...blockPieces.map((p) => p.advance),
        ...rails.map((p) => p.fullInk)
      ])
    if (
      allowedBlock.has(undefined) ||
      items.some((p) => !allowedBlock.has(p) && hit(blockEnvelope, p.bound))
    )
      return
    const operationSet = new Set(blockPieces.map((p) => p.operationIndex))
    if (
      records.some(
        (r) => !blockRecords.includes(r) && r.glyphs.some((g) => operationSet.has(g.operationIndex))
      )
    )
      return
    const cap = records.filter(
      (r) =>
        r.rect[0] >= figure.caption.rect[0] - 0.02 &&
        r.rect[2] <= figure.caption.rect[2] + 0.02 &&
        r.rect[1] >= figure.caption.rect[1] - 0.02 &&
        r.rect[3] <= figure.caption.rect[3] + 0.02
    )
    if (
      framedCompact(cap.map((r) => r.source.str).join('')) !==
        framedCompact(figure.caption.lines.join('')) ||
      cap.some((r) => r.pieces.some((p) => !framedWhole(p, true)))
    )
      return
    const previous = picked.excluded ?? [],
      captionPieces = cap.flatMap((r) => r.pieces.map((p) => itemByPiece.get(p)))
    // A previous adapter may already exclude this same complete caption. Keep
    // its original members and order; no other prior exclusion is admitted.
    if (
      picked.excluded !== undefined &&
      (previous.length !== captionPieces.length ||
        new Set(previous).size !== previous.length ||
        previous.some(
          (p) => !captionPieces.includes(p) || hit(blockEnvelope, p.bound) || hit(oldRect, p.bound)
        ))
    )
      return
    const foreign = items.filter((p) => !own.has(p)),
      oldForeign = foreign.filter((p) => hit(oldRect, p.bound))
    if (
      oldForeign.length !== 1 ||
      oldForeign[0] !== closing ||
      blockPieces.some((p) => hit(oldRect, p.fullInk)) ||
      oldRect[1] <= y(divider)
    )
      return
    const rect = [oldRect[0], ownBounds[1] - 2 / minScale, oldRect[2], oldRect[3]]
    if (
      !valid(rect) ||
      rect[1] <= oldRect[1] ||
      rect[1] <= closing.bound[3] + 2 / minScale ||
      !inside([0, 0, page.width, page.height], rect) ||
      picked.own.some((p) => !inside(rect, p.bound)) ||
      foreign.some((p) => hit(rect, framedExpand(p.bound, 2 / minScale))) ||
      hit(rect, figure.caption.rect) ||
      previous.some((p) => hit(rect, p.bound))
    )
      return
    return { rect, excluded: [...previous, closing] }
  } catch {
    return
  }
}
