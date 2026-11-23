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

// Full-size TeX braces can enclose two numbered cases on two nearby baselines.
// Keep the condition attached to its value, even when “if” looks like prose.
function factorialConditionalItems(items: Part[]): ReadonlySet<number> {
  const selected = new Set<number>()
  for (let at = 1; at + 7 < items.length; at++) {
    const brace = items[at],
      equal = items[at - 1]
    if (
      brace.str !== '{' ||
      equal.str !== '=' ||
      ![brace, equal].every(valid) ||
      brace.fontAscent! < 0 ||
      brace.fontAscent! > 0.1 ||
      brace.fontDescent! >= -2
    )
      continue
    const labelAt = items
      .slice(at + 1, at + 24)
      .findIndex((item) => /^\([1-9]\d?\)$/u.test(item.str))
    if (labelAt < 0) continue
    const label = items[at + 1 + labelAt],
      packet = items.slice(at + 1, at + 1 + labelAt)
    const [first, last, extra] = packet.filter((item) => item.str === 'if')
    if (!first || !last || extra || ![label, ...packet].every(valid)) continue
    const h = brace.height,
      x = (item: Part): number => item.transform[4],
      y = (item: Part): number => item.transform[5],
      right = (item: Part): number => x(item) + item.width,
      near = (a: number, b: number): boolean => Math.abs(a - b) < h * 0.06,
      rows = [
        packet.filter((item) => y(item) > y(equal)),
        packet.filter((item) => y(item) <= y(equal))
      ]
    if (rows.some((row) => row.length < 3)) continue
    const splits = rows.map((row, n) => row.indexOf(n === 0 ? first : last))
    const compact = (row: Part[]): string =>
      row.map((item) => item.str.replace(/\s/gu, '')).join('')
    const [upper, lower] = rows.map((row, n) => compact(row.slice(0, splits[n])))
    const match = /^([a-z])=([a-z]),$/u.exec(compact(rows[0].slice(splits[0] + 1)))
    if (
      splits.some((split) => split < 1) ||
      !match ||
      match[1] === match[2] ||
      !new RegExp(
        '^(?:\\(−1\\)' + match[2] + '·[a-z]' + match[2] + '·)?' + match[2] + '!$',
        'u'
      ).test(upper) ||
      lower !== '0' ||
      compact(rows[1].slice(splits[1] + 1)) !== match[1] + '<' + match[2] + '.' ||
      !near(y(equal), y(label)) ||
      !near(equal.height, h) ||
      !near(label.height, h) ||
      !near(y(brace) - y(equal), h * 1.72) ||
      !near(y(first) - y(last), h * 1.5) ||
      !near(y(first) - y(equal), h * 0.7) ||
      !near(x(brace) - right(equal), h * 0.28) ||
      !near(x(first), x(last)) ||
      first.fontName !== last.fontName ||
      first.fontName === brace.fontName ||
      ![rows[0][0], rows[1][0]].every((item) => near(x(item), right(brace))) ||
      rows.some((row, n) =>
        row.some((item, i) => {
          const connector = n ? last : first
          const script =
            n === 0 &&
            item.height > h * 0.7 &&
            item.height < h * 0.8 &&
            /^[a-z]$/u.test(item.str) &&
            i < splits[0] &&
            y(item) - y(first) > h * 0.3 &&
            y(item) - y(first) < h * 0.45 &&
            i > 0 &&
            near(x(item), right(row[i - 1]))
          return (
            x(item) < right(brace) - h * 0.06 ||
            right(item) >= x(label) - h ||
            (!script && (!near(y(item), y(connector)) || !near(item.height, h))) ||
            (i > 0 && x(item) < right(row[i - 1]) - h * 0.06)
          )
        })
      )
    )
      continue
    for (const item of [equal, brace, ...packet, label]) selected.add(item.index)
  }
  return selected
}

// A single TeX brace can span a native three-row numeric set-membership display.
function numericSetCaseItems(items: Part[]): ReadonlySet<number> {
  const result = new Set<number>()
  for (let at = 3; at + 9 < items.length; at++) {
    const [base, subscript, equal, brace] = items.slice(at - 3, at + 1)
    if (
      brace.str !== '{' ||
      equal.str !== '=' ||
      ![base, subscript, equal, brace].every(valid) ||
      !/^[A-Za-z\p{Script=Greek}]$/u.test(base.str) ||
      !/^[A-Za-z\p{Script=Greek}]$/u.test(subscript.str) ||
      brace.fontAscent! < 0 ||
      brace.fontAscent! > 0.1 ||
      brace.fontDescent! >= -0.3 ||
      brace.fontName === equal.fontName
    )
      continue
    const size = equal.height,
      x = (i: Part): number => i.transform[4],
      y = (i: Part): number => i.transform[5],
      right = (i: Part): number => x(i) + i.width,
      near = (a: number, b: number): boolean => Math.abs(a - b) < size * 0.06,
      lhs = [base, subscript, equal]
    if (
      !near(brace.height, size) ||
      y(brace) - y(equal) < size * 1.5 ||
      y(brace) - y(equal) > size * 2 ||
      x(equal) < right(subscript) ||
      x(equal) - right(subscript) > size * 0.8 ||
      x(brace) - right(equal) < 0 ||
      x(brace) - right(equal) > size * 0.6 ||
      !conditionalMathParts(lhs, size, y(equal)) ||
      y(subscript) >= y(base)
    )
      continue

    const rows = [1.2, 0, -1.2].map((offset) =>
      items.filter(
        (item) =>
          item.index > brace.index &&
          x(item) >= right(brace) &&
          near(y(item), y(equal) + size * offset)
      )
    )
    const columns = rows.map((row) => {
      const split = row.findIndex((item) => item.str === 'if')
      return { value: row.slice(0, split), connector: row[split], condition: row.slice(split + 1) }
    })
    const compact = (row: Part[]): string => row.map((item) => item.str.trim()).join('')
    const values = columns.map(({ value }) => compact(value))
    if (
      new Set(values).size !== 3 ||
      columns.some(
        ({ value, connector, condition }, row) =>
          !connector ||
          !/^[+−-]?\d{1,3},$/u.test(values[row]) ||
          !new RegExp('^' + subscript.str + '∈[A-Za-z]∩[A-Za-z][;.]$', 'u').test(
            compact(condition)
          ) ||
          x(value[0]) - right(brace) > size * 0.5 ||
          connector.fontName !== equal.fontName ||
          !near(x(value[0]), x(columns[0].value[0])) ||
          !near(x(connector), x(columns[0].connector)) ||
          !near(x(condition[0]), x(columns[0].condition[0])) ||
          !near(right(condition.at(-1)!), right(columns[0].condition.at(-1)!)) ||
          rows[row].some(
            (item, n, entries) =>
              !valid(item) ||
              !near(item.height, size) ||
              (n > 0 &&
                (item.index <= entries[n - 1].index ||
                  x(item) < right(entries[n - 1]) - size * 0.06 ||
                  x(item) - right(entries[n - 1]) > size * 3))
          )
      )
    )
      continue

    const packet = [...lhs, brace, ...rows.flat()],
      selected = new Set(packet.map((item) => item.index)),
      end = Math.max(...selected),
      high = y(brace) + size * 0.5,
      low = y(rows[2][0]) - size * 0.6,
      far = right(rows[0].at(-1)!)
    if (
      packet.length !== selected.size ||
      packet.some((item, n) => n > 0 && item.index <= packet[n - 1].index) ||
      items.some(
        (item) =>
          !selected.has(item.index) &&
          ((item.index >= base.index && item.index <= end) ||
            (x(item) < far && right(item) > x(base) && y(item) < high && y(item) > low))
      )
    )
      continue
    for (const index of selected) result.add(index)
  }
  return result
}

// An assignment and two aligned comparison rows certify a complete Unicode
// cases brace. Its interior can contain a function and stacked fractions.
function extensibleCaseItems(items: Part[]): ReadonlySet<number> {
  const result = new Set<number>()
  for (const [at, top] of items.entries()) {
    if (top.str !== '⎧' || !valid(top)) continue
    let end = at + 1
    while (end < at + 12 && /^[⎪⎨]$/u.test(items[end]?.str ?? '')) end++
    const rail = items.slice(at, end + 1),
      bottom = items[end],
      lead = items[at - 1],
      size = top.height,
      x = (item: Part): number => item.transform[4],
      y = (item: Part): number => item.transform[5],
      right = (item: Part): number => x(item) + item.width,
      near = (a: number, b: number): boolean => Math.abs(a - b) < size * 0.05
    if (
      !bottom ||
      !lead ||
      !valid(lead) ||
      !/=\s*$/u.test(lead.str) ||
      Math.abs(y(lead) - (y(top) + y(bottom)) / 2) > size * 0.85 ||
      Math.abs(x(top) - right(lead)) > size * 0.7 ||
      !/^⎧⎪+⎨⎪+⎩$/u.test(rail.map(({ str }) => str).join('')) ||
      !rail.every(
        (item, index) =>
          valid(item) &&
          item.fontName === top.fontName &&
          near(item.height, size) &&
          near(item.width, top.width) &&
          near(x(item), x(top)) &&
          (!index || (y(rail[index - 1]) > y(item) && y(rail[index - 1]) - y(item) < size * 2))
      )
    )
      continue
    const body = items
        .slice(end + 1, end + 49)
        .filter(
          (item) =>
            valid(item) &&
            x(item) >= right(top) - size * 0.05 &&
            y(item) < y(top) &&
            y(item) > y(bottom) - size
        ),
      comparisons = body.filter((item, index) => {
        const value = body[index + 1]
        return (
          /[<>≤≥]$/u.test(item.str) &&
          x(item) - x(top) > size * 6 &&
          !!value &&
          /^\d+[.,]?$/u.test(value.str) &&
          near(y(item), y(value)) &&
          x(value) > x(item) &&
          x(value) - right(item) < size
        )
      }),
      upper = comparisons.find((item) => y(item) > y(bottom) + size),
      lower = comparisons.find((item) => Math.abs(y(item) - y(bottom)) < size * 0.6)
    if (!upper || !lower || Math.abs(x(upper) - x(lower)) > size * 1.5) continue

    for (const item of rail) result.add(item.index)
    const fn = items[end + 1]
    if (
      fn &&
      valid(fn) &&
      /^(?:max|min)$/u.test(fn.str) &&
      near(y(fn), y(upper)) &&
      near(x(fn), right(top))
    )
      result.add(fn.index)
    for (const [index, item] of body.entries()) {
      const numerator = body[index - 1],
        minus = body[index - 2],
        one = body[index - 3]
      if (
        numerator &&
        minus &&
        one &&
        /^\p{Ll}$/u.test(item.str) &&
        /^\p{Ll}$/u.test(numerator.str) &&
        item.fontName === numerator.fontName &&
        y(item) < y(upper) &&
        y(item) > y(lower) &&
        x(item) > x(one) &&
        right(item) < right(numerator) &&
        y(numerator) - y(item) > size &&
        y(numerator) - y(item) < size * 2 &&
        minus.str === '−' &&
        one.str === '1' &&
        near(y(one), y(numerator)) &&
        near(y(minus), y(numerator))
      )
        result.add(item.index)
      if (x(item) < x(top) + size * 2 && near(y(item), y(lower)) && /^[\d,.]+$/u.test(item.str))
        result.add(item.index)
    }
  }
  return result
}

// A closed four-row brace can keep split relation clauses in their original type.
function alignedCaseConditionItems(items: Part[]): number[] {
  for (const [at, top] of items.entries()) {
    if (top.str !== '\uF8F1' || !valid(top)) continue
    let end = at + 1
    while (end - at < 15 && /^[\uF8F2\uF8F4]$/u.test(items[end]?.str ?? '')) end++
    const rail = items.slice(at, end + 1),
      bottom = rail.at(-1)!,
      em = top.height
    const x = (i: Part): number => i.transform[4],
      y = (i: Part): number => i.transform[5]
    if (
      !/^\uF8F1\uF8F4{3,6}\uF8F2\uF8F4{3,6}\uF8F3$/u.test(rail.map((i) => i.str).join('')) ||
      rail.some(
        (i, n) =>
          !valid(i) ||
          i.fontName !== top.fontName ||
          Math.abs(x(i) - x(top)) > em * 0.01 ||
          Math.abs(i.height - em) > em * 0.01 ||
          Math.abs(i.width - top.width) > em * 0.01 ||
          (n > 0 && (y(rail[n - 1]) - y(i) <= 0 || y(rail[n - 1]) - y(i) > em * 2))
      )
    )
      continue
    const next = items.slice(end + 1, end + 101)
    const tag = next.find(
      (i) =>
        /^\([1-9]\d{0,2}\)$/u.test(i.str) &&
        valid(i) &&
        x(i) - x(top) > em * 18 &&
        x(i) - x(top) < em * 24 &&
        Math.abs(y(i) - (y(top) + y(bottom)) / 2) < em * 0.2
    )
    if (!tag) continue
    const packet = next.slice(0, next.indexOf(tag))
    if (
      !packet.length ||
      packet.some(
        (i) =>
          !valid(i) ||
          x(i) < x(top) + top.width - em * 0.02 ||
          x(i) + i.width >= x(tag) ||
          y(i) > y(top) ||
          y(i) < y(bottom) - em * 0.7 ||
          !/^[\p{Script=Latin}\p{Script=Greek}ℓ\d\s(),.+−<>≤≥]+$/u.test(i.str) ||
          /[A-Za-z]{4,}/u.test(i.str)
      )
    )
      continue
    const comparisons = packet.filter((i) => /[<>≤≥]/u.test(i.str))
    const levels = [...new Set(comparisons.map(y))]
    if (
      levels.length !== 4 ||
      levels.some(
        (b, n) => n > 0 && (levels[n - 1] - b < em * 1.25 || levels[n - 1] - b > em * 2.05)
      )
    )
      continue
    const firstX = (baseline: number): number =>
      Math.min(
        ...packet
          .filter((i) => Math.abs(y(i) - baseline) < em * 0.03 && x(i) - x(top) > em * 10)
          .map(x)
      )
    const column = firstX(levels[0])
    if (
      !(column - x(top) > em * 10 && column - x(top) < em * 12) ||
      levels.some((b) => Math.abs(firstX(b) - column) > em * 0.04)
    )
      continue
    return packet.map((i) => i.index)
  }
  return []
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
  for (const index of extensibleCaseItems(items)) result.add(index)
  for (const index of opaqueConditionalItems(items, page.width)) result.add(index)
  for (const index of annotatedModularItems(items)) result.add(index)
  for (const index of factorialConditionalItems(items)) result.add(index)
  for (const index of numericSetCaseItems(items)) result.add(index)
  for (const index of alignedCaseConditionItems(items)) result.add(index)
  return result
}
