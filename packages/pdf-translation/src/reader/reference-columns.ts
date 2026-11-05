type NativeReferenceBlock = {
  x: number
  y: number
  right: number
  bottom: number
  font: number
  source: string
  items: {
    index: number
    page: number
    unsupported: boolean
    fontName?: string
    transform: number[]
    dir: string
    str: string
    width: number
    height: number
  }[]
}

// A centered native page number can obscure an otherwise complete bibliography
// gutter. Prove both numbered columns before restoring their native order.
// This does not reconstruct records, change text or infer missing numbers.
export function nativeNumberedReferenceColumns<T extends NativeReferenceBlock>(
  blocks: T[],
  page: { page: number; width: number; height: number }
): T[] | undefined {
  const markers = blocks.filter((block) => /^\[\d{1,4}\]\s+\p{Lu}/u.test(block.source))
  if (markers.length < 8) return undefined
  if (
    ![page.width, page.height].every((value) => Number.isFinite(value) && value > 0) ||
    blocks.some(
      (block) =>
        ![block.x, block.y, block.right, block.bottom, block.font].every(Number.isFinite) ||
        block.font <= 0 ||
        block.x < 0 ||
        block.y < 0 ||
        block.x >= block.right ||
        block.y >= block.bottom ||
        block.right > page.width ||
        block.bottom > page.height ||
        !block.items.length ||
        block.items.some(
          (item) =>
            item.page !== page.page ||
            !Number.isSafeInteger(item.index) ||
            item.unsupported ||
            !item.fontName ||
            item.dir !== 'ltr' ||
            ![item.width, item.height].every((value) => Number.isFinite(value) && value > 0) ||
            item.transform.length !== 6 ||
            !item.transform.every(Number.isFinite) ||
            item.transform[0] <= 0 ||
            item.transform[3] <= 0 ||
            Math.abs(item.transform[1]) > 0.001 ||
            Math.abs(item.transform[2]) > 0.001
        )
    )
  )
    return undefined
  const font = markers[0].font
  const starts = markers.map((block) => block.x).toSorted((a, b) => a - b)
  const gaps = starts.flatMap((start, index) =>
    index > 0 && start - starts[index - 1] > font * 4 ? [(start + starts[index - 1]) / 2] : []
  )
  if (gaps.length !== 1) return undefined
  const middle = gaps[0]
  const footers = blocks.filter(
    (block) => block.items.length === 1 && block.source === String(block.items[0].page)
  )
  if (footers.length !== 1) return undefined
  const footer = footers[0]
  if (
    footer.right - footer.x > font * 3 ||
    footer.items[0].fontName !== markers[0].items[0]?.fontName ||
    Math.abs(footer.font - font) > font * 0.05 ||
    footer.y < page.height * 0.85 ||
    Math.abs((footer.x + footer.right) / 2 - page.width / 2) > page.width * 0.1
  )
    return undefined
  const body = blocks.filter((block) => block !== footer)
  const lanes = [
    body.filter((block) => block.x < middle),
    body.filter((block) => block.x > middle)
  ].map((lane) => lane.toSorted((a, b) => a.y - b.y || a.x - b.x))
  if (
    lanes.flat().length !== body.length ||
    Math.min(...lanes[1].map((block) => block.x)) -
      Math.max(...lanes[0].map((block) => block.right)) <
      font * 0.9 ||
    footer.x <= Math.max(...lanes[0].map((block) => block.right)) ||
    footer.right >= Math.min(...lanes[1].map((block) => block.x)) ||
    footer.y <= Math.max(...body.map((block) => block.bottom)) ||
    footer.y - Math.max(...body.map((block) => block.bottom)) > font * 3 ||
    Math.max(...body.map((block) => block.bottom)) - Math.min(...body.map((block) => block.y)) <
      page.height * 0.6 ||
    Math.abs(lanes[0][0].y - lanes[1][0].y) > font * 0.5 ||
    footer.items[0].index <=
      Math.max(...body.flatMap((block) => block.items.map((item) => item.index)))
  )
    return undefined
  const records: { number: number; blocks: T[] }[] = []
  for (const lane of lanes) {
    let record: (typeof records)[number] | undefined
    const laneRecords: typeof records = []
    for (const block of lane) {
      const marker = /^\[(\d{1,4})\]\s+\p{Lu}/u.exec(block.source)
      if (marker) {
        if (
          !block.items[0].str.startsWith(`[${marker[1]}]`) ||
          block.items[0].fontName !== markers[0].items[0].fontName ||
          Math.abs(block.font - font) > font * 0.05
        )
          return undefined
        record = { number: Number(marker[1]), blocks: [] }
        laneRecords.push(record)
      }
      if (!record) return undefined
      record.blocks.push(block)
    }
    if (
      laneRecords.length < 4 ||
      laneRecords.some((entry, index) => {
        const text = entry.blocks.map((block) => block.source).join(' ')
        const items = entry.blocks.flatMap((block) => block.items)
        return (
          !/\b(?:19|20)\d{2}\b/u.test(text) ||
          (text.match(/\p{L}{2,}/gu)?.length ?? 0) < 8 ||
          items.some((item, at) => at > 0 && item.index <= items[at - 1].index) ||
          (index > 0 && entry.number !== laneRecords[index - 1].number + 1)
        )
      })
    )
      return undefined
    records.push(...laneRecords)
  }
  const items = lanes.flat().flatMap((block) => block.items)
  return records.every(
    (record, index) => index === 0 || record.number === records[index - 1].number + 1
  ) &&
    new Set(items.map((item) => item.index)).size === items.length &&
    items.every((item, index) => index === 0 || item.index > items[index - 1].index)
    ? [...lanes.flat(), footer]
    : undefined
}

type ColumnItem = import('./layout.js').PdfLayoutTextItem & {
  index: number
  key: string
  page: number
  font: number
  unsupported: boolean
}
type ColumnBlock = Omit<NativeReferenceBlock, 'items'> & {
  items: ColumnItem[]
  lines: { items: ColumnItem[]; baseline: number; x: number; y: number }[]
  risks: string[]
}

/** Keep the existing prefix owners and repair only proved body slots. This
 * supplies no glyph, caption, table-cell or translation-policy authority. */
export function nativeStaggeredColumnBodyOrder<T extends ColumnBlock>(
  blocks: T[],
  page: import('./layout.js').PdfLayoutPage,
  order: (values: T[]) => T[]
): T[] | undefined {
  try {
    const retained: {
        object: object
        prototype: object | null
        keys: string[]
        descriptors: PropertyDescriptor[]
      }[] = [],
      seen = new Set<object>(),
      watch = (object: object): boolean => {
        if (!object || typeof object !== 'object') return false
        if (seen.has(object)) return true
        if (seen.size >= 65536 || (Array.isArray(object) && object.length > 65536)) return false
        const prototype = Object.getPrototypeOf(object)
        if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null)
          return false
        const keys = Reflect.ownKeys(object)
        if (keys.some((key) => typeof key !== 'string')) return false
        const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(object, key)!)
        if (descriptors.some((descriptor) => !descriptor || !('value' in descriptor))) return false
        if (
          Array.isArray(object) &&
          (keys.length !== object.length + 1 ||
            keys.some((key) => key !== 'length' && !/^(?:0|[1-9]\d*)$/u.test(String(key))))
        )
          return false
        retained.push({ object, prototype, keys: keys as string[], descriptors })
        seen.add(object)
        return true
      },
      current = (): boolean =>
        retained.every(({ object, prototype, keys, descriptors }) => {
          const now = Reflect.ownKeys(object)
          return (
            Object.getPrototypeOf(object) === prototype &&
            now.length === keys.length &&
            now.every((key, index) => key === keys[index]) &&
            keys.every((key, index) => {
              const value = Object.getOwnPropertyDescriptor(object, key),
                before = descriptors[index]
              return (
                !!value &&
                'value' in value &&
                Object.is(value.value, before.value) &&
                value.writable === before.writable &&
                value.enumerable === before.enumerable &&
                value.configurable === before.configurable
              )
            })
          )
        }),
      gaps = (
        values: { x: number; right: number }[]
      ): { start: number; end: number; size: number }[] => {
        const sorted = [...values].sort((a, b) => a.x - b.x),
          result = []
        let right = sorted[0]?.right
        for (const value of sorted.slice(1)) {
          if (value.x > right) result.push({ start: right, end: value.x, size: value.x - right })
          right = Math.max(right, value.right)
        }
        return result
      },
      range = (values: T[]): [number, number] => [
        Math.min(...values.flatMap((b) => b.items.map((i) => i.index))),
        Math.max(...values.flatMap((b) => b.items.map((i) => i.index)))
      ],
      words = (s: string): number => s.match(/\p{L}{2,}/gu)?.length ?? 0,
      // Local prefix exclusion only. Do not widen the global caption parser.
      caption =
        /^(?:Table|Tab\.|Figure|Fig\.)\s+(?:[1-9]\d{0,3}|(?=[MDCLXVI])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))[.:]\s/iu
    if (
      !watch(page) ||
      !watch(page.items) ||
      !watch(blocks) ||
      page.rotation !== 0 ||
      !Number.isSafeInteger(page.page) ||
      page.page < 1 ||
      ![page.width, page.height].every((v) => Number.isFinite(v) && v > 0) ||
      page.items.length > 4096 ||
      blocks.length < 8 ||
      blocks.length > 4096
    )
      return
    const evidence = page.nativeReferenceEvidence
    if (!evidence?.complete || !watch(evidence) || !watch(evidence.fonts) || !watch(evidence.rules))
      return
    if (evidence.rules.length > 4096 || Object.keys(evidence.fonts).length > 4096) return
    for (const font of Object.values(evidence.fonts)) if (!watch(font)) return
    for (const rule of evidence.rules) if (!watch(rule) || !watch(rule.operators)) return
    const native = page.items.flatMap((item, index) => {
      if (!watch(item) || !watch(item.transform)) throw Error('Unretained native item')
      if (!item.str.trim()) return []
      const font = evidence.fonts[item.fontName ?? '']
      if (
        !font?.nativeMetrics ||
        font.vertical !== false ||
        item.fontVertical !== false ||
        item.fontAscent !== font.ascent ||
        item.fontDescent !== font.descent ||
        !(font.ascent > 0 && font.ascent <= 1 && font.descent >= -1 && font.descent <= 0) ||
        item.dir !== 'ltr' ||
        item.transform.length !== 6 ||
        ![...item.transform, item.width, item.height].every(Number.isFinite) ||
        item.width <= 0 ||
        item.height <= 0 ||
        item.transform[0] <= 0 ||
        item.transform[3] !== item.height ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0
      )
        throw Error('Incomplete native font or affine source')
      const x = item.transform[4],
        right = x + item.width,
        y = page.height - item.transform[5] - font.ascent * item.height,
        bottom = page.height - item.transform[5] - font.descent * item.height
      if (x < 0 || right > page.width || y < 0 || bottom > page.height)
        throw Error('Outside native page')
      return [{ index, item, x, right, y, bottom }]
    })
    const counts = new Set<number>()
    for (const block of blocks) {
      if (
        !watch(block) ||
        !watch(block.items) ||
        !watch(block.lines) ||
        !watch(block.risks) ||
        !block.items.length ||
        block.risks.length ||
        ![block.x, block.y, block.right, block.bottom, block.font].every(Number.isFinite) ||
        block.right <= block.x ||
        block.bottom <= block.y ||
        block.font <= 0
      )
        return
      for (const line of block.lines) if (!watch(line) || !watch(line.items)) return
      for (const item of block.items) {
        const n = page.items[item.index]
        if (
          !watch(item) ||
          !watch(item.transform) ||
          !n ||
          counts.has(item.index) ||
          item.unsupported ||
          item.page !== page.page ||
          item.key !== page.page + ':' + item.index ||
          item.str !== n.str ||
          item.width !== n.width ||
          item.height !== n.height ||
          item.dir !== n.dir ||
          item.fontName !== n.fontName ||
          item.fontVertical !== n.fontVertical ||
          item.fontAscent !== n.fontAscent ||
          item.fontDescent !== n.fontDescent ||
          item.transform.length !== 6 ||
          item.transform.some((v, k) => !Object.is(v, n.transform[k]))
        )
          return
        counts.add(item.index)
      }
    }
    if (counts.size !== native.length || native.some((i) => !counts.has(i.index))) return
    const possibleFrames = blocks.filter(
      (b) =>
        b.lines.length >= 2 &&
        words(b.source) >= 12 &&
        b.right - b.x >= b.font * 8 &&
        !caption.test(b.source)
    )
    if (possibleFrames.length < 4) return
    const font = possibleFrames.map((b) => b.font).sort((a, b) => a - b)[
        Math.floor(possibleFrames.length / 2)
      ],
      frames = possibleFrames.filter((b) => Math.abs(b.font - font) < font * 0.05),
      frameGaps = gaps(frames).filter((g) => g.size > font * 0.9),
      nativeGaps = gaps(native)
    if (frameGaps.length !== 1 || nativeGaps.length !== 1) return
    const frameGap = frameGaps[0],
      gutter = nativeGaps[0]
    if (gutter.start < frameGap.start || gutter.end > frameGap.end) return
    const sides = [
        native.filter((i) => i.right <= gutter.start),
        native.filter((i) => i.x >= gutter.end)
      ],
      frameSides = [
        frames.filter((b) => b.right <= frameGap.start + 0.001),
        frames.filter((b) => b.x >= frameGap.end - 0.001)
      ]
    if (
      sides.some((s) => !s.length) ||
      sides.flat().length !== native.length ||
      frameSides.some((s) => s.length < 2) ||
      frameSides.flat().length !== frames.length ||
      sides[0].at(-1)!.index >= sides[1][0].index
    )
      return
    const starts = frameSides.map((s) => range(s)[0]),
      lane = new Map(sides.flatMap((s, n) => s.map((i) => [i.index, n] as const))),
      isBody = (i: ColumnItem): boolean => i.index >= starts[lane.get(i.index)!],
      prefix: T[] = [],
      body: T[][] = [[], []]
    for (const block of blocks) {
      if (block.items.every((i) => !isBody(i))) prefix.push(block)
      else {
        const side = lane.get(block.items[0].index)!
        if (
          !block.items.every((i) => isBody(i) && lane.get(i.index) === side) ||
          (side === 0 ? block.right > frameGap.start + 0.001 : block.x < frameGap.end - 0.001)
        )
          return
        body[side].push(block)
      }
    }
    const tops = body.map((s) => Math.min(...s.map((b) => b.y))),
      nativePrefixes = sides.map((s, n) => s.filter((i) => i.index < starts[n]))
    if (
      body.some((s) => !s.length) ||
      nativePrefixes.some((s) => !s.length) ||
      nativePrefixes.some((s, n) => s.some((i) => i.bottom >= tops[n])) ||
      !(
        tops[0] < Math.max(...nativePrefixes[1].map((i) => i.bottom)) ||
        tops[1] < Math.max(...nativePrefixes[0].map((i) => i.bottom))
      ) ||
      [0, 1].some(
        (n) =>
          prefix.filter(
            (b) => caption.test(b.source) && b.items.every((i) => lane.get(i.index) === n)
          ).length !== 1
      )
    )
      return
    const exactPermutation = (values: T[], originals: T[]): boolean =>
      values.length === originals.length &&
      new Set(values).size === originals.length &&
      values.every((b) => originals.includes(b))
    const old = order(blocks),
      orderedSides = body.map((s) => order(s))
    if (
      !exactPermutation(old, blocks) ||
      orderedSides.some((s, n) => !exactPermutation(s, body[n])) ||
      orderedSides.some((s) => s.some((b, n) => n > 0 && range([s[n - 1]])[1] >= range([b])[0])) ||
      range(orderedSides[0])[1] >= range(orderedSides[1])[0] ||
      !current()
    )
      return
    const wanted = orderedSides.flat(),
      bodySet = new Set(wanted)
    let at = 0
    const result = old.map((b) => (bodySet.has(b) ? wanted[at++] : b))
    return at === wanted.length && result.some((b, n) => b !== old[n]) && current()
      ? result
      : undefined
  } catch {
    return undefined
  }
}
