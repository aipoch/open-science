/** Native ownership for a wrapped percentage bullet containing a literal example.
 * No text annotation or checkpoint flag can grant this exception. */
type NativeItem = {
  str: string
  width: number
  height: number
  dir: string
  transform: readonly number[]
  hasEOL?: boolean
  fontName?: string
  fontFamily?: string
}
type Entry = { item: NativeItem; index: number }
type Row = { entries: Entry[]; line: number; text: string; x: number; right: number; y: number }
export type NativeMixedBullet = Readonly<{
  indices: readonly number[]
  tailIndices: readonly number[]
  literals: readonly string[]
  proved: boolean
}>

export function nativeMixedBulletOwners(
  items: readonly (NativeItem | { type: string })[],
  styles: Readonly<Record<string, { fontFamily?: string }>> = {},
  excluded: ReadonlySet<number> = new Set()
): NativeMixedBullet[] {
  const rows: Row[] = []
  let line = 0
  items.forEach((item, index) => {
    if (!('str' in item)) return
    if (item.str.trim()) {
      let row = rows.at(-1)
      if (row?.line !== line) {
        row = { entries: [], line, text: '', x: item.transform[4], right: 0, y: item.transform[5] }
        rows.push(row)
      }
      row!.entries.push({ item, index })
      row!.text += (row!.text ? ' ' : '') + item.str.trim()
      row!.right = item.transform[4] + item.width
    }
    if (item.hasEOL === true) line++
  })
  const family = (i: NativeItem): string | undefined =>
    i.fontFamily ?? styles[i.fontName ?? '']?.fontFamily
  const size = (i: NativeItem): number => i.transform[3]
  const same = (a: number, b: number, tolerance: number): boolean => Math.abs(a - b) < tolerance
  const heads = rows.filter((r) => /^[•●▪]\s+\d{1,3}%\s+\p{L}/u.test(r.text))
  const result: NativeMixedBullet[] = []
  for (const head of heads) {
    const at = rows.indexOf(head),
      mid = rows[at + 1],
      end = rows[at + 2]
    if (!mid || !end) continue
    const body = head.entries[0].item,
      code = mid.entries.findLast(
        ({ item }) => family(item) === 'monospace' && item.str !== '→'
      )?.item
    // A candidate survives loss of type/geometry proof. Readers must retain its
    // owner, rather than silently treating a restored snapshot as ordinary prose.
    if (
      ![...mid.entries, ...end.entries].some(
        ({ item }) => item.str === '→' || family(item) === 'monospace'
      ) ||
      !/^(?:[a-z]+|\[[A-Z]{2,8}\])(?: (?:[a-z]+|\[[A-Z]{2,8}\])){1,7}$/u.test(end.text)
    )
      continue
    if (!code) {
      result.push({
        indices: [...head.entries, ...mid.entries, ...end.entries].map((e) => e.index),
        tailIndices: end.entries.map((e) => e.index),
        literals: [],
        proved: false
      })
      continue
    }
    const em = size(body),
      pitch = head.y - mid.y
    const safe = (rs: Row[]): boolean =>
      rs.every(
        (r) =>
          r.entries.every(
            ({ item: i, index }) =>
              !excluded.has(index) &&
              i.dir === 'ltr' &&
              !!i.fontName &&
              i.transform.length === 6 &&
              i.transform.every(Number.isFinite) &&
              Number.isFinite(i.width) &&
              i.width > 0 &&
              Number.isFinite(i.height) &&
              i.height > 0 &&
              i.transform[0] > 0 &&
              size(i) > 0 &&
              Math.abs(i.transform[1]) < 0.001 &&
              Math.abs(i.transform[2]) < 0.001 &&
              same(i.transform[5], r.y, em * 0.05)
          ) &&
          r.entries.every(
            ({ item: i, index }, n) =>
              !n ||
              (index > r.entries[n - 1].index &&
                i.transform[4] >=
                  r.entries[n - 1].item.transform[4] + r.entries[n - 1].item.width - em * 0.03)
          )
      )
    const bodyPart = (i: NativeItem): boolean =>
      i.fontName === body.fontName && same(size(i), em, em * 0.03)
    const codePart = (i: NativeItem): boolean =>
      i.fontName === code.fontName &&
      family(i) === 'monospace' &&
      (same(size(i), size(code), em * 0.03) ||
        (/^\[[A-Z]{2,8}\]$/u.test(i.str) && same(size(i), em, em * 0.03)))
    const mixed = (r: Row): boolean =>
      [body.fontName, code.fontName].includes(r.entries[0].item.fontName) &&
      r.entries.some(({ item }) => item.fontName === body.fontName) &&
      r.entries.filter(({ item }) => item.str === '→').length === 1 &&
      r.entries.some(({ item }) => item.fontName === code.fontName) &&
      r.entries.every(({ item }) =>
        item.str === '→'
          ? same(size(item), size(code), em * 0.03)
          : bodyPart(item) || codePart(item)
      )
    const peer = heads.some((other) => {
      if (
        other === head ||
        !same(other.x, head.x, em * 0.05) ||
        !same(other.right, head.right, em * 0.2) ||
        !other.entries.every(({ item }) => bodyPart(item))
      )
        return false
      const m = rows.find((r) => r.line === other.line + 1),
        e = m && rows.find((r) => r.line === m.line + 1)
      return (
        !!m &&
        !!e &&
        mixed(m) &&
        same(m.x, mid.x, em * 0.08) &&
        same(e.x, end.x, em * 0.08) &&
        same(other.y - m.y, pitch, em * 0.05) &&
        same(m.y - e.y, pitch, em * 0.05) &&
        e.entries[0].item.fontName === code.fontName &&
        e.entries.some(({ item }) => bodyPart(item)) &&
        e.entries.every(({ item }, n) =>
          e.entries.slice(0, n).some(({ item: previous }) => bodyPart(previous))
            ? bodyPart(item)
            : bodyPart(item) || codePart(item)
        ) &&
        safe([other, m, e])
      )
    })
    const proved =
      mid.line === head.line + 1 &&
      end.line === mid.line + 1 &&
      head.entries.every(({ item }) => bodyPart(item)) &&
      safe([head, mid, end]) &&
      mixed(mid) &&
      end.entries.every(
        ({ item }) =>
          item.fontName === code.fontName &&
          family(item) === 'monospace' &&
          same(size(item), size(code), em * 0.03)
      ) &&
      size(code) / em >= 0.8 &&
      size(code) / em <= 0.9 &&
      same(mid.x, end.x, em * 0.08) &&
      mid.x - head.x >= em * 0.65 &&
      mid.x - head.x <= em * 1.1 &&
      pitch >= em &&
      pitch <= em * 1.4 &&
      same(mid.y - end.y, pitch, em * 0.05) &&
      /^(?:[a-z]+|\[[A-Z]{2,8}\])(?: (?:[a-z]+|\[[A-Z]{2,8}\])){1,7}$/u.test(end.text) &&
      peer
    const literals: string[] = []
    let literal = ''
    for (const { item } of [...mid.entries, ...end.entries]) {
      if (family(item) === 'monospace' || item.str === '→')
        literal += (literal ? ' ' : '') + item.str.trim().replace(/\s+/gu, ' ')
      else if (literal) {
        literals.push(literal)
        literal = ''
      }
    }
    if (literal) literals.push(literal)
    result.push({
      indices: [...head.entries, ...mid.entries, ...end.entries].map((e) => e.index),
      tailIndices: end.entries.map((e) => e.index),
      literals,
      proved
    })
  }
  return result
}

/** Spaces between literal words are semantic. Matching is ordered and counted,
 * including a short literal that also occurs inside a longer example. */
export function nativeMixedBulletLiteralsMatch(literals: readonly string[], text: string): boolean {
  const normalized = text.replace(/\s+/gu, ' ')
  const matches = (literal: string, value: string): RegExpExecArray[] => {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return [...value.matchAll(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gu'))]
  }
  let cursor = 0
  for (const literal of literals) {
    const match = matches(literal, normalized).find((m) => m.index >= cursor)
    if (!match) return false
    cursor = match.index + literal.length
  }
  return literals.every(
    (literal) => matches(literal, normalized).length === matches(literal, literals.join(' ')).length
  )
}
