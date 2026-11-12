/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker. */
import { PDFArray, PDFDict, PDFName } from 'pdf-lib'
const blankPageCertificates = new WeakMap()

// A complete native name family establishes page identity without coordinate matching.
function completeNativePageAnchorFamily(entries, count) {
  const anchors = entries.filter((entry) => /^page\./u.test(entry.raw?.decodeText?.() ?? ''))
  if (anchors.length !== count || count < 2) return new Map()
  const result = new Map()
  for (let number = 1; number <= count; number++) {
    const matches = anchors.filter((entry) => entry.raw.decodeText() === `page.${number}`)
    if (matches.length !== 1) return new Map()
    const entry = matches[0],
      dest = entry.destination
    const value = entry.value instanceof PDFDict ? entry.value.lookup(PDFName.of('D')) : entry.value
    if (
      !(value instanceof PDFArray) ||
      dest.pageNumber !== number ||
      dest.mode !== 1 ||
      dest.params.length !== 3 ||
      !dest.params.slice(0, 2).every(Number.isFinite) ||
      dest.params[2] !== null
    )
      return new Map()
    result.set(number, entry)
  }
  return result
}

export function readBlankPageAnchors(native, source, input, entries, geometry, unsafePages) {
  const family = completeNativePageAnchorFamily(entries, input.pages.length),
    result = new Map(),
    privateEntries = new Map(),
    { p, m } = native,
    at = native.alloc(16)
  const changed = new Set(
    input.units
      .filter((u) => u.translation !== u.source)
      .flatMap((u) => u.fragments.map((f) => f.pageNumber))
  )
  try {
    for (const [number, entry] of family) {
      if (!changed.has(number) || unsafePages.has(number)) continue
      const g = geometry[number - 1],
        [x, y] = entry.destination.params,
        dimensions = input.pages[number - 1]
      if (
        !g ||
        ![g.left, g.top, g.width, g.height].every(Number.isFinite) ||
        g.width <= 0 ||
        g.height <= 0 ||
        !(x > g.left && x < g.left + g.width && y < g.top && y > g.top - g.height)
      )
        continue
      // Source positions must independently agree that the complete strip is empty.
      const normalizedBottom = (g.top - y + 1) / g.height
      const rects = input.units
        .flatMap((u) => u.fragments.filter((f) => f.pageNumber === number).map((f) => f.rect))
        .concat(
          (input.originalRegions ?? []).filter((r) => r.pageNumber === number).map((r) => r.rect)
        )
      if (
        !rects.length ||
        rects.some(
          (r) =>
            ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
            r.width < 0 ||
            r.height < 0 ||
            r.y <= normalizedBottom
        )
      )
        continue
      const page = p.FPDF_LoadPage(source.doc, number - 1)
      let bitmap
      try {
        if (p.FPDFPage_GetRotation(page)) continue
        const objects = native.objects(page)
        // Unsupported forms/shadings can paint outside an uncertified nested boundary.
        if (
          !objects.length ||
          objects.some(
            (o) =>
              ![1, 2, 3].includes(o.type) ||
              o.bounds.length !== 4 ||
              !o.bounds.every(Number.isFinite) ||
              o.bounds[0] > o.bounds[2] ||
              o.bounds[1] > o.bounds[3] ||
              o.bounds[3] + 1 >= y
          )
        )
          continue
        const objectRect = (object) => ({
          x: (object.bounds[0] - g.left) / g.width,
          y: (g.top - object.bounds[3]) / g.height,
          width: (object.bounds[2] - object.bounds[0]) / g.width,
          height: (object.bounds[3] - object.bounds[1]) / g.height
        })
        const contains = (a, b) =>
          a.x >= b.x &&
          a.y >= b.y &&
          a.x + a.width <= b.x + b.width &&
          a.y + a.height <= b.y + b.height
        const firstObject = objects.reduce((a, b) => (a.bounds[3] >= b.bounds[3] ? a : b)),
          band = objects.filter((o) => o.bounds[3] >= firstObject.bounds[1])
        const firstOwners = band.map((o) =>
          input.units.flatMap((unit, index) =>
            unit.fragments.some((f) => f.pageNumber === number && contains(objectRect(o), f.rect))
              ? [index]
              : []
          )
        )
        if (
          band.some((o) => o.type !== 1 || !o.text?.trim()) ||
          firstOwners.some((owners) => owners.length !== 1)
        )
          continue
        const ownerIndices = [...new Set(firstOwners.flat())],
          ownerRects = [],
          ownerSnapshots = []
        let completeOwners = true
        for (const ownerIndex of ownerIndices) {
          const unit = input.units[ownerIndex]
          if (unit.fragments.length !== 1 || unit.fragments[0].pageNumber !== number) {
            completeOwners = false
            break
          }
          const ownerRect = unit.fragments[0].rect,
            ownerObjects = objects.filter((o) => {
              const a = objectRect(o)
              return (
                a.x < ownerRect.x + ownerRect.width &&
                a.x + a.width > ownerRect.x &&
                a.y < ownerRect.y + ownerRect.height &&
                a.y + a.height > ownerRect.y
              )
            }),
            items = unit.fragments[0].items
          if (
            ownerObjects.some((o) => o.type !== 1 || !contains(objectRect(o), ownerRect)) ||
            ownerObjects
              .map((o) => o.text)
              .join('')
              .replace(/\s/gu, '') !== unit.source.replace(/\s/gu, '') ||
            (ownerIndices.length > 1 &&
              (!items?.length ||
                items.some(
                  (item, i) =>
                    !Number.isSafeInteger(item.index) ||
                    item.index < 0 ||
                    typeof item.text !== 'string' ||
                    (i && item.index <= items[i - 1].index)
                ) ||
                items
                  .map((i) => i.text)
                  .join('')
                  .replace(/\s/gu, '') !== unit.source.replace(/\s/gu, '') ||
                items.some(
                  (item) =>
                    input.units.flatMap((u) =>
                      u.fragments.flatMap((f) =>
                        f.pageNumber === number
                          ? (f.items ?? []).filter((peer) => peer.index === item.index)
                          : []
                      )
                    ).length !== 1
                ) ||
                ownerObjects.some((o) =>
                  input.units
                    .flatMap((u, i) =>
                      u.fragments.flatMap((f, j) =>
                        f.pageNumber === number && anchorIntersects(objectRect(o), f.rect)
                          ? [{ i, j }]
                          : []
                      )
                    )
                    .some(
                      ({ i, j }, k, owners) => owners.length !== 1 || i !== ownerIndex || j !== 0
                    )
                ) ||
                ownerObjects.some(
                  (o) =>
                    p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(o.obj)) !== -1 ||
                    p.FPDFTextObj_GetTextRenderMode(o.obj) !== 0
                )))
          ) {
            completeOwners = false
            break
          }
          ownerRects.push(ownerRect)
          ownerSnapshots.push({ index: ownerIndex, unit, key: anchorUnitKey(unit) })
        }
        if (!completeOwners || !ownerRects.length) continue
        const ownerRect = {
          x: Math.min(...ownerRects.map((r) => r.x)),
          y: Math.min(...ownerRects.map((r) => r.y)),
          width:
            Math.max(...ownerRects.map((r) => r.x + r.width)) -
            Math.min(...ownerRects.map((r) => r.x)),
          height:
            Math.max(...ownerRects.map((r) => r.y + r.height)) -
            Math.min(...ownerRects.map((r) => r.y))
        }
        if (
          input.units.some(
            (other, index) =>
              !ownerIndices.includes(index) &&
              other.fragments.some((f) => f.pageNumber === number && f.rect.y < ownerRect.y)
          )
        )
          continue
        let safe = true
        for (let index = 0; index < p.FPDFPage_GetAnnotCount(page); index++) {
          const annotation = p.FPDFPage_GetAnnot(page, index)
          try {
            if (
              p.FPDFAnnot_GetSubtype(annotation) !== 2 ||
              p.FPDFAnnot_HasKey(annotation, 'AP') ||
              !p.FPDFAnnot_GetRect(annotation, at)
            ) {
              safe = false
              break
            }
            const rect = [...m.HEAPF32.slice(at / 4, at / 4 + 4)]
            if (
              !rect.every(Number.isFinite) ||
              Math.max(rect[1], rect[3]) + 1 >= y ||
              Math.max(rect[1], rect[3]) > g.top - ownerRect.y * g.height
            ) {
              safe = false
              break
            }
          } finally {
            p.FPDFPage_CloseAnnot(annotation)
          }
        }
        if (!safe) continue
        // Same native renderer/profile as this reflow's actual crop bitmap. This is
        // a blank-strip check, never a claim about cross-engine crop AA equivalence.
        const scale = Math.min(2, 2400 / Math.max(dimensions.width, dimensions.height)),
          pw = Math.ceil(dimensions.width * scale),
          ph = Math.ceil(dimensions.height * scale),
          rows = Math.ceil(normalizedBottom * ph)
        if (rows <= 0 || rows >= ph) continue
        bitmap = p.FPDFBitmap_Create(pw, ph, 1)
        if (!bitmap) continue
        p.FPDFBitmap_FillRect(bitmap, 0, 0, pw, ph, 0xffffffff)
        p.FPDF_RenderPageBitmap(bitmap, page, 0, 0, pw, ph, 0, 1)
        const stride = p.FPDFBitmap_GetStride(bitmap),
          pointer = p.FPDFBitmap_GetBuffer(bitmap)
        if (stride < pw * 4 || !pointer) continue
        outer: for (let row = 0; row < rows; row++)
          for (let column = 0; column < pw * 4; column++)
            if (m.HEAPU8[pointer + row * stride + column] !== 255) {
              safe = false
              break outer
            }
        if (!safe) continue
        let firstInk = false
        ink: for (let row = rows; row < ph; row++) {
          for (let column = 0; column < pw; column++) {
            const offset = pointer + row * stride + column * 4
            if (
              m.HEAPU8[offset] === 255 &&
              m.HEAPU8[offset + 1] === 255 &&
              m.HEAPU8[offset + 2] === 255
            )
              continue
            firstInk = true
            if (
              !ownerRects.some(
                (r) =>
                  row / ph >= r.y &&
                  (row + 1) / ph <= r.y + r.height &&
                  column / pw >= r.x &&
                  (column + 1) / pw <= r.x + r.width
              )
            )
              safe = false
          }
          if (firstInk) break ink
        }
        if (safe && firstInk) {
          const value =
            ownerIndices.length === 1 ? ownerIndices[0] : Object.freeze([...ownerIndices])
          result.set(entry, value)
          privateEntries.set(entry, {
            value,
            entryKey: anchorEntryKey(entry),
            units: input.units,
            unitsLength: input.units.length,
            ownerSnapshots
          })
        }
      } catch {
        // Missing native evidence retains the existing annotation fallback.
        continue
      } finally {
        if (bitmap) p.FPDFBitmap_Destroy(bitmap)
        p.FPDF_ClosePage(page)
      }
    }
  } finally {
    native.free(at)
  }
  blankPageCertificates.set(result, privateEntries)
  return result
}

export function mapBlankPageAnchor(
  entry,
  certificates,
  firstContent,
  sourcePages,
  placements,
  lines,
  units
) {
  const certificate = blankPageCertificates.get(certificates)?.get(entry)
  if (
    !certificate ||
    certificate.units !== units ||
    certificate.unitsLength !== units.length ||
    certificate.value !== certificates.get(entry) ||
    certificate.entryKey !== anchorEntryKey(entry) ||
    certificate.ownerSnapshots.some(
      (s) => units[s.index] !== s.unit || anchorUnitKey(s.unit) !== s.key
    )
  )
    return undefined
  const first = firstContent?.get(entry.destination.pageNumber),
    owners = Array.isArray(certificate.value) ? certificate.value : [certificate.value],
    owner = first?.unitIndex,
    r = first?.rect,
    output = placements.get(owner),
    unit = units[owner]
  if (
    !first ||
    !owners.includes(owner) ||
    !Number.isSafeInteger(first.pageNumber) ||
    !sourcePages[first.pageNumber - 1]?.includes(entry.destination.pageNumber) ||
    !r ||
    ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
    r.x < 0 ||
    r.y < 0 ||
    r.width <= 0 ||
    r.height <= 0 ||
    r.x + r.width > 1 ||
    r.y + r.height > 1
  )
    return undefined
  if (
    first.kind !== 'line' ||
    first.unitIndex !== owner ||
    first.covered ||
    !unit ||
    output?.length !== 1 ||
    output[0].pageNumber !== first.pageNumber ||
    output[0].rect.x !== r.x ||
    output[0].rect.y !== r.y ||
    (lines.get(owner) ?? [])
      .map((l) => l.text)
      .join('')
      .replace(/\s/gu, '') !== unit.translation.replace(/\s/gu, '')
  )
    return undefined
  return { pageNumber: first.pageNumber, mode: 1, params: [r.x * 595.28, (1 - r.y) * 841.89, null] }
}

const anchorIntersects = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
const anchorEntryKey = (entry) =>
  JSON.stringify({
    name: entry.raw?.decodeText?.(),
    value: entry.value?.toString?.(),
    destination: entry.destination
  })
const anchorUnitKey = (unit) =>
  JSON.stringify({
    source: unit.source,
    translation: unit.translation,
    kind: unit.kind,
    fragments: unit.fragments
  })
