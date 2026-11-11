/* eslint-disable @typescript-eslint/explicit-function-return-type -- Unbundled Node worker. */
import { nativeMathAlphabet, nativeMathSymbolText } from './math-symbols.mjs'

const compact = (text) => text.normalize('NFKC').replace(/\s/gu, '')
const valid = (r) =>
  r &&
  [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
  r.x >= 0 &&
  r.y >= 0 &&
  r.width > 0 &&
  r.height > 0 &&
  r.x + r.width <= 1 &&
  r.y + r.height <= 1
const intersects = (a, b, pad = 0) =>
  a.x < b.x + b.width + pad &&
  a.x + a.width + pad > b.x &&
  a.y < b.y + b.height + pad &&
  a.y + a.height + pad > b.y
const contains = (a, b) =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height
const mathematicalFont = (o) =>
  nativeMathAlphabet(o, o.fontName ?? '') ||
  nativeMathSymbolText(o, o.fontName ?? '') !== o.text ||
  (/^(?:[A-Z]{6}\+)?(?:CMMIB|MSBM)(?:5|6|7|8|9|10|12)$/u.test(o.fontName ?? '') &&
    /^[A-Za-z]+$/u.test(o.text.trim()))

// This only selects existing source-crop/page fallback. It never authorizes
// changing native atoms or inventing typography from flattened source text.
export function readNativeReflowRetention(native, source, input, geometry) {
  const units = new Set(),
    pages = new Set(),
    inventory = new Map(),
    { p, m } = native,
    at = native.alloc(24)
  const fragmentsByPage = new Map(),
    itemOwners = new Map()
  input.units.forEach((unit, unitIndex) =>
    unit.fragments.forEach((fragment, fragmentIndex) => {
      const rows = fragmentsByPage.get(fragment.pageNumber) ?? []
      rows.push({ fragment, unitIndex, fragmentIndex })
      fragmentsByPage.set(fragment.pageNumber, rows)
      for (const item of fragment.items ?? []) {
        const key = `${fragment.pageNumber}:${item.index}`
        itemOwners.set(key, (itemOwners.get(key) ?? 0) + 1)
      }
    })
  )
  const read = (number) => {
    if (inventory.has(number)) return inventory.get(number)
    const g = geometry[number - 1],
      page = p.FPDF_LoadPage(source.doc, number - 1)
    let result
    try {
      if (
        !page ||
        !g ||
        ![g.left, g.top, g.width, g.height].every(Number.isFinite) ||
        g.width <= 0 ||
        g.height <= 0 ||
        p.FPDFPage_GetRotation(page)
      )
        return
      const objects = native.objects(page).map((o) => {
        const [left, bottom, right, top] = o.bounds,
          rect = {
            x: (left - g.left) / g.width,
            y: (g.top - top) / g.height,
            width: (right - left) / g.width,
            height: (top - bottom) / g.height
          }
        if (o.type !== 1) return { ...o, rect }
        if (!p.FPDFTextObj_GetFontSize(o.obj, at)) return { ...o, rect }
        const size = m.HEAPF32[at / 4]
        if (!p.FPDFPageObj_GetMatrix(o.obj, at)) return { ...o, rect }
        const matrix = [...m.HEAPF32.slice(at / 4, at / 4 + 6)],
          horizontal =
            matrix.every(Number.isFinite) &&
            matrix[0] > 0 &&
            matrix[3] > 0 &&
            Math.abs(matrix[1]) < 0.0001 &&
            Math.abs(matrix[2]) < 0.0001,
          font = p.FPDFTextObj_GetFont(o.obj),
          length = p.FPDFFont_GetBaseFontName(font, 0, 0)
        let fontName = ''
        if (length > 1 && length <= 256) {
          const buffer = native.alloc(length)
          try {
            p.FPDFFont_GetBaseFontName(font, buffer, length)
            fontName = Buffer.from(m.HEAPU8.slice(buffer, buffer + length - 1)).toString()
          } finally {
            native.free(buffer)
          }
        }
        const unclipped = p.FPDFClipPath_CountPaths(p.FPDFPageObj_GetClipPath(o.obj)) === -1
        return {
          ...o,
          rect,
          size: size * matrix[3],
          baseline: matrix[5],
          horizontal,
          fontName,
          unclipped
        }
      })
      result = { objects, g }
    } catch {
      result = undefined
    } finally {
      if (page) p.FPDF_ClosePage(page)
      inventory.set(number, result)
    }
    return result
  }
  try {
    for (const [unitIndex, unit] of input.units.entries()) {
      if (unit.kind && unit.kind !== 'text' && unit.kind !== 'reference') continue
      let unsafe = false,
        closed =
          compact(unit.source) ===
          compact(
            unit.fragments
              .flatMap((f) => f.items ?? [])
              .map((i) => i.text)
              .join('')
          )
      const regions = []
      for (const [fragmentIndex, fragment] of unit.fragments.entries()) {
        const row = read(fragment.pageNumber)
        if (!row || !valid(fragment.rect)) {
          closed = false
          if (
            Number.isSafeInteger(fragment.pageNumber) &&
            fragment.pageNumber > 0 &&
            fragment.pageNumber <= geometry.length
          )
            pages.add(fragment.pageNumber)
          continue
        }
        const owned = row.objects.filter((o) => o.type === 1 && intersects(o.rect, fragment.rect)),
          exact =
            owned.length > 0 &&
            owned.every((o) => valid(o.rect) && contains(o.rect, fragment.rect)) &&
            fragment.items?.length > 0 &&
            fragment.items.every(
              (item, i, all) =>
                Number.isSafeInteger(item.index) &&
                item.index >= 0 &&
                typeof item.text === 'string' &&
                (!i || item.index > all[i - 1].index)
            ) &&
            compact(owned.map((o) => o.text).join('')) ===
              compact(fragment.items.map((i) => i.text).join('')),
          finite = owned.every((o) => o.horizontal && Number.isFinite(o.size) && o.size > 0),
          font = owned.some(mathematicalFont),
          hierarchy = owned.some((base, i) => {
            const small = owned[i + 1]
            if (
              !small ||
              !base.horizontal ||
              !small.horizontal ||
              !Number.isFinite(base.size) ||
              !Number.isFinite(small.size) ||
              base.size <= 0 ||
              small.i !== base.i + 1 ||
              !/[\p{L}\p{N}∂∇)]\s*$/u.test(base.text) ||
              !/^[\p{L}\p{N}()+−,′\s]{1,16}$/u.test(small.text)
            )
              return false
            const ratio = small.size / base.size,
              rise = small.baseline - base.baseline,
              gap = small.bounds[0] - base.bounds[2]
            return (
              ratio >= 0.5 &&
              ratio < 0.85 &&
              Math.abs(rise) >= base.size * 0.05 &&
              Math.abs(rise) <= base.size * 0.6 &&
              gap >= -base.size * 0.25 &&
              gap <= base.size * 0.5 &&
              small.bounds[3] > base.bounds[1] &&
              small.bounds[1] < base.bounds[3]
            )
          })
        // Opaque Forms alone supply no math evidence. Their paint still prevents
        // a local crop below when independent native hierarchy requires retention.
        unsafe ||=
          font ||
          hierarchy ||
          owned.some((o) => !o.horizontal || !Number.isFinite(o.size) || o.size <= 0)
        const dimensions = input.pages?.[fragment.pageNumber - 1] ?? row.g,
          scale = Math.min(2, 2400 / Math.max(dimensions.width, dimensions.height)),
          pw = Math.ceil(dimensions.width * scale),
          ph = Math.ceil(dimensions.height * scale),
          left = Math.floor(fragment.rect.x * pw),
          top = Math.floor(fragment.rect.y * ph),
          visible = {
            x: left / pw,
            y: top / ph,
            width: (Math.ceil((fragment.rect.x + fragment.rect.width) * pw) - left) / pw,
            height: (Math.ceil((fragment.rect.y + fragment.rect.height) * ph) - top) / ph
          }
        // crop() rounds outward to pixels. Even an adjacent foreign atom outside
        // the declared frame must not be copied a second time in that fringe.
        closed &&=
          row.objects.every(
            (o) =>
              [o.rect.x, o.rect.y, o.rect.width, o.rect.height].every(Number.isFinite) &&
              o.rect.width >= 0 &&
              o.rect.height >= 0
          ) &&
          (fragment.items ?? []).every(
            (i) => itemOwners.get(`${fragment.pageNumber}:${i.index}`) === 1
          ) &&
          !owned.some((o) =>
            (fragmentsByPage.get(fragment.pageNumber) ?? []).some(
              (f) =>
                (f.unitIndex !== unitIndex || f.fragmentIndex !== fragmentIndex) &&
                valid(f.fragment.rect) &&
                intersects(o.rect, f.fragment.rect)
            )
          ) &&
          exact &&
          finite &&
          owned.every((o) => o.unclipped) &&
          valid(visible) &&
          !row.objects.some((o) => !owned.includes(o) && intersects(o.rect, visible))
        const em = Math.max(0, ...owned.map((o) => (Number.isFinite(o.size) ? o.size : 0)))
        regions.push({ fragment, em, g: row.g })
      }
      if (!unsafe) continue
      // A standalone script crop cannot certify neighboring equation atoms or a
      // scaffold's row order. Keep its source page instead of separating tiles.
      const scaffold = regions.some(({ fragment, em, g }) =>
        input.units.some(
          (peer, index) =>
            index !== unitIndex &&
            peer.kind !== 'text' &&
            peer.kind !== 'reference' &&
            peer.fragments.some(
              (f) =>
                f.pageNumber === fragment.pageNumber &&
                valid(f.rect) &&
                intersects(f.rect, fragment.rect, em / Math.min(g.width, g.height))
            )
        )
      )
      if (!closed || scaffold) for (const f of unit.fragments) pages.add(f.pageNumber)
      else units.add(unitIndex)
    }
  } finally {
    native.free(at)
  }
  return { units, pages }
}
