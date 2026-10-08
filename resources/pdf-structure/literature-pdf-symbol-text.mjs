/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs'
import {
  joinHorizontalTableRules,
  clusterTableRulePositions,
  classifyTableRuleEdge
} from './literature-pdf-table-rules.mjs'

function closedTextFrames(context) {
  if (!context?.viewport || context.viewport.rotation !== 0 || !context.rules) return []
  const horizontal = joinHorizontalTableRules(context.rules, 1),
    groups = []
  for (const rule of horizontal) {
    const group = groups.find(
      (g) => Math.abs(g[0][0] - rule[0]) < 0.1 && Math.abs(g[0][2] - rule[2]) < 0.1
    )
    if (group) group.push(rule)
    else groups.push([rule])
  }
  const vertical = context.rules.filter((r) => r[0] === r[2])
  return groups.flatMap((group) => {
    if (group.length < 4) return []
    const [left, top, right] = group[0],
      bottom = group.at(-1)[1]
    const xs = clusterTableRulePositions(
      vertical
        .filter(
          (r) => r[0] >= left - 0.1 && r[0] <= right + 0.1 && r[1] >= top - 1 && r[3] <= bottom + 1
        )
        .map((r) => r[0])
    )
    if (
      xs.length < 4 ||
      Math.abs(xs[0] - left) > 0.1 ||
      Math.abs(xs.at(-1) - right) > 0.1 ||
      xs.some((x) => classifyTableRuleEdge(vertical, 0, x, top, bottom) !== 1)
    )
      return []
    return [{ rect: [left, top, right, bottom], cuts: xs.slice(1, -1) }]
  })
}

function closedCellParts(item, glyphs, first, scale, context, frames) {
  if (!frames.length || item.transform[1] !== 0 || item.transform[2] !== 0) return
  const [x, y] = context.viewport.convertToViewportPoint(item.transform[4], item.transform[5])
  const unit = context.viewport.scale
  const owners = frames.filter(
    ({ rect, numericOnly }) =>
      (!numericOnly || /^[<>≤≥−+\d.\s-]+$/u.test(item.str)) &&
      x >= rect[0] &&
      x + item.width * unit <= rect[2] &&
      y - item.height * unit >= rect[1] &&
      y <= rect[3]
  )
  if (owners.length !== 1) return
  const boundaries = []
  for (const [cutIndex, cut] of owners[0].cuts.entries()) {
    if (cut <= x || cut >= x + item.width * unit) continue
    const band = owners[0].gutterBands?.[cutIndex]
    const matches = glyphs.slice(1).flatMap((g, n) => {
      const a = x + (glyphs[n].end - first.start) * scale * unit,
        b = x + (g.start - first.start) * scale * unit
      const inside = band
        ? ((a >= band[0] && b <= band[1]) || (a < cut && b > cut)) &&
          b - a >= item.height * unit * 0.25
        : a < cut && b > cut && b - a > 0.1
      return inside ? [n + 1] : []
    })
    // A complete body label can overhang the corresponding header gutter.
    // The descriptive-record proof validates that whole label in its lane.
    if (!matches.length && band && x + item.width * unit <= band[1]) continue
    if (matches.length !== 1) return
    boundaries.push(matches[0])
  }
  if (!boundaries.length) return
  let count = 0,
    start = 0
  const parts = []
  for (const match of item.str.matchAll(/\S/gu)) {
    const index = match.index
    if (boundaries.includes(count)) {
      if (!/\s/u.test(item.str[index - 1] ?? '')) return
      parts.push(item.str.slice(start, index).trim())
      start = index
    }
    count++
  }
  parts.push(item.str.slice(start).trim())
  return parts.length === boundaries.length + 1 && parts.every(Boolean) ? parts : undefined
}

// Independent text operations can be joined into one PDF.js item. Observe their
// explicit text/graphics positions only; the numeric splitter retains its own
// eligibility rules and never uses this observation to infer a column.
function positionedNativeGlyphs(operators) {
  const points = new Map(),
    stack = []
  let matrix = [1, 0, 0, 1, 0, 0],
    textMatrix = [...matrix]
  let size = 0,
    charSpace = 0,
    wordSpace = 0,
    hScale = 1,
    rise = 0,
    leading = 0
  let x = 0,
    y = 0,
    lineX = 0,
    lineY = 0,
    active = false
  const move = (dx, dy) => {
    x = lineX += dx
    y = lineY += dy
  }
  for (let run = 0; run < operators.fnArray.length; run++) {
    const op = operators.fnArray[run],
      args = operators.argsArray[run]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push({ matrix, size, charSpace, wordSpace, hScale, rise, leading })
      if (op === OPS.paintFormXObjectBegin && args[0])
        matrix = Util.transform(matrix, Array.from(args[0]))
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const state = stack.pop()
      if (state) ({ matrix, size, charSpace, wordSpace, hScale, rise, leading } = state)
      else active = false
    } else if (op === OPS.transform) matrix = Util.transform(matrix, args)
    else if (op === OPS.beginText) {
      textMatrix = [1, 0, 0, 1, 0, 0]
      x = y = lineX = lineY = 0
      active = true
    } else if (op === OPS.endText) active = false
    else if (op === OPS.setTextMatrix) {
      textMatrix = Array.from(args)
      x = y = lineX = lineY = 0
    } else if (op === OPS.moveText) move(args[0], args[1])
    else if (op === OPS.setLeadingMoveText) {
      leading = -args[1]
      move(args[0], args[1])
    } else if (op === OPS.nextLine) move(0, -leading)
    else if (op === OPS.setFont) size = args[1]
    else if (op === OPS.setCharSpacing) charSpace = args[0]
    else if (op === OPS.setWordSpacing) wordSpace = args[0]
    else if (op === OPS.setHScale) hScale = args[0] / 100
    else if (op === OPS.setTextRise) rise = args[0]
    else if (op === OPS.setLeading) leading = args[0]
    else if ([OPS.nextLineShowText, OPS.nextLineSetSpacingShowText, OPS.setGState].includes(op))
      active = false
    else if (op === OPS.showText) {
      const transform = Util.transform(matrix, textMatrix),
        glyphs = new Map()
      const valid =
        active &&
        transform.every(Number.isFinite) &&
        transform[0] > 0 &&
        transform[3] > 0 &&
        Math.abs(transform[1]) < 1e-8 &&
        Math.abs(transform[2]) < 1e-8 &&
        [size, charSpace, wordSpace, hScale, rise, x, y].every(Number.isFinite) &&
        size > 0 &&
        hScale > 0
      for (const [index, glyph] of args[0].entries()) {
        if (typeof glyph === 'number') {
          x -= ((glyph * size) / 1000) * hScale
          continue
        }
        if (!glyph || !Number.isFinite(glyph.width)) {
          active = false
          continue
        }
        const width = (glyph.width * size) / 1000
        const start = [x, y + rise],
          end = [x + width * hScale, y + rise]
        if (valid) {
          Util.applyTransform(start, transform)
          Util.applyTransform(end, transform)
          glyphs.set(index, {
            start,
            end,
            axis: size * hScale * transform[0],
            height: size * transform[3]
          })
        }
        x += (width + charSpace + (glyph.isSpace ? wordSpace : 0)) * hScale
      }
      if (valid && active) points.set(run, glyphs)
    }
  }
  return points
}

function observePositionedGlyphs(glyphs, item, points, scale) {
  const first = glyphs[0],
    start = points.get(first.run)?.get(first.glyphIndex)?.start
  if (
    !start ||
    Math.abs(start[0] - item.transform[4]) > 0.02 ||
    Math.abs(start[1] - item.transform[5]) > 0.02
  )
    return
  const measured = []
  for (const glyph of glyphs) {
    const point = points.get(glyph.run)?.get(glyph.glyphIndex)
    if (
      !point ||
      ![...point.start, ...point.end, point.axis, point.height].every(Number.isFinite) ||
      Math.abs(point.start[1] - start[1]) > 0.02 ||
      Math.abs(point.end[1] - start[1]) > 0.02 ||
      Math.abs(point.axis - item.transform[0]) > 0.02 ||
      Math.abs(point.height - item.height) > 0.02
    )
      return
    measured.push({
      ...glyph,
      start: first.start + (point.start[0] - start[0]) / scale,
      end: first.start + (point.end[0] - start[0]) / scale
    })
  }
  if (measured.some((g, n) => g.end < g.start || (n && g.start < measured[n - 1].start - 0.001)))
    return
  return measured
}

// Recover separate numeric entries from one PDF.js item using the original TJ
// advances, not equal-width guesses. Bounded count/fraction, header and statistic
// patterns are eligible; incompatible font streams or geometry remain untouched.
export function splitPdfNumericRuns(content, operators, context) {
  const observeWhitespace = context?.observeWhitespace
  const positioned = observeWhitespace ? positionedNativeGlyphs(operators) : undefined
  const frames =
    context?.viewport?.rotation === 0
      ? [...closedTextFrames(context), ...(context?.provenFrames ?? [])]
      : []
  const pattern = /^\d+(?:\.\d+)?\s*\(\d+\/\d+\)(?:\s+\d+(?:\.\d+)?\s*\(\d+\/\d+\))+$/
  const joinedHeader = /^(\d+\))\s+([A-Za-z][A-Za-z -]+\s*\(n)$/
  const closingCategory = /^([)\]])\s+(\p{L}[\p{L}\s/-]+)$/u
  const joinedRange = /^(.+\((?:range|IQR)\))\s+(\d+(?:\.\d+)?\s*\(\d+(?:\.\d+)?)$/i
  const spacedStatistics =
    /^([−+-]?(?:\d+(?:\.\d+)?|\.\d+))\s+([−+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\([−–+-]?\d+(?:\.\d+)?[−–-][−–+-]?\d+(?:\.\d+)?\))?|\*{1,3})$/
  const pairedSummary =
    /^(\d+(?:\.\d+)?\s*\(\d+(?:\.\d+)?(?:[–-]\d+(?:\.\d+)?)?\))\s+(\d+(?:\.\d+)?\s*\(\d+(?:\.\d+)?(?:[–-]\d+(?:\.\d+)?)?\))$/
  const intervalStatistic =
    /^(\d+(?:\.\d+)?(?:\s*\(\d+(?:\.\d+)?\))?\s*\[[−+-]?\d+(?:\.\d+)?,\s*[−+-]?\d+(?:\.\d+)?\])\s+([<>≤≥]?(?:\d+(?:\.\d+)?|\.\d+))$/u
  // A font change at the range separator can leave one item containing the
  // previous interval's end and the next interval's start. Require the same
  // measured gutter as complete paired summaries before separating them.
  const adjoiningIntervals =
    /^([−+-]?\d+(?:\.\d+)?\))\s+([−+-]?\d+(?:\.\d+)?\s*\([−+-]?\d+(?:\.\d+)?)$/
  const countStatistics =
    /^[<>≤≥−+-]?\d+(?:\.\d+)?(?:\s*\(\d+(?:\.\d+)?%?\))?(?:\s+[<>≤≥−+-]?\d+(?:\.\d+)?(?:\s*\(\d+(?:\.\d+)?%?\))?)+$/u
  const decimalRun = /^(?:[<>≤≥−+-]?(?:\d+\.\d+|\.\d+)\s+){2,}[<>≤≥−+-]?(?:\d+\.\d+|\.\d+)$/u
  const countParts = (text) =>
    decimalRun.test(text.trim()) ||
    (countStatistics.test(text.trim()) && /\(\d+(?:\.\d+)?%?\)/u.test(text))
      ? [...text.matchAll(/[<>≤≥−+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*\(\d+(?:\.\d+)?%?\))?/gu)].map(
          (match) => match[0]
        )
      : undefined
  const deviationParts = (text) =>
    /^[−+-]?\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?(?:\s+[−+-]?\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?)+(?:\s+[<>≤≥]?\d+(?:\.\d+)?)?$/u.test(
      text.trim()
    )
      ? [...text.matchAll(/[−+-]?\d+(?:\.\d+)?\s*±\s*\d+(?:\.\d+)?|[<>≤≥]?\d+(?:\.\d+)?/gu)].map(
          (m) => m[0]
        )
      : undefined
  const eligible = (text) =>
    pattern.test(text.trim()) ||
    joinedHeader.test(text.trim()) ||
    closingCategory.test(text.trim()) ||
    joinedRange.test(text.trim()) ||
    spacedStatistics.test(text.trim()) ||
    pairedSummary.test(text.trim()) ||
    intervalStatistic.test(text.trim()) ||
    adjoiningIntervals.test(text.trim()) ||
    !!countParts(text) ||
    !!deviationParts(text)
  if (
    !observeWhitespace &&
    !frames.length &&
    !content.items.some((i) => 'str' in i && eligible(i.str))
  )
    return content
  const streams = new Map(),
    stack = []
  let font,
    size = 0,
    charSpace = 0,
    wordSpace = 0
  for (let run = 0; run < operators.fnArray.length; run++) {
    const op = operators.fnArray[run],
      args = operators.argsArray[run]
    if (op === OPS.save) stack.push({ font, size, charSpace, wordSpace })
    else if (op === OPS.restore)
      ({ font, size, charSpace, wordSpace } = stack.pop() ?? {
        size: 0,
        charSpace: 0,
        wordSpace: 0
      })
    else if (op === OPS.setFont) [font, size] = args
    else if (op === OPS.setCharSpacing) charSpace = args[0]
    else if (op === OPS.setWordSpacing) wordSpace = args[0]
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      const stream = streams.get(font)
      let x = 0
      for (const [glyphIndex, glyph] of args[0].entries()) {
        if (typeof glyph === 'number') {
          x -= (glyph * size) / 1000
          continue
        }
        if (!glyph || typeof glyph.unicode !== 'string') continue
        const start = x
        x += (glyph.width * size) / 1000 + charSpace + (glyph.isSpace ? wordSpace : 0)
        for (const char of glyph.unicode
          .replace(/[ﬀ-ﬆ]/gu, (c) => c.normalize('NFKC'))
          .replace(/\s/gu, ''))
          stream.push({
            char,
            glyphIndex,
            start,
            // The observation endpoint excludes trailing character spacing,
            // matching PDF.js item.width. Keep the numeric splitter unchanged.
            end: observeWhitespace ? start + (glyph.width * size) / 1000 : x,
            run,
            size
          })
      }
    }
  }
  const source = new Map(),
    unmatchedStreams = new Map()
  for (const i of content.items)
    if ('str' in i)
      source.set(i.fontName, (source.get(i.fontName) ?? '') + i.str.replace(/\s/gu, ''))
  for (const [name, stream] of streams)
    if (stream.map((g) => g.char).join('') !== source.get(name)) {
      unmatchedStreams.set(name, stream)
      streams.delete(name)
    }
  const offsets = new Map()
  // A range separator in another font can split both neighboring intervals.
  // Require the original adjacent fragments to balance both intervals before
  // using their measured internal spacing to distinguish a narrow gutter.
  const boundedInterval = (item, index) => {
    if (item.transform[1] !== 0 || item.transform[2] !== 0 || item.transform[0] <= 0) return false
    const before = content.items.slice(index - 2, index),
      after = content.items.slice(index + 1, index + 3)
    if (before.length !== 2 || after.length !== 2) return false
    const number = '[−+-]?\\d+(?:\\.\\d+)?'
    if (
      !new RegExp(`^${number}\\s*\\(${number}$`).test(before[0].str?.trim()) ||
      !/^[–−-]$/.test(before[1].str?.trim()) ||
      !/^[–−-]$/.test(after[0].str?.trim()) ||
      !new RegExp(`^${number}\\)$`).test(after[1].str?.trim())
    )
      return false
    const fragments = [...before, item, ...after]
    return fragments.every(
      (fragment, n) =>
        fragment.transform &&
        fragment.dir === item.dir &&
        fragment.transform.slice(0, 4).every((value, axis) => value === item.transform[axis]) &&
        Math.abs(fragment.transform[5] - item.transform[5]) < 0.01 &&
        (!n ||
          Math.abs(fragment.transform[4] - fragments[n - 1].transform[4] - fragments[n - 1].width) <
            item.height * 0.1)
    )
  }
  return {
    ...content,
    items: content.items.flatMap((item, itemIndex) => {
      if (!('str' in item)) return [item]
      const offset = offsets.get(item.fontName) ?? 0,
        length = Array.from(item.str.replace(/\s/gu, '')).length
      offsets.set(item.fontName, offset + length)
      let local
      if (!streams.has(item.fontName)) {
        // A different ligature elsewhere can invalidate page-wide stream
        // alignment. Closed cells allow only a unique exact local match.
        const stream = unmatchedStreams.get(item.fontName)
        if ((!frames.length && !observeWhitespace) || !stream || !/\s/u.test(item.str))
          return [item]
        const text = item.str.replace(/\s/gu, ''),
          native = stream.map((g) => g.char).join('')
        const at = native.indexOf(text)
        if (at < 0 || native.indexOf(text, at + 1) >= 0) return [item]
        const nativeIndex = Array.from(native.slice(0, at)).length
        local = stream.slice(nativeIndex, nativeIndex + length)
      }
      if (
        (!observeWhitespace && !frames.length && !eligible(item.str)) ||
        !item.transform ||
        item.dir !== 'ltr' ||
        Math.abs(item.transform[0] * item.transform[2] + item.transform[1] * item.transform[3]) >
          0.001 ||
        item.transform[0] * item.transform[3] - item.transform[1] * item.transform[2] <= 0
      )
        return [item]
      let glyphs = local ?? streams.get(item.fontName).slice(offset, offset + length)
      const first = glyphs[0]
      if (!first || first.size <= 0) return [item]
      const axis = Math.hypot(item.transform[0], item.transform[1])
      const scale = axis / first.size
      const statistics =
        item.str.trim().match(spacedStatistics) ??
        item.str.trim().match(pairedSummary) ??
        item.str.trim().match(intervalStatistic) ??
        item.str.trim().match(adjoiningIntervals)
      let separateRuns = false
      if (glyphs.some((g) => g.run !== first.run)) {
        const observed =
          observeWhitespace && observePositionedGlyphs(glyphs, item, positioned, scale)
        if (observed) glyphs = observed
        else {
          if (!statistics && !frames.length) return [item]
          const split = statistics
              ? statistics[1].replace(/\s/g, '').length
              : glyphs.findIndex((g) => g.run !== first.run),
            second = glyphs[split]
          if (
            second.run === first.run ||
            glyphs.some(
              (g, n) => g.size !== first.size || g.run !== (n < split ? first.run : second.run)
            )
          )
            return [item]
          // PDF.js may combine two independent showText runs on one baseline.
          // Their measured glyph widths and the combined item extent determine
          // the sole intervening gap; no equal-width character estimate is used.
          const secondStart = first.start + item.width / scale - (glyphs.at(-1).end - second.start)
          const gap = (secondStart - glyphs[split - 1].end) * scale
          if (gap < 0 || (!frames.length && gap > item.height * 2)) return [item]
          if (intervalStatistic.test(item.str.trim()) && gap < item.height * 0.2) return [item]
          glyphs = glyphs.map((g, n) =>
            n < split
              ? g
              : {
                  ...g,
                  start: g.start + secondStart - second.start,
                  end: g.end + secondStart - second.start
                }
          )
          separateRuns = true
        }
      }
      if (scale <= 0 || Math.abs((glyphs.at(-1).end - first.start) * scale - item.width) > 0.02)
        return [item]
      if (observeWhitespace) {
        if (
          context.viewport?.rotation !== 0 ||
          item.transform[1] !== 0 ||
          item.transform[2] !== 0 ||
          !item.transform.every(Number.isFinite) ||
          !(Number.isFinite(item.width) && item.width > 0) ||
          !(Number.isFinite(item.height) && item.height > 0) ||
          !(Number.isFinite(context.viewport.scale) && context.viewport.scale > 0) ||
          glyphs.some((glyph) => !Number.isFinite(glyph.start) || !Number.isFinite(glyph.end))
        )
          return [item]
        const unit = context.viewport.scale,
          [x, baseline] = context.viewport.convertToViewportPoint(
            item.transform[4],
            item.transform[5]
          ),
          gaps = []
        let count = 0
        const characters = Array.from(item.str)
        for (let index = 0; index < characters.length; index++) {
          if (/\s/u.test(characters[index])) continue
          if (count && /\s/u.test(characters[index - 1])) {
            const left = x + (glyphs[count - 1].end - first.start) * scale * unit,
              right = x + (glyphs[count].start - first.start) * scale * unit
            if (right > left) gaps.push({ left, right, index: count })
          }
          count++
        }
        observeWhitespace({
          text: item.str,
          rect: [x, baseline - item.height * unit, x + item.width * unit, baseline],
          baseline,
          height: item.height * unit,
          gaps,
          glyphRuns: glyphs.map((glyph) => glyph.run),
          literalGlyphs: [...new Set(glyphs.map((glyph) => glyph.run))].flatMap((run) => {
            const matched = glyphs.filter((glyph) => glyph.run === run)
            // One TJ run may paint several PDF.js items. Keep only this item's
            // matched native span, including any real space glyph between its edges.
            return operators.argsArray[run][0]
              .slice(matched[0].glyphIndex, matched.at(-1).glyphIndex + 1)
              .flatMap((glyph) =>
                glyph && typeof glyph.unicode === 'string' ? [glyph.unicode] : []
              )
          })
        })
        return [item]
      }
      const closed = closedCellParts(item, glyphs, first, scale, context, frames)
      if (!closed && (local || !eligible(item.str))) return [item]
      let cursor = 0
      const joined =
        item.str.trim().match(joinedHeader) ??
        item.str.trim().match(joinedRange) ??
        item.str.trim().match(closingCategory) ??
        statistics
      // A closing delimiter may share one TJ run with the next column's
      // category. Require a measured half-em gutter, preserving normal prose.
      if (
        !closed &&
        closingCategory.test(item.str.trim()) &&
        (glyphs[1].start - glyphs[0].end) * scale < item.height * 0.5
      )
        return [item]
      if (!closed && statistics && !separateRuns) {
        const split = statistics[1].replace(/\s/g, '').length
        const gap = (glyphs[split].start - glyphs[split - 1].end) * scale
        const internalGap = Math.max(
          0,
          ...glyphs
            .slice(1)
            .flatMap((glyph, index) =>
              index + 1 === split ? [] : [(glyph.start - glyphs[index].end) * scale]
            )
        )
        const bounded =
          adjoiningIntervals.test(item.str.trim()) &&
          boundedInterval(item, itemIndex) &&
          gap > internalGap * 1.5 &&
          gap >= item.height * 0.25
        // A normal space or thousands separator is not a column boundary.
        if (
          !bounded &&
          gap <
            item.height *
              (pairedSummary.test(item.str.trim()) || adjoiningIntervals.test(item.str.trim())
                ? 0.5
                : 0.75)
        )
          return [item]
      }
      const counted = !joined && (countParts(item.str) ?? deviationParts(item.str))
      // Mixed count/percentage and P-value runs must have a measured column
      // gutter at every split. Ordinary inline statistics remain one token.
      if (!closed && counted) {
        let boundary = 0
        if (
          counted.slice(0, -1).some((part) => {
            boundary += part.replace(/\s/gu, '').length
            return (glyphs[boundary].start - glyphs[boundary - 1].end) * scale < item.height * 0.5
          })
        )
          return [item]
      }
      const fragments =
        closed ??
        (joined
          ? joined.slice(1)
          : (counted ?? [...item.str.matchAll(/\d+(?:\.\d+)?\s*\(\d+\/\d+\)/g)].map((m) => m[0])))
      const parts = fragments.map((text) => {
        const count = Array.from(text.replace(/\s/gu, '')).length,
          a = glyphs[cursor],
          b = glyphs[cursor + count - 1]
        cursor += count
        return {
          ...item,
          str: text,
          width: (b.end - a.start) * scale,
          transform: [
            ...item.transform.slice(0, 4),
            item.transform[4] + ((a.start - first.start) * scale * item.transform[0]) / axis,
            item.transform[5] + ((a.start - first.start) * scale * item.transform[1]) / axis
          ],
          hasEOL: cursor === length && item.hasEOL
        }
      })
      return parts.every(
        (p, i) =>
          p.width > 0 &&
          (!i ||
            ((p.transform[4] - parts[i - 1].transform[4]) * item.transform[0] +
              (p.transform[5] - parts[i - 1].transform[5]) * item.transform[1]) /
              axis >=
              parts[i - 1].width - 0.001)
      )
        ? parts
        : [item]
    })
  }
}

// Expose only measured whitespace from the same validated native stream used
// for splitting. This observation path never changes content or estimates ink.
export function nativeWhitespaceGaps(content, operators, viewport) {
  const runs = []
  splitPdfNumericRuns(content, operators, { viewport, observeWhitespace: (run) => runs.push(run) })
  return runs
}

// This embedded TeX font uses a legacy symbol encoding but is sometimes given a
// Latin ToUnicode map. These slots render as star/plus/equals in the font. Require
// both the font and original glyph code; never replace these characters globally.
const texSymbols = new Map([
  [0, ['\u0000', '−', 250]],
  [3, ['�', '*']],
  [133, ['ð', '(', 385]],
  [134, ['Þ', ')', 385]],
  [135, ['þ', '+']],
  [136, ['¼', '=']]
])
const galliardComparisonSubset = new Map([
  [81, ['«', '≤', 860, 'guillemotleft']],
  [82, ['»', '≥', 860, 'guillemotright']]
])
const comparisonSubset = new Map([
  [2, ['\u0002', '–', 770]],
  [3, ['\u0015', '≥', 770]],
  [4, ['\u0014', '≤', 770]]
])
const footnoteSubset = new Map([
  [3, ['\u0003', '±', 770]],
  [121, ['y', '†', 437]],
  [122, ['z', '‡', 437]]
])
const universalGlyphs = new Map([
  ['H11001', ['+', 833]],
  ['H11002', ['−', 833]],
  ['H11003', ['×', 833]],
  ['H11005', ['=', 833]],
  ['H11006', ['±', 833]],
  ['H11021', ['<', 833]],
  ['H11022', ['>', 833]],
  ['H9257', ['η', 611]],
  ['H9273', ['χ', 556]]
])
const latinPiSymbols = new Map([
  [
    'MathematicalPi-One',
    new Map([
      [1, ['1', '+', 833, 'one']],
      [2, ['b', 'β', 611, 'b']],
      [4, ['m', 'μ', 667, 'm']],
      [5, ['2', '−', 833, 'two']],
      [6, [',', '<', 833, 'comma']],
      [7, ['5', '=', 833, 'five']],
      [9, ['l', 'λ', 556, 'l']],
      [10, ['´', 'ε', 500, 'acute']],
      [11, ['k', 'κ', 556, 'k']],
      [12, ['a', 'α', 611, 'a']],
      [13, ['g', 'γ', 556, 'g']]
    ])
  ],
  ['MathematicalPi-Four', new Map([[1, ['2', '−', 833, 'two']]])]
])
const publisherSymbols = new Map([
  // AdvT041 encodes common `ffi`/`fl` ligatures as legacy punctuation slots.
  // PDF.js exposes those slots as fraction slash and pound sign respectively.
  [
    'AdvT041',
    new Map([
      [135, ['⁄', 'ffi', 770]],
      [161, ['¡', 'ff', 562]],
      [162, ['¢', 'fi', 500]],
      [163, ['£', 'fl', 500]]
    ])
  ],
  // AdvPSSym uses a narrow fraction-slash code for ordinary inline separators.
  [
    'AdvPSSym',
    new Map([
      [135, ['⁄', '/', 166]],
      [133, ['–', '±', 552]],
      [163, ['£', '≤', 552]],
      [130, ['‡', '≥', 552]]
    ])
  ],
  ['AdvT678', new Map([[162, ['¢', 'fi', 500]]])],
  // AdvMPi-One uses its legacy `five` slot for an equals sign in compact
  // sample-size headers (PDF.js otherwise exposes the painted glyph as `5`).
  ['AdvMPi-One', new Map([[53, ['5', '=', 833]]])],
  // Some articles from the same legacy publisher use a dedicated
  // AdvPSSPS-AS subset for the minus sign.  PDF.js exposes its only glyph as
  // `)` because the embedded ToUnicode entry points at parenright; the
  // subset name, slot, and advance width together identify the painted dash.
  ['AdvPSSPS-AS', new Map([[41, [')', '−', 635]]])],
  [
    'AdvOT463cc31e',
    new Map([
      [44, [',', '<', 822]],
      [46, ['.', '>', 822]],
      [49, ['1', '+', 822]],
      [50, ['2', '−', 822]],
      [51, ['3', '×', 822]],
      [53, ['5', '=', 822]],
      [54, ['6', '±', 822]]
    ])
  ],
  ['AdvOT9d186844', new Map([[53, ['5', '=', [822, 833]]]])],
  [
    'AdvOT8817665d',
    new Map([
      [35, ['#', '≤', 822]],
      [36, ['$', '≥', 822]]
    ])
  ],
  ['AdvPS_SSYB', new Map([[135, ['‡', '≥', 604]]])],
  ['AdvP3EAA99', new Map([[120, ['x', 'χ', 552]]])],
  [
    'AdvP7DA6',
    new Map([
      [1, [',', '<', 833, 'comma']],
      [2, ['>', '≥', 833, 'greater']],
      [98, ['b', 'β', 614, 'b']],
      [114, ['r', 'ρ', 500, 'r']],
      [109, ['m', 'µ', 666]]
    ])
  ],
  [
    'AdvPS586B',
    new Map([
      [44, [',', '<', 833]],
      [49, ['1', '+', 833]],
      [50, ['2', '−', 833]],
      [54, ['6', '±', 833]],
      [53, ['5', '=', 833]]
    ])
  ],
  [
    'AdvP80675',
    new Map([
      [44, [',', '<', 833, 'comma']],
      [49, ['1', '+', 833]],
      [50, ['2', '−', 833]],
      [54, ['6', '±', 833]]
    ])
  ],
  ['AdvP586B', new Map([[54, ['6', '±', 833]]])],
  [
    'AdvPS7DED',
    new Map([
      [50, ['2', '−', 833]],
      [53, ['5', '=', 833]]
    ])
  ],
  ['AdvMT_SY', new Map([[188, ['¼', '=', 770]]])],
  ['AdvPSMSAM10', new Map([[88, ['X', '✓', 833, 'X']]])],
  ['MinionMathSymbols', new Map([[136, ['�', '=', 583]]])],
  [
    'TeX_CM_Bold_Maths_Symbols',
    new Map([
      [136, ['¼', '=', 885]],
      [135, ['þ', '+', 885]]
    ])
  ],
  [
    'AdvTT454a7a89',
    new Map([
      [98, ['b', '<', 562]],
      [78, ['N', '>', 562]]
    ])
  ],
  ['AdvPS_TINR', new Map([[2, ['\u0091', '½', 822, 'C145']]])],
  [
    'AdvPS4731B1',
    new Map([
      [33, ['!', '<', 1000]],
      [79, ['O', '>', 1000]]
    ])
  ],
  ['AdvPS3F4C13', new Map([[117, ['u', 'ω', 718]]])],
  [
    'AdvP0003',
    new Map([
      [106, ['j', '−', 833]],
      [81, ['Q', '≥', 552, 'Q']]
    ])
  ],
  [
    'AdvP0004',
    new Map([
      [71, ['G', '<', 562]],
      [57, ['9', '>', 562]]
    ])
  ],
  ['AdvP0005', new Map([[89, ['Y', '–', 500]]])],
  // AdvP0DE0 paints these legacy WinAnsi slots as an en dash and fi ligature.
  // The dedicated math font supplies real plus/minus signs separately.
  [
    'AdvP0DE0',
    new Map([
      [177, ['±', '–', 552]],
      [174, ['Æ', 'fi', 614]]
    ])
  ],
  ['AdvPS.MH4', new Map([[53, ['5', '=', 833]]])],
  [
    'AdvPSMP4',
    new Map([
      [91, ['[', '>', 1000]],
      [92, ['\\', '<', 1000]]
    ])
  ],
  [
    'AdvPSMP11',
    new Map([
      [98, ['b', 'β', 500]],
      [108, ['l', 'μ', 552]]
    ])
  ],
  [
    'AdvPSMP10',
    new Map([
      [98, ['b', 'β', 552]],
      [100, ['d', 'δ', 500, 'd']],
      [118, ['v', 'χ', 500]]
    ])
  ],
  // This dedicated subset paints the Taurus-shaped statistical note marker.
  ['AdvOTddb58f6f', new Map([[98, ['b', '♉', 1000, 'b']]])],
  ['AdvP697C', new Map([[97, ['a', 'α', 635, 'a']]])],
  [
    'AdvP7DED',
    new Map([
      [97, ['a', 'α', 666]],
      [49, ['1', '+', 833, 'one']],
      [53, ['5', '=', 833, 'five']]
    ])
  ],
  [
    'AdvPi1',
    new Map([
      [123, ['{', '†', 500]],
      [52, ['4', '>', 1000]],
      [43, ['+', '±', 1000]],
      [119, ['w', 'χ', 552]]
    ])
  ],
  [
    'AdvMacMthSyN',
    new Map([
      [188, ['¼', '=', 781]],
      [2, ['\u0002', '−', 781, 'C0']]
    ])
  ],
  [
    'AdvEls-ent4',
    new Map([
      [111, ['o', '<', 979]],
      [114, ['r', '≤', 979]]
    ])
  ],
  ['AdvEls-ent5', new Map([[90, ['Z', '≥', 979]]])],
  ['AdvGreek_B', new Map([[108, ['l', 'μ', 552]]])],
  [
    'AdvPSMP13',
    new Map([
      [68, ['D', 'Δ', 666]],
      [97, ['a', 'α', 552]],
      [98, ['b', 'β', 552]],
      [99, ['c', 'γ', 500]],
      [108, ['l', 'μ', 552]],
      [118, ['v', 'χ', 552]]
    ])
  ],
  [
    'AdvTir_symb',
    new Map([
      [63, ['?', '+', 781]],
      [66, ['B', '≤', 750]],
      [67, ['C', '≥', 750]]
    ])
  ],
  [
    'WTimesGreekSF-One',
    new Map([
      [176, ['∞', '<', 833]],
      [185, ['π', '+', 833]],
      [186, ['∫', '±', 833]],
      [189, ['Ω', '=', 833]]
    ])
  ],
  [
    'AdvPS3FDD77',
    new Map([
      [90, ['Z', '=', 1000]],
      [91, ['[', '=', 1000]]
    ])
  ],
  ['AdvP7CA8', new Map([[85, ['U', '=', 833]]])],
  ['AdvMathSymb', new Map([[188, ['¼', '=', 781, 'onequarter']]])],
  [
    'AdvP4C4E74',
    new Map([
      [112, ['p', '✓', 822, 'p']],
      // Verified footnote bars in this math subset, distinct from Latin k/j.
      [107, ['k', '‖', 500, 'k']],
      [106, ['j', '|', 270, 'j']],
      [48, ['0', '′', 270, 'zero']],
      [188, ['¼', '=', 770]],
      [136, ['à', '=', 770]],
      [2, ['\u0002', '±', 770]],
      [4, ['\u0004', '±', 770]],
      [20, ['\u0014', '≤', 770]],
      [21, ['\u0015', '≥', 770]],
      [135, ['á', '+', 770]],
      [1, ['\u0001', '−', 770]]
    ])
  ],
  [
    'AdvPS7DA6',
    new Map([
      [36, ['$', '≥', 833]],
      [35, ['#', '≤', 833]],
      [53, ['5', '=', 833]],
      [44, [',', '<', 833, 'comma']]
    ])
  ],
  [
    'NewGalliard-Roman',
    new Map([
      [74, ['»', '≥', 860, 'guillemotright']],
      [71, ['«', '≤', 860, 'guillemotleft']]
    ])
  ],
  ['AdvP4C4E3A', new Map([[188, ['¼', '=', 885]]])],
  ['AdvP4C9543', new Map([[167, ['§', '±', 781]]])],
  [
    'Universal-GreekwithMathPi',
    new Map([
      [1, ['\u0001', '=', 833]],
      [2, ['\u0002', '±', 833]],
      [3, ['\u0003', '<', 833]]
    ])
  ],
  [
    'MathematicalPi-Four',
    new Map([
      [1, ['\u0001', '=', 833]],
      [2, ['\u0002', '±', 833]],
      [53, ['5', '=', 833, 'five']]
    ])
  ],
  [
    'MathematicalPi-One',
    new Map([
      [1, ['\u0001', 'µ', 667]],
      [5, ['\u0005', 'χ', 556, 'H9273']],
      // Verified legacy slots with their native 833-unit math advances.
      [35, ['#', '≤', 833]],
      [36, ['$', '≥', 833]],
      [44, [',', '<', 833, 'comma']],
      [49, ['1', '+', 833]],
      [50, ['2', '−', 833]],
      [53, ['5', '=', 833]],
      [54, ['6', '±', 833]]
    ])
  ],
  [
    // This math font paints paired parentheses at the legacy s/d slots.
    // Native glyph advances distinguish them from ordinary Times letters.
    'MathematicalPi-Three',
    new Map([
      [115, ['s', '(', 333]],
      [100, ['d', ')', 333]]
    ])
  ],
  [
    'MathematicalPi-Six',
    new Map([
      [1, ['\u0001', '*', 500, 'H11569']],
      [2, ['\u0002', '*', 500, 'H11569']]
    ])
  ]
])

// Re-subsetting can prepend a second six-letter tag without a plus sign.
// Strip it only when the remaining family already has verified slot mappings;
// the glyph's original code, Unicode and advance width are still checked below.
const symbolFontName = (name) => {
  const family = name?.replace(/^[A-Z]{6}\+/, '')
  const untagged = family?.replace(/^[A-Z][a-z]{5}(?=Adv)/, '')
  return publisherSymbols.has(untagged) ? untagged : family
}

// These subsets paint mathematical outlines under Latin encoding names. Admit
// only the complete reviewed Type1 encoding, then check the native glyph slot,
// Unicode and advance below. A family name alone is insufficient evidence.
const reviewedSubsetSymbols = (font, name) => {
  // This CID subset retains the Windows Symbol PUA character. Symbol encoding
  // B3 names greaterequal and its native advance is 549; do not infer it from
  // neighboring numeric text or apply the mapping to other subset codes.
  if (
    name === 'SymbolMT' &&
    font.type === 'CIDFontType2' &&
    Array.isArray(font.differences) &&
    font.differences.length === 0
  )
    return new Map([[3, ['\uf0b3', '≥', 549]]])
  if (font.type !== 'Type1' || !Array.isArray(font.differences)) return undefined
  const matches = (length, entries) =>
    font.differences.length === length &&
    font.differences.filter(Boolean).length === entries.length &&
    entries.every(([slot, value]) => font.differences[slot] === value)
  if (
    name === 'MathTechnicalPD' &&
    matches(57, [
      [32, 'space'],
      [56, 'eight']
    ])
  )
    return new Map([[56, ['8', '±', 1000]]])
  if (name === 'Universal-GreekwithMathPi') {
    if (
      matches(32, [
        [30, 'six'],
        [31, 'comma']
      ])
    )
      return new Map([
        [30, ['6', '±', 833]],
        [31, [',', '<', 833]]
      ])
    if (
      matches(32, [
        [27, 'one'],
        [28, 'six'],
        [29, 'space'],
        [30, 'comma'],
        [31, 'x']
      ])
    )
      return new Map([
        [28, ['6', '±', 833]],
        [30, ['\ue02c', '<', 833]],
        [31, ['\ue078', 'χ', 556]]
      ])
  }
  if (
    name === 'AdvP4C4E74' &&
    matches(255, [
      [2, 'C21'],
      [3, 'C20'],
      [4, 'C0'],
      [188, 'onequarter'],
      [254, 'thorn']
    ])
  )
    return new Map([[254, ['þ', '+', 770]]])
  if (name === 'AdvP7DA6') {
    if (
      matches(58, [
        [35, 'numbersign'],
        [36, 'dollar'],
        [44, 'comma'],
        [46, 'period'],
        [57, 'nine']
      ])
    )
      return new Map([
        [35, ['#', '≤', 833]],
        [36, ['$', '≥', 833]],
        [44, [',', '<', 833]],
        [46, ['.', '>', 833]]
      ])
    if (
      matches(64, [
        [35, 'numbersign'],
        [44, 'comma'],
        [46, 'period'],
        [63, 'question']
      ])
    )
      return new Map([
        [44, [',', '<', 833]],
        [46, ['.', '>', 833]],
        [63, ['?', '·', 333]]
      ])
  }
  if (name === 'AdvMacms' && matches(3, [[2, 'C3']])) return new Map([[2, ['\u0002', '*', 500]]])
  if (font.differences.length) return undefined
  // The embedded CMEX9/CMEX10 Type1 Encoding names slot 112 /radicalbig, but a
  // conflicting ToUnicode map can expose that large radical as Latin `p`.
  // Require its original slot, exact native advance and unmodified encoding;
  // another font, explicitly remapped slot or genuine Latin glyph stays intact.
  const radicalAdvance = new Map([
    ['CMEX9', 1027.8],
    ['CMEX10', 1000]
  ]).get(name)
  if (radicalAdvance !== undefined && font.defaultEncoding?.[112] === 'p')
    return new Map([[112, ['p', '√', radicalAdvance]]])
  const punctuation = new Map([
    ['AdvPS44A44B', [36, '$', '·', 447, 'dollar']],
    ['AdvP3F4C13', [104, 'h', 'η', 635, 'h']],
    ['AdvTT98d9a78a', [75, 'K', 'µ', 666, 'K']],
    ['AdvPSMP10', [97, 'a', 'α', 500, 'a']],
    ['AdvEls-ent8', [55, '7', '±', 979, 'seven']],
    ['AdvEls-ent5', [88, 'X', '≥', 979, 'X']]
  ]).get(name)
  if (punctuation && font.defaultEncoding?.[punctuation[0]] === punctuation[4])
    return new Map([[punctuation[0], punctuation.slice(1, 4)]])
  return undefined
}

// PDF.js classifies a missing ToUnicode entry by its numeric CID. When that
// happens to be a combining-mark code point it reports zero width, even though
// the PDF paints a positive-advance glyph. Recover geometry only: the intended
// Unicode character is still unknown. Mapped marks and unmatched streams stay
// untouched.
function recoverUnmappedCidAdvances(page, content, operators) {
  if (!content.items.some((item) => item.width === 0 && /^\p{Mn}$/u.test(item.str ?? '')))
    return content
  const streams = new Map(),
    stack = []
  let fontName,
    size = 0,
    charSpace = 0
  for (let index = 0; index < (operators?.fnArray.length ?? 0); index++) {
    const op = operators.fnArray[index],
      args = operators.argsArray[index]
    if (op === OPS.save) stack.push({ fontName, size, charSpace })
    else if (op === OPS.restore)
      ({ fontName, size, charSpace } = stack.pop() ?? { size: 0, charSpace: 0 })
    else if (op === OPS.setFont) [fontName, size] = args
    else if (op === OPS.setCharSpacing) charSpace = args[0]
    else if (op === OPS.showText && fontName) {
      if (!streams.has(fontName)) streams.set(fontName, [])
      for (const glyph of args[0]) {
        if (!glyph || typeof glyph.unicode !== 'string') continue
        for (const char of glyph.unicode.replace(/\s/gu, ''))
          streams.get(fontName).push({ char, glyph, charSpace, size })
      }
    }
  }
  const source = new Map(),
    offsets = new Map()
  for (const item of content.items)
    if ('str' in item)
      source.set(item.fontName, (source.get(item.fontName) ?? '') + item.str.replace(/\s/gu, ''))
  for (const [name, stream] of streams)
    if (stream.map((entry) => entry.char).join('') !== source.get(name)) streams.delete(name)
  return {
    ...content,
    items: content.items.map((item) => {
      if (!('str' in item) || !streams.has(item.fontName)) return item
      const offset = offsets.get(item.fontName) ?? 0
      offsets.set(item.fontName, offset + [...item.str.replace(/\s/gu, '')].length)
      if (
        item.width !== 0 ||
        !Number.isFinite(item.height) ||
        item.height <= 0 ||
        !/^\p{Mn}$/u.test(item.str) ||
        item.dir !== 'ltr' ||
        !item.transform ||
        !item.transform.every(Number.isFinite) ||
        item.transform[0] <= 0 ||
        item.transform[3] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0
      )
        return item
      const entry = streams.get(item.fontName)[offset]
      if (
        !entry ||
        !Number.isFinite(entry.charSpace) ||
        !(entry.size > 0) ||
        entry.glyph.unicode !== item.str
      )
        return item
      const glyph = entry.glyph
      if (glyph.originalCharCode !== item.str.codePointAt(0) || !(glyph.width > 0)) return item
      let font
      try {
        font = page.commonObjs?.get?.(item.fontName)
      } catch {
        return item
      }
      const map = font?.toUnicode?._map,
        matrix = font?.fontMatrix
      if (
        font?.composite !== true ||
        font.type !== 'CIDFontType2' ||
        !map ||
        map[glyph.originalCharCode] !== undefined ||
        font.widths?.[glyph.originalCharCode] !== glyph.width ||
        !matrix ||
        matrix.length !== 6 ||
        matrix[0] !== 0.001 ||
        matrix[3] !== 0.001 ||
        matrix[1] !== 0 ||
        matrix[2] !== 0 ||
        matrix[4] !== 0 ||
        matrix[5] !== 0
      )
        return item
      const width = (glyph.width * matrix[0] + entry.charSpace / entry.size) * item.transform[0]
      return Number.isFinite(width) && width > 0 ? { ...item, width } : item
    })
  }
}

export async function repairPdfSymbolText(page, content, operators) {
  if (content.items.some((item) => item.transform)) operators ??= await page.getOperatorList()
  content = recoverUnmappedCidAdvances(page, content, operators)
  content = repairSpacedTextOffsets(content, operators)
  const originalContent = content
  // Myriad's fitted numeral glyphs retain Adobe private-use codes in some
  // PDFs. Check the font and its encoding entry rather than replacing private
  // Unicode globally: other fonts may paint unrelated outlines at these slots.
  if (
    content.items.some(
      (item) => 'str' in item && /[\uf130-\uf139\uf639-\uf641\uf6dc]/u.test(item.str)
    )
  ) {
    operators ??= await page.getOperatorList()
    const fitted = new Map([
      ['\uf639', '0'],
      ['\uf6dc', '1'],
      ['\uf63a', '2'],
      ['\uf63b', '3'],
      ['\uf63c', '4'],
      ['\uf63d', '5'],
      ['\uf63e', '6'],
      ['\uf63f', '7'],
      ['\uf640', '8'],
      ['\uf641', '9']
    ])
    content = {
      ...content,
      items: content.items.map((item) => {
        if (!('str' in item) || !/[\uf130-\uf139\uf639-\uf641\uf6dc]/u.test(item.str)) return item
        const font = page.commonObjs.get(item.fontName)
        const name = symbolFontName(font.name)
        const privateDigits = ['AdvOTfc06a83e+f1', 'AdvOT58b04b30.B+f1'].includes(name)
        if (!privateDigits && !/^MyriadPro-(?:Semibold)?SemiCn$/.test(name)) return item
        return {
          ...item,
          str: item.str.replace(
            privateDigits ? /[\uf130-\uf139]/gu : /[\uf639-\uf641\uf6dc]/gu,
            (char) =>
              font.differences?.includes(`uni${char.charCodeAt(0).toString(16).toUpperCase()}`)
                ? privateDigits
                  ? String(char.charCodeAt(0) - 0xf130)
                  : fitted.get(char)
                : char
          )
        }
      })
    }
  }
  const letters = new Map()
  for (const item of content.items) {
    if (!('str' in item)) continue
    if (!letters.has(item.fontName)) letters.set(item.fontName, new Set())
    for (const char of item.str) if (/[A-Za-z]/.test(char)) letters.get(item.fontName).add(char)
  }
  if ([...letters.values()].some((chars) => chars.size >= 35)) {
    operators ??= await page.getOperatorList()
    content = repairShiftedLatinCase(content, operators)
  }
  if (content.items.some((item) => 'str' in item && /\d{2}/u.test(item.str))) {
    operators ??= await page.getOperatorList()
    content = removeInvisibleNumericPadding(content, operators, originalContent)
  }
  // A few verified publisher subsets expose their only mathematical glyph as
  // an ordinary punctuation character.  Keep the fast-path for normal pages,
  // but admit a content item when its font is one of the explicitly mapped
  // subsets so the operator stream can repair that glyph.
  const hasMappedPublisherGlyph = content.items.some((item) => {
    if (!('str' in item)) return false
    try {
      const font = page.commonObjs?.get?.(item.fontName) ?? {}
      const name = symbolFontName(font.name)
      const mappings = reviewedSubsetSymbols(font, name) ?? publisherSymbols.get(name)
      return mappings
        ? [...mappings.values()].some(([unicode]) => item.str.includes(unicode))
        : false
    } catch {
      return false
    }
  })
  if (
    !hasMappedPublisherGlyph &&
    !content.items.some(
      (item) =>
        ('str' in item &&
          ([
            '�',
            'þ',
            'ð',
            'Þ',
            '¼',
            '§',
            '±',
            'Æ',
            'á',
            '\u0000',
            '\u0001',
            '\u0002',
            '\u0003',
            '\u0004',
            '\u0005',
            '\u0006',
            '\u0007',
            '\u0008',
            '\u0009',
            '\u000f',
            '?',
            'à',
            '\\',
            '\u0014',
            '\u0015',
            '$',
            '»',
            '«',
            '∞',
            'π',
            '∫',
            'Ω',
            'Ω'
          ].some((char) => item.str.includes(char)) ||
            /^[jGQ9](?:$|[\d.])|(?:^|\d)Y(?:$|\d)/.test(item.str) ||
            ['+', 'w', '!', 'O', '#'].includes(item.str) ||
            item.str === 'e' ||
            item.str === 'd' ||
            item.str === 'm' ||
            item.str === 'u' ||
            item.str === 'Z' ||
            item.str === 'U' ||
            item.str === '[' ||
            item.str === ',' ||
            item.str === 'D' ||
            item.str === 'C' ||
            item.str === 'B' ||
            item.str === 'o' ||
            item.str === 'a' ||
            item.str === 'b' ||
            (item.str.includes('v') && page.commonObjs?.get))) ||
        item.str === '0' ||
        item.str === '4' ||
        ['1', '2', 'l', '´', 'k', 'g'].includes(item.str) ||
        item.str === '5' ||
        item.str === '6' ||
        item.str === 'y' ||
        item.str === 'z'
    )
  )
    return removeBackgroundNumericPadding(
      removeClippedFormText(content, operators, originalContent),
      operators
    )
  operators ??= await page.getOperatorList()
  const mappings = new Map()
  const fontStack = []
  let font
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index],
      args = operators.argsArray[index]
    if (op === OPS.save) fontStack.push(font)
    else if (op === OPS.restore) font = fontStack.pop()
    else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.showText && font) {
      const fontInfo = page.commonObjs?.get(font) ?? {}
      const name = symbolFontName(fontInfo.name)
      const reviewed = reviewedSubsetSymbols(fontInfo, name)
      // These legacy Pi subsets label mathematical outlines with Latin glyph
      // names. Require the complete observed encoding as well as each glyph's
      // original code, Unicode and width; other subsets remain untouched.
      const latinPi =
        (name === 'MathematicalPi-One' &&
          fontInfo.differences?.length === 15 &&
          [
            'one',
            'b',
            'eight',
            'm',
            'two',
            'comma',
            'five',
            'three',
            'l',
            'acute',
            'k',
            'a',
            'g',
            'numbersign'
          ].every((value, n) => fontInfo.differences[n + 1] === value)) ||
        (name === 'MathematicalPi-Four' &&
          fontInfo.differences?.length === 2 &&
          fontInfo.differences[1] === 'two')
          ? latinPiSymbols.get(name)
          : undefined
      const alternateGalliard =
        name === 'NewGalliard-Roman' &&
        fontInfo.differences?.[75] === 'less' &&
        fontInfo.differences?.[81] === 'guillemotleft' &&
        fontInfo.differences?.[82] === 'guillemotright' &&
        fontInfo.differences?.[83] === 'equal'
      if (
        name === 'NewGalliard-Roman' &&
        !alternateGalliard &&
        !['guillemotleft', 'greater', 'less', 'guillemotright'].every(
          (value, i) => fontInfo.differences?.[71 + i] === value
        )
      )
        continue
      if (
        name !== 'TeX_CM_Maths_Symbols' &&
        name !== 'AdvPS44A44B' &&
        !publisherSymbols.has(name) &&
        !reviewed
      )
        continue
      let map = mappings.get(font)
      if (!map) mappings.set(font, (map = new Map()))
      for (const glyph of args[0]) {
        if (typeof glyph !== 'object' || !glyph) continue
        // This publisher's dedicated punctuation font paints its 750-unit
        // dash at WinAnsi e. Require the font, code, Unicode and advance width;
        // an e in a prose font is still a letter.
        // Universal's subset slots are not stable between papers. This
        // encoding names the less-than glyph H11021 in slot 2, not plus/minus.
        const isComparisonSubset =
          name === 'AdvP4C4E74' &&
          ['C1', 'C0', 'C21', 'C20'].every(
            (glyphName, i) => fontInfo.differences?.[i + 1] === glyphName
          )
        const alternateComparison =
          name === 'AdvP4C4E74' &&
          fontInfo.differences?.[2] === 'C21' &&
          fontInfo.differences?.[3] === 'C0' &&
          fontInfo.differences?.[4] === 'C20' &&
          fontInfo.differences?.[254] === 'thorn'
        const treatmentComparison =
          name === 'AdvP4C4E74' &&
          fontInfo.differences?.[1] === 'C3' &&
          fontInfo.differences?.[3] === 'C21' &&
          fontInfo.differences?.[4] === 'C20' &&
          fontInfo.differences?.[121] === 'y' &&
          fontInfo.differences?.[254] === 'thorn'
        const publisher =
          reviewed?.get(glyph.originalCharCode) ??
          (name === 'AdvP4C4E74' &&
          fontInfo.differences?.[2] === 'C15' &&
          glyph.originalCharCode === 2
            ? ['\u000f', '•', 500]
            : name === 'AdvP4C4E74' &&
                Array.isArray(fontInfo.differences) &&
                fontInfo.differences.length === 0 &&
                glyph.originalCharCode === 254
              ? ['þ', '+', 770]
              : treatmentComparison && [3, 4, 254].includes(glyph.originalCharCode)
                ? new Map([
                    [3, ['\u0015', '≥', 770]],
                    [4, ['\u0014', '≤', 770]],
                    [254, ['þ', '+', 770]]
                  ]).get(glyph.originalCharCode)
                : alternateComparison
                  ? (new Map([
                      [2, ['\u0015', '≥', 770]],
                      [4, ['\u0014', '≤', 770]],
                      [254, ['þ', '+', 770]]
                    ]).get(glyph.originalCharCode) ??
                    publisherSymbols.get(name)?.get(glyph.originalCharCode))
                  : alternateGalliard
                    ? galliardComparisonSubset.get(glyph.originalCharCode)
                    : name === 'AdvP4C4E74' &&
                        ['C0', 'C20'].includes(fontInfo.differences?.[1]) &&
                        fontInfo.differences?.[3] === 'C6' &&
                        fontInfo.differences?.[121] === 'y' &&
                        (glyph.originalCharCode !== 122 || fontInfo.differences?.[122] === 'z') &&
                        footnoteSubset.has(glyph.originalCharCode)
                      ? footnoteSubset.get(glyph.originalCharCode)
                      : // The range/comparison subset reuses slots that mean ± in other subsets.
                        isComparisonSubset && comparisonSubset.has(glyph.originalCharCode)
                        ? comparisonSubset.get(glyph.originalCharCode)
                        : name === 'Universal-GreekwithMathPi' &&
                            fontInfo.differences?.[3] === 'H11001' &&
                            glyph.originalCharCode === 3
                          ? ['\u0003', '+', 833]
                          : name === 'Universal-GreekwithMathPi' &&
                              fontInfo.differences?.[1] === 'H11005' &&
                              fontInfo.differences?.[2] === 'H11021' &&
                              glyph.originalCharCode === 2
                            ? ['\u0002', '<', 833]
                            : name === 'AdvP4C4E74' &&
                                fontInfo.differences?.[1] === 'C21' &&
                                glyph.originalCharCode === 1
                              ? ['\u0015', '≥', 770]
                              : name === 'AdvP4C4E74' &&
                                  (fontInfo.differences?.[1] === 'C21' ||
                                    (fontInfo.differences?.[2] === 'C21' &&
                                      fontInfo.differences?.[3] === 'C14' &&
                                      fontInfo.differences?.[188] === 'onequarter') ||
                                    (fontInfo.differences?.[2] === 'C0' &&
                                      fontInfo.differences?.[188] === 'onequarter')) &&
                                  fontInfo.differences?.[254] === 'thorn' &&
                                  glyph.originalCharCode === 254
                                ? ['þ', '+', 770]
                                : publisherSymbols.get(name)?.get(glyph.originalCharCode))
        // Subset slots vary; the embedded glyph name is authoritative when present.
        const namedUniversal =
          name === 'Universal-GreekwithMathPi'
            ? universalGlyphs.get(fontInfo.differences?.[glyph.originalCharCode])
            : undefined
        const namedAdv =
          name === 'AdvP4C4E74' && glyph.width === 770 && !isComparisonSubset
            ? new Map([
                ['C0', '−'],
                ['C6', '±'],
                ['C2', '×'],
                [
                  'thorn',
                  glyph.unicode === 'þ' &&
                  glyph.originalCharCode === 254 &&
                  ((['C21', 'C3'].includes(fontInfo.differences?.[2]) &&
                    fontInfo.differences?.[3] === undefined &&
                    fontInfo.differences?.[188] === 'onequarter') ||
                    (fontInfo.differences?.[1] === 'C0' && fontInfo.differences?.[3] === 'C6') ||
                    (fontInfo.differences?.[2] === 'C6' &&
                      fontInfo.differences?.[3] === 'C21' &&
                      fontInfo.differences?.[4] === 'C3' &&
                      fontInfo.differences?.[5] === 'C0'))
                    ? '+'
                    : undefined
                ],
                ['C20', glyph.unicode === '\u0014' ? '≤' : undefined],
                ['C21', glyph.unicode === '\u0015' ? '≥' : undefined]
              ]).get(fontInfo.differences?.[glyph.originalCharCode])
            : undefined
        const namedStar =
          name === 'AdvP4C4E74' &&
          glyph.width === 500 &&
          fontInfo.differences?.[glyph.originalCharCode] === 'C3' &&
          glyph.originalCharCode < 32 &&
          glyph.unicode === String.fromCharCode(glyph.originalCharCode)
            ? '*'
            : undefined
        const tex = texSymbols.get(glyph.originalCharCode)
        const pi =
          (name === 'MathematicalPi-One' &&
          glyph.unicode === String.fromCharCode(glyph.originalCharCode)
            ? new Map([
                ['H11021', [glyph.unicode, '<', 833]],
                ['H11022', [glyph.unicode, '>', 833]],
                ['H11350', [glyph.unicode, '≥', 833]],
                ['H11349', [glyph.unicode, '≤', 833]],
                ['H9252', [glyph.unicode, 'β', 611]],
                ['H9257', [glyph.unicode, 'η', 611]],
                ['H9273', [glyph.unicode, 'χ', 556]]
              ]).get(fontInfo.differences?.[glyph.originalCharCode])
            : undefined) ??
          latinPi?.get(glyph.originalCharCode) ??
          (name === 'MathematicalPi-Four' &&
          glyph.originalCharCode === 2 &&
          fontInfo.differences?.[2] === 'H11549'
            ? ['\u0002', '=', 833]
            : undefined)
        const correction = namedStar
          ? [glyph.unicode, namedStar]
          : pi && pi[2] === glyph.width
            ? pi
            : namedAdv
              ? [glyph.unicode, namedAdv]
              : namedUniversal && namedUniversal[1] === glyph.width
                ? [glyph.unicode, namedUniversal[0]]
                : publisher &&
                    (Array.isArray(publisher[2])
                      ? publisher[2].includes(glyph.width)
                      : publisher[2] === glyph.width) &&
                    (!publisher[3] ||
                      (fontInfo.differences?.[glyph.originalCharCode] ??
                        fontInfo.defaultEncoding?.[glyph.originalCharCode]) === publisher[3])
                  ? publisher
                  : name === 'AdvPS44A44B'
                    ? glyph.originalCharCode === 101 && glyph.width === 750
                      ? ['e', '–']
                      : glyph.originalCharCode === 100 && glyph.width === 1000
                        ? ['d', '—']
                        : [67, 68].includes(glyph.originalCharCode) && glyph.width === 1000
                          ? [String.fromCharCode(glyph.originalCharCode), '+']
                          : undefined
                    : name === 'TeX_CM_Maths_Symbols'
                      ? tex?.[2] === undefined || tex[2] === glyph.width
                        ? tex
                        : undefined
                      : undefined
        const value = correction?.[0] === glyph.unicode ? correction[1] : glyph.unicode
        // Several original glyphs can share the same broken Unicode value. In
        // that case there is no safe text-item substitution: leave it for review.
        if (map.has(glyph.unicode) && map.get(glyph.unicode) !== value) map.set(glyph.unicode, null)
        else if (!map.has(glyph.unicode)) map.set(glyph.unicode, value)
        // PDF.js normalizes the ohm sign to Greek omega in text content, while
        // the operator glyph retains U+2126. Only alias this verified slot.
        if (name === 'WTimesGreekSF-One' && glyph.originalCharCode === 189 && value === '=')
          map.set('Ω', value)
      }
    }
  }
  return removeBackgroundNumericPadding(
    removeClippedFormText(
      {
        ...content,
        items: content.items.map((item) => {
          const map = mappings.get(item.fontName)
          if (!('str' in item) || !map) return item
          const str = [...item.str].map((char) => map.get(char) ?? char).join('')
          return str === item.str ? item : { ...item, str, inlineSymbol: [...str].length === 1 }
        })
      },
      operators,
      originalContent
    ),
    operators
  )
}

// Cropped Form XObjects can contain off-crop text from an entire source page.
// Require exact glyph-stream alignment; keep partially visible or unknown text.
export function removeClippedFormText(content, operators, originalContent = content) {
  if (
    !operators?.fnArray.some((op) => [OPS.paintFormXObjectBegin, OPS.clip, OPS.eoClip].includes(op))
  )
    return content
  const streams = new Map(),
    stack = []
  let font,
    matrix = [1, 0, 0, 1, 0, 0],
    clip
  let pendingClip = false
  const applyClip = (box) => {
    if (!box || box.length !== 4 || !Array.from(box).every(Number.isFinite)) return
    const points = [
      [box[0], box[1]],
      [box[2], box[1]],
      [box[0], box[3]],
      [box[2], box[3]]
    ]
    for (const p of points) Util.applyTransform(p, matrix)
    const next = [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1]))
    ]
    clip = clip
      ? [
          Math.max(clip[0], next[0]),
          Math.max(clip[1], next[1]),
          Math.min(clip[2], next[2]),
          Math.min(clip[3], next[3])
        ]
      : next
  }
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i],
      args = operators.argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) stack.push({ font, matrix, clip })
    if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const state = stack.pop()
      if (state) ({ font, matrix, clip } = state)
    } else if (op === OPS.transform) matrix = Util.transform(matrix, args)
    else if (op === OPS.paintFormXObjectBegin) {
      if (args[0]) matrix = Util.transform(matrix, Array.from(args[0]))
      applyClip(args[1])
    } else if (op === OPS.clip || op === OPS.eoClip) pendingClip = true
    else if (op === OPS.constructPath && pendingClip) {
      // PDF.js defers clipping until this combined path-ending operation.
      // Its bounding box is conservative even for a nonrectangular path.
      applyClip(args[2])
      pendingClip = false
    } else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      streams.get(font).push(
        ...args[0]
          .filter((g) => g && typeof g === 'object')
          .flatMap((g) =>
            // Match PDF.js Latin ligature normalization, including its
            // long-s exception; never normalize the visible item itself.
            [...g.unicode.replace(/[ﬀ-ﬆ]/gu, (c) => (c === 'ﬅ' ? 'ſt' : c.normalize('NFKC')))]
              .filter((c) => !/\s/u.test(c))
              .map((char) => ({ char, clip }))
          )
      )
    }
  }
  const original = new Map()
  for (const item of originalContent.items)
    if ('str' in item)
      original.set(
        item.fontName,
        (original.get(item.fontName) ?? '') + item.str.replace(/\s/gu, '')
      )
  for (const [font, chars] of streams) {
    const text = chars.map((c) => c.char).join('')
    const source = original.get(font)
    // PDF.js can omit an off-page suffix. A single clip for the entire font
    // stream makes its item-to-clip assignment unambiguous even in that case.
    const uniformClip = chars[0]?.clip
    if (
      text !== source &&
      !(
        source &&
        text.startsWith(source) &&
        uniformClip &&
        chars.every((c) => c.clip === uniformClip)
      )
    )
      streams.delete(font)
  }
  const positions = new Map()
  return {
    ...content,
    items: content.items.filter((item, index) => {
      const source = originalContent.items[index],
        chars = streams.get(item.fontName)
      if (!('str' in item) || !chars) return true
      const start = positions.get(item.fontName) ?? 0,
        // The operator stream above expands Unicode code points. UTF-16
        // lengths skip clip owners after mathematical letters or other astral glyphs.
        length = [...source.str.replace(/\s/gu, '')].length
      positions.set(item.fontName, start + length)
      if (!length || !item.transform) return true
      const [a, b, c, d, x, y] = item.transform,
        horizontal = Math.hypot(a, b),
        vertical = Math.hypot(c, d)
      if (!horizontal || !vertical) return true
      // Use the same oriented advance box as page geometry. Form text can
      // be rotated independently of the page, including outside its crop.
      const points = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
      ].map(([u, v]) => [
        x + (u * item.width * a) / horizontal + (v * item.height * c) / vertical,
        y + (u * item.width * b) / horizontal + (v * item.height * d) / vertical
      ])
      const bounds = [
        Math.min(...points.map((p) => p[0])),
        Math.min(...points.map((p) => p[1])),
        Math.max(...points.map((p) => p[0])),
        Math.max(...points.map((p) => p[1]))
      ]
      return !chars
        .slice(start, start + length)
        .every(
          ({ clip: c }) =>
            c &&
            (bounds[2] < c[0] - 0.5 ||
              bounds[0] > c[2] + 0.5 ||
              bounds[3] < c[1] - 0.5 ||
              bounds[1] > c[3] + 0.5)
        )
    })
  }
}

// Some publishers advance the cursor with an invisible digit before painting a
// number. PDF.js combines both into one text item (e.g. hidden 0 + visible 0).
// Only discard padding immediately followed by visible digits in the same text
// object. Keep invisible OCR layers and require exact per-font stream alignment.
export function removeInvisibleNumericPadding(content, operators, originalContent = content) {
  const streams = new Map()
  const stack = []
  let font,
    mode = 0,
    pending
  for (let index = 0; index < operators.fnArray.length; index++) {
    const op = operators.fnArray[index],
      args = operators.argsArray[index]
    if (op === OPS.save) stack.push({ font, mode })
    else if (op === OPS.restore) ({ font, mode } = stack.pop() ?? { mode: 0 })
    else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.setTextRenderingMode) mode = args[0]
    else if (op === OPS.showText && font) {
      const text = args[0]
        .filter((glyph) => glyph && typeof glyph === 'object')
        .map((glyph) => glyph.unicode)
        .join('')
      let stream = streams.get(font)
      if (!stream) streams.set(font, (stream = []))
      if (pending?.font === font && mode === 0 && /^\d/.test(text.trim())) {
        for (const char of pending.chars) char.padding = true
      }
      const chars = [...text].filter((char) => !/\s/u.test(char)).map((char) => ({ char }))
      stream.push(...chars)
      pending = mode === 3 && /^\d+$/.test(text.trim()) ? { font, chars } : undefined
      continue
    }
    if (op !== OPS.setTextRenderingMode && op !== OPS.setGState) pending = undefined
  }
  const itemStreams = new Map()
  for (const item of originalContent.items) {
    if (!('str' in item)) continue
    itemStreams.set(
      item.fontName,
      (itemStreams.get(item.fontName) ?? '') + item.str.replace(/\s/gu, '')
    )
  }
  for (const [font, stream] of streams) {
    if (
      !stream.some((char) => char.padding) ||
      stream.map(({ char }) => char).join('') !== itemStreams.get(font)
    )
      streams.delete(font)
  }
  if (!streams.size) return content
  const offsets = new Map()
  return {
    ...content,
    items: content.items.map((item) => {
      const stream = streams.get(item.fontName)
      if (!('str' in item) || !stream) return item
      let offset = offsets.get(item.fontName) ?? 0
      const str = [...item.str]
        .filter((char) => /\s/u.test(char) || !stream[offset++].padding)
        .join('')
      offsets.set(item.fontName, offset)
      return str === item.str ? item : { ...item, str }
    })
  }
}

// Some subset fonts give uppercase glyphs lowercase ToUnicode values. Recover
// only an otherwise consistent shifted ASCII encoding, with both cases well
// represented and distinct lowercase glyphs. Never capitalize by word context.
export function repairShiftedLatinCase(content, operators) {
  const streams = new Map(),
    stack = []
  let font
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i],
      args = operators.argsArray[i]
    if (op === OPS.save) stack.push(font)
    else if (op === OPS.restore) font = stack.pop()
    else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      streams.get(font).push(...args[0].filter((g) => g && typeof g === 'object'))
    }
  }
  const replacements = new Map()
  for (const [font, stream] of streams) {
    const glyphs = [
      ...new Map(
        stream.filter((g) => /^[A-Za-z]$/.test(g.unicode)).map((g) => [g.originalCharCode, g])
      ).values()
    ]
    const offsets = new Map()
    for (const g of glyphs) {
      const offset = g.originalCharCode - g.unicode.charCodeAt(0)
      offsets.set(offset, (offsets.get(offset) ?? 0) + 1)
    }
    const [offset, count] = [...offsets].sort((a, b) => b[1] - a[1])[0] ?? []
    if (!offset || glyphs.length < 35 || count < glyphs.length * 0.85) continue
    const matched = glyphs.filter((g) => g.originalCharCode - g.unicode.charCodeAt(0) === offset)
    if (
      matched.filter((g) => /^[A-Z]$/.test(g.unicode)).length < 8 ||
      matched.filter((g) => /^[a-z]$/.test(g.unicode)).length < 15
    )
      continue
    const changed = new Map()
    for (const g of glyphs.filter((g) => !matched.includes(g))) {
      const expected = String.fromCharCode(g.originalCharCode - offset)
      const lower = matched.find((other) => other.unicode === g.unicode)
      if (
        !/^[A-Z]$/.test(expected) ||
        expected.toLowerCase() !== g.unicode ||
        !lower ||
        lower.fontChar === g.fontChar ||
        lower.width === g.width
      ) {
        changed.clear()
        break
      }
      changed.set(g.originalCharCode, expected)
    }
    if (changed.size < 2) continue
    const chars = stream.flatMap((g) =>
      [...g.unicode]
        .filter((c) => !/\s/u.test(c))
        .map((char) => ({ char, corrected: changed.get(g.originalCharCode) ?? char }))
    )
    const source = content.items
      .filter((i) => i.fontName === font && 'str' in i)
      .map((i) => i.str.replace(/\s/gu, ''))
      .join('')
    if (source === chars.map((c) => c.char).join('')) replacements.set(font, chars)
  }
  const positions = new Map()
  return replacements.size
    ? {
        ...content,
        items: content.items.map((item) => {
          const chars = replacements.get(item.fontName)
          if (!chars || !('str' in item)) return item
          let position = positions.get(item.fontName) ?? 0
          const str = [...item.str]
            .map((char) => (/\s/u.test(char) ? char : chars[position++].corrected))
            .join('')
          positions.set(item.fontName, position)
          return str === item.str ? item : { ...item, str }
        })
      }
    : content
}

// Some tables paint an alignment parenthesis in exactly the row background
// colour after a visible zero. Require a previously painted background, exact
// operator/item stream alignment, and adjacent zero on the same baseline.
export function removeBackgroundNumericPadding(content, operators) {
  if (!operators || !content.items.some((i) => ['(', '<', '0', '.0'].includes(i.str)))
    return content
  const streams = new Map(),
    backgrounds = new Set(['#ffffff']),
    stack = []
  let font,
    colour = '#000000'
  for (let n = 0; n < operators.fnArray.length; n++) {
    const op = operators.fnArray[n],
      args = operators.argsArray[n]
    if (op === OPS.save) stack.push({ font, colour })
    else if (op === OPS.restore) ({ font, colour } = stack.pop() ?? { colour: '#000000' })
    else if (op === OPS.setFont) font = args[0]
    else if (op === OPS.setFillRGBColor) colour = args[0]
    else if ([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(op))
      backgrounds.add(colour)
    else if (
      op === OPS.constructPath &&
      [OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke].includes(args[0])
    )
      backgrounds.add(colour)
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      for (const g of args[0])
        if (g && typeof g === 'object')
          for (const char of g.unicode.replace(/\s/gu, ''))
            streams.get(font).push({
              char,
              hidden:
                backgrounds.has(colour) &&
                /^#[0-9a-f]{6}$/i.test(colour) &&
                [1, 3, 5].every((offset) => parseInt(colour.slice(offset, offset + 2), 16) >= 210)
            })
    }
  }
  for (const [font, chars] of streams)
    if (
      chars.map((c) => c.char).join('') !==
      content.items
        .filter((i) => i.fontName === font && 'str' in i)
        .map((i) => i.str.replace(/\s/gu, ''))
        .join('')
    )
      streams.delete(font)
  const offsets = new Map()
  return {
    ...content,
    items: content.items.filter((item, index) => {
      const chars = streams.get(item.fontName)
      if (!chars || !('str' in item)) return true
      const start = offsets.get(item.fontName) ?? 0
      offsets.set(item.fontName, start + item.str.replace(/\s/gu, '').length)
      const before = content.items.slice(0, index).findLast((i) => i.str?.trim())
      const after = content.items.slice(index + 1).find((i) => i.str?.trim())
      // Publishers also pad decimal p-values with a background-coloured less-than
      // sign or trailing zero. Preserve visible comparisons and numeric OCR layers.
      const neighbour = item.str === '<' ? after : before
      if (
        ['<', '0', '.0'].includes(item.str) &&
        chars.slice(start, start + item.str.length).every((c) => c.hidden) &&
        (item.str === '.0' ? /^\d+$/ : /^\d+\.\d+$/).test(neighbour?.str?.trim() ?? '') &&
        item.transform &&
        neighbour?.transform
      ) {
        const [a, b] = item.transform,
          scale = Math.hypot(a, b)
        const dx = neighbour.transform[4] - item.transform[4],
          dy = neighbour.transform[5] - item.transform[5]
        const along = (dx * a + dy * b) / scale
        const gap = item.str === '<' ? along - item.width : -along - neighbour.width
        const neighbourOffset =
          item.str === '<' ? start + 1 : start - neighbour.str.replace(/\s/gu, '').length
        if (
          scale &&
          !chars[neighbourOffset]?.hidden &&
          neighbour.transform[0] === a &&
          neighbour.transform[1] === b &&
          Math.abs((dy * a - dx * b) / scale) < 0.01 &&
          item.height === neighbour.height &&
          gap >= -0.01 &&
          gap < item.height * 0.5
        )
          return false
      }
      if (item.str !== '(' || !item.transform || !before?.transform) return true
      // PDF text can run vertically on landscape pages. Measure adjacency in
      // the text baseline direction rather than assuming page-space x/y axes.
      const [a, b] = before.transform
      const scale = Math.hypot(a, b)
      const dx = item.transform[4] - before.transform[4]
      const dy = item.transform[5] - before.transform[5]
      const gap = (dx * a + dy * b) / scale - before.width
      return !(
        chars[start]?.hidden &&
        !chars[start - 1]?.hidden &&
        before?.str.trim() === '0' &&
        item.transform[0] === a &&
        item.transform[1] === b &&
        Math.abs((dy * a - dx * b) / scale) < 0.01 &&
        item.height === before.height &&
        gap >= -0.01 &&
        gap < item.height * 0.5
      )
    })
  }
}

// PDF.js text extraction adds Tc to an empty TJ string before a leading
// numeric adjustment; Canvas rendering applies only that numeric adjustment.
// Match the complete native glyph stream before removing the extra advance.
// A text-line/matrix reset also resets the accumulated extraction offset.
export function repairSpacedTextOffsets(content, operators) {
  if (!operators?.fnArray.includes(OPS.setCharSpacing)) return content
  const streams = new Map(),
    stack = []
  let font,
    size = 0,
    charSpace = 0,
    error = 0
  for (let n = 0; n < operators.fnArray.length; n++) {
    const op = operators.fnArray[n],
      args = operators.argsArray[n]
    if (op === OPS.save) stack.push({ font, size, charSpace, error })
    else if (op === OPS.restore)
      ({ font, size, charSpace, error } = stack.pop() ?? { size: 0, charSpace: 0, error: 0 })
    else if (op === OPS.setFont) [font, size] = args
    else if (op === OPS.setCharSpacing) charSpace = args[0]
    else if (
      [
        OPS.beginText,
        OPS.setTextMatrix,
        OPS.moveText,
        OPS.setLeadingMoveText,
        OPS.nextLine
      ].includes(op)
    )
      error = 0
    else if (op === OPS.showText && font) {
      if (!streams.has(font)) streams.set(font, [])
      let empty = true
      for (const g of args[0]) {
        if (typeof g === 'number') {
          if (g !== 0 && empty) error += charSpace
          empty = true
          continue
        }
        if (!g || typeof g.unicode !== 'string') continue
        empty = false
        for (const char of g.unicode
          .replace(/[ﬀ-ﬆ]/gu, (c) => (c === 'ﬅ' ? 'ſt' : c.normalize('NFKC')))
          .replace(/\s/gu, ''))
          streams.get(font).push({ char, error, size })
      }
    }
  }
  const text = new Map()
  for (const i of content.items)
    if ('str' in i) text.set(i.fontName, (text.get(i.fontName) ?? '') + i.str.replace(/\s/gu, ''))
  for (const [font, g] of streams)
    if (g.map((i) => i.char).join('') !== text.get(font)) streams.delete(font)
  const positions = new Map()
  return {
    ...content,
    items: content.items.map((i) => {
      const g = streams.get(i.fontName)
      if (!g || !('str' in i)) return i
      const at = positions.get(i.fontName) ?? 0,
        length = [...i.str.replace(/\s/gu, '')].length
      positions.set(i.fontName, at + length)
      const part = g.slice(at, at + length),
        first = part[0]
      if (
        !first?.error ||
        !(first.size > 0) ||
        !i.transform ||
        i.dir !== 'ltr' ||
        part.some((x) => x.error !== first.error || x.size !== first.size)
      )
        return i
      return {
        ...i,
        transform: [
          ...i.transform.slice(0, 4),
          i.transform[4] - (first.error * i.transform[0]) / first.size,
          i.transform[5] - (first.error * i.transform[1]) / first.size
        ]
      }
    })
  }
}
