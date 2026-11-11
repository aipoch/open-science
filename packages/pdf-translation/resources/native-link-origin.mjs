/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker. */

const certificates = new WeakMap()
const compact = (value) => value.replace(/\s/gu, '')
const contains = (a, b) =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height
// Match the mapper's annotation hit-area collar, never a native glyph's ownership.
const containsHitArea = (a, b) =>
  a.x >= b.x - 0.002 &&
  a.y >= b.y - 0.002 &&
  a.x + a.width <= b.x + b.width + 0.002 &&
  a.y + a.height <= b.y + b.height + 0.002
const intersects = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const valid = (r) =>
  r &&
  [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
  r.x >= 0 &&
  r.y >= 0 &&
  r.width > 0 &&
  r.height > 0 &&
  r.x + r.width <= 1 &&
  r.y + r.height <= 1

const numericHit = /^[[［]?\d{1,4}(?:[,，\]］])?$/u
const closedNumbers = /\[\d{1,4}(?:[,，]\d{1,4}){0,63}\]|［\d{1,4}(?:[,，]\d{1,4}){0,63}］/gu

// A complete native list supplies stronger context than a repeated digit. Keep
// a literal neighboring witness too: unrelated prose must not manufacture an
// occurrence merely by repeating the same list in a different source owner.
function closedNativeBlockSpan(unit, owned, first, end, label) {
  if (!numericHit.test(compact(label))) return
  const text = owned.map((c) => c.text).join(''),
    selectedStart = owned
      .slice(0, first)
      .map((c) => c.text)
      .join('').length,
    selectedEnd = owned
      .slice(0, end)
      .map((c) => c.text)
      .join('').length,
    nativeBlocks = [...text.matchAll(closedNumbers)],
    block = nativeBlocks.find(
      (b) => b.index <= selectedStart && b.index + b[0].length >= selectedEnd
    )
  if (!block || nativeBlocks.filter((b) => b[0] === block[0]).length !== 1) return
  const source = compact(unit.source),
    matches = [...source.matchAll(closedNumbers)].filter((b) => b[0] === block[0])
  if (matches.length !== 1) return
  const target = matches[0],
    before = Math.min(8, block.index),
    after = Math.min(8, text.length - block.index - block[0].length),
    witnesses = [
      before === 8 && [block.index - before, block.index + block[0].length],
      after === 8 && [block.index, block.index + block[0].length + after]
    ].filter(Boolean)
  if (
    !witnesses.some(([left, right]) => {
      const at = target.index + left - block.index
      return at >= 0 && source.slice(at, at + right - left) === text.slice(left, right)
    })
  )
    return
  const offsets = []
  for (let n = 0; n < unit.source.length; n++) if (!/\s/u.test(unit.source[n])) offsets.push(n)
  const start = target.index + selectedStart - block.index,
    finish = target.index + selectedEnd - block.index,
    from = offsets[start],
    result = unit.source.slice(from, offsets[finish - 1] + 1)
  return compact(result) === compact(label) ? { start: from, text: result } : undefined
}

// Whole native paragraph identity supplies an occurrence offset, not a semantic
// interpretation of a repeated number. Only unchanged ordinary text is eligible.
function prove(unit, pageNumber, rect, label, characters) {
  if (
    unit.kind !== 'text' ||
    unit.translation !== unit.source ||
    unit.source.length > 32768 ||
    unit.fragments.length !== 1
  )
    return undefined
  const fragment = unit.fragments[0],
    owner = fragment.rect
  if (
    fragment.pageNumber !== pageNumber ||
    !valid(owner) ||
    !valid(rect) ||
    !contains(rect, owner) ||
    !fragment.items?.length ||
    fragment.items.some(
      (item, index, items) =>
        !Number.isSafeInteger(item.index) ||
        item.index < 0 ||
        (index > 0 && item.index <= items[index - 1].index) ||
        typeof item.text !== 'string'
    ) ||
    compact(fragment.items.map((item) => item.text).join('')) !== compact(unit.source)
  )
    return undefined
  const owned = characters.filter((c) => intersects(c.rect, owner))
  if (
    !owned.length ||
    owned.some((c) => !contains(c.rect, owner) || !c.horizontal || !valid(c.rect))
  )
    return undefined
  const sourceCharacters = []
  for (let at = 0; at < unit.source.length;) {
    const text = String.fromCodePoint(unit.source.codePointAt(at))
    if (text.trim()) sourceCharacters.push({ text, at })
    at += text.length
  }
  if (
    owned.length !== sourceCharacters.length ||
    owned.some((c, index) => c.text !== sourceCharacters[index].text)
  )
    return undefined
  const selected = characters.filter((c) => intersects(c.rect, rect)),
    offsets = selected.map((c) => owned.indexOf(c))
  if (
    !offsets.length ||
    offsets.some((at, index) => at < 0 || (index > 0 && at !== offsets[index - 1] + 1)) ||
    selected.map((c) => c.text).join('') !== compact(label)
  )
    return undefined
  const start = sourceCharacters[offsets[0]].at,
    last = sourceCharacters[offsets.at(-1)],
    text = unit.source.slice(start, last.at + last.text.length)
  return compact(text) === compact(label) ? { start, text } : undefined
}

// A complete native line can identify one source occurrence inside a translated
// paragraph. This supplies a source offset only; target semantics stay separate.
function proveSourceFragment(unit, pageNumber, rect, label, characters) {
  const fragments = unit.fragments.filter(
    (f) => f.pageNumber === pageNumber && containsHitArea(rect, f.rect)
  )
  if (fragments.length !== 1 || !valid(rect) || unit.source.length > 32768) return
  const fragment = fragments[0]
  if (
    !valid(fragment.rect) ||
    !fragment.items?.length ||
    fragment.items.some(
      (item, n, items) =>
        !Number.isSafeInteger(item.index) ||
        item.index < 0 ||
        typeof item.text !== 'string' ||
        (n > 0 && item.index <= items[n - 1].index)
    )
  )
    return
  const owned = characters.filter((c) => intersects(c.rect, fragment.rect))
  if (
    !owned.length ||
    owned.some((c) => !contains(c.rect, fragment.rect) || !c.horizontal || !valid(c.rect)) ||
    owned.map((c) => c.text).join('') !== compact(fragment.items.map((i) => i.text).join(''))
  )
    return
  const selected = characters.filter((c) => intersects(c.rect, rect)),
    indices = selected.map((c) => owned.indexOf(c)),
    needle = compact(label)
  if (
    !indices.length ||
    indices.some((n, i) => n < 0 || (i > 0 && n !== indices[i - 1] + 1)) ||
    selected.map((c) => c.text).join('') !== needle
  )
    return
  const first = indices[0],
    end = indices.at(-1) + 1,
    contexts = [
      [0, owned.length],
      [0, end],
      [first, owned.length]
    ],
    offsets = []
  const closed = closedNativeBlockSpan(unit, owned, first, end, label)
  if (closed) return closed
  for (let n = 0; n < unit.source.length; n++) if (!/\s/u.test(unit.source[n])) offsets.push(n)
  const haystack = compact(unit.source)
  for (const [left, right] of contexts) {
    const context = owned
      .slice(left, right)
      .map((c) => c.text)
      .join('')
    if (context.length < needle.length + 8) continue
    const at = haystack.indexOf(context)
    if (at < 0 || haystack.indexOf(context, at + 1) >= 0) continue
    const start =
        at +
        owned
          .slice(left, first)
          .map((c) => c.text)
          .join('').length,
      from = offsets[start],
      last = offsets[start + needle.length - 1]
    const text = unit.source.slice(from, last + 1)
    if (compact(text) === needle) return { start: from, text }
  }
}

function readCharacters(native, source, number, geometry, at) {
  const { p, m } = native,
    page = p.FPDF_LoadPage(source.doc, number - 1)
  let textPage
  try {
    if (!page || p.FPDFPage_GetRotation(page)) return []
    textPage = p.FPDFText_LoadPage(page)
    const count = p.FPDFText_CountChars(textPage),
      chars = []
    if (count < 1 || count > 250000) return []
    for (let index = 0; index < count; index++) {
      const code = p.FPDFText_GetUnicode(textPage, index)
      if (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return []
      // PDFium replaces a printed line-end hyphen with this certified marker.
      const text =
        code === 2 && p.FPDFText_IsHyphen?.(textPage, index) === 1
          ? '-'
          : String.fromCodePoint(code)
      if (!text.trim()) continue
      if (!p.FPDFText_GetCharBox(textPage, index, at, at + 8, at + 16, at + 24)) return []
      const [left, right, bottom, top] = m.HEAPF64.slice(at / 8, at / 8 + 4),
        angle = p.FPDFText_GetCharAngle(textPage, index),
        rect = {
          x: (left - geometry.left) / geometry.width,
          y: (geometry.top - top) / geometry.height,
          width: (right - left) / geometry.width,
          height: (top - bottom) / geometry.height
        }
      if (!valid(rect)) return []
      chars.push({
        text,
        horizontal:
          Number.isFinite(angle) &&
          Math.abs(Math.sin(angle)) <= 0.0001 &&
          Math.cos(angle) >= 0.9999,
        rect
      })
    }
    return chars
  } catch {
    return []
  } finally {
    if (textPage) p.FPDFText_ClosePage(textPage)
    if (page) p.FPDF_ClosePage(page)
  }
}

export function captureNativeLinkOrigins(native, source, input, links, geometry) {
  const pages = new Map(),
    at = native.alloc(32)
  try {
    for (const link of links) {
      certificates.delete(link)
      if (link.unsupported) continue
      for (const [regionIndex, rect] of link.regions.entries()) {
        const label = link.labels[regionIndex],
          needle = compact(label)
        if (!needle || !valid(rect)) continue
        const owners = input.units.flatMap((unit, unitIndex) =>
          unit.fragments.some(
            (f) => f.pageNumber === link.pageNumber && containsHitArea(rect, f.rect)
          )
            ? [{ unit, unitIndex }]
            : []
        )
        if (owners.length !== 1) continue
        const { unit, unitIndex } = owners[0],
          text = compact(unit.source),
          first = text.indexOf(needle)
        if (
          unit.kind !== 'text' ||
          first < 0 ||
          (text.indexOf(needle, first + 1) < 0 && !numericHit.test(needle))
        )
          continue
        if (!pages.has(link.pageNumber))
          pages.set(
            link.pageNumber,
            readCharacters(native, source, link.pageNumber, geometry[link.pageNumber - 1], at)
          )
        const result =
          prove(unit, link.pageNumber, rect, label, pages.get(link.pageNumber)) ??
          proveSourceFragment(unit, link.pageNumber, rect, label, pages.get(link.pageNumber))
        if (result) {
          const entries = certificates.get(link) ?? []
          entries.push({
            unit,
            unitIndex,
            regionIndex,
            pageNumber: link.pageNumber,
            annotationIndex: link.index,
            source: unit.source,
            fragment: JSON.stringify(unit.fragments),
            region: JSON.stringify(rect),
            label,
            result
          })
          certificates.set(link, entries)
        }
      }
    }
  } finally {
    native.free(at)
  }
}

export function nativeLinkOriginSpan(link, unit, unitIndex, regionIndex) {
  return unit.source === unit.translation
    ? nativeLinkSourceSpan(link, unit, unitIndex, regionIndex)
    : undefined
}

export function nativeLinkSourceSpan(link, unit, unitIndex, regionIndex) {
  const entry = certificates
    .get(link)
    ?.find(
      (e) =>
        e.unit === unit &&
        e.unitIndex === unitIndex &&
        e.regionIndex === regionIndex &&
        e.pageNumber === link.pageNumber &&
        e.annotationIndex === link.index &&
        unit.kind === 'text' &&
        e.source === unit.source &&
        e.fragment === JSON.stringify(unit.fragments) &&
        e.region === JSON.stringify(link.regions[regionIndex]) &&
        e.label === link.labels[regionIndex]
    )
  return entry && { ...entry.result }
}
