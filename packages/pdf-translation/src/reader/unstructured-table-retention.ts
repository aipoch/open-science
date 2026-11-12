import { parsePdfStructureResult } from '@aipoch/pdf-structure/result'
import { createPdfTranslationSource } from './source.js'
import { carryNativeCaptionEligibility } from './caption-eligibility.js'
import { getPdfTranslationTextContent } from './text-content.js'
import type { applyCachedPdfFigureSources } from './figure-source.js'

type Region = { page: number; x: number; y: number; width: number; height: number }
const overlaps = (a: Region, b: Region): boolean =>
  a.page === b.page &&
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height
const normalize = (s: string): string => s.replace(/\s/gu, '')

// This is negative translation eligibility only. It supplies neither a crop nor
// paint permission: content-first must retain the complete original source page.
export async function retainUnstructuredTablePages(
  args: Parameters<typeof applyCachedPdfFigureSources>[0]
): Promise<{
  extraction: typeof args.extraction
  retainedUnitIds: readonly string[]
  retainedSourcePageNumbers: readonly number[]
}> {
  const { extraction, document, sourceIdentity, signal } = args,
    source = extraction.source,
    identity = { ...sourceIdentity },
    getPage = document.getPage,
    empty = { extraction, retainedUnitIds: [], retainedSourcePageNumbers: [] },
    retained = new Set<string>(),
    pages = new Set<number>(),
    checks: (() => boolean)[] = [],
    snapshot = JSON.stringify(source),
    current = (): boolean =>
      !signal.aborted &&
      source.fingerprint === document.fingerprints[0] &&
      source.pages.length === document.numPages &&
      document.getPage === getPage &&
      JSON.stringify(source) === snapshot &&
      checks.every((check) => check())
  if (!document.getData || !current()) return empty
  const digest = async (): Promise<boolean> => {
    const bytes = await document.getData!()
    if (bytes.length !== identity.sourceSizeBytes) return false
    const hash = await crypto.subtle.digest('SHA-256', bytes.slice().buffer)
    return (
      Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('') ===
      identity.sourceChecksum
    )
  }
  try {
    const candidates: {
      result: ReturnType<typeof parsePdfStructureResult>
      element: ReturnType<typeof parsePdfStructureResult>['elements'][number]
    }[] = []
    const allElements: ReturnType<typeof parsePdfStructureResult>['elements'][number][] = []
    const batches = new Map<string, string>()
    let cacheBytes = 0,
      elementCount = 0
    for (let number = 1; number <= document.numPages; number++) {
      const cached = await args.readCached({ sourceId: args.sourceId, page: number })
      if (!current()) return empty
      if (!cached) continue
      const result = parsePdfStructureResult(cached, { ...cached, ...identity })
      if (result.pageCount !== document.numPages || !result.processedPages.includes(number))
        return empty
      const serialized = JSON.stringify(result),
        prior = batches.get(result.extractionId)
      if (prior !== undefined) {
        if (prior !== serialized) return empty
        continue
      }
      cacheBytes += serialized.length * 2
      elementCount += result.elements.length
      if (cacheBytes > 32 * 1024 ** 2 || elementCount > 512) return empty
      batches.set(result.extractionId, serialized)
      allElements.push(...result.elements)
      for (const element of result.elements)
        if (
          element.kind === 'table' &&
          !element.table &&
          !element.tableParts &&
          !element.nativeBody &&
          !element.sourceItems &&
          element.regions.length === 1 &&
          element.caption?.regions.length === 1 &&
          element.issues.length === 1 &&
          element.issues[0].code === 'no-source-cell-grid'
        )
          candidates.push({ result, element })
    }
    if (!candidates.length || candidates.length > 16 || !(await digest()) || !current())
      return empty
    const owners = new Map<string, (typeof source.units)[number]>()
    for (const unit of source.units)
      for (const fragment of unit.fragments)
        for (const item of fragment.items) {
          const key = fragment.pageNumber + ':' + item.index
          if (owners.has(key)) return empty
          owners.set(key, unit)
        }
    for (const { result, element } of candidates) {
      const region = element.regions[0],
        number = region.page,
        page = await document.getPage(number),
        viewport = page.getViewport({ scale: 1 }),
        expected = source.pages[number - 1],
        content = await getPdfTranslationTextContent(page),
        binding = JSON.stringify([content, viewport]),
        fonts = new Map<number, Region>()
      if (!current()) return empty
      if (
        !expected ||
        viewport.rotation !== 0 ||
        viewport.width !== expected.width ||
        viewport.height !== expected.height ||
        !result.processedPages.includes(number)
      )
        continue
      let valid = true
      for (const [index, item] of content.items.entries()) {
        if (!('str' in item) || !item.str.trim()) continue
        const style = content.styles[item.fontName],
          [a, b, c, d, x, y] = item.transform
        if (
          item.dir !== 'ltr' ||
          style?.vertical !== false ||
          ![a, b, c, d, x, y, item.width, item.height, style?.ascent, style?.descent].every(
            Number.isFinite
          ) ||
          a <= 0 ||
          d <= 0 ||
          b !== 0 ||
          c !== 0 ||
          item.width <= 0 ||
          item.height !== d ||
          style.ascent <= style.descent
        ) {
          valid = false
          break
        }
        const [left, top] = viewport.convertToViewportPoint(x, y + style.ascent * d),
          [right, bottom] = viewport.convertToViewportPoint(x + item.width, y + style.descent * d)
        fonts.set(index, {
          page: number,
          x: left / viewport.width,
          y: top / viewport.height,
          width: (right - left) / viewport.width,
          height: (bottom - top) / viewport.height
        })
      }
      if (!valid) continue
      const selected = new Set(
          [...fonts].filter(([, box]) => overlaps(box, region)).map(([i]) => i)
        ),
        bodyOwners = new Set([...selected].map((i) => owners.get(number + ':' + i)))
      if (selected.size < 9 || bodyOwners.has(undefined)) continue
      // A packed multirow owner is precisely the unsafe prose case. Ordinary
      // individual labels and the adjacent caption keep their existing policy.
      const multirow = [...bodyOwners].some(
        (unit) =>
          unit &&
          new Set(unit.fragments.flatMap((f) => f.items.map((i) => fonts.get(i.index)?.y))).size >=
            2 &&
          unit.fragments.reduce((n, f) => n + f.items.length, 0) >= 6
      )
      const layered = [...bodyOwners].filter((unit) => {
        if (!unit || unit.fragments.length !== 1) return false
        const items = unit.fragments[0].items
        if (items.length < 3 || items.length >= 6) return false
        const raw = items.map((i) => content.items[i.index])
        return (
          raw.every((i) => 'str' in i) &&
          new Set(raw.map((i) => 'str' in i && i.transform[5])).size >= 2 &&
          raw.every(
            (i) =>
              'str' in i &&
              'str' in raw[0] &&
              i.fontName === raw[0].fontName &&
              i.transform.slice(0, 4).every((n, k) => n === raw[0].transform[k])
          )
        )
      })
      if (!multirow && !layered.length) continue
      const selectedBoxes = [...selected].map((i) => fonts.get(i)!),
        left = Math.min(region.x, ...selectedBoxes.map((b) => b.x)),
        top = Math.min(region.y, ...selectedBoxes.map((b) => b.y)),
        right = Math.max(region.x + region.width, ...selectedBoxes.map((b) => b.x + b.width)),
        bottom = Math.max(region.y + region.height, ...selectedBoxes.map((b) => b.y + b.height)),
        body = { page: number, x: left, y: top, width: right - left, height: bottom - top }
      for (const owner of bodyOwners) {
        if (!owner) {
          valid = false
          break
        }
        const literals: string[] = []
        for (const fragment of owner.fragments) {
          if (fragment.pageNumber !== number || fragment.unclippedRect || !fragment.items.length)
            valid = false
          for (const item of fragment.items) {
            const raw = content.items[item.index]
            if (
              !selected.has(item.index) ||
              !raw ||
              !('str' in raw) ||
              raw.str !== item.text ||
              !fonts.has(item.index)
            )
              valid = false
            literals.push(item.text)
          }
        }
        if (normalize(owner.source) !== normalize(literals.join(''))) valid = false
      }
      if (!valid || [...fonts].some(([i, b]) => overlaps(b, body) && !selected.has(i))) continue
      const caption = element.caption!,
        captionRegion = caption.regions[0],
        captionItems = [...fonts].filter(([, box]) => overlaps(box, captionRegion))
      const captionLiteral = captionItems
        .map(([index], position) => {
          const item = content.items[index] as {
              str: string
              width: number
              height: number
              hasEOL: boolean
              transform: number[]
              fontName: string
            },
            next = content.items[captionItems[position + 1]?.[0]] as typeof item | undefined
          // Only a witnessed native line end may join a printed word. The cache
          // must still match the complete resulting caption exactly below.
          const between = content.items.slice(
              index + 1,
              captionItems[position + 1]?.[0] ?? index + 1
            ),
            lineEnd =
              item.hasEOL ||
              (between.every((i) => 'str' in i && !i.str.trim()) &&
                between.some((i) => 'hasEOL' in i && i.hasEOL))
          return next &&
            lineEnd &&
            /\p{L}-$/u.test(item.str) &&
            /^\p{Ll}/u.test(next.str) &&
            item.fontName === next.fontName &&
            item.transform[5] - next.transform[5] >= item.height * 0.5 &&
            item.transform[5] - next.transform[5] <= item.height * 1.75 &&
            next.transform[4] < item.transform[4] + item.width
            ? item.str.slice(0, -1)
            : item.str
        })
        .join('')
      if (
        captionRegion.page !== number ||
        !captionItems.length ||
        captionItems.some(([i, b]) => selected.has(i) || overlaps(b, body)) ||
        (normalize(captionLiteral) !== normalize(caption.text) &&
          normalize(
            captionItems.map(([i]) => (content.items[i] as { str: string }).str).join('')
          ) !== normalize(caption.text)) ||
        allElements.some(
          (other) =>
            other !== element &&
            [...other.regions, ...(other.caption?.regions ?? [])].some((r) => overlaps(r, body))
        )
      )
        continue
      // Re-read native observations after all asynchronous proof work below.
      const readText = page.getTextContent,
        readViewport = page.getViewport,
        readOperators = page.getOperatorList,
        operators = await page.getOperatorList(),
        operatorBinding = JSON.stringify(operators),
        { OPS, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs'),
        rules: number[][] = [],
        stack: number[][] = []
      let matrix = [1, 0, 0, 1, 0, 0]
      if (
        operators.fnArray.length !== operators.argsArray.length ||
        operators.fnArray.length > 100000
      )
        continue
      // Observe ordinary axis-aligned native rules only. These bounds are a
      // table-family check for page retention, never a stroke/paint certificate.
      for (const [index, op] of operators.fnArray.entries()) {
        const a = operators.argsArray[index]
        if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
          stack.push([...matrix])
          if (op === OPS.paintFormXObjectBegin && a?.[0]) matrix = Util.transform(matrix, a[0])
        } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
          if (!stack.length) {
            valid = false
            break
          }
          matrix = stack.pop()!
        } else if (op === OPS.transform) matrix = Util.transform(matrix, a)
        else if (op === OPS.constructPath && a?.[0] === OPS.fill) {
          const path = a?.[1]?.[0]
          if (
            !path ||
            path.length !== 13 ||
            path[0] !== 0 ||
            path[3] !== 1 ||
            path[6] !== 1 ||
            path[9] !== 1 ||
            path[12] !== 4 ||
            !(
              (path[1] === path[10] &&
                path[4] === path[7] &&
                path[2] === path[5] &&
                path[8] === path[11]) ||
              (path[1] === path[4] &&
                path[7] === path[10] &&
                path[2] === path[11] &&
                path[5] === path[8])
            )
          )
            continue
          const transform = Util.transform(viewport.transform, matrix),
            p = [path[1], path[2]],
            q = [path[7], path[8]]
          if (transform[1] !== 0 || transform[2] !== 0) continue
          Util.applyTransform(p, transform)
          Util.applyTransform(q, transform)
          const left = Math.min(p[0], q[0]),
            right = Math.max(p[0], q[0]),
            top = Math.min(p[1], q[1]),
            bottom = Math.max(p[1], q[1])
          if (
            ![left, right, top, bottom].every(Number.isFinite) ||
            right - left < 30 ||
            bottom - top <= 0 ||
            bottom - top > 2
          )
            continue
          const y = (top + bottom) / 2 / viewport.height
          rules.push([left / viewport.width, y, right / viewport.width, y])
        } else if (op === OPS.constructPath && a?.[0] === OPS.stroke) {
          const path = a?.[1]?.[0],
            line =
              path?.length === 9 &&
              path[0] === 0 &&
              path[3] === 0 &&
              path[1] === path[4] &&
              path[2] === path[5]
                ? path.slice(3)
                : path
          if (!line || line.length !== 6 || line[0] !== 0 || line[3] !== 1) continue
          const transform = Util.transform(viewport.transform, matrix),
            p = [line[1], line[2]],
            q = [line[4], line[5]]
          Util.applyTransform(p, transform)
          Util.applyTransform(q, transform)
          if (![...p, ...q].every(Number.isFinite) || (p[0] !== q[0] && p[1] !== q[1])) continue
          rules.push([
            Math.min(p[0], q[0]) / viewport.width,
            Math.min(p[1], q[1]) / viewport.height,
            Math.max(p[0], q[0]) / viewport.width,
            Math.max(p[1], q[1]) / viewport.height
          ])
        }
      }
      const fontHeight = Math.max(...selectedBoxes.map((b) => b.height)),
        horizontals = rules.filter(
          ([x, y, right, bottom]) =>
            y === bottom &&
            x >= body.x &&
            right <= body.x + body.width &&
            right - x >= body.width * 0.75 &&
            y >= body.y &&
            y <= body.y + body.height + fontHeight
        ),
        verticals = rules.filter(
          ([x, y, right, bottom]) =>
            x === right &&
            x > body.x &&
            x < body.x + body.width &&
            y >= body.y &&
            bottom - y >= fontHeight &&
            bottom <= body.y + body.height + fontHeight
        ),
        horizontalEnd = Math.max(...horizontals.map((r) => r[1])),
        terminalEnds = verticals.filter(
          (r) =>
            r[3] >= body.y + body.height &&
            new Set(
              verticals
                .filter((other) => Math.abs(other[3] - r[3]) <= Number.EPSILON * 16)
                .map((other) => other[0])
            ).size >= 2
        ),
        lastRule = Math.max(horizontalEnd, ...terminalEnds.map((r) => r[3]))
      if (
        !valid ||
        stack.length ||
        horizontals.length < 2 ||
        new Set(verticals.map((r) => r[0])).size < 2
      )
        continue
      const retainBody =
        multirow &&
        lastRule >= body.y + body.height &&
        captionItems.every(([, b]) => b.y > lastRule)
      // A layered header can cross native column fences while its outer cell
      // remains open. Only suppress the unsafe whole owner; the selected crop
      // padding is neither a native boundary nor a new paint permission.
      const axes = [...horizontals, ...verticals],
        frame = [
          Math.min(...axes.map((r) => r[0])),
          Math.min(...axes.map((r) => r[1])),
          Math.max(...axes.map((r) => r[2])),
          Math.max(...axes.map((r) => r[3]))
        ],
        layeredOwners =
          !retainBody &&
          selectedBoxes.every(
            (b) =>
              b.x >= frame[0] &&
              b.y >= frame[1] &&
              b.x + b.width <= frame[2] &&
              b.y + b.height <= frame[3]
          ) &&
          captionItems.every(([, b]) => b.y > frame[3])
            ? layered.filter((unit) => {
                const boxes = unit!.fragments[0].items
                  .map((i) => fonts.get(i.index)!)
                  .sort((a, b) => a.x - b.x)
                return boxes.slice(1).every((right, index) => {
                  const left = boxes[index],
                    top = Math.max(left.y, right.y),
                    bottom = Math.min(left.y + left.height, right.y + right.height)
                  return (
                    top < bottom &&
                    verticals.some(
                      (r) =>
                        r[0] > left.x + left.width &&
                        r[0] < right.x &&
                        r[1] <= top &&
                        r[3] >= bottom &&
                        boxes.every((b) => !(b.x < r[0] && b.x + b.width > r[0]))
                    )
                  )
                })
              })
            : []
      if (!retainBody && !layeredOwners.length) continue
      checks.push(
        () =>
          binding === JSON.stringify([content, viewport]) &&
          page.getTextContent === readText &&
          page.getViewport === readViewport &&
          page.getOperatorList === readOperators &&
          JSON.stringify(operators) === operatorBinding
      )
      const again = await getPdfTranslationTextContent(page)
      if (
        JSON.stringify(again) !== JSON.stringify(content) ||
        JSON.stringify(page.getViewport({ scale: 1 })) !== JSON.stringify(viewport)
      )
        return empty
      for (const owner of retainBody ? bodyOwners : layeredOwners) retained.add(owner!.id)
      pages.add(number)
    }
    if (!retained.size || !(await digest()) || !current()) return empty
    return {
      retainedSourcePageNumbers: Object.freeze([...pages].sort((a, b) => a - b)),
      retainedUnitIds: Object.freeze([...retained]),
      extraction: Object.freeze({
        ...extraction,
        source: carryNativeCaptionEligibility(
          source,
          createPdfTranslationSource({
            ...source,
            units: source.units.map((unit) =>
              retained.has(unit.id) ? { ...unit, sourceOnly: true as const } : unit
            )
          })
        )
      })
    }
  } catch {
    signal.throwIfAborted()
    return empty
  }
}
