/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { findAlgorithmCandidates } from './literature-pdf-numbered-native-procedure.mjs'
import { groupPageLines } from './literature-pdf-caption-group.mjs'
import { proveNativeUniqueWholeFonts } from './literature-pdf-table-evidence.mjs'
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'

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
    rect: inkRect ?? rect,
    caption: { ...caption, rect: captionRect },
    nativeBody: {
      kind: 'algorithm',
      sourceItems: body
        .map(({ sourceItem: { pageNumber, index, text } }) => ({ pageNumber, index, text }))
        .sort((a, b) => a.pageNumber - b.pageNumber || a.index - b.index)
    }
  }
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
    outputs = body.filter((l) => /^(?:Ensure|Outputs?)\s*:/i.test(l.text))
  if (
    ordinals.length < 4 ||
    ordinals.length > 128 ||
    inputs.length !== 1 ||
    // An explicit terminal return supplies the output when Ensure is absent.
    outputs.length > 1 ||
    inputs[0].bottom <= divider[1] ||
    inputs[0].y >= ordinals[0].y ||
    (outputs.length &&
      (outputs[0].y <= inputs[0].y ||
        (outputs[0].bottom >= ordinals[0].y &&
          !nativeOrdinalAfterOutput(page, context, ordinals[0], outputs[0])))) ||
    !/^\d+\s*:\s*return\b/i.test(ordinals.at(-1).text) ||
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
  const stack = []
  let loops = 0
  for (const l of ordinals) {
    const text = l.text.replace(/^\d+\s*:\s*/, '').trim(),
      open = /^(for|while)\b.+\bdo\s*$/i.exec(text) ?? /^(if)\b.+\bthen\s*$/i.exec(text),
      close = /^end\s+(for|while|if)\s*$/i.exec(text)
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
      if (current.kind !== 'if') loops++
      if (stack.length) stack.at(-1).body = true
      continue
    }
    if (
      /^(?:for|while|if|else|end)\b/i.test(text) ||
      (!text && !body.some((other) => other !== l && other.y < l.bottom && other.bottom > l.y))
    )
      return false
    if (stack.length) stack.at(-1).body = true
  }
  return loops > 0 && stack.length === 0
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
    closedNumberedFrame(page, candidate, lines, rules, context)
      ? (proveNativeAlgorithmBody(page, candidate, context) ?? candidate)
      : candidate
  )
  for (const title of titles) {
    for (const c of [
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
  }
  return result
}
