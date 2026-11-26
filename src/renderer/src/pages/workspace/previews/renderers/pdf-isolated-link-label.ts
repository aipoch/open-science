import type { PDFPageProxy } from 'pdfjs-dist'
import { translatedPdfLinkFragment } from '@aipoch/pdf-translation/reader'

type Item = Extract<
  Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number],
  { str: string }
>
type Ops = typeof import('pdfjs-dist').OPS
type Draw = { label: string; x: number; y: number; width: number; size: number; font: string }

// Narrow proof for a separately painted label inside a merged PDF.js text item.
// Stop at the first unsupported state change rather than interpreting arbitrary PDF graphics.
export async function readIsolatedLinkLabels(page: PDFPageProxy, ops: Ops): Promise<Draw[]> {
  const program = await page.getOperatorList(),
    out: Draw[] = []
  if (program.fnArray.length > 100000) return out
  let font = '',
    size = 0,
    spacing = 0,
    matrix: ArrayLike<number> | undefined
  for (let i = 0; i < program.fnArray.length; i++) {
    const op = program.fnArray[i],
      a = program.argsArray[i]
    if (op === ops.setFont) {
      font = a[0]
      size = a[1]
    } else if (op === ops.setCharSpacing) spacing = a[0]
    else if (op === ops.setTextMatrix) matrix = a.length === 1 ? a[0] : a
    else if (op === ops.showText) {
      if (
        matrix &&
        matrix[0] > 0 &&
        matrix[0] === matrix[3] &&
        matrix[1] === 0 &&
        matrix[2] === 0 &&
        size > 0 &&
        font &&
        Array.isArray(a[0])
      ) {
        let label = '',
          advance = 0
        for (const g of a[0]) {
          if (typeof g === 'number') {
            advance -= (g * size) / 1000
            continue
          }
          if (
            !g ||
            !Number.isFinite(g.width) ||
            !/^[A-Za-z0-9]$/u.test(g.unicode) ||
            g.isSpace ||
            g.isInFont === false
          ) {
            label = ''
            break
          }
          label += g.unicode
          advance += (g.width * size) / 1000 + spacing
        }
        if (/^(?:S?\d{1,4}[A-Za-z]?)$/u.test(label) && page.commonObjs.has(font)) {
          const f = page.commonObjs.get(font)
          if (
            Number.isFinite(advance) &&
            Number.isFinite(spacing) &&
            advance > spacing &&
            !f.vertical &&
            !f.isType3Font &&
            f.fontMatrix?.join(',') === '0.001,0,0,0.001,0,0'
          )
            out.push({
              label,
              x: matrix[4],
              y: matrix[5],
              size: matrix[0] * size,
              width: matrix[0] * (advance - spacing),
              font
            })
        }
      }
      matrix = undefined
    } else if (
      [ops.beginText, ops.endText, ops.nextLine, ops.moveText, ops.setLeadingMoveText].some(
        (x) => x === op
      )
    )
      matrix = undefined
    else if (
      ![
        ops.save,
        ops.setRenderingIntent,
        ops.dependency,
        ops.setFillRGBColor,
        ops.setWordSpacing
      ].some((x) => x === op)
    )
      break
  }
  return out
}

const compact = (s: string): string => s.replace(/\s/gu, '')
const unique = (s: string, part: string): number =>
  part && s.indexOf(part) === s.lastIndexOf(part) ? s.indexOf(part) : -1

export function provesIsolatedLink(input: {
  draws: Draw[]
  rect: readonly number[]
  sourceLine: Item
  targetGlyph: Item
  targetRow: Item[]
  source: string
  translation: string
}): boolean {
  const { draws, rect, sourceLine, targetGlyph, targetRow, source, translation } = input,
    label = targetGlyph.str.trim()
  const [x0, bottom, x1, top] = rect,
    [a, b, c, d, x, y] = sourceLine.transform
  if (!/^(?:S?\d{1,4}[A-Za-z]?)$/u.test(label) || a <= 0 || b !== 0 || c !== 0 || a !== d)
    return false
  const inside = draws.filter(
    (g) => g.y >= bottom && g.y <= top && g.x + g.width / 2 >= x0 && g.x + g.width / 2 <= x1
  )
  if (inside.length !== 1) return false
  const g = inside[0]
  if (
    g.label !== label ||
    g.font !== sourceLine.fontName ||
    Math.abs(g.size - a) > 0.02 ||
    Math.abs(g.y - y) > 0.02 ||
    Math.abs(g.x - x0) > 0.3 ||
    Math.abs(g.x + g.width - x1) > 0.3 ||
    g.x < x - 0.3 ||
    g.x + g.width > x + sourceLine.width + 0.3
  )
    return false
  const line = sourceLine.str.trim().replace(/-$/u, ''),
    matches = [
      ...line.matchAll(/(?:\b(?:Figure|Fig\.?)\s*(S?\d{1,4}[A-Za-z]?)\b|\[(\d{1,4})\])/giu)
    ].filter((m) => (m[1] ?? m[2]) === label)
  const at = unique(source, line)
  if (
    matches.length !== 1 ||
    at < 0 ||
    [...line.matchAll(new RegExp(`(?<![a-zA-Z0-9])${label}(?![a-zA-Z0-9])`, 'gu'))].length !== 1
  )
    return false
  const sourceAt = at + matches[0].index! + matches[0][0].lastIndexOf(label),
    mapped = translatedPdfLinkFragment(source, translation, label, sourceAt)
  if (mapped?.text !== label) return false
  const index = targetRow.indexOf(targetGlyph)
  if (index < 0) return false
  const atExpectedOffset = (items: Item[], index: number): boolean => {
    const row = compact(items.map((t) => t.str).join('')),
      at = unique(compact(translation), row)
    return (
      row.length > label.length &&
      at >= 0 &&
      at +
        compact(
          items
            .slice(0, index)
            .map((t) => t.str)
            .join('')
        ).length ===
        compact(translation.slice(0, mapped.start)).length
    )
  }
  if (atExpectedOffset(targetRow, index)) return true
  // Match the adjacent painted context, not distant words on the row: the
  // latter can contain independently positioned superscripts.
  const left = compact(
      targetRow
        .slice(Math.max(0, index - 1), index)
        .map((t) => t.str)
        .join('')
    ),
    right = compact(
      targetRow
        .slice(index + 1, index + 2)
        .map((t) => t.str)
        .join('')
    ),
    target = compact(translation),
    offset = compact(translation.slice(0, mapped.start)).length
  if (
    /^\d+$/u.test(label)
      ? !(left.endsWith('[') && right.startsWith(']'))
      : !/(?:Figure|Fig\.?|图|圖)$/iu.test(left)
  )
    return false
  const context = left + label + right,
    atTarget = unique(target, context)
  return atTarget >= 0 && atTarget + left.length === offset
}
