/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { findAlgorithmCandidates } from './literature-pdf-numbered-native-procedure.mjs'
import { groupPageLines } from './literature-pdf-caption-group.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { collectTableRules, collectClosedFigureFrames } from './literature-pdf-graphics.mjs'
import { nativePageTextPacketInventory } from './literature-pdf-figure-native-plot-labels.mjs'
import { completeNativeNodeGlyphState } from './literature-pdf-figure-native-plot-bands.mjs'
import { tableTextToken } from './literature-pdf-orientation.mjs'
import { getPdfCropRasterProtectionFromPng } from './literature-pdf-crop.mjs'

const valid = (r) =>
  Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > r[0] && r[3] > r[1]
const inside = (a, b) => b.every((v, i) => (i < 2 ? v >= a[i] - 1e-6 : v <= a[i] + 1e-6))
const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
const box = (l) => [l.x, l.y, l.right ?? l.x + l.width, l.bottom ?? l.y + l.height]
const union = (boxes) => [
  Math.min(...boxes.map((r) => r[0])),
  Math.min(...boxes.map((r) => r[1])),
  Math.max(...boxes.map((r) => r[2])),
  Math.max(...boxes.map((r) => r[3]))
]
const titlePattern = /^Algorithm\s+(?:[A-Z]\.?)?\d+\b/i

// Optional crop-only completion. A whole native item must match one unspaced
// renderer glyph run; Unicode is compared literally, never reconstructed.
function nativeRightInk(page, context, body, rect, captionRect, inventory) {
  const p = context.nativeGlyphContext,
    raw = p?.content?.items,
    current = context.content?.items,
    o = p?.operators,
    bounds = p?.glyphBounds ?? p?.partialFontGlyphBounds,
    equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  if (
    ![raw, current, bounds, o?.fnArray, o?.argsArray].every(Array.isArray) ||
    raw.length !== current.length ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    p.viewport?.scale !== 1 ||
    p.viewport.rotation !== 0 ||
    p.viewport.width !== page.width ||
    p.viewport.height !== page.height ||
    !equal(p.viewport.transform, [1, 0, 0, -1, 0, page.height])
  )
    return
  const forward = new Map(),
    reverse = new Map()
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i],
      b = current[i]
    if (
      ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => a[k] !== b[k]) ||
      !equal(a.transform, b.transform) ||
      !p.content.styles?.[a.fontName] ||
      !equal(p.content.styles[a.fontName], context.content.styles?.[b.fontName]) ||
      (forward.has(a.fontName) && forward.get(a.fontName) !== b.fontName) ||
      (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
    )
      return
    forward.set(a.fontName, b.fontName)
    reverse.set(b.fontName, a.fontName)
  }
  const fonts = new Map()
  for (const f of bounds) {
    if (typeof f?.fontName !== 'string' || fonts.has(f.fontName) || !Array.isArray(f.glyphs)) return
    const glyphs = new Map()
    for (const g of f.glyphs) {
      if (
        typeof g?.fontChar !== 'string' ||
        !g.fontChar ||
        glyphs.has(g.fontChar) ||
        !Array.isArray(g.bounds) ||
        g.bounds.length !== 4 ||
        !g.bounds.every(Number.isFinite) ||
        g.bounds[0] > g.bounds[2] ||
        g.bounds[1] > g.bounds[3]
      )
        return
      glyphs.set(g.fontChar, g.bounds)
    }
    fonts.set(f.fontName, glyphs)
  }
  let state = {
      font: undefined,
      size: 0,
      char: 0,
      word: 0,
      scale: 100,
      rise: 0,
      mode: 0,
      unsafe: false
    },
    annotation = 0
  const stack = [],
    runs = new Map()
  for (let i = 0; i < o.fnArray.length; i++) {
    const op = o.fnArray[i],
      a = o.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ ...state })
    else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      if (!stack.length) return
      state = stack.pop()
    } else if (op === OPS.setFont) {
      state.font = a?.[0]
      state.size = a?.[1]
    } else if (op === OPS.setCharSpacing) state.char = a?.[0]
    else if (op === OPS.setWordSpacing) state.word = a?.[0]
    else if (op === OPS.setHScale) state.scale = a?.[0]
    else if (op === OPS.setTextRise) state.rise = a?.[0]
    else if (op === OPS.setTextRenderingMode) state.mode = a?.[0]
    else if (op === OPS.setGState) state.unsafe = true
    else if (op === OPS.beginAnnotation || op === OPS.beginGroup) annotation++
    else if (op === OPS.endAnnotation || op === OPS.endGroup) {
      if (!annotation) return
      annotation--
    } else if (op === OPS.showText) {
      const glyphs = a?.[0]
      if (!Array.isArray(glyphs) || typeof state.font !== 'string') return
      const text = glyphs
          .filter((g) => typeof g === 'object' && g)
          .map((g) => g.unicode)
          .join(''),
        key = state.font + '\0' + text,
        candidates = runs.get(key) ?? []
      const safe =
        !annotation &&
        !state.unsafe &&
        state.char === 0 &&
        state.word === 0 &&
        state.scale === 100 &&
        state.rise === 0 &&
        state.mode === 0 &&
        Number.isFinite(state.size) &&
        state.size > 0 &&
        glyphs.length &&
        glyphs.every(
          (g) =>
            g &&
            typeof g === 'object' &&
            typeof g.unicode === 'string' &&
            g.unicode.length &&
            typeof g.fontChar === 'string' &&
            g.fontChar.length &&
            g.isInFont === true &&
            !g.accent &&
            Number.isFinite(g.width) &&
            g.width > 0
        )
      candidates.push(safe ? { size: state.size, glyphs } : undefined)
      runs.set(key, candidates)
    }
  }
  if (stack.length || annotation) return
  let right = rect[2]
  for (const item of body) {
    const original = raw[item.sourceItem.index],
      font = original.fontName,
      candidates = runs.get(font + '\0' + original.str),
      fontBounds = fonts.get(font)
    if (!candidates?.length || !fontBounds || candidates.some((c) => !c)) continue
    const signatures = new Set(candidates.map((c) => JSON.stringify(c)))
    if (signatures.size !== 1) continue
    const run = candidates[0],
      h = original.height
    if (
      Math.abs(run.size - h) > 1e-6 ||
      Math.abs(run.glyphs.reduce((sum, g) => sum + (g.width * h) / 1000, 0) - original.width) > 1e-6
    )
      continue
    let advance = 0,
      inkRight = 0,
      complete = true
    for (const g of run.glyphs) {
      const b = fontBounds.get(g.fontChar)
      if (!b) {
        complete = false
        break
      }
      const ink = [
        original.transform[4] + advance + b[0] * h,
        item.baseline - b[3] * h,
        original.transform[4] + advance + b[2] * h,
        item.baseline - b[1] * h
      ]
      if (!ink.every(Number.isFinite) || overlap(ink, captionRect)) {
        complete = false
        break
      }
      inkRight = Math.max(inkRight, ink[2])
      advance += (g.width * h) / 1000
    }
    if (complete) right = Math.max(right, inkRight)
  }
  if (right <= rect[2] || right > page.width) return
  const extended = [rect[0], rect[1], right, rect[3]],
    owned = new Set(body)
  if (
    page.graphicsBounds.some((g) => {
      const paint = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      return overlap(paint, extended) && !overlap(paint, rect)
    })
  )
    return
  if (
    inventory.some(
      (t) =>
        !owned.has(t) &&
        !inside(captionRect, t.labelRect) &&
        (overlap(t.rect, extended) || overlap(t.labelRect, extended))
    )
  )
    return
  return extended
}

function nativeInventory(page, context) {
  const { content, viewport: v } = context
  if (
    !Array.isArray(content?.items) ||
    !content.styles ||
    v?.scale !== 1 ||
    v.rotation !== 0 ||
    v.width !== page.width ||
    v.height !== page.height ||
    !Array.isArray(v.transform) ||
    v.transform.some((x, i) => x !== [1, 0, 0, -1, 0, page.height][i])
  )
    return
  return content.items.flatMap((item, index) => {
    if (typeof item?.str !== 'string' || !item.str.trim()) return []
    const t = item.transform,
      style = content.styles[item.fontName]
    if (!Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite)) return [{ invalid: true }]
    const baseline = page.height - t[5],
      h = item.height
    const rect = [t[4], baseline - h, t[4] + item.width, baseline]
    const ascent = style?.ascent
    const labelRect = [t[4], baseline - ascent * h, t[4] + item.width, baseline + (1 - ascent) * h]
    return [
      {
        text: item.str,
        sourceItem: item.sourceItem,
        ...(item.sourceSegment ? { sourceSegment: item.sourceSegment } : {}),
        ...(item.sourceToken ? { sourceToken: item.sourceToken } : {}),
        rect,
        labelRect,
        baseline,
        height: h,
        horizontal: item.dir === 'ltr' && t[1] === 0 && t[2] === 0 && t[0] > 0 && t[3] > 0,
        valid:
          valid(rect) &&
          valid(labelRect) &&
          Number.isFinite(ascent) &&
          ascent > 0 &&
          ascent <= 1 &&
          !style.vertical &&
          // PDF horizontal text scaling changes t[0], not the measured native
          // width or vertical em box. Rotation/shear and reflected text stay out.
          t[0] > 0 &&
          t[1] === 0 &&
          t[2] === 0 &&
          Math.abs(t[3] - h) < 1e-6 &&
          !['sourceSegment', 'sourceSegments', 'sourceToken', 'sourceTokens', 'sourceItems'].some(
            (k) => k in item
          ) &&
          item.sourceItem?.pageNumber === page.pageNumber &&
          item.sourceItem.index === index &&
          item.sourceItem.text === item.str
      }
    ]
  })
}

// Optional crop completion uses the native stroke envelope, not a fixed margin.
// Unsupported Form/group state and any new foreign content keep the old crop.
function nativeClosingFrameInk(page, context, rect, inventory, captionTokens, body) {
  const o = context.operators
  if (
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    !Array.isArray(context.rules) ||
    context.rules.length > 4096 ||
    context.rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) ||
    page.invalidGraphicsBounds ||
    o.fnArray.some((op) =>
      [
        OPS.paintFormXObjectBegin,
        OPS.paintFormXObjectEnd,
        OPS.beginGroup,
        OPS.endGroup,
        OPS.beginAnnotation,
        OPS.endAnnotation
      ].includes(op)
    )
  )
    return
  let depth = 0
  for (const op of o.fnArray) {
    if (op === OPS.save) depth++
    else if (op === OPS.restore && --depth < 0) return
  }
  if (depth) return
  const paint = new Map(),
    rules = collectTableRules(o, context.viewport, paint),
    equal = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6),
    frame = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          Math.abs(r[0] - rect[0]) < 1e-6 &&
          Math.abs(r[2] - rect[2]) < 1e-6 &&
          r[1] >= rect[1] &&
          r[1] <= rect[3]
      )
      .sort((a, b) => a[1] - b[1])
  if (
    frame.length !== 3 ||
    frame[0][1] >= frame[1][1] ||
    frame[1][1] >= frame[2][1] ||
    Math.abs(frame[2][1] - rect[3]) > 1e-6 ||
    frame.some(
      (r) => context.rules.filter((c) => equal(r, c)).length !== 1 || !paint.has(r.join(','))
    )
  )
    return
  const lower = paint.get(frame[2].join(','))
  if (
    !valid(lower) ||
    lower[3] <= rect[3] ||
    lower[0] < rect[0] ||
    lower[2] > rect[2] ||
    !inside([0, 0, page.width, page.height], lower)
  )
    return
  const owners = page.graphicsBounds.filter((g) => {
    if (
      g.kind !== 'path' ||
      !Number.isInteger(g.operationIndex) ||
      o.fnArray[g.operationIndex] !== OPS.constructPath
    )
      return false
    const bounds = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
    return inside(bounds, frame[2])
  })
  if (owners.length !== 1) return
  const operation = o.argsArray[owners[0].operationIndex],
    path = operation?.[1]?.[0]
  if (
    operation?.[0] !== OPS.stroke ||
    operation[1]?.length !== 1 ||
    !(Array.isArray(path) || ArrayBuffer.isView(path)) ||
    path.length !== 6 ||
    path[0] !== 0 ||
    path[3] !== 1 ||
    !Array.from(path).every(Number.isFinite)
  )
    return
  const without = { fnArray: [...o.fnArray], argsArray: [...o.argsArray] }
  without.fnArray[owners[0].operationIndex] = OPS.dependency
  without.argsArray[owners[0].operationIndex] = []
  const remaining = collectTableRules(without, context.viewport)
  if (
    remaining.length !== rules.length - 1 ||
    JSON.stringify(remaining) !== JSON.stringify(rules.filter((r) => !equal(r, frame[2])))
  )
    return
  const extended = [rect[0], rect[1], rect[2], lower[3]],
    added = [rect[0], rect[3], rect[2], lower[3]],
    owned = new Set([...captionTokens, ...body])
  if (
    inventory.some(
      (t) => !owned.has(t) && (overlap(t.rect, extended) || overlap(t.labelRect, extended))
    ) ||
    page.graphicsBounds.some((g) => {
      if (g === owners[0]) return false
      const bounds = g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width))
      return overlap(bounds, added)
    })
  )
    return
  return extended
}

// A detected image alone never proves ownership of native body text.
export function proveNativeAlgorithmBody(page, candidate, context) {
  const inventory = nativeInventory(page, context)
  if (
    !inventory ||
    inventory.some((t) => t.invalid) ||
    !valid(candidate?.rect) ||
    !valid(candidate.caption?.rect)
  )
    return
  const caption = candidate.caption,
    captionTokens = inventory.filter((t) => inside(caption.rect, t.rect))
  if (
    !captionTokens.length ||
    captionTokens.some((t) => !t.valid || !inside(caption.rect, t.rect)) ||
    captionTokens
      .map((t) => t.text)
      .join('')
      .replace(/\s/gu, '') !== caption.lines.join('').replace(/\s/gu, '')
  )
    return
  const captionRect = union(captionTokens.map((t) => t.labelRect))
  const captionSet = new Set(captionTokens)
  const body = inventory.filter((t) => !captionSet.has(t) && overlap(t.rect, candidate.rect))
  if (
    !body.length ||
    body.some(
      (t) =>
        !t.valid ||
        !t.horizontal ||
        !inside(candidate.rect, t.rect) ||
        overlap(t.labelRect, captionRect)
    ) ||
    !proveNativeUniqueWholeFonts([...captionTokens, ...body], inventory)
  )
    return
  // Confirm that the geometry inventory did not lose a native run before this
  // proof. Reading order may differ for scripts; original characters must not.
  const characters = (strings) => [...strings.join('').replace(/\s/gu, '')].sort().join('')
  const bodyLines = page.lines.filter(
    (line) => overlap(box(line), candidate.rect) && !inside(caption.rect, box(line))
  )
  if (
    bodyLines.some((l) => /^(?:Figure|Fig\.|Table|Algorithm)\s+\d+\b/i.test(l.text)) ||
    page.graphicsBounds.some(
      (g) =>
        g.kind !== 'path' &&
        overlap(
          g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
          candidate.rect
        )
    )
  )
    return
  if (characters(body.map((t) => t.text)) !== characters(bodyLines.map((l) => l.text))) return
  const rect = union([candidate.rect, captionRect, ...body.map((t) => t.labelRect)])
  if (
    !inside([0, 0, page.width, page.height], rect) ||
    inventory.some((t) => !captionSet.has(t) && !body.includes(t) && overlap(t.rect, rect))
  )
    return
  const inkRect = nativeRightInk(page, context, body, rect, captionRect, inventory)
  return {
    ...candidate,
    rect:
      nativeClosingFrameInk(page, context, inkRect ?? rect, inventory, captionTokens, body) ??
      inkRect ??
      rect,
    caption: { ...caption, rect: captionRect },
    nativeBody: {
      kind: 'algorithm',
      sourceItems: body
        .map(({ sourceItem: { pageNumber, index, text } }) => ({ pageNumber, index, text }))
        .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
    }
  }
}

// A three-step computational routine has no explicit end-for/return. Its
// numbered initialization, computation and update each need their own native
// equation packet inside the same three-rule frame; prose lists stay out.
function framedSteps(page, title, titles, rules, context) {
  const inventory = nativeInventory(page, context),
    operators = context.operators,
    h = title.fontSize
  if (
    !inventory ||
    inventory.length > 16384 ||
    rules.length > 4096 ||
    inventory.some((t) => t.invalid) ||
    !Array.isArray(operators?.fnArray) ||
    !Array.isArray(operators.argsArray) ||
    operators.fnArray.length !== operators.argsArray.length ||
    operators.fnArray.length > 100000
  )
    return []
  const nativeRules = collectTableRules(operators, context.viewport),
    matches = [],
    horizontal = rules.filter((r) => r[1] === r[3] && r[2] - r[0] >= page.width * 0.5)
  if (horizontal.length > 64) return []
  for (const top of horizontal) {
    if (Math.abs(top[1] - title.y) > h || title.x < top[0] - 1e-6 || title.right > top[2]) continue
    const aligned = rules
      .filter((r) => r[1] === r[3] && r[0] === top[0] && r[2] === top[2] && r[1] >= top[1])
      .sort((a, b) => a[1] - b[1])
    const nativeAligned = nativeRules
      .filter((r) => r[1] === r[3] && r[0] === top[0] && r[2] === top[2] && r[1] >= top[1])
      .sort((a, b) => a[1] - b[1])
    if (aligned.length !== 3 || JSON.stringify(aligned) !== JSON.stringify(nativeAligned)) continue
    const [, divider, bottom] = aligned,
      rect = [top[0], Math.min(top[1], title.y), top[2], bottom[1]]
    if (
      divider[1] <= title.bottom ||
      divider[1] - title.bottom > h ||
      bottom[1] - divider[1] < h * 5 ||
      titles.some((t) => t !== title && overlap(box(t), rect))
    )
      continue
    const body = inventory.filter((t) => overlap(t.rect, rect) && !inside(box(title), t.rect))
    if (
      !body.length ||
      body.length > 4096 ||
      body.some(
        (t) =>
          !t.valid ||
          !t.horizontal ||
          !inside(rect, t.rect) ||
          t.labelRect[1] <= divider[1] ||
          t.labelRect[3] >= bottom[1]
      )
    )
      continue
    const steps = body
      .filter((t) => /^Step\s+\d+\.(?:\s|$)/u.test(t.text))
      .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
    if (
      steps.length !== 3 ||
      steps.some(
        (t, i) =>
          Number(t.text.match(/^Step\s+(\d+)\./u)[1]) !== i + 1 ||
          Math.abs(t.height - h) > 1e-6 ||
          Math.abs(t.rect[0] - top[0]) > h * 0.1 ||
          (i && t.rect[1] <= steps[i - 1].labelRect[3])
      )
    )
      continue
    const rows = steps.map((step) =>
        body
          .filter(
            (t) => Math.abs(t.baseline - step.baseline) < 1e-6 && Math.abs(t.height - h) < 1e-6
          )
          .sort((a, b) => a.sourceItem.index - b.sourceItem.index)
      ),
      text = rows.map((row) => row.map((t) => t.text.trim()).join(' ')),
      headerItems = new Set(rows.flat())
    if (
      !/^Step\s+1\.\s+Initialize\b/u.test(text[0]) ||
      !/^Step\s+2\.\s+(?:Compute\b|For\b.+\bcompute\b)/u.test(text[1]) ||
      !/^Step\s+3\.\s+Update\b/u.test(text[2]) ||
      body.some(
        (t) => !headerItems.has(t) && /^(?:Step|for|while|if|then|else|end)\b/iu.test(t.text.trim())
      ) ||
      body.some((t) => t.sourceItem.index < steps[0].sourceItem.index)
    )
      continue
    let complete = true
    for (const [i, step] of steps.entries()) {
      const packet = body.filter(
          (t) =>
            t.sourceItem.index >= step.sourceItem.index &&
            (!steps[i + 1] || t.sourceItem.index < steps[i + 1].sourceItem.index)
        ),
        payload = packet.filter((t) => t.baseline > step.baseline + h * 0.5)
      if (
        rows[i][0] !== step ||
        !payload.length ||
        !payload.some((t) => /[=←]/u.test(t.text)) ||
        payload.some(
          (t) => t.sourceItem.index <= Math.max(...rows[i].map((r) => r.sourceItem.index))
        ) ||
        packet.some((t) => steps[i + 1] && t.labelRect[3] >= steps[i + 1].rect[1]) ||
        /\p{L}{3,}\s+\p{L}{3,}\s+\p{L}{3,}/u.test(payload.map((t) => t.text).join(' '))
      ) {
        complete = false
        break
      }
    }
    if (complete)
      matches.push({
        rect,
        caption: { page: page.pageNumber, lines: [title.text], rect: box(title) }
      })
  }
  return matches.length === 1 ? matches : []
}

// Numbered column programs can wrap their expressions and close without Return.
// The three native strokes and complete ordinal packets establish this boundary;
// the legacy page-width heuristic and whole-item ownership proof remain unchanged.
function framedNumberedInput(page, title, titles, rules, context) {
  const inventory = nativeInventory(page, context),
    o = context.operators,
    h = title.fontSize
  if (
    !inventory ||
    inventory.length > 16384 ||
    inventory.some((t) => t.invalid) ||
    rules.length > 4096 ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000 ||
    o.fnArray.some((op) =>
      [
        OPS.paintFormXObjectBegin,
        OPS.paintFormXObjectEnd,
        OPS.beginGroup,
        OPS.endGroup,
        OPS.beginAnnotation,
        OPS.endAnnotation
      ].includes(op)
    )
  )
    return []
  let depth = 0
  for (const op of o.fnArray) {
    if (op === OPS.save) depth++
    else if (op === OPS.restore && --depth < 0) return []
  }
  if (depth) return []
  const paint = new Map(),
    nativeRules = collectTableRules(o, context.viewport, paint),
    tops = rules.filter(
      (r) =>
        r[1] === r[3] &&
        Math.abs(r[1] - title.y) < h &&
        r[2] - r[0] >= title.right - title.x &&
        title.x >= r[0] - h * 0.1 &&
        title.right <= r[2]
    )
  if (tops.length !== 1) return []
  const top = tops[0],
    frame = rules
      .filter((r) => r[1] === r[3] && r[0] === top[0] && r[2] === top[2] && r[1] >= top[1])
      .sort((a, b) => a[1] - b[1]),
    actual = nativeRules
      .filter((r) => r[1] === r[3] && r[0] === top[0] && r[2] === top[2] && r[1] >= top[1])
      .sort((a, b) => a[1] - b[1])
  if (
    frame.length !== 3 ||
    JSON.stringify(frame) !== JSON.stringify(actual) ||
    frame.some((r) => !paint.has(r.join(',')))
  )
    return []
  const [, divider, bottom] = frame
  if (divider[1] <= title.bottom || divider[1] - title.bottom > h || bottom[1] - divider[1] < h * 5)
    return []
  const caption = inventory.filter((t) => inside(box(title), t.rect)),
    seed = inventory.filter((t) => overlap([top[0], divider[1], top[2], bottom[1]], t.rect))
  if (
    !caption.length ||
    !seed.length ||
    seed.length > 4096 ||
    caption.some((t) => !t.valid || !t.horizontal || t.rect[2] <= top[0] || t.rect[0] >= top[2]) ||
    seed.some(
      (t) =>
        !t.valid ||
        !t.horizontal ||
        t.labelRect[1] <= divider[1] ||
        t.labelRect[3] >= bottom[1] ||
        t.rect[0] < top[0] ||
        (t.rect[2] > top[2] &&
          (!/^[\p{P}\p{S}]$/u.test(t.text) || t.rect[2] - top[2] > (t.rect[2] - t.rect[0]) / 2))
    )
  )
    return []
  const rect = union([
      [top[0], Math.min(top[1], title.y), top[2], bottom[1]],
      ...caption.map((t) => t.labelRect),
      ...seed.flatMap((t) => [t.rect, t.labelRect])
    ]),
    owned = new Set([...caption, ...seed]),
    first = seed[0].sourceItem.index,
    last = seed.at(-1).sourceItem.index
  if (
    caption.some((t) => t.sourceItem.index >= first) ||
    inventory.some(
      (t) =>
        !owned.has(t) &&
        (overlap(t.rect, rect) ||
          overlap(t.labelRect, rect) ||
          (t.sourceItem.index >= first && t.sourceItem.index <= last))
    ) ||
    titles.some((t) => t !== title && overlap(box(t), rect)) ||
    !closedNativeOrdinalPackets(seed, h)
  )
    return []
  const owners = frame.map((rule) =>
    page.graphicsBounds.filter(
      (g) =>
        g.kind === 'path' &&
        Number.isInteger(g.operationIndex) &&
        o.fnArray[g.operationIndex] === OPS.constructPath &&
        inside(
          g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
          rule
        )
    )
  )
  if (
    owners.some((a) => a.length !== 1) ||
    new Set(owners.map((a) => a[0].operationIndex)).size !== 3
  )
    return []
  const indices = owners.map((a) => a[0].operationIndex)
  for (const i of indices) {
    const a = o.argsArray[i],
      p = a?.[1]?.[0]
    if (
      a?.[0] !== OPS.stroke ||
      a[1]?.length !== 1 ||
      !(Array.isArray(p) || ArrayBuffer.isView(p)) ||
      p.length !== 6 ||
      p[0] !== 0 ||
      p[3] !== 1 ||
      !Array.from(p).every(Number.isFinite)
    )
      return []
  }
  const removed = { fnArray: [...o.fnArray], argsArray: [...o.argsArray] }
  for (const i of indices) {
    removed.fnArray[i] = OPS.dependency
    removed.argsArray[i] = []
  }
  if (
    JSON.stringify(collectTableRules(removed, context.viewport)) !==
    JSON.stringify(nativeRules.filter((r) => !frame.some((f) => f.every((v, i) => v === r[i]))))
  )
    return []
  // Complete the actual stroke paint, including the lower half of the closing
  // line. Only its three uniquely proved operations are exempt from sidebands.
  const expanded = union([rect, ...frame.map((r) => paint.get(r.join(',')))]),
    bands = [
      [expanded[0], expanded[1], rect[0], expanded[3]],
      [rect[2], expanded[1], expanded[2], expanded[3]],
      [rect[0], expanded[1], rect[2], rect[1]],
      [rect[0], rect[3], rect[2], expanded[3]]
    ].filter(valid)
  if (
    !inside([0, 0, page.width, page.height], expanded) ||
    inventory.some(
      (t) => !owned.has(t) && (overlap(t.rect, expanded) || overlap(t.labelRect, expanded))
    ) ||
    page.graphicsBounds.some(
      (g) =>
        !indices.includes(g.operationIndex) &&
        bands.some((b) =>
          overlap(
            g.normalizedRect.map((v, i) => v * (i % 2 ? page.height : page.width)),
            b
          )
        )
    ) ||
    titles.some((t) => t !== title && overlap(box(t), expanded)) ||
    page.lines.some(
      (l) =>
        /^(?:Figure|Fig\.|Table|Algorithm)\s+\d+\b/iu.test(l.text) &&
        !inside(box(title), box(l)) &&
        overlap(box(l), expanded)
    )
  )
    return []
  return [
    { rect: expanded, caption: { page: page.pageNumber, lines: [title.text], rect: box(title) } }
  ]
}

function closedNativeOrdinalPackets(body, h) {
  const control = /^(?:for|while|if|then|else|end|Inputs?|Outputs?|Return|Algorithm)\b/iu,
    ordinals = body.filter((t) => /^\d+:$/u.test(t.text))
  if (
    ordinals.length < 4 ||
    ordinals.length > 128 ||
    ordinals[0] !== body[0] ||
    ordinals.some(
      (t, i) =>
        Number(t.text.slice(0, -1)) !== i + 1 ||
        Math.abs(t.height - ordinals[0].height) > 1e-6 ||
        Math.abs(t.rect[2] - ordinals[0].rect[2]) > h * 0.001 ||
        (i && t.baseline <= ordinals[i - 1].baseline)
    )
  )
    return false
  const packets = []
  for (const [i, n] of ordinals.entries()) {
    const items = body.filter(
        (t) =>
          t.sourceItem.index > n.sourceItem.index &&
          (!ordinals[i + 1] || t.sourceItem.index < ordinals[i + 1].sourceItem.index)
      ),
      first = items[0],
      next = ordinals[i + 1]
    if (
      !first ||
      Math.abs(first.height - h) > 1e-6 ||
      Math.abs(first.baseline - n.baseline) > 1e-6 ||
      first.rect[0] <= n.rect[2] ||
      items.some((t) => t.labelRect[1] < first.rect[1] || (next && t.labelRect[3] >= next.rect[1]))
    )
      return false
    const comment = items.findIndex((t) => t.text.trim() === '▷'),
      program = comment < 0 ? items : items.slice(0, comment),
      comments = comment < 0 ? [] : items.slice(comment + 1),
      row = program.filter(
        (t) => Math.abs(t.baseline - first.baseline) < 1e-6 && Math.abs(t.height - h) < 1e-6
      ),
      header = new Set(row)
    if (
      row[0] !== first ||
      program.some((t) => !header.has(t) && control.test(t.text.trim())) ||
      comments.some((t) => control.test(t.text.trim()))
    )
      return false
    packets.push({ text: row.map((t) => t.text.trim()).join(' '), x: first.rect[0] })
  }
  if (
    !/^Inputs?:\s+\S/iu.test(packets[0].text) ||
    !/^Initialize\b.+(?:←|=)/u.test(packets[1].text) ||
    Math.abs(packets[0].x - packets[1].x) > h * 0.1
  )
    return false
  const stack = []
  let loops = 0
  for (const [i, p] of packets.slice(2).entries()) {
    const open = /^(for)\b.+\bdo$/u.exec(p.text) ?? /^(if)\b.+\bthen$/u.exec(p.text),
      close = /^end\s+(for|if)$/u.exec(p.text),
      current = stack.at(-1)
    if (open) {
      if (current ? p.x < current.x + h * 0.5 : i !== 0 || Math.abs(p.x - packets[0].x) > h * 0.1)
        return false
      stack.push({ kind: open[1], x: p.x, body: false, alternate: false })
    } else if (p.text === 'else') {
      if (
        current?.kind !== 'if' ||
        !current.body ||
        current.alternate ||
        Math.abs(p.x - current.x) > h * 0.1
      )
        return false
      current.body = false
      current.alternate = true
    } else if (close) {
      if (!current?.body || current.kind !== close[1] || Math.abs(p.x - current.x) > h * 0.1)
        return false
      stack.pop()
      if (current.kind === 'for') loops++
      if (stack.length) stack.at(-1).body = true
      else if (i !== packets.length - 3) return false
    } else {
      if (control.test(p.text) || !current || p.x < current.x + h * 0.5) return false
      current.body = true
    }
  }
  return !stack.length && loops === 1 && packets.at(-1).text === 'end for'
}

function framedLoop(page, title, titles, lines, rules, context) {
  const horizontal = rules.filter((r) => r[1] === r[3] && r[2] - r[0] >= page.width * 0.5)
  const matches = []
  for (const top of horizontal) {
    const h = title.fontSize
    if (Math.abs(top[1] - title.y) > h || title.x < top[0] || title.right > top[2]) continue
    const aligned = horizontal
      .filter(
        (r) => r[1] >= top[1] && Math.abs(r[0] - top[0]) < 0.01 && Math.abs(r[2] - top[2]) < 0.01
      )
      .sort((a, b) => a[1] - b[1])
    if (aligned.length !== 3) continue
    const [, divider, bottom] = aligned
    if (
      divider[1] <= title.bottom ||
      divider[1] - title.bottom > h ||
      bottom[1] - divider[1] < h * 5
    )
      continue
    const rect = [top[0], Math.min(top[1], title.y), top[2], bottom[1]]
    if (titles.some((t) => t !== title && overlap(box(t), rect))) continue
    const body = lines.filter(
      (l) =>
        l.y > title.bottom &&
        l.bottom > divider[1] &&
        l.y < bottom[1] &&
        l.x >= top[0] &&
        l.right <= top[2]
    )
    const inputs = body.filter((l) => /^Inputs?\s*:/i.test(l.text)),
      returns = body.filter((l) => /^Return\s*:/i.test(l.text))
    const opens = body.filter((l) => /^(for|while)\b.+\bdo\s*$/i.test(l.text)),
      closes = body.filter((l) => /^end\s+(for|while)\s*$/i.test(l.text))
    if (
      inputs.length === 0 &&
      returns.length === 0 &&
      nativeSetLoop(page, context, rect, title, [top, divider, bottom])
    ) {
      matches.push({
        rect,
        caption: { page: page.pageNumber, lines: [title.text], rect: box(title) }
      })
      continue
    }
    if (
      inputs.length === 1 &&
      returns.length === 0 &&
      nativeDataLoop(page, context, rect, title, divider, bottom, inputs[0])
    ) {
      matches.push({
        rect,
        caption: { page: page.pageNumber, lines: [title.text], rect: box(title) }
      })
      continue
    }
    if (inputs.length !== 1 || returns.length !== 1 || opens.length !== 1 || closes.length !== 1)
      continue
    const input = inputs[0],
      ret = returns[0],
      open = opens[0],
      close = closes[0]
    if (
      input.y >= open.y ||
      open.bottom >= close.y ||
      close.bottom > ret.bottom ||
      close.text.split(/\s+/)[1].toLowerCase() !== open.text.split(/\s+/)[0].toLowerCase() ||
      Math.abs(open.x - close.x) > h * 0.1 ||
      Math.abs(input.x - open.x) > h * 0.1 ||
      Math.abs(ret.x - open.x) > h * 0.1 ||
      body.some((l) => /^(?:if\b.*\bthen|else|end\s+if)\s*$/i.test(l.text)) ||
      !body.some(
        (l) =>
          l.y > open.y &&
          l.bottom < close.bottom &&
          l.x >= open.x + h * 0.5 &&
          l.fontSize >= h * 0.85
      ) ||
      body.some((l) => l.y > ret.bottom && l.fontSize >= h * 0.85) ||
      page.lines.some((l) => l.text.trim() && overlap(box(l), rect) && !inside(rect, box(l)))
    )
      continue
    matches.push({
      rect,
      caption: { page: page.pageNumber, lines: [title.text], rect: box(title) }
    })
  }
  return matches.length === 1 ? matches : []
}

// Some complete routines initialize state instead of declaring Input/Return.
// This branch requires its three rules from the very same native operators and
// exactly one closed, indented loop; it does not infer nested control flow.
function nativeSetLoop(page, context, rect, title, frame) {
  const inventory = nativeInventory(page, context),
    operators = context.operators
  if (
    !inventory ||
    inventory.some((t) => t.invalid) ||
    !Array.isArray(operators?.fnArray) ||
    !Array.isArray(operators.argsArray) ||
    operators.fnArray.length !== operators.argsArray.length ||
    operators.fnArray.length > 100000
  )
    return false
  const nativeRules = collectTableRules(operators, context.viewport)
  if (
    frame.some((rule) => nativeRules.filter((r) => r.every((v, i) => v === rule[i])).length !== 1)
  )
    return false
  const body = inventory.filter((t) => overlap(t.rect, rect) && !inside(box(title), t.rect))
  if (
    !body.length ||
    body.length > 4096 ||
    body.some((t) => !t.valid || !t.horizontal || !inside(rect, t.rect))
  )
    return false
  const h = Math.max(...body.map((t) => t.height)),
    rows = []
  if (
    body.some(
      (t) =>
        /^(?:Set|for|while|if|then|else|end|Inputs?|Data|Outputs?|Return)\b/iu.test(
          t.text.trim()
        ) && Math.abs(t.height - h) >= 1e-6
    )
  )
    return false
  for (const t of body
    .filter((t) => Math.abs(t.height - h) < 1e-6)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    let row = rows.at(-1)
    if (!row || Math.abs(row.baseline - t.baseline) > 1e-6) {
      row = { baseline: t.baseline, items: [] }
      rows.push(row)
    }
    row.items.push(t)
  }
  if (rows.length < 5 || rows.length > 256) return false
  const statements = rows.map((row) => ({
    text: row.items
      .map((t) => t.text.trim())
      .join(' ')
      .trim(),
    x: row.items[0].rect[0],
    y: Math.min(...row.items.map((t) => t.rect[1])),
    bottom: row.baseline,
    sources: row.items.map((t) => t.sourceItem.index)
  }))
  const [init, open] = statements,
    close = statements.at(-1)
  if (
    !/^Set\s+.+(?:=|\bto\b)/u.test(init.text) ||
    !/^for\s+.+\s+do$/u.test(open.text) ||
    close.text !== 'end for' ||
    Math.abs(init.x - open.x) > h * 0.1 ||
    Math.abs(close.x - open.x) > h * 0.1 ||
    init.y <= frame[1][1] ||
    init.y - frame[1][1] > h ||
    close.bottom >= frame[2][1] ||
    frame[2][1] - close.bottom > h ||
    body.some((t) => t.rect[3] > close.bottom + 1e-6) ||
    statements.some(
      (s, i) =>
        i &&
        (s.y <= statements[i - 1].bottom ||
          Math.min(...s.sources) <= Math.max(...statements[i - 1].sources))
    ) ||
    statements
      .slice(2, -1)
      .some(
        (s) =>
          s.x < open.x + h * 0.5 ||
          /^(?:Set|for|while|if|then|else|end|Inputs?|Data|Outputs?|Return|Algorithm)\b/iu.test(
            s.text
          )
      )
  )
    return false
  return true
}

// Input/Data routines can terminate at the closing loop instead of Return.
// Use whole native baseline packets for the control grammar: inline scripts may
// split a grouped if/then, but never authorize partial text or an open frame.
function nativeDataLoop(page, context, rect, title, divider, bottom, input) {
  const inventory = nativeInventory(page, context),
    h = input.fontSize
  if (!inventory || inventory.some((t) => t.invalid) || !Number.isFinite(h) || h <= 0) return false
  const body = inventory.filter((t) => overlap(t.rect, rect) && !inside(box(title), t.rect))
  if (
    !body.length ||
    body.length > 4096 ||
    body.some(
      (t) =>
        !t.valid ||
        !t.horizontal ||
        !inside(rect, t.rect) ||
        (/^(?:for|while|if|then|else|end)\b/i.test(t.text.trim()) && Math.abs(t.height - h) >= 1e-6)
    )
  )
    return false
  const rows = []
  for (const t of body
    .filter((t) => Math.abs(t.height - h) < 1e-6)
    .sort((a, b) => a.baseline - b.baseline || a.rect[0] - b.rect[0])) {
    let row = rows.at(-1)
    if (!row || Math.abs(row.baseline - t.baseline) > 1e-6) {
      row = { baseline: t.baseline, items: [] }
      rows.push(row)
    }
    row.items.push(t)
  }
  if (rows.length < 8 || rows.length > 256) return false
  const statements = rows.map((r) => ({
    text: r.items
      .map((t) => t.text.trim())
      .join(' ')
      .trim(),
    x: r.items[0].rect[0],
    y: Math.min(...r.items.map((t) => t.rect[1])),
    bottom: r.baseline,
    items: r.items
  }))
  const [first, data, root] = statements
  if (
    !/^Inputs?\s*:/i.test(first.text) ||
    !/^Data\s*:/i.test(data.text) ||
    !/^(?:for|while)\b.+\bdo\s*$/i.test(root.text) ||
    Math.abs(first.x - root.x) > h * 0.1 ||
    Math.abs(data.x - root.x) > h * 0.1 ||
    first.y <= divider[1] ||
    first.y - divider[1] > h ||
    bottom[1] - statements.at(-1).bottom > h ||
    body.some((t) => t.rect[3] > statements.at(-1).bottom + 1e-6)
  )
    return false
  const stack = []
  let loops = 0,
    branches = 0,
    lastControlSource = -1
  for (const [index, row] of statements.slice(2).entries()) {
    const open =
        /^(for|while)\b.+\bdo\s*$/i.exec(row.text) ?? /^(if)\b.+\bthen\s*$/i.exec(row.text),
      close = /^end\s+(for|while|if)\s*$/i.exec(row.text),
      alternate = /^else\s*$/i.test(row.text),
      current = stack.at(-1)
    if (open || close || alternate) {
      const sources = row.items.map((t) => t.sourceItem.index)
      if (Math.min(...sources) <= lastControlSource) return false
      lastControlSource = Math.max(...sources)
    }
    if (open) {
      if (current ? row.x < current.x + h * 0.5 : index !== 0) return false
      stack.push({ kind: open[1].toLowerCase(), x: row.x, body: false, alternate: false })
      if (open[1].toLowerCase() === 'if') branches++
    } else if (alternate) {
      if (
        current?.kind !== 'if' ||
        !current.body ||
        current.alternate ||
        Math.abs(row.x - current.x) > h * 0.1
      )
        return false
      current.alternate = true
      current.body = false
    } else if (close) {
      if (
        !current?.body ||
        current.kind !== close[1].toLowerCase() ||
        Math.abs(row.x - current.x) > h * 0.1
      )
        return false
      stack.pop()
      if (current.kind !== 'if') loops++
      if (stack.length) stack.at(-1).body = true
      else if (index !== statements.length - 3) return false
    } else {
      if (
        !current ||
        row.x < current.x + h * 0.5 ||
        /^(?:for|while|if|then|else|end|Inputs?|Data|Outputs?|Return|Algorithm)\b/i.test(row.text)
      )
        return false
      current.body = true
    }
  }
  return loops > 0 && branches > 0 && !stack.length
}

function wrappedSources(inventory, ordinals, context, h, codeX, bodyLines) {
  if (ordinals.some((n, i) => i && n.sourceItem.index <= ordinals[i - 1].sourceItem.index))
    return false

  for (const line of bodyLines) {
    const tokens = inventory.filter((t) => inside(box(line), t.rect))
    if (!tokens.length) return false
    const first = tokens[0].sourceItem.index,
      last = tokens.at(-1).sourceItem.index
    const packet = ordinals.filter(
      (n, i) =>
        n.sourceItem.index < first &&
        (i === ordinals.length - 1 || ordinals[i + 1].sourceItem.index > last)
    )
    if (packet.length !== 1) return false
    const n = packet[0],
      next = ordinals[ordinals.indexOf(n) + 1]
    if (Math.abs(line.bottom - n.baseline) < h * 0.8) continue
    const peers = inventory.filter(
      (t) =>
        t.sourceItem.index > n.sourceItem.index &&
        (!next || t.sourceItem.index < next.sourceItem.index)
    )
    const anchors = peers.filter(
      (t) => Math.abs(t.baseline - n.baseline) < 0.01 && Math.abs(t.height - h) < 0.01
    )
    const font = context.content.items[first].fontName
    const starts = peers.filter(
      (t) =>
        t.text.startsWith('//') &&
        context.content.items[t.sourceItem.index].fontName === font &&
        Math.abs(t.baseline - n.baseline) < 0.01
    )
    const comment =
      starts.length === 1 &&
      context.content.styles[font]?.fontFamily === 'monospace' &&
      tokens.every(
        (t) =>
          context.content.items[t.sourceItem.index].fontName === font &&
          Math.abs(t.height - h) < 0.01 &&
          t.sourceItem.index > starts[0].sourceItem.index
      ) &&
      line.y > n.baseline &&
      (!next || line.bottom < next.rect[1]) &&
      line.x > codeX &&
      line.x - codeX < h &&
      tokens.every((t) => Math.abs(t.baseline - line.bottom) < 0.01)
    const math = tokens.every((t) => {
      const matches = ordinals.filter((row) =>
        inventory.some(
          (a) =>
            a !== t &&
            Math.abs(a.baseline - row.baseline) < 0.01 &&
            Math.abs(a.height - h) < 0.01 &&
            t.labelRect[1] < row.baseline - h / 2 &&
            row.baseline - h / 2 < t.labelRect[3] &&
            Math.min(Math.abs(t.rect[0] - a.rect[2]), Math.abs(t.rect[2] - a.rect[0])) < h * 0.2
        )
      )
      return (
        t.baseline < n.baseline &&
        Math.abs(t.height - h) < 0.01 &&
        matches.length === 1 &&
        matches[0] === n &&
        anchors.some(
          (a) =>
            a !== t &&
            ((t.sourceItem.index > a.sourceItem.index &&
              Math.abs(t.rect[0] - a.rect[2]) < h * 0.2) ||
              (t.sourceItem.index < a.sourceItem.index &&
                Math.abs(t.rect[2] - a.rect[0]) < h * 0.2))
        )
      )
    })
    if (!comment && !math) return false
  }
  return true
}
function numberedScope(page, title, titles, lines, rules, context) {
  const inventory = nativeInventory(page, context)
  if (!inventory || inventory.some((t) => t.invalid)) return []
  const starts = lines
    .filter((l) => /^(?:1\s+)?(?:Function|Procedure)\b/.test(l.text) && l.bottom < title.y)
    .flatMap((l) => {
      const first = inventory.filter(
        (t) =>
          t.text === '1' &&
          t.rect[2] <= l.right &&
          t.rect[0] <= l.x &&
          l.x - t.rect[2] < l.fontSize * 2 &&
          Math.abs(t.baseline - l.bottom) < l.fontSize * 0.3
      )
      return first.length === 1
        ? [{ ...l, x: Math.min(l.x, first[0].rect[0]), y: Math.min(l.y, first[0].rect[1]) }]
        : []
    })
  const result = []
  for (const start of starts) {
    const h = start.fontSize
    const vertical = rules.filter((r) => r[0] === r[2] && r[3] > r[1])
    const roots = vertical.filter(
      (r) =>
        r[0] > start.x &&
        r[0] - start.x < h * 2 &&
        r[1] >= start.bottom - h * 0.25 &&
        r[1] - start.bottom < h &&
        Math.abs(r[3] - title.y) < h * 0.5
    )
    if (roots.length !== 1) continue
    const root = roots[0]
    const ordinals = inventory
      .filter(
        (t) =>
          /^\d+$/.test(t.text) &&
          t.rect[2] < root[0] &&
          root[0] - t.rect[2] < h * 2 &&
          t.baseline >= start.y &&
          t.baseline < title.y
      )
      .sort((a, b) => a.baseline - b.baseline)
    if (
      ordinals.length < 4 ||
      ordinals.length > 128 ||
      ordinals.some(
        (t, i) =>
          Number(t.text) !== i + 1 ||
          !t.valid ||
          t.height > h ||
          Math.abs(t.rect[2] - ordinals[0].rect[2]) > h * 0.2 ||
          (i && t.baseline <= ordinals[i - 1].baseline)
      )
    )
      continue
    if (
      ordinals
        .slice(1)
        .some((t) => !page.lines.some((l) => l.text === t.text && inside(box(l), t.rect)))
    )
      continue
    const bodyLines = lines.filter((l) => l.y >= start.y && l.y < title.y && l.x > root[0])
    const statements = ordinals
      .slice(1)
      .map(
        (n) =>
          bodyLines
            .filter(
              (l) =>
                (Math.abs(l.bottom - n.baseline) < h * 0.3 ||
                  inventory.some(
                    (t) =>
                      inside(box(l), t.rect) &&
                      t.height >= h * 0.85 &&
                      Math.abs(t.baseline - n.baseline) < 0.01
                  )) &&
                l.fontSize >= h * 0.85
            )
            .sort((a, b) => a.x - b.x)[0]
      )
    if (statements.some((l) => !l) || !/^return\b/i.test(statements.at(-1).text)) continue
    const codeX = Math.min(...statements.map((l) => l.x)),
      scopes = vertical.filter(
        (r) => r !== root && r[0] > root[0] && r[1] > root[1] && r[3] < root[3]
      )
    if (!scopes.length || codeX - root[0] < h * 0.5 || codeX - root[0] > h * 2) continue
    if (
      scopes.some((a) =>
        scopes.some(
          (b) =>
            a !== b &&
            a[1] < b[3] &&
            b[1] < a[3] &&
            (a[0] === b[0] || (a[0] < b[0] && (b[1] < a[1] || b[3] > a[3])))
        )
      ) ||
      scopes.some((r) => !statements.some((l) => l.x > r[0] && l.bottom > r[1] && l.bottom < r[3]))
    )
      continue
    const controls = statements.filter((l) =>
      /^(?:(?:for|foreach|while)\b.+\bdo|if\b.+\bthen)\s*$/i.test(l.text)
    )
    if (
      !controls.length ||
      controls.some(
        (l) =>
          scopes.filter(
            (r) =>
              r[0] > l.x &&
              r[0] - l.x < h &&
              r[1] >= l.bottom - h * 0.25 &&
              r[1] - l.bottom < h &&
              r[3] > r[1]
          ).length !== 1
      )
    )
      continue
    if (
      scopes.some(
        (r) =>
          controls.filter(
            (l) =>
              r[0] > l.x && r[0] - l.x < h && r[1] >= l.bottom - h * 0.25 && r[1] - l.bottom < h
          ).length !== 1
      )
    )
      continue
    // A continuation must belong to one ordered native packet and prove either
    // its comment font or its delimiter envelope against that numbered row.
    if (!wrappedSources(inventory, ordinals, context, h, codeX, bodyLines)) continue
    if (
      statements.some(
        (l) =>
          l.x > codeX + h * 0.2 &&
          !scopes.some((r) => l.x > r[0] && l.x - r[0] < h * 2 && l.y < r[3] && l.bottom > r[1])
      )
    )
      continue
    const selected = inventory.filter(
      (t) =>
        t.rect[0] >= Math.min(...ordinals.map((n) => n.rect[0])) &&
        t.baseline >= start.y &&
        t.rect[1] < title.y &&
        !inside(box(title), t.rect)
    )
    if (
      !selected.length ||
      selected.some(
        (t) =>
          !t.valid ||
          (!ordinals.includes(t) &&
            t.rect[0] <= root[0] &&
            !(t.sourceItem.index < ordinals[1].sourceItem.index && inside(box(start), t.rect)))
      )
    )
      continue
    const rect = union([...selected.map((t) => t.rect), root])
    if (rect[3] > title.bottom || titles.some((t) => t !== title && overlap(box(t), rect))) continue
    result.push({ rect, caption: { page: page.pageNumber, lines: [title.text], rect: box(title) } })
  }
  return result.length === 1 ? result : []
}

// Legacy crop recognition also accepts short numbered prose. Only this complete
// native frame and closed numbered program can upgrade such a crop to ownership.
function numberedDeclarationProgram(ordinals) {
  const text = ordinals.map((l) => l.text.replace(/^\d+\s*:\s*/, '').trim())
  let first = 0
  while (/^Inputs?\s*:\s*\S/i.test(text[first] ?? '')) first++
  if (!first || first > 8) return false
  const inputs = first
  while (/^Initial Values?\s*:\s*\S/i.test(text[first] ?? '')) first++
  if (first - inputs > 4 || first >= text.length - 2) return false
  const functionBody =
    /^function\s+[A-Za-z][A-Za-z0-9_]*\s*\(\s*[A-Za-z][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z][A-Za-z0-9_]*)*\s*\)$/i.test(
      text[first]
    )
  let end = text.length
  if (functionBody) {
    if (!/^end\s+function$/i.test(text.at(-1)) || !/^return\s+\S/i.test(text.at(-2))) return false
    first++
    end -= 2
  } else {
    while (/^Outputs?\s*:\s*\S/i.test(text[end - 1] ?? '')) end--
    if (end === text.length || text.length - end > 8) return false
  }
  return (
    end > first &&
    text
      .slice(first, end)
      .every(
        (s) => !/^(?:Inputs?|Outputs?|Initial Values?)\s*:|^function\b|^end\s+function\b/i.test(s)
      )
  )
}

// Grouping may leave an ordinal alone while the code on its baseline is a
// separate line. Read every native ordinal packet before checking control flow;
// a grouped line is not evidence that an inner control statement is absent.
function nativeNumberedStatements(page, context, ordinals, rect) {
  const inventory = nativeInventory(page, context)
  if (!inventory || inventory.some((t) => t.invalid || !t.sourceItem)) return
  const anchors = ordinals.map((line) =>
    inventory.filter(
      (t) =>
        new RegExp('^' + line.text.match(/^\d+/)[0] + '\\s*:').test(t.text) &&
        inside(box(line), t.rect)
    )
  )
  if (
    anchors.some(
      (tokens, i) =>
        tokens.length !== 1 ||
        !tokens[0].valid ||
        !tokens[0].horizontal ||
        (i && tokens[0].sourceItem.index <= anchors[i - 1][0]?.sourceItem.index)
    )
  )
    return
  const declaration = inventory.filter(
      (t) =>
        t.sourceItem.index >= anchors[0][0].sourceItem.index &&
        t.sourceItem.index < anchors[1][0].sourceItem.index &&
        /^(?:1\s*:\s*)?Inputs?\s*:/i.test(t.text.trim()) &&
        Math.abs(t.baseline - anchors[0][0].baseline) < 1e-6
    ),
    statements = [],
    control = /\b(?:for|while|if|then|else|end|return|function)\b/i
  if (declaration.length !== 1) return
  const h = declaration[0].height
  for (const [i, [anchor]] of anchors.entries()) {
    const next = anchors[i + 1]?.[0],
      packet = inventory.filter(
        (t) =>
          t.sourceItem.index >= anchor.sourceItem.index &&
          (next ? t.sourceItem.index < next.sourceItem.index : inside(rect, t.rect))
      ),
      row = packet.filter(
        (t) => Math.abs(t.baseline - anchor.baseline) < 1e-6 && Math.abs(t.height - h) < 1e-6
      ),
      header = new Set(row)
    if (
      !packet.length ||
      !row.length ||
      packet.some(
        (t) =>
          !t.valid ||
          !t.horizontal ||
          !inside(rect, t.rect) ||
          (next && t.baseline >= next.baseline) ||
          (!header.has(t) && control.test(t.text))
      ) ||
      row.some((t, j) => j && t.rect[0] < row[j - 1].rect[2] - h * 0.1)
    )
      return
    const text = row.map((t) => t.text.trim()).join(' ')
    statements.push({ text: row[0] === anchor ? text : `${i + 1}: ${text}` })
  }
  return numberedDeclarationProgram(statements) ? statements : undefined
}

// A declaration can finish a parenthetical note on its next native row. The
// ordinal interval, closed delimiter, style and complete source packet must
// all agree; this cannot admit an unnumbered program statement or paragraph.
function nativeDeclarationNote(page, context, step, next, line) {
  if (!next || !/^\d+\s*:\s*(?:Inputs?|Outputs?|Initial Values?)\s*:/i.test(step.text)) return false
  const inventory = nativeInventory(page, context)
  if (!inventory || inventory.some((t) => t.invalid)) return false
  const anchor = (row) =>
    inventory.filter(
      (t) =>
        new RegExp('^' + row.text.match(/^\d+/)[0] + '\\s*:').test(t.text) &&
        inside(box(row), t.rect)
    )
  const first = anchor(step),
    after = anchor(next)
  if (
    first.length !== 1 ||
    after.length !== 1 ||
    first[0].sourceItem.index >= after[0].sourceItem.index
  )
    return false
  const packet = inventory.filter(
      (t) =>
        t.sourceItem.index > first[0].sourceItem.index &&
        t.sourceItem.index < after[0].sourceItem.index
    ),
    tokens = packet.filter((t) => inside(box(line), t.rect))
  if (
    !tokens.length ||
    packet.some((t) => !t.valid || !t.horizontal || t.sourceItem.pageNumber !== page.pageNumber) ||
    tokens.at(-1) !== packet.at(-1) ||
    tokens
      .map((t) => t.text)
      .join('')
      .replace(/\s/gu, '') !== line.text.replace(/\s/gu, '')
  )
    return false
  const prefix = packet.filter((t) => t.sourceItem.index < tokens[0].sourceItem.index),
    opener = prefix.findLast((t) => t.text.includes('(')),
    before = prefix.map((t) => t.text).join(' '),
    tail = tokens.map((t) => t.text).join(' ')
  if (
    !opener ||
    !prefix.length ||
    !/^[A-Za-z][A-Za-z\d\s,.'’-]*\)$/u.test(
      before.slice(before.lastIndexOf('(') + 1) + ' ' + tail
    ) ||
    packet.some((t) => /^(?:for|while|if|else|end|return|function)\b/i.test(t.text.trim()))
  )
    return false
  let depth = 0
  for (const char of before) {
    if (char === '(') depth++
    else if (char === ')' && --depth < 0) return false
  }
  if (depth !== 1 || [...tail].filter((c) => c === ')').length !== 1 || tail.includes('('))
    return false
  const font = context.content.items[opener.sourceItem.index]?.fontName
  return (
    !!font &&
    tokens.every(
      (t) =>
        context.content.items[t.sourceItem.index]?.fontName === font &&
        Math.abs(t.height - opener.height) < opener.height * 0.01
    ) &&
    line.y - opener.rect[1] > opener.height * 0.75 &&
    line.y - opener.rect[1] < opener.height * 1.7 &&
    Math.abs(line.x - packet[0].rect[0]) < opener.height * 0.1 &&
    line.bottom < after[0].rect[1]
  )
}

function closedNumberedFrame(page, candidate, lines, rules, context) {
  const title = candidate.caption,
    h = title.rect[3] - title.rect[1],
    // In addition to the established wide frame, accept a full column frame
    // only when every rule covers the caption and nearly all of its crop.
    // Both branches still require three exactly matching endpoints below.
    main = rules
      .filter(
        (r) =>
          r[1] === r[3] &&
          (r[2] - r[0] >= page.width * 0.5 ||
            (r[2] - r[0] >= candidate.rect[2] - candidate.rect[0] - h * 2 &&
              r[0] <= title.rect[0] &&
              r[2] >= title.rect[2])) &&
          inside(candidate.rect, r)
      )
      .sort((a, b) => a[1] - b[1])
  if (main.length !== 3) return false
  const [top, divider, bottom] = main
  if (
    main.some((r) => Math.abs(r[0] - top[0]) > 0.01 || Math.abs(r[2] - top[2]) > 0.01) ||
    Math.abs(top[1] - title.rect[1]) > h ||
    divider[1] <= title.rect[3] ||
    divider[1] - title.rect[3] > h ||
    bottom[1] <= divider[1] + h * 5
  )
    return false
  const body = lines.filter(
      (l) => l.y > title.rect[3] && l.y < bottom[1] && inside(candidate.rect, box(l))
    ),
    ordinals = body.filter((l) => /^\d+\s*:/.test(l.text)),
    inputs = body.filter((l) => /^(?:Require|Inputs?)\s*:/i.test(l.text)),
    outputs = body.filter((l) => /^(?:Ensure|Outputs?)\s*:/i.test(l.text)),
    numberedDeclarations = !inputs.length && !outputs.length && numberedDeclarationProgram(ordinals)
  if (
    ordinals.length < 4 ||
    ordinals.length > 128 ||
    (!numberedDeclarations &&
      (inputs.length !== 1 ||
        // An explicit terminal return supplies the output when Ensure is absent.
        outputs.length > 1 ||
        inputs[0].bottom <= divider[1] ||
        inputs[0].y >= ordinals[0].y ||
        (outputs.length &&
          (outputs[0].y <= inputs[0].y ||
            (outputs[0].bottom >= ordinals[0].y &&
              !nativeOrdinalAfterOutput(page, context, ordinals[0], outputs[0])))) ||
        !/^\d+\s*:\s*return\b/i.test(ordinals.at(-1).text))) ||
    ordinals.some(
      (l, i) => Number(l.text.match(/^\d+/)[0]) !== i + 1 || (i && l.y <= ordinals[i - 1].y)
    )
  )
    return false
  const gutters = new Map()
  for (const l of ordinals) {
    const digits = l.text.match(/^\d+/)[0].length
    if (gutters.has(digits) && Math.abs(l.x - gutters.get(digits)) > l.fontSize * 0.2) return false
    gutters.set(digits, l.x)
  }
  // Whole native expression continuations may span several baselines. Require
  // their own numbered introduction and assignment, not an adjacent paragraph.
  for (const l of body.filter((l) => !ordinals.includes(l) && l.y >= ordinals[0].y)) {
    if (ordinals.some((step) => l.y < step.bottom && l.bottom > step.y)) continue
    const index = ordinals.findLastIndex((step) => step.bottom <= l.y),
      step = ordinals[index]
    if (
      numberedDeclarations &&
      step &&
      nativeDeclarationNote(page, context, step, ordinals[index + 1], l)
    )
      continue
    if (!step || !/:\s*$/.test(step.text)) return false
    const continuation = body.filter(
      (other) => other.y >= step.bottom && other.bottom <= (ordinals[index + 1]?.y ?? bottom[1])
    )
    if (
      !continuation.some((other) => /←/.test(other.text)) ||
      continuation.some((other) =>
        /\p{L}{3,}\s+\p{L}{3,}\s+\p{L}{3,}/u.test(other.text.replace(/\barg\s+(?:max|min)\b/g, ''))
      )
    )
      return false
  }
  const statements = numberedDeclarations
    ? nativeNumberedStatements(page, context, ordinals, candidate.rect)
    : ordinals
  if (!statements) return false
  const stack = []
  let loops = 0
  for (const l of statements) {
    const text = l.text.replace(/^\d+\s*:\s*/, '').trim(),
      open =
        /^(for|while)\b.+\bdo\s*$/i.exec(text) ??
        /^(if)\b.+\bthen\s*$/i.exec(text) ??
        (numberedDeclarations
          ? /^(function)\s+[A-Za-z][A-Za-z0-9_]*\s*\([^()]+\)\s*$/i.exec(text)
          : null),
      close = (
        numberedDeclarations ? /^end\s+(for|while|if|function)\s*$/i : /^end\s+(for|while|if)\s*$/i
      ).exec(text)
    if (open) {
      stack.push({ kind: open[1].toLowerCase(), body: false, alternate: false })
      continue
    }
    if (/^else(?:\s+if\b.+\bthen)?\s*$/i.test(text)) {
      const current = stack.at(-1)
      if (current?.kind !== 'if' || !current.body || current.alternate) return false
      current.alternate = /^else\s*$/i.test(text)
      current.body = false
      continue
    }
    if (close) {
      const current = stack.pop()
      if (!current?.body || current.kind !== close[1].toLowerCase()) return false
      if (current.kind === 'for' || current.kind === 'while') loops++
      if (stack.length) stack.at(-1).body = true
      continue
    }
    if (
      /^(?:for|while|if|else|end)\b/i.test(text) ||
      (numberedDeclarations && /^function\b/i.test(text)) ||
      (!text && !body.some((other) => other !== l && other.y < l.bottom && other.bottom > l.y))
    )
      return false
    if (stack.length) stack.at(-1).body = true
  }
  return loops > 0 && stack.length === 0
}

// A publisher may close one numbered while scope through native indentation
// instead of printing end/return. Keep that shape separate from the established
// explicit-control proof, and still require the complete body/source proof.
// Only the outer level may contain a whole single-line conditional instruction;
// an inner if or an outer then/colon block remains unproved.
function nativeIndentedNumberedFrame(page, candidate, context) {
  const inventory = nativeInventory(page, context),
    o = context.operators,
    caption = candidate.caption?.rect,
    h = caption?.[3] - caption?.[1]
  if (
    !inventory?.length ||
    inventory.length > 16384 ||
    inventory.some((t) => !t.valid || !t.horizontal) ||
    !valid(candidate.rect) ||
    !valid(caption) ||
    !Array.isArray(context.rules) ||
    context.rules.length > 4096 ||
    !Number.isFinite(h) ||
    h <= 0 ||
    !Array.isArray(o?.fnArray) ||
    !Array.isArray(o.argsArray) ||
    o.fnArray.length !== o.argsArray.length ||
    o.fnArray.length > 100000
  )
    return false
  const frame = context.rules
      .filter((r) => r[1] === r[3] && inside(candidate.rect, r))
      .sort((a, b) => a[1] - b[1]),
    paint = new Map(),
    native = collectTableRules(o, context.viewport, paint)
      .filter((r) => r[1] === r[3] && inside(candidate.rect, r))
      .sort((a, b) => a[1] - b[1])
  if (
    frame.length !== 3 ||
    JSON.stringify(frame) !== JSON.stringify(native) ||
    frame.some(
      (r, i) =>
        r[0] !== frame[0][0] ||
        r[2] !== frame[0][2] ||
        !paint.has(r.join(',')) ||
        (i && r[1] <= frame[i - 1][1])
    )
  )
    return false
  const [top, divider, bottom] = frame
  if (
    top[2] - top[0] < page.width * 0.5 ||
    Math.abs(top[1] - caption[1]) > h ||
    divider[1] <= caption[3] ||
    divider[1] - caption[3] > h ||
    bottom[1] - divider[1] < h * 5
  )
    return false
  const body = inventory.filter((t) => overlap(t.rect, candidate.rect) && !inside(caption, t.rect)),
    markers = body.filter((t) => /^\d+:$/u.test(t.text))
  if (
    body.length > 4096 ||
    body.some((t) => !inside(candidate.rect, t.rect) || t.labelRect[1] <= divider[1]) ||
    markers.length < 4 ||
    markers.length > 128 ||
    markers.some(
      (t, i) =>
        t.text !== `${i + 1}:` ||
        context.content.items[t.sourceItem.index].fontName !==
          context.content.items[markers[0].sourceItem.index].fontName ||
        Math.abs(t.height - markers[0].height) > 1e-6 ||
        Math.abs(t.rect[0] - markers[0].rect[0]) > 0.02 ||
        (i && t.baseline - markers[i - 1].baseline < h * 0.8)
    )
  )
    return false
  const prefix = body.filter((t) => t.sourceItem.index < markers[0].sourceItem.index),
    rows = markers.map((marker, i) => {
      const items = body.filter(
        (t) =>
          t.sourceItem.index > marker.sourceItem.index &&
          t.sourceItem.index < (markers[i + 1]?.sourceItem.index ?? Infinity)
      )
      return {
        marker,
        items,
        first: items[0],
        text: items.map((t) => t.text.trim()).join(' ')
      }
    }),
    em = prefix[0]?.height
  if (
    !em ||
    prefix[0].text !== 'Require:' ||
    prefix.some((t) => t.baseline >= markers[0].baseline) ||
    rows.some(
      ({ marker, items, first }) =>
        !first ||
        first.rect[0] <= marker.rect[2] ||
        Math.abs(first.height - em) > 1e-6 ||
        Math.abs(first.baseline - marker.baseline) > 1e-6 ||
        items.some((t) => Math.abs(t.baseline - marker.baseline) > em * 0.3)
    )
  )
    return false
  const controls = rows.filter((r) => /^while\b.+\bdo$/u.test(r.text))
  if (controls.length !== 1) return false
  const control = controls[0],
    at = rows.indexOf(control),
    base = rows[0].first.rect[0],
    out = rows.findIndex((r, i) => i > at && Math.abs(r.first.rect[0] - base) <= 0.02),
    nested = rows.slice(at + 1, out),
    indent = nested[0]?.first.rect[0] - base
  return (
    at >= 1 &&
    out >= at + 3 &&
    Math.abs(control.first.rect[0] - base) <= 0.02 &&
    context.content.items[control.first.sourceItem.index].fontName ===
      context.content.items[prefix[0].sourceItem.index].fontName &&
    context.content.items[control.items.at(-1).sourceItem.index].fontName ===
      context.content.items[prefix[0].sourceItem.index].fontName &&
    indent >= em * 0.5 &&
    indent <= em * 2 &&
    nested.every((r) => Math.abs(r.first.rect[0] - base - indent) <= 0.02) &&
    rows
      .slice(0, at + 1)
      .concat(rows.slice(out))
      .every((r) => Math.abs(r.first.rect[0] - base) <= 0.02) &&
    rows.every(
      (r) =>
        r === control ||
        (!/^(?:for|while|repeat|until|else|end)\b/iu.test(r.text) &&
          (!/^if\b/iu.test(r.text) || (!nested.includes(r) && !/(?:\bthen|:)\s*$/iu.test(r.text))))
    )
  )
}

// A raised script may lift the grouped first row above the preceding output.
// Only the whole native ordinal and complete output packet can prove order;
// the later ownership proof still validates every body item and full frame.
function nativeOrdinalAfterOutput(page, context, first, output) {
  const inventory = nativeInventory(page, context)
  if (!inventory || inventory.some((t) => t.invalid)) return false
  const ordinal = inventory.filter(
    (t) =>
      t.valid &&
      t.horizontal &&
      /^1\s*:/.test(t.text) &&
      inside(box(first), t.rect) &&
      Math.abs(t.rect[0] - first.x) < first.fontSize * 0.05
  )
  const packet = inventory.filter(
    (t) => inside(box(output), t.rect) || inside(box(output), t.labelRect)
  )
  if (
    ordinal.length !== 1 ||
    !packet.length ||
    packet.some((t) => !t.valid || !t.horizontal) ||
    packet
      .map((t) => t.text)
      .join('')
      .replace(/\s/gu, '') !== output.text.replace(/\s/gu, '')
  )
    return false
  const anchor = ordinal[0]
  return (
    output.bottom < anchor.rect[1] &&
    anchor.rect[1] - first.y < first.fontSize &&
    packet.every((t) => t.sourceItem.index < anchor.sourceItem.index)
  )
}

// Vertical native scope strokes close these loops instead of printed end-for
// tokens. This path proves actual source glyphs independently; the older whole
// font-box proof and its refusal of caption overlap remain unchanged.
function verticalScopedLoop(page, context, title, titles) {
  const inventory = nativeInventory(page, context),
    p = context.nativeGlyphContext,
    raw = p?.content?.items,
    current = context.content?.items,
    equal = (a, b) => JSON.stringify(a) === JSON.stringify(b),
    h = title.fontSize
  if (
    titles.length !== 1 ||
    !Number.isFinite(h) ||
    h <= 0 ||
    !inventory?.length ||
    inventory.length > 16384 ||
    inventory.some((t) => !t.valid || !t.horizontal) ||
    !Array.isArray(raw) ||
    raw.length > 32768 ||
    raw.length !== current?.length ||
    !Array.isArray(p.glyphBounds) ||
    !Array.isArray(context.rules) ||
    context.rules.length > 4096 ||
    !equal(p.graphicsBounds, page.graphicsBounds) ||
    !Array.isArray(page.graphicsBounds) ||
    page.graphicsBounds.some(
      (g) =>
        g.kind !== 'path' ||
        !valid(g.normalizedRect) ||
        !Number.isSafeInteger(g.operationIndex) ||
        g.operationIndex < 0
    )
  )
    return
  const aliases = new Map(),
    reverse = new Map()
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i],
      b = current[i]
    if (
      ['str', 'width', 'height', 'dir', 'hasEOL'].some((k) => a[k] !== b[k]) ||
      !equal(a.transform, b.transform) ||
      !equal(a.sourceItem, b.sourceItem) ||
      !p.content.styles?.[a.fontName] ||
      !equal(p.content.styles[a.fontName], context.content.styles?.[b.fontName]) ||
      (aliases.has(a.fontName) && aliases.get(a.fontName) !== b.fontName) ||
      (reverse.has(b.fontName) && reverse.get(b.fontName) !== a.fontName)
    )
      return
    aliases.set(a.fontName, b.fontName)
    reverse.set(b.fontName, a.fontName)
  }
  const mapped = (v) =>
    Array.isArray(v) ? v.map(mapped) : typeof v === 'string' ? (aliases.get(v) ?? v) : v
  if (
    !equal(p.operators?.fnArray, context.operators?.fnArray) ||
    !equal(mapped(p.operators?.argsArray), context.operators?.argsArray)
  )
    return
  const caption = inventory.filter((t) => inside(box(title), t.rect))
  if (
    !caption.length ||
    !equal(
      caption
        .map((t) => t.text)
        .join(' ')
        .replace(/\s/gu, ''),
      title.text.replace(/\s/gu, '')
    )
  )
    return
  const last = caption.at(-1),
    tail = inventory[inventory.indexOf(last) + 1],
    afterTail = inventory[inventory.indexOf(last) + 2]
  // Only this complete wrapped caption shape is admitted: an explicit title,
  // one aligned terminal word in its final text font, then a separate paragraph.
  if (
    /[.!?]$/u.test(title.text) ||
    !tail ||
    !/^[\p{L}]+\.$/u.test(tail.text) ||
    Math.abs(tail.rect[0] - title.x) > 0.02 ||
    Math.abs(tail.height - h) > 1e-6 ||
    current[tail.sourceItem.index].fontName !== current[last.sourceItem.index].fontName ||
    tail.baseline - last.baseline < h * 0.8 ||
    tail.baseline - last.baseline > h * 1.6 ||
    !afterTail ||
    afterTail.baseline - tail.baseline < h * 2
  )
    return
  caption.push(tail)
  const firstCaption = caption[0].sourceItem.index,
    inputs = inventory.filter(
      (t) => /^Input:\s*/u.test(t.text) && t.sourceItem.index < firstCaption
    )
  if (inputs.length !== 1) return
  const body = inventory.filter(
      (t) => t.sourceItem.index >= inputs[0].sourceItem.index && t.sourceItem.index < firstCaption
    ),
    output = body.filter((t) => /^Output:\s*/u.test(t.text)),
    controls = body.filter((t) => /^for\b/u.test(t.text)),
    extent = union(body.map((t) => t.labelRect))
  if (
    body.length < 8 ||
    body.length > 4096 ||
    output.length !== 1 ||
    controls.length !== 3 ||
    body[0] !== inputs[0] ||
    Math.abs(inputs[0].height - h) > 1e-6 ||
    body.at(-1).baseline !== output[0].baseline ||
    Math.abs(output[0].rect[0] - inputs[0].rect[0]) > 0.02 ||
    title.x > inputs[0].rect[0] ||
    inputs[0].rect[0] - title.x > h * 2 ||
    title.width < (extent[2] - extent[0]) * 0.8 ||
    body.some((t) => /^(?:while|if|repeat|until|end|Algorithm|Figure|Table)\b/iu.test(t.text)) ||
    body.some((t) => /^(?:for|else|Input|Output)\b/iu.test(t.text) && Math.abs(t.height - h) > 1e-6)
  )
    return
  const vertical = context.rules.filter(
    (r) => r[0] === r[2] && r[1] < r[3] && r[1] > inputs[0].baseline && r[3] < output[0].baseline
  )
  if (vertical.length !== 3) return
  const sourceSet = new Set([...body, ...caption].map((t) => t.sourceItem.index)),
    v = { ...p.viewport, convertToViewportPoint: (x, y) => [x, page.height - y] },
    sourceContext = { ...p, viewport: v },
    sourceInventory = nativeInventory(page, sourceContext),
    frames = collectClosedFigureFrames(p.operators, v)
  if (
    !sourceInventory ||
    !completeNativeNodeGlyphState(page, sourceInventory, frames, sourceContext) ||
    p.operators.fnArray.some(
      (op, i) =>
        [OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(op) &&
        p.operators.argsArray[i]?.[0]?.toLowerCase() === '#ffffff'
    )
  )
    return
  const tokens = raw.map((r) => tableTextToken(r, v, 0)).filter((t) => t?.text?.trim()),
    proof = nativePageTextPacketInventory(page, tokens, sourceContext, false, sourceSet)
  if (!proof) return
  const selected = proof.records.filter((r) => sourceSet.has(r.index)),
    ownedGlyphs = new Set(selected.flatMap((r) => r.part.map((z) => z.g)))
  if (
    selected.length !== sourceSet.size ||
    selected.some((r) => !r.advanceComplete || !valid(r.ink) || r.part.some((z) => !valid(z.g.ink)))
  )
    return
  const bodyInk = union(selected.filter((r) => r.index < firstCaption).map((r) => r.ink)),
    captionInk = union(selected.filter((r) => r.index >= firstCaption).map((r) => r.ink))
  if (bodyInk[3] >= captionInk[1]) return
  const paint = new Map(),
    nativeRules = collectTableRules(context.operators, context.viewport, paint),
    bindings = []
  for (const c of controls) {
    const row = body.filter(
        (t) => Math.abs(t.height - h) < 1e-6 && Math.abs(t.baseline - c.baseline) < 1e-6
      ),
      matches = vertical.filter(
        (r) =>
          r[0] > c.rect[0] && r[0] - c.rect[0] < h && r[1] >= c.baseline && r[1] - c.baseline < h
      )
    if (
      row[0] !== c ||
      !/^for\b.+\bdo$/u.test(row.map((t) => t.text.trim()).join(' ')) ||
      matches.length !== 1
    )
      return
    const rule = matches[0],
      owners = page.graphicsBounds.filter(
        (g) =>
          g.kind === 'path' &&
          inside(
            g.normalizedRect.map((n, i) => n * (i % 2 ? page.height : page.width)),
            rule
          )
      )
    if (
      nativeRules.filter((r) => equal(r, rule)).length !== 1 ||
      owners.length !== 1 ||
      !paint.has(rule.join(','))
    )
      return
    const id = owners[0].operationIndex,
      a = context.operators.argsArray[id],
      path = a?.[1]?.[0],
      removed = {
        fnArray: [...context.operators.fnArray],
        argsArray: [...context.operators.argsArray]
      }
    if (
      context.operators.fnArray[id] !== OPS.constructPath ||
      a?.[0] !== OPS.stroke ||
      a[1]?.length !== 1 ||
      path?.length !== 6 ||
      path[0] !== 0 ||
      path[3] !== 1
    )
      return
    removed.fnArray[id] = OPS.dependency
    removed.argsArray[id] = ['removed-native-scope']
    if (collectTableRules(removed, context.viewport).some((r) => equal(r, rule))) return
    const enclosed = body.filter(
        (t) => Math.abs(t.height - h) < 1e-6 && t.baseline > rule[1] && t.baseline < rule[3]
      ),
      end = enclosed.at(-1)
    if (
      !end ||
      enclosed.some((t) => t.rect[0] <= rule[0]) ||
      rule[3] - end.baseline <= 0 ||
      rule[3] - end.baseline >= h
    )
      return
    bindings.push({ rule, id, ink: paint.get(rule.join(',')), gap: rule[3] - end.baseline })
  }
  const [root, a, b] = bindings
  if (
    new Set(bindings.map((b) => b.id)).size !== 3 ||
    [a, b].some(
      (c) =>
        c.rule[0] <= root.rule[0] ||
        c.rule[1] <= root.rule[1] ||
        c.rule[3] >= root.rule[3] ||
        Math.abs(c.gap - root.gap) > 0.02
    ) ||
    a.rule[3] >= b.rule[1] ||
    body.some(
      (t) =>
        t.sourceItem.index > controls[0].sourceItem.index &&
        t.sourceItem.index < output[0].sourceItem.index &&
        t.baseline > root.rule[3]
    ) ||
    !proveNativeUniqueWholeFonts([...body, ...caption], inventory)
  )
    return
  const rect = union([
      bodyInk,
      captionInk,
      ...bindings.map((b) => b.ink),
      ...caption.map((t) => t.labelRect)
    ]),
    foreignGlyphs = proof.glyphs
      .filter((g) => !ownedGlyphs.has(g) && valid(g.ink))
      .map((g) => g.ink),
    foreignPaint = [],
    graphicsIds = new Set(page.graphicsBounds.map((g) => g.operationIndex))
  if (
    graphicsIds.size !== page.graphicsBounds.length ||
    page.graphicsBounds.some((g) => g.kind !== 'path') ||
    !inside([0, 0, page.width, page.height], rect)
  )
    return
  for (const [id, state] of proof.evidence.paths) {
    const a = p.operators.argsArray[id]
    if (a?.[0] === OPS.endPath) continue
    if (!graphicsIds.delete(id)) return
    if (bindings.some((b) => b.id === id)) continue
    const tr = Util.transform(v.transform, state.transform),
      points = [],
      path = a?.[1]?.[0]
    if (!Array.isArray(path) && !ArrayBuffer.isView(path)) return
    for (let n = 0; n < path.length;) {
      const op = path[n++],
        count = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 4 ? 0 : -1
      if (count < 0 || n + count > path.length) return
      for (let j = 0; j < count; j += 2) points.push([path[n + j], path[n + j + 1]])
      n += count
    }
    if (!points.length) return
    const pad =
        a[0] === OPS.fill
          ? 0
          : (state.lineWidth * Math.max(1, proof.strokeMargins.get(id) ?? 10)) / 2,
      bounds = [
        Math.min(...points.map((p) => p[0])) - pad,
        Math.min(...points.map((p) => p[1])) - pad,
        Math.max(...points.map((p) => p[0])) + pad,
        Math.max(...points.map((p) => p[1])) + pad
      ]
    foreignPaint.push(proof.box(bounds, tr))
  }
  if (
    graphicsIds.size ||
    foreignPaint.some((r) => !valid(r)) ||
    [...foreignGlyphs, ...foreignPaint].some((r) => overlap(r, rect))
  )
    return
  return {
    rect,
    caption: {
      page: page.pageNumber,
      rect: union([captionInk, ...caption.map((t) => t.labelRect)]),
      lines: [title.text, tail.text]
    },
    nativeBody: { kind: 'algorithm', sourceItems: body.map((t) => ({ ...t.sourceItem })) },
    scopedGlyphProof: { foreignGlyphs, foreignPaint }
  }
}

export function acceptsNativeScopedAlgorithmPng(page, candidate, png) {
  const proof = candidate?.scopedGlyphProof,
    raster = getPdfCropRasterProtectionFromPng(png, candidate?.rect, page)
  return (
    !!proof &&
    !!raster &&
    Array.isArray(proof.foreignGlyphs) &&
    Array.isArray(proof.foreignPaint) &&
    [...proof.foreignGlyphs, ...proof.foreignPaint].every(
      (r) => valid(r) && !overlap(r, raster.protection)
    )
  )
}

export function findNativeAlgorithmCandidates(page, context = {}) {
  const { rules = [] } = context,
    old = findAlgorithmCandidates(page, rules)
  if (
    page.rotation !== 0 ||
    page.invalidGraphicsBounds !== 0 ||
    !Array.isArray(page.lines) ||
    rules.some((r) => !Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite))
  )
    return old
  const lines = groupPageLines(page),
    titles = lines.filter((l) => titlePattern.test(l.text))
  const result = old.map((candidate) =>
    closedNumberedFrame(page, candidate, lines, rules, context) ||
    nativeIndentedNumberedFrame(page, candidate, context)
      ? (proveNativeAlgorithmBody(page, candidate, context) ?? candidate)
      : candidate
  )
  for (const title of titles) {
    for (const c of [
      ...framedSteps(page, title, titles, rules, context),
      ...framedNumberedInput(page, title, titles, rules, context),
      ...framedLoop(page, title, titles, lines, rules, context),
      ...numberedScope(page, title, titles, lines, rules, context)
    ]) {
      const proved = proveNativeAlgorithmBody(page, c, context)
      if (!proved) continue
      const same = result.findIndex((other) => overlap(other.caption.rect, box(title)))
      if (result.some((other, i) => i !== same && overlap(other.rect, proved.rect))) continue
      if (same >= 0) result[same] = proved
      else result.push(proved)
    }
    const scoped = verticalScopedLoop(page, context, title, titles)
    if (scoped && !result.some((other) => overlap(other.rect, scoped.rect))) result.push(scoped)
  }
  return result
}
