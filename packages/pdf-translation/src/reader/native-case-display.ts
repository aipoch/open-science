import type { PdfLayoutPage, PdfLayoutTextItem } from './layout.js'
import { nativeClosedMathGrammar, nativeMathAtom } from './native-display-packets.js'

type Part = PdfLayoutTextItem & { index: number }
const valid = (item: Part): boolean =>
  item.dir === 'ltr' &&
  item.fontVertical === false &&
  !!item.fontName &&
  item.transform.length === 6 &&
  [...item.transform, item.width, item.height, item.fontAscent, item.fontDescent].every(
    Number.isFinite
  ) &&
  item.width > 0 &&
  item.height > 0 &&
  item.transform[0] > 0 &&
  item.transform[3] > 0 &&
  item.transform[1] === 0 &&
  item.transform[2] === 0 &&
  Math.abs(item.transform[3] - item.height) < item.height * 0.01
const mathematical = (text: string): boolean =>
  /^[A-Za-z\p{Script=Greek}\d\s()[\]{},.;/'′″+−*/=<>≤≥∈∉]+$/u.test(text) &&
  !/[A-Za-z]{2,}/u.test(text)

function conditionalMathParts(parts: Part[], size: number, baseline: number): boolean {
  if (!parts.length) return false
  const brackets: string[] = []
  for (const [at, item] of parts.entries()) {
    if (
      item.str !== '\u0338' &&
      !/^[A-Za-z\p{Script=Greek}\d\s()[\]{},.;/'′″+−*/=<>≤≥∈∉]+$/u.test(item.str)
    )
      return false
    for (const char of item.str) {
      if ('([{'.includes(char)) brackets.push(char)
      else if (')]}'.includes(char) && brackets.pop() !== '([{'[')]}'.indexOf(char)]) return false
    }
    const prior = parts[at - 1],
      next = parts[at + 1]
    if (item.str === '\u0338') {
      if (
        item.width !== 0 ||
        !item.fontName ||
        item.fontVertical !== false ||
        !Number.isFinite(item.fontAscent) ||
        !Number.isFinite(item.fontDescent) ||
        item.fontAscent! <= item.fontDescent! ||
        !next ||
        next.str !== '=' ||
        !valid(next) ||
        item.height !== next.height ||
        item.transform.length !== 6 ||
        !item.transform.every(Number.isFinite) ||
        item.transform.some((v, n) => Math.abs(v - next.transform[n]) > 1e-7)
      )
        return false
      continue
    }
    if (!valid(item) || item.fontAscent! <= item.fontDescent! || !nativeMathAtom(item, size))
      return false
    const drop = Math.abs(item.transform[5] - baseline)
    if (Math.abs(item.height - size) < size * 0.05 && drop < size * 0.05) continue
    if (
      !prior ||
      item.height < size * 0.5 ||
      item.height >= size * 0.85 ||
      drop < size * 0.08 ||
      drop > size * 0.55 ||
      item.transform[4] - prior.transform[4] - prior.width < -size * 0.1 ||
      item.transform[4] - prior.transform[4] - prior.width > size * 0.25 ||
      (Math.abs(prior.height - size) < size * 0.05
        ? !/^[A-Za-z\p{Script=Greek}]$/u.test(prior.str) ||
          Math.abs(prior.transform[5] - baseline) >= size * 0.05
        : Math.abs(item.height - prior.height) >= size * 0.05 ||
          Math.abs(item.transform[5] - prior.transform[5]) >= size * 0.05)
    )
      return false
  }
  return brackets.length === 0
}

// An opaque symbol is not decoded as a brace. A complete assignment and two
// conditional lanes prove only negative translation eligibility, never ink bounds.
function opaqueConditionalItems(items: Part[], width: number): ReadonlySet<number> {
  const selected = new Set<number>(),
    conditionalWords = items.filter((i) => i.str === 'if' && valid(i))
  const center = (parts: Part[]): number =>
    (Math.min(...parts.map((i) => i.transform[4])) +
      Math.max(...parts.map((i) => i.transform[4] + i.width))) /
    2
  for (const [at, marker] of items.entries()) {
    if (
      !/^\p{Cc}$/u.test(marker.str) ||
      !valid(marker) ||
      marker.fontAscent! <= marker.fontDescent!
    )
      continue
    const size = marker.height,
      right = marker.transform[4] + marker.width,
      connectors = conditionalWords.filter(
        (i) =>
          i.index > marker.index &&
          Math.abs(i.height - size) < size * 0.05 &&
          i.transform[4] > right &&
          i.transform[4] - right < size * 5 &&
          i.transform[5] < marker.transform[5] &&
          i.transform[5] > marker.transform[5] - size * 6
      )
    if (connectors.length !== 2) continue
    const [first, last] = connectors,
      pitch = first.transform[5] - last.transform[5],
      middle = (first.transform[5] + last.transform[5]) / 2
    if (
      pitch < size * 0.9 ||
      pitch > size * 1.8 ||
      first.fontName !== last.fontName ||
      marker.fontName === first.fontName ||
      Math.abs(first.transform[4] - last.transform[4]) > size * 0.05 ||
      marker.transform[5] - first.transform[5] < size * 0.5 ||
      marker.transform[5] - first.transform[5] > size * 1.3
    )
      continue
    const lhs: Part[] = []
    for (let n = at - 1; n >= 0 && lhs.length < 12; n--) {
      const i = items[n]
      if (
        !valid(i) ||
        i.transform[4] + i.width > marker.transform[4] ||
        i.transform[4] < marker.transform[4] - size * 8 ||
        Math.abs(i.transform[5] - middle) > size * 0.6
      )
        break
      lhs.unshift(i)
    }
    if (
      !/^[A-Za-z\p{Script=Greek}]['′″]{0,2}\([A-Za-z\p{Script=Greek}]\)\s*=$/u.test(
        lhs.map((i) => i.str).join('')
      ) ||
      !conditionalMathParts(lhs, size, middle) ||
      marker.transform[4] - lhs.at(-1)!.transform[4] - lhs.at(-1)!.width > size * 0.6
    )
      continue
    const rows = connectors.map((connector) =>
      items.filter(
        (i) =>
          i.index > marker.index &&
          i.transform[4] >= right &&
          i.transform[4] < width * 0.95 &&
          Math.abs(i.transform[5] - connector.transform[5]) <
            size * (i.height < size * 0.85 ? 0.55 : 0.05)
      )
    )
    const values: Part[][] = [],
      conditions: Part[][] = []
    if (
      rows.some((row, n) => {
        const split = row.indexOf(connectors[n]),
          value = row.slice(0, split),
          condition = row.slice(split + 1)
        values.push(value)
        conditions.push(condition)
        return (
          split <= 0 ||
          !conditionalMathParts(value, size, connectors[n].transform[5]) ||
          !conditionalMathParts(condition, size, connectors[n].transform[5]) ||
          !nativeClosedMathGrammar(condition, size) ||
          row.some(
            (i, k) =>
              k > 0 &&
              (i.index <= row[k - 1].index ||
                i.transform[4] < row[k - 1].transform[4] - size * 0.1 ||
                i.transform[4] - row[k - 1].transform[4] - row[k - 1].width > size * 4)
          )
        )
      }) ||
      Math.abs(center(values[0]) - center(values[1])) > size * 0.05 ||
      Math.abs(center(conditions[0]) - center(conditions[1])) > size * 0.05
    )
      continue
    const packet = [...lhs, marker, ...rows.flat()],
      keys = new Set(packet.map((i) => i.index)),
      start = Math.min(...keys),
      end = Math.max(...keys),
      domain = [
        Math.min(...packet.map((i) => i.transform[4])),
        Math.min(...packet.map((i) => i.transform[5] + i.height * i.fontDescent!)),
        Math.max(...packet.map((i) => i.transform[4] + i.width)),
        Math.max(...packet.map((i) => i.transform[5] + i.height * i.fontAscent!))
      ]
    if (
      packet.length !== keys.size ||
      items.some(
        (i) =>
          !keys.has(i.index) &&
          ((i.index >= start && i.index <= end) ||
            ![...i.transform, i.width, i.height, i.fontAscent, i.fontDescent].every(
              Number.isFinite
            ) ||
            i.fontAscent! <= i.fontDescent! ||
            (i.transform[4] < domain[2] &&
              i.transform[4] + i.width > domain[0] &&
              i.transform[5] + i.height * i.fontDescent! < domain[3] &&
              i.transform[5] + i.height * i.fontAscent! > domain[1]))
      )
    )
      continue
    for (const key of keys) selected.add(key)
  }
  return selected
}

// Parenthesized value labels do not make aligned modular branches ordinary prose.
// Retain the whole display: free wrapping can move a branch value onto its prior row.
function annotatedModularItems(items: Part[]): ReadonlySet<number> {
  const result = new Set<number>()
  for (let at = 0; at < items.length; at++) {
    if (items[at].str !== '\uF8F1') continue
    let end = at + 1
    while (end < items.length && /^[\uF8F2\uF8F4]$/u.test(items[end].str)) end++
    const frame = items.slice(at, end + 1),
      top = frame[0],
      bottom = frame.at(-1)!,
      size = top.height,
      x = top.transform[4],
      right = x + top.width
    if (
      !/^\uF8F1\uF8F4*\uF8F2\uF8F4*\uF8F3$/u.test(frame.map((i) => i.str).join('')) ||
      frame.length > 12 ||
      frame.some(
        (i, n) =>
          !valid(i) ||
          i.fontName !== top.fontName ||
          Math.abs(i.height - size) > size * 0.01 ||
          Math.abs(i.width - top.width) > size * 0.01 ||
          Math.abs(i.transform[4] - x) > size * 0.01 ||
          i.fontAscent !== top.fontAscent ||
          i.fontDescent !== top.fontDescent ||
          (n > 0 && i.transform[5] >= frame[n - 1].transform[5])
      ) ||
      top.fontAscent! < 0 ||
      top.fontAscent! > 0.2 ||
      top.fontDescent! >= -0.3
    )
      continue
    const high = top.transform[5] + size * top.fontAscent!,
      low = bottom.transform[5] + size * bottom.fontDescent!,
      labels = items.filter(
        (i) =>
          i.index > bottom.index &&
          i.transform[4] >= right &&
          i.transform[4] - right < size * 0.5 &&
          i.transform[5] > low &&
          i.transform[5] < high &&
          /^\d+(?:\.\d+)?\s*\([A-Za-z]+(?:[ -][A-Za-z]+)*\)$/u.test(i.str)
      )
    if (high - low < size * 2 || high - low > size * 9 || labels.length < 2 || labels.length > 8)
      continue
    const pitch = labels[0].transform[5] - labels[1].transform[5],
      center = (labels[0].transform[5] + labels.at(-1)!.transform[5]) / 2
    if (
      pitch < size * 0.9 ||
      pitch > size * 1.8 ||
      labels.some(
        (i, n) =>
          Math.abs(i.transform[4] - labels[0].transform[4]) > size * 0.05 ||
          (n > 0 && Math.abs(labels[n - 1].transform[5] - i.transform[5] - pitch) > size * 0.05)
      )
    )
      continue
    const rows = labels.map((label, rowIndex) =>
        items.filter(
          (i) =>
            i.index >= label.index &&
            (!labels[rowIndex + 1] || i.index < labels[rowIndex + 1].index) &&
            i.transform[4] >= right &&
            Math.abs(i.transform[5] - label.transform[5]) < size * 0.05
        )
      ),
      conditions: Part[][] = []
    if (
      rows.some((row, n) => {
        const condition = row.slice(2)
        conditions.push(condition)
        return (
          row[0] !== labels[n] ||
          row[1]?.str !== ',' ||
          !condition.length ||
          row.some(
            (i, k) =>
              !valid(i) ||
              i.fontAscent! <= i.fontDescent! ||
              Math.abs(i.height - size) > size * 0.05 ||
              (k > 0 &&
                (i.index <= row[k - 1].index ||
                  i.transform[4] - row[k - 1].transform[4] - row[k - 1].width < -size * 0.05 ||
                  i.transform[4] - row[k - 1].transform[4] - row[k - 1].width > size * 3))
          ) ||
          !/^[A-Za-z\p{Script=Greek}]\s*≡\s*[±+−-]?\s*\d+\s*\(mod\s+\d+\)[,.]$/u.test(
            condition.map((i) => i.str).join('')
          )
        )
      }) ||
      conditions.some(
        (row) => Math.abs(row[0].transform[4] - conditions[0][0].transform[4]) > size * 0.05
      )
    )
      continue
    const lhs: Part[] = []
    for (let n = at - 1; n >= 0 && lhs.length < 12; n--) {
      const i = items[n]
      if (
        !valid(i) ||
        i.transform[4] + i.width > x ||
        i.transform[4] < x - size * 8 ||
        Math.abs(i.transform[5] - center) > size * 0.65 ||
        !mathematical(i.str)
      )
        break
      lhs.unshift(i)
    }
    if (
      !/^[A-Za-z\p{Script=Greek}]['′″]{0,2}\([A-Za-z\p{Script=Greek}]\)\s*=$/u.test(
        lhs.map((i) => i.str).join('')
      ) ||
      x - lhs.at(-1)!.transform[4] - lhs.at(-1)!.width > size * 0.6
    )
      continue
    const packet = [...lhs, ...frame, ...rows.flat()],
      keys = new Set(packet.map((i) => i.index)),
      start = Math.min(...keys),
      finish = Math.max(...keys),
      left = Math.min(...packet.map((i) => i.transform[4])),
      far = Math.max(...packet.map((i) => i.transform[4] + i.width))
    if (
      packet.length !== keys.size ||
      items.some(
        (i) =>
          !keys.has(i.index) &&
          ((i.index >= start && i.index <= finish) ||
            ![...i.transform, i.width, i.height, i.fontAscent, i.fontDescent].every(
              Number.isFinite
            ) ||
            (i.transform[4] < far &&
              i.transform[4] + i.width > left &&
              i.transform[5] + i.height * i.fontDescent! < high &&
              i.transform[5] + i.height * i.fontAscent! > low))
      )
    )
      continue
    for (const key of keys) result.add(key)
  }
  return result
}

/** Only closed native case rows or a complete conditional display lose eligibility. */
export function nativeCaseDisplayItems(page: PdfLayoutPage): ReadonlySet<number> {
  const result = new Set<number>()
  if (page.rotation !== 0 || page.items.length > 8192) return result
  const items = page.items.flatMap((item, index) => (item.str.trim() ? [{ ...item, index }] : []))
  for (let at = 0; at + 2 < items.length; at++) {
    const frame = items.slice(at, at + 3),
      [top, middle, bottom] = frame
    if (frame.map((i) => i.str).join('') !== '\uF8F1\uF8F2\uF8F3' || frame.some((i) => !valid(i)))
      continue
    const size = top.height,
      x = top.transform[4],
      right = x + top.width,
      high = top.transform[5] + top.fontAscent! * size,
      low = bottom.transform[5] + bottom.fontDescent! * size
    if (
      frame.some(
        (i) =>
          i.fontName !== top.fontName ||
          Math.abs(i.height - size) > size * 0.01 ||
          Math.abs(i.width - top.width) > size * 0.01 ||
          Math.abs(i.transform[4] - x) > size * 0.01 ||
          i.fontAscent !== top.fontAscent ||
          i.fontDescent !== top.fontDescent
      ) ||
      top.fontAscent! < 0 ||
      top.fontAscent! > 0.2 ||
      top.fontDescent! >= -0.3 ||
      top.transform[5] <= middle.transform[5] ||
      middle.transform[5] <= bottom.transform[5] ||
      high - low < size * 2 ||
      high - low > size * 9
    )
      continue
    const connectors = items.filter(
      (i) =>
        i.index > bottom.index &&
        i.str === 'if' &&
        valid(i) &&
        Math.abs(i.height - size) < size * 0.05 &&
        i.transform[4] > right &&
        i.transform[4] - right < size * 5 &&
        i.transform[5] > low - size * 0.25 &&
        i.transform[5] < high
    )
    if (connectors.length < 2 || connectors.length > 8) continue
    const first = connectors[0],
      pitch = first.transform[5] - connectors[1].transform[5]
    if (
      pitch < size * 0.9 ||
      pitch > size * 1.8 ||
      connectors.some(
        (i, n) =>
          i.fontName !== first.fontName ||
          Math.abs(i.transform[4] - first.transform[4]) > size * 0.05 ||
          (n > 0 && Math.abs(connectors[n - 1].transform[5] - i.transform[5] - pitch) > size * 0.05)
      )
    )
      continue
    const rows = connectors.map((connector) =>
      items.filter(
        (i) =>
          i.index > bottom.index &&
          i.transform[4] >= right &&
          i.transform[4] < page.width * 0.95 &&
          Math.abs(i.transform[5] - connector.transform[5]) <
            size * (i.height < size * 0.85 ? 0.55 : 0.05)
      )
    )
    const numericValues: Part[][] = []
    let closed = true
    for (const [n, row] of rows.entries()) {
      const connector = connectors[n],
        split = row.indexOf(connector),
        value = row.slice(0, split),
        condition = row.slice(split + 1)
      if (
        split <= 0 ||
        !condition.length ||
        row.some((i) => !valid(i) || i.height < size * 0.5 || i.height > size * 1.05) ||
        !mathematical(value.map((i) => i.str).join('')) ||
        !mathematical(condition.map((i) => i.str).join('')) ||
        !/[=<>≤≥∈∉]/u.test(condition.map((i) => i.str).join('')) ||
        row.some(
          (i, k) =>
            k > 0 &&
            (i.index <= row[k - 1].index ||
              i.transform[4] < row[k - 1].transform[4] - size * 0.1 ||
              i.transform[4] - row[k - 1].transform[4] - row[k - 1].width > size * 4)
        ) ||
        items.some(
          (i) => i.index >= row[0].index && i.index <= row.at(-1)!.index && !row.includes(i)
        )
      ) {
        closed = false
        break
      }
      if (/^\d+(?:\.\d+)?$/u.test(value.map((i) => i.str).join(''))) numericValues.push(value)
    }
    if (
      !closed ||
      numericValues.length < 2 ||
      numericValues.some(
        (value) => Math.abs(value[0].transform[4] - numericValues[0][0].transform[4]) > size * 0.05
      )
    )
      continue
    const before = items.slice(0, at),
      lhs: Part[] = [],
      center = (first.transform[5] + connectors.at(-1)!.transform[5]) / 2
    for (let n = before.length - 1; n >= 0 && lhs.length < 12; n--) {
      const item = before[n]
      if (
        !valid(item) ||
        item.transform[4] >= x ||
        item.transform[4] < x - size * 8 ||
        Math.abs(item.transform[5] - center) > size * 0.65 ||
        !mathematical(item.str)
      )
        break
      lhs.unshift(item)
    }
    if (
      !/^[A-Za-z\p{Script=Greek}]['′″]{0,2}\([A-Za-z\p{Script=Greek}]\)\s*=$/u.test(
        lhs.map((i) => i.str).join('')
      )
    )
      continue
    const selected = [...lhs, ...frame, ...rows.flat()],
      keys = new Set(selected.map((i) => i.index)),
      end = Math.max(...keys),
      start = Math.min(...keys)
    if (
      selected.length !== keys.size ||
      items.some((i) => i.index >= start && i.index <= end && !keys.has(i.index))
    )
      continue
    for (const index of keys) result.add(index)
  }
  for (const index of opaqueConditionalItems(items, page.width)) result.add(index)
  for (const index of annotatedModularItems(items)) result.add(index)
  return result
}
