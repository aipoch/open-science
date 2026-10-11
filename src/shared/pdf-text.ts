export type PdfTextItem = Readonly<{
  str?: string
  hasEOL?: boolean
  dir?: string
  transform?: readonly number[]
  width?: number
  height?: number
}>

const fontHeight = (item: PdfTextItem): number => {
  if (item.height && item.height > 0) return item.height
  const transform = item.transform
  return transform && transform.length >= 4 ? Math.hypot(transform[2], transform[3]) : 0
}

const hasWordGap = (previous: PdfTextItem, current: PdfTextItem): boolean => {
  if ((previous.dir && previous.dir !== 'ltr') || (current.dir && current.dir !== 'ltr'))
    return false
  const previousTransform = previous.transform
  const currentTransform = current.transform
  if (
    !previousTransform ||
    previousTransform.length < 6 ||
    !currentTransform ||
    currentTransform.length < 6 ||
    previous.width === undefined
  ) {
    return false
  }
  const height = Math.max(fontHeight(previous), fontHeight(current))
  if (height <= 0 || Math.abs(previousTransform[5] - currentTransform[5]) > height / 2) return false
  return currentTransform[4] - (previousTransform[4] + previous.width) > height * 0.15
}

const hasCaptionBlockGap = (previous: PdfTextItem, current: PdfTextItem): boolean => {
  const label = previous.str ?? ''
  if (
    previous.hasEOL ||
    (!/[A-Za-z]{3,}$/u.test(label) &&
      !/^[0-9]$/u.test(label) &&
      !/^[0-9]{4}$/u.test(label) &&
      !/^[A-Za-z]{3,}(?:[ ,]+[A-Za-z]{3,})*[ ,]+[0-9]{1,2}$/u.test(label) &&
      !/^[A-Za-z]{3,}(?: +[A-Za-z]{3,})+ +↓$/u.test(label))
  )
    return false
  if ([...label].some((character) => character.charCodeAt(0) < 32)) return false
  if (!/^(?:Figure\s+[A-Z]?\d+\s*:|Fig\.\s+[A-Z]?\d+\.)(?=\s|$)/u.test(current.str ?? ''))
    return false
  const upright = (item: PdfTextItem): boolean => {
    const transform = item.transform
    return Boolean(
      transform &&
      transform.length === 6 &&
      transform.every(Number.isFinite) &&
      transform[0] > 0 &&
      transform[3] > 0 &&
      transform[1] === 0 &&
      transform[2] === 0 &&
      Number.isFinite(item.width) &&
      item.width! > 0 &&
      Number.isFinite(item.height) &&
      item.height! > 0 &&
      Math.abs(item.height! - transform[3]) < 1e-6 &&
      (!item.dir || item.dir === 'ltr')
    )
  }
  if (!upright(previous) || !upright(current)) return false
  if (current.transform![4] + current.width! >= previous.transform![4]) return false
  if (previous.height! * 1.5 >= current.height!) return false
  const height = Math.max(previous.height!, current.height!)
  const descendingDistance = previous.transform![5] - current.transform![5]
  return descendingDistance > 2 * height && descendingDistance - current.height! > height
}

const nativeRunBox = (item: PdfTextItem): readonly number[] | undefined => {
  const t = item.transform
  if (
    !t ||
    t.length !== 6 ||
    !t.every(Number.isFinite) ||
    !Number.isFinite(item.width) ||
    item.width! <= 0 ||
    !Number.isFinite(item.height) ||
    item.height! <= 0 ||
    (item.dir && item.dir !== 'ltr') ||
    [...(item.str ?? '')].some((c) => c.charCodeAt(0) < 32)
  )
    return
  const horizontal = t[0] > 0 && t[1] === 0 && t[2] === 0 && t[3] > 0
  const vertical = t[0] === 0 && t[3] === 0 && t[1] * t[2] < 0
  const height = Math.hypot(t[2], t[3])
  const advance = Math.hypot(t[0], t[1])
  const rotated =
    t[0] > 0 &&
    t[3] > 0 &&
    t[0] * t[3] - t[1] * t[2] > 0 &&
    Math.abs(t[0] * t[2] + t[1] * t[3]) <= advance * height * 1e-6
  if ((!horizontal && !vertical && !rotated) || Math.abs(height - item.height!) > 1e-6) return
  const dx = (t[0] * item.width!) / advance
  const dy = (t[1] * item.width!) / advance
  const xs = [t[4], t[4] + dx, t[4] + t[2], t[4] + dx + t[2]]
  const ys = [t[5], t[5] + dy, t[5] + t[3], t[5] + dy + t[3]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

// A short label alone cannot prove a block boundary. Additional native label
// carriers and the complete descriptive caption line establish the new cases;
// the existing two-item caption proof above remains independent.
const hasNativeCaptionLineGap = (
  items: readonly PdfTextItem[],
  index: number,
  previous: PdfTextItem
): boolean => {
  const current = items[index]
  if (
    previous.hasEOL ||
    !/^(?:Figure\s+[A-Z]?\d+\s*(?::|\.(?=\s|$))|Fig\.\s+[A-Z]?\d+)/u.test(current.str ?? '')
  )
    return false
  const before = nativeRunBox(previous)
  const caption = nativeRunBox(current)
  const t = current.transform
  if (!before || !caption || !t || t[1] !== 0 || t[2] !== 0) return false
  const height = Math.max(previous.height!, current.height!)
  if (before[1] - caption[3] <= height || caption[0] >= before[0] - height * 0.1) return false
  let line = ''
  let right = caption[0]
  for (const part of items.slice(index, index + 16)) {
    if (!part.str?.trim()) {
      if (part.hasEOL) break
      continue
    }
    const box = nativeRunBox(part)
    if (
      !box ||
      !part.transform ||
      part.transform[1] !== 0 ||
      part.transform[2] !== 0 ||
      Math.abs(part.transform[5] - t[5]) > current.height! * 0.05 ||
      part.height! < current.height! * 0.65 ||
      part.height! > current.height! * 1.25 ||
      box[0] < right - current.height! * 0.05 ||
      box[0] - right > current.height! * 0.7
    )
      break
    line += part.str
    right = box[2]
    if (part.hasEOL) break
  }
  const prefix = /^(?:Figure\s+[A-Z]?\d+\s*(?::|\.(?=\s|$))|Fig\.\s+[A-Z]?\d+[.:])\s*/u.exec(line)
  if (!prefix || (line.slice(prefix[0].length).match(/\p{L}/gu)?.length ?? 0) < 12) return false
  const labels = items.slice(Math.max(0, index - 16), index).filter((item) => {
    if (!item.str?.trim() || /[.!?]\s*$/u.test(item.str)) return false
    const box = nativeRunBox(item)
    return (
      box &&
      item.height! <= current.height! * 1.5 &&
      box[1] - caption[3] > height * 0.5 &&
      box[0] >= caption[0] - height &&
      box[2] <= Math.max(right, before[2]) + height
    )
  })
  return labels.length >= 3 && new Set(labels.map((i) => i.transform?.join(','))).size >= 3
}

// The complete initial native line and a closed, distant row of smaller word
// labels establish separate blocks. This uses item geometry, not header meaning.
const hasInitialLineClosedLabelGap = (
  items: readonly PdfTextItem[],
  index: number,
  previous: PdfTextItem
): boolean => {
  if (index < 2 || index > 16 || previous.hasEOL) return false
  const prefix = items.slice(0, index),
    fonts = prefix.filter((part) => part.str && !/^ *$/u.test(part.str))
  if (fonts.length < 2 || fonts.at(-1) !== previous || prefix.some((part) => part.hasEOL))
    return false
  const size = Math.max(...fonts.map((part) => part.height!)),
    first = fonts[0],
    frame = nativeRunBox(first)
  if (!frame || !Number.isFinite(size) || first.transform![1] !== 0 || first.transform![2] !== 0)
    return false
  const baseline = first.transform![5],
    seen = new Set<PdfTextItem>()
  let right = frame[0],
    letters = 0
  for (const part of prefix) {
    if (!part.str || /^ *$/u.test(part.str)) continue
    const box = nativeRunBox(part)
    if (
      !box ||
      seen.has(part) ||
      part.transform![1] !== 0 ||
      part.transform![2] !== 0 ||
      Math.abs(part.transform![5] - baseline) > size * 0.05 ||
      part.height! < size * 0.65 ||
      part.height! > size ||
      box[0] < right - size * 0.05 ||
      box[0] - right > size * 0.7
    )
      return false
    seen.add(part)
    right = box[2]
    letters += part.str.match(/\p{L}/gu)?.length ?? 0
  }
  if (letters < 12 || right - frame[0] < size * 8) return false
  const initialBottom = Math.min(...fonts.map((part) => nativeRunBox(part)![1])),
    globalFonts = new Set(seen)
  let globallySeparated = true,
    laterFonts = 0
  for (let n = index; n < items.length; n++) {
    const part = items[n]
    if (!part.str || /^ *$/u.test(part.str)) continue
    const box = nativeRunBox(part)
    if (!box || globalFonts.has(part) || box[3] >= initialBottom - size * 3) {
      globallySeparated = false
      break
    }
    globalFonts.add(part)
    laterFonts++
  }
  if (globallySeparated && laterFonts > 0) return true
  const current = items[index],
    after = nativeRunBox(current),
    small = current.height!
  if (
    !after ||
    current.transform![1] !== 0 ||
    current.transform![2] !== 0 ||
    small > size * 0.9 ||
    small < size * 0.5 ||
    baseline - after[3] <= size * 3 ||
    after[0] >= frame[0] - size
  )
    return false
  const bandBaseline = current.transform![5]
  let count = 0,
    bandRight = after[0],
    closedAt = -1
  for (let n = index; n < Math.min(items.length, index + 12); n++) {
    const part = items[n]
    if (!part.str || /^ *$/u.test(part.str)) {
      if (part.hasEOL) {
        closedAt = n
        break
      }
      continue
    }
    const box = nativeRunBox(part)
    if (
      !box ||
      seen.has(part) ||
      !/^[A-Za-z]+(?: [A-Za-z]+){0,3}$/u.test(part.str) ||
      part.str.length > 32 ||
      part.transform![1] !== 0 ||
      part.transform![2] !== 0 ||
      Math.abs(part.transform![5] - bandBaseline) > small * 0.05 ||
      Math.abs(part.height! - small) > small * 0.05 ||
      box[0] < 0 ||
      box[2] > right ||
      (count > 0 && box[0] - bandRight <= small * 1.5)
    )
      return false
    seen.add(part)
    count++
    bandRight = box[2]
    if (part.hasEOL) {
      closedAt = n
      break
    }
  }
  if (closedAt < 0 || count < 2 || count > 4) return false
  // Closure must account for later carriers too: no aliases, unknown geometry,
  // or interleaved fonts returning to either of the claimed physical bands.
  for (let n = closedAt + 1; n < items.length; n++) {
    const part = items[n]
    if (!part.str || /^ *$/u.test(part.str)) continue
    const box = nativeRunBox(part)
    if (
      !box ||
      seen.has(part) ||
      (box[1] <= baseline + size * 1.5 && box[3] >= baseline - size * 0.5) ||
      (box[1] <= bandBaseline + small * 1.5 && box[3] >= bandBaseline - small * 0.5)
    )
      return false
  }
  return true
}

// A complete formal caption line and a closed smaller label band prove a text
// boundary without assigning figure ownership or changing native item order.
const hasNativeCaptionTailBandGap = (
  items: readonly PdfTextItem[],
  index: number,
  previous: PdfTextItem
): boolean => {
  if (previous.hasEOL) return false
  let start = index - 1,
    bounded = start === 0
  for (let n = index - 2; n >= Math.max(0, index - 20); n--) {
    if (items[n].hasEOL) {
      start = n + 1
      bounded = true
      break
    }
    start = n
    if (n === 0) bounded = true
  }
  if (!bounded) return false
  const captionParts = items.slice(start, index),
    first = captionParts.find((part) => part.str && !/^ *$/u.test(part.str))
  if (!first || !/^(?:Figure\s+[A-Z]?\d+\s*:|Fig\.\s+[A-Z]?\d+[.:])(?:\s|$)/u.test(first.str!))
    return false
  const frame = nativeRunBox(first)
  if (!frame || first.transform![1] !== 0 || first.transform![2] !== 0) return false
  const size = first.height!,
    baseline = first.transform![5],
    seen = new Set<PdfTextItem>()
  let right = frame[0],
    line = ''
  for (const part of captionParts) {
    if (part.hasEOL) return false
    if (!part.str || /^ *$/u.test(part.str)) {
      line += part.str ?? ''
      continue
    }
    const box = nativeRunBox(part)
    if (
      !box ||
      seen.has(part) ||
      part.transform![1] !== 0 ||
      part.transform![2] !== 0 ||
      Math.abs(part.transform![5] - baseline) > size * 0.05 ||
      part.height! < size * 0.8 ||
      part.height! > size * 1.25 ||
      box[0] < right - size * 0.05 ||
      box[0] - right > size * 0.7
    )
      return false
    seen.add(part)
    line += part.str
    right = box[2]
  }
  const prefix = /^(?:Figure\s+[A-Z]?\d+\s*:|Fig\.\s+[A-Z]?\d+[.:])\s*/u.exec(line)
  if (!prefix || (line.slice(prefix[0].length).match(/\p{L}/gu)?.length ?? 0) < 12) return false
  const current = items[index],
    after = nativeRunBox(current)
  if (!after || current.transform![1] !== 0 || current.transform![2] !== 0) return false
  const small = current.height!
  if (
    small > size * 0.9 ||
    small < size * 0.5 ||
    frame[1] - after[3] <= size * 3 ||
    after[0] < frame[0] ||
    after[2] > right
  )
    return false
  let count = 0,
    bandRight = after[0],
    closed = false
  for (let n = index; n < Math.min(items.length, index + 12); n++) {
    const part = items[n]
    if (!part.str || /^ *$/u.test(part.str)) {
      if (part.hasEOL) {
        closed = true
        break
      }
      continue
    }
    const box = nativeRunBox(part)
    if (
      !box ||
      seen.has(part) ||
      !/^[A-Za-z]+(?: [A-Za-z]+){0,3}$/u.test(part.str) ||
      part.str.length > 32 ||
      part.transform![1] !== 0 ||
      part.transform![2] !== 0 ||
      Math.abs(part.transform![5] - current.transform![5]) > small * 0.05 ||
      Math.abs(part.height! - small) > small * 0.05 ||
      box[0] < frame[0] ||
      box[2] > right ||
      (count > 0 && box[0] - bandRight <= small * 1.5)
    )
      return false
    seen.add(part)
    count++
    bandRight = box[2]
    if (part.hasEOL) {
      closed = true
      break
    }
  }
  return closed && count >= 2 && count <= 4
}

// A solitary initial integer and a closed, complete row of smaller independent
// whole numeric carriers establish separate blocks even when their first carriers
// are nearby horizontally. Never join decimal fragments or scientific runs here.
const hasInitialIntegerLineGap = (
  items: readonly PdfTextItem[],
  index: number,
  previous: PdfTextItem
): boolean => {
  const current = items[index]
  if (
    previous.hasEOL ||
    !/^\d+$/u.test(previous.str ?? '') ||
    !/^[+−-]?\d+(?:\.\d+)?$/u.test(current.str ?? '')
  )
    return false
  let solitary = false
  for (let n = 0; n < index; n++) {
    const part = items[n]
    if (part.hasEOL) return false
    if (part.str && !/^ *$/u.test(part.str)) {
      if (part !== previous || solitary) return false
      solitary = true
    }
  }
  if (!solitary) return false
  const before = nativeRunBox(previous),
    first = nativeRunBox(current)
  const upright = (part: PdfTextItem): boolean =>
    part.transform?.[1] === 0 && part.transform?.[2] === 0
  if (!before || !first || !upright(previous) || !upright(current)) return false
  const height = previous.height!,
    size = current.height!,
    baseline = current.transform![5]
  if (
    height < size * 1.5 ||
    before[1] - first[3] <= height * 3 ||
    before[2] > first[0] ||
    previous.width! > height * 4
  )
    return false
  let right = first[0],
    groups = 0,
    closed = false
  for (const part of items.slice(index, index + 32)) {
    if (!part.str || /^ *$/u.test(part.str)) {
      if (part.hasEOL) {
        closed = true
        break
      }
      continue
    }
    const box = nativeRunBox(part)
    if (
      !box ||
      !upright(part) ||
      !/^[+−-]?\d+(?:\.\d+)?$/u.test(part.str) ||
      Math.abs(part.transform![5] - baseline) > size * 0.05 ||
      Math.abs(part.height! - size) > size * 0.05 ||
      (groups > 0 && box[0] - right <= size * 1.5)
    )
      return false
    groups++
    right = box[2]
    if (part.hasEOL) {
      closed = true
      break
    }
  }
  return closed && groups >= 3 && right - first[0] > height * 4
}

// Two independently spaced numeric runs establish a printed numeric band.
// Separate its distant larger carrier without interpreting decimal or exponent
// fragments, or using this geometry as evidence for figure/table ownership.
const hasIndependentNumericBandGap = (
  items: readonly PdfTextItem[],
  index: number,
  previous: PdfTextItem
): boolean => {
  const current = items[index]
  if (
    previous.hasEOL ||
    !Number.isFinite(previous.height) ||
    !Number.isFinite(current.height) ||
    previous.height! < current.height! * 1.15 ||
    !/^\d+$/u.test(current.str ?? '')
  )
    return false
  const before = nativeRunBox(previous),
    after = nativeRunBox(current)
  const upright = (item: PdfTextItem): boolean =>
    item.transform?.[1] === 0 && item.transform?.[2] === 0
  if (!before || !after || !upright(previous) || !upright(current)) return false
  const height = previous.height!
  if (
    before[1] - after[3] <= height * 3 ||
    Math.max(before[0] - after[2], after[0] - before[2]) <= height * 3
  )
    return false
  if (!/^[+−-]?\d+(?:\.\d+)?$/u.test(previous.str ?? '')) {
    if (index > 8 || !/\p{L}{3}/u.test(previous.str ?? '') || !/[.!?]$/u.test(previous.str ?? ''))
      return false
    // A running header must be the complete initial physical line. A later
    // sentence or an unsupported earlier carrier cannot lend it this proof.
    if (
      items
        .slice(0, index)
        .some(
          (part) =>
            part.hasEOL ||
            (part.str?.trim() &&
              (!nativeRunBox(part) ||
                !upright(part) ||
                Math.abs(part.transform![5] - previous.transform![5]) > height * 0.05))
        )
    )
      return false
  }
  const baseline = current.transform![5],
    size = current.height!
  let value = '',
    right = after[0],
    groups = 0,
    separated = false
  for (const part of items.slice(index, index + 24)) {
    if (!part.str?.trim()) {
      if (part.hasEOL) break
      if (part.str) separated = true
      continue
    }
    const box = nativeRunBox(part)
    if (!box || !upright(part) || !/^[+−-]?\d*(?:\.\d*)?$/u.test(part.str)) return false
    const offset = part.transform![5] - baseline
    const base = Math.abs(offset) <= size * 0.05 && Math.abs(part.height! - size) <= size * 0.05
    const exponent =
      part.height! <= size * 0.8 && part.height! >= size * 0.5 && offset > 0 && offset < size
    if (!base && !exponent) break
    if (box[0] < right - size * 0.05) return false
    if (value && (separated || box[0] - right > size * 1.5)) {
      if (!base || box[0] - right <= size * 1.5 || !/^[+−-]?\d+(?:\.\d+)?$/u.test(value))
        return false
      groups++
      value = ''
    } else if (value && box[0] - right > size * 0.5) return false
    value += part.str
    right = box[2]
    separated = false
    if (part.hasEOL) break
  }
  return groups >= 1 && /^[+−-]?\d+(?:\.\d+)?$/u.test(value)
}

export const joinPdfTextItems = (items: readonly PdfTextItem[]): string => {
  let text = ''
  let previousItem: PdfTextItem | undefined
  for (const [index, item] of items.entries()) {
    const value = item.str ?? ''
    if (!value) {
      // PDF.js can end a physical line with a separate empty item. It carries
      // no glyph geometry, but its explicit line-end flag still owns whitespace.
      if (item.hasEOL) text += '\n'
      continue
    }
    const previous = text.at(-1)
    if (previous && !/\s/u.test(previous) && !/^\s/u.test(value) && previousItem) {
      if (
        hasInitialLineClosedLabelGap(items, index, previousItem) ||
        hasCaptionBlockGap(previousItem, item) ||
        hasNativeCaptionLineGap(items, index, previousItem) ||
        hasNativeCaptionTailBandGap(items, index, previousItem) ||
        hasInitialIntegerLineGap(items, index, previousItem) ||
        hasIndependentNumericBandGap(items, index, previousItem)
      )
        text += '\n'
      else if (hasWordGap(previousItem, item)) text += ' '
    }
    text += value
    if (item.hasEOL) text += '\n'
    previousItem = item
  }
  return text.trim()
}
