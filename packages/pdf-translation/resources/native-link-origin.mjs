/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker. */

const certificates = new WeakMap()
const compact = (value) => value.replace(/\s/gu, '')
const contains = (a, b) =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height
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
      const text = String.fromCodePoint(code)
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
          unit.fragments.some((f) => f.pageNumber === link.pageNumber && contains(rect, f.rect))
            ? [{ unit, unitIndex }]
            : []
        )
        if (owners.length !== 1) continue
        const { unit, unitIndex } = owners[0],
          text = compact(unit.source),
          first = text.indexOf(needle)
        if (
          unit.kind !== 'text' ||
          unit.source !== unit.translation ||
          first < 0 ||
          text.indexOf(needle, first + 1) < 0
        )
          continue
        if (!pages.has(link.pageNumber))
          pages.set(
            link.pageNumber,
            readCharacters(native, source, link.pageNumber, geometry[link.pageNumber - 1], at)
          )
        const result = prove(unit, link.pageNumber, rect, label, pages.get(link.pageNumber))
        if (result) {
          const entries = certificates.get(link) ?? []
          entries.push({
            unit,
            unitIndex,
            regionIndex,
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
  const entry = certificates
    .get(link)
    ?.find(
      (e) =>
        e.unit === unit &&
        e.unitIndex === unitIndex &&
        e.regionIndex === regionIndex &&
        unit.kind === 'text' &&
        e.source === unit.source &&
        unit.source === unit.translation &&
        e.fragment === JSON.stringify(unit.fragments) &&
        e.region === JSON.stringify(link.regions[regionIndex]) &&
        e.label === link.labels[regionIndex]
    )
  return entry && { ...entry.result }
}
