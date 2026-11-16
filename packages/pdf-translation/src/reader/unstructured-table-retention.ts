import { parsePdfStructureResult } from '@aipoch/pdf-structure/result'
import { createPdfTranslationSource } from './source.js'
import { carryNativeCaptionEligibility } from './caption-eligibility.js'
import { getPdfTranslationTextContent } from './text-content.js'
import type { applyCachedPdfFigureSources } from './figure-source.js'
import type { PDFPageProxy } from 'pdfjs-dist'
import { nativeAlgorithmInkRegions, nativeZeroAdvanceRegions } from './native-source-geometry.js'
import { nativeInkPageCurrent } from './auxiliary-native-ink.js'

type Region = { page: number; x: number; y: number; width: number; height: number }
const overlaps = (a: Region, b: Region): boolean =>
  a.page === b.page &&
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height
const normalize = (s: string): string => s.replace(/\s/gu, '')
const recordIssues = [
  'native-fused-tuple-crosses-cell-wall',
  'native-section-label-value-records-merged',
  'native-group-heading-merged-with-record'
] as const
type RecordIssue = (typeof recordIssues)[number]
const centeredIssue = 'native-centered-headed-record-lanes-collapsed'
const ambiguousIssue = 'native-table-structure-ambiguous'
const missingGridIssue = 'no-source-cell-grid'
const knownIssues: readonly string[] = [
  ambiguousIssue,
  missingGridIssue,
  centeredIssue,
  ...recordIssues
]

// This proves a native record family, never replacement cells or paint bounds.
const nativeRecordFamily = (
  family: RecordIssue,
  content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>,
  selected: ReadonlySet<number>,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  rules: readonly number[][]
): boolean => {
  const t = viewport.transform
  if (
    t.length !== 6 ||
    !t.every(Number.isFinite) ||
    !(t[0] > 0) ||
    t[1] !== 0 ||
    t[2] !== 0 ||
    t[3] !== -t[0] ||
    selected.size > 1024
  )
    return false
  const records = [...selected].flatMap((index) => {
    const item = content.items[index]
    if (!item || !('str' in item)) return []
    const x = item.transform[4] * t[0] + t[4]
    return [
      {
        index,
        text: item.str,
        x,
        right: x + item.width * t[0],
        baseline: item.transform[5] * t[3] + t[5],
        h: item.height * t[0],
        face: item.fontName
      }
    ]
  })
  if (records.length !== selected.size) return false
  type Record = (typeof records)[number]
  const sameRow = (a: Record, b: Record): boolean => Math.abs(a.baseline - b.baseline) < a.h * 0.02,
    sameFace = (a: Record, b: Record): boolean =>
      a.face === b.face && Math.abs(a.h - b.h) < a.h * 0.02,
    aligned = (a: Record, b: Record): boolean =>
      Math.abs(a.x - b.x) < a.h * 0.05 ||
      Math.abs(a.right - b.right) < a.h * 0.1 ||
      Math.abs((a.x + a.right) / 2 - (b.x + b.right) / 2) < a.h * 0.05,
    rows: Record[][] = []
  for (const item of [...records].sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    const row = rows.find((r) => sameRow(r[0], item))
    if (row) row.push(item)
    else rows.push([item])
  }
  for (const row of rows) row.sort((a, b) => a.x - b.x)
  if (family === 'native-fused-tuple-crosses-cell-wall') {
    const tuple = (s: string): boolean =>
      /^\([+−-]?\d+(?:\.\d+)?(?:,[+−-]?\d+(?:\.\d+)?)+\)$/u.test(normalize(s))
    return rows.some((row) =>
      row.some(
        (seam, index) =>
          /^\)\s+\($/u.test(seam.text) &&
          row.every((r) => Math.abs(r.h - seam.h) < seam.h * 0.02) &&
          row.slice(0, index).some((_, start) =>
            tuple(
              row
                .slice(start, index)
                .map((r) => r.text)
                .join('') + ')'
            )
          ) &&
          row.slice(index + 1).some((_, end) =>
            tuple(
              '(' +
                row
                  .slice(index + 1, index + end + 2)
                  .map((r) => r.text)
                  .join('')
            )
          ) &&
          rules.some(
            ([x, top, right, bottom]) =>
              x === right &&
              x * viewport.width > seam.x &&
              x * viewport.width < seam.right &&
              top * viewport.height <= seam.baseline - seam.h * 0.75 &&
              bottom * viewport.height >= seam.baseline
          )
      )
    )
  }
  if (family === 'native-section-label-value-records-merged') {
    const pairs = rows.filter(
      (row) =>
        row.length === 2 &&
        /\p{L}{2}/u.test(row[0].text) &&
        /^[\p{L}\p{N}_.+−-]{1,24}$/u.test(row[1].text) &&
        sameFace(row[0], row[1]) &&
        row[0].right < row[1].x - row[0].h &&
        row[0].index < row[1].index
    )
    return pairs.some(([left, right]) => {
      const peers = pairs.filter(
        ([a, b]) => sameFace(left, a) && aligned(left, a) && aligned(right, b)
      )
      return (
        peers.length >= 3 &&
        peers.slice(1).every((p, n) => peers[n][1].index < p[0].index) &&
        rows.some(
          (r) =>
            r.length === 1 &&
            /\p{L}{2}/u.test(r[0].text) &&
            !sameFace(r[0], left) &&
            r[0].x < left.x - left.h &&
            peers.some(
              ([a]) => a.baseline - r[0].baseline > a.h && a.baseline - r[0].baseline < a.h * 1.8
            )
        )
      )
    })
  }
  const headings = rows.flatMap((row, index) => {
    const next = rows[index + 1],
      head = row[0],
      start = next?.[0]
    return row.length === 1 &&
      start &&
      next.length >= 3 &&
      /\p{L}{2}/u.test(head.text) &&
      /\p{L}{2}/u.test(start.text) &&
      !sameFace(head, start) &&
      aligned(head, start) &&
      start.baseline - head.baseline > head.h &&
      start.baseline - head.baseline < head.h * 1.8 &&
      head.index < start.index &&
      next.slice(1).every((r) => r.x > start.right + head.h && r.index > start.index)
      ? [head]
      : []
  })
  return headings.some((a) => headings.some((b) => a !== b && sameFace(a, b) && aligned(a, b)))
}

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
      centered: boolean
      records: readonly RecordIssue[]
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
      for (const element of result.elements) {
        const codes = element.issues.map((issue) => issue.code),
          knownRecordIssues =
            codes.includes(ambiguousIssue) &&
            codes.includes(missingGridIssue) &&
            codes.every((code) => knownIssues.includes(code)),
          centered = knownRecordIssues && codes.includes(centeredIssue),
          records = knownRecordIssues ? recordIssues.filter((code) => codes.includes(code)) : []
        if (
          element.kind === 'table' &&
          !element.table &&
          !element.tableParts &&
          !element.nativeBody &&
          !element.sourceItems &&
          element.regions.length === 1 &&
          element.caption?.regions.length === 1 &&
          (centered || records.length || (codes.length === 1 && codes[0] === missingGridIssue))
        )
          candidates.push({ result, element, centered, records })
      }
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
    for (const { result, element, centered, records } of candidates) {
      const region = element.regions[0],
        record = records.length > 0,
        number = region.page,
        page = await document.getPage(number),
        viewport = page.getViewport({ scale: 1 }),
        expected = source.pages[number - 1],
        declared = result.pages.find((p) => p.page === number),
        content = await getPdfTranslationTextContent(page),
        binding = JSON.stringify([content, viewport]),
        fonts = new Map<number, Region>()
      if (!current()) return empty
      if (
        !expected ||
        !declared ||
        declared.width !== viewport.width ||
        declared.height !== viewport.height ||
        declared.rotation !== viewport.rotation ||
        viewport.rotation !== 0 ||
        viewport.width !== expected.width ||
        viewport.height !== expected.height ||
        !result.processedPages.includes(number)
      )
        continue
      // Native line-end evidence can validate the reader's complete canonical
      // spelling. It never changes an owner or drops an unwitnessed hyphen.
      const nativeLiteral = (indexes: readonly number[], strictPacket = false): string =>
        indexes
          .map((index, position) => {
            const item = content.items[index] as {
                str: string
                width: number
                height: number
                hasEOL: boolean
                transform: number[]
                fontName: string
              },
              next = content.items[indexes[position + 1]] as typeof item | undefined,
              between = content.items.slice(index + 1, indexes[position + 1] ?? index + 1),
              blank = between.every((i) => 'str' in i && !i.str.trim()),
              lineEnd = item.hasEOL || (blank && between.some((i) => 'hasEOL' in i && i.hasEOL))
            return next &&
              (!strictPacket || blank) &&
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
      let valid = true,
        zero: Awaited<ReturnType<typeof nativeZeroAdvanceRegions>> | undefined
      for (const [index, item] of content.items.entries()) {
        if (!('str' in item) || !item.str.trim()) continue
        if (record && item.width === 0) {
          zero ??= await nativeZeroAdvanceRegions(page, content, viewport, number)
          if (!current()) return empty
          const ink = zero.get(index)
          if (ink && ![region, ...element.caption!.regions].some((r) => overlaps(r, ink))) continue
        }
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
      if (!centered && !record && !multirow && !layered.length) continue
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
        if (
          normalize(owner.source) !== normalize(literals.join('')) &&
          (!record ||
            normalize(owner.source) !==
              normalize(
                nativeLiteral(
                  owner.fragments.flatMap((f) => f.items.map((i) => i.index)),
                  true
                )
              ))
        )
          valid = false
      }
      if (!valid || [...fonts].some(([i, b]) => overlaps(b, body) && !selected.has(i))) continue
      const caption = element.caption!,
        captionRegion = caption.regions[0],
        captionItems = [...fonts].filter(([, box]) => overlaps(box, captionRegion))
      const captionLiteral = nativeLiteral(captionItems.map(([index]) => index))
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
      const proveCenteredLanes = (): boolean => {
        // Recheck independent native heading/value lanes. The cache diagnostic
        // selects this family; it cannot itself suppress ordinary prose.
        if (selected.size > 512) return false
        const records = [...selected].flatMap((index) => {
            const item = content.items[index]
            return 'str' in item ? [item] : []
          }),
          h = records[0].height,
          top = Math.max(...records.map((item) => item.transform[5])),
          heads = records
            .filter((item) => Math.abs(item.transform[5] - top) < h * 0.02)
            .sort((a, b) => a.transform[4] - b.transform[4]),
          center = (item: (typeof records)[number]): number => item.transform[4] + item.width / 2
        if (
          heads.length !== 3 ||
          heads.some(
            (item) =>
              Math.abs(item.height - h) > h * 0.02 ||
              !/^\p{L}{2}[\p{L}\d]*(?:[ -][\p{L}\d]+)*$/u.test(item.str.trim())
          ) ||
          heads[0].transform[4] + heads[0].width >= heads[1].transform[4] - h ||
          heads[2].transform[4] - heads[1].transform[4] - heads[1].width < h * 0.6
        )
          return false
        const baselines: number[] = []
        for (const left of records) {
          const y = left.transform[5],
            sameRow = (item: (typeof records)[number]): boolean =>
              Math.abs(item.transform[5] - y) < h * 0.02 && Math.abs(item.height - h) < h * 0.02
          if (
            y >= top - h * 0.5 ||
            Math.abs(left.height - h) > h * 0.02 ||
            !/^[\p{L}\d.+−-]{1,24}$/u.test(left.str.trim()) ||
            Math.abs(center(left) - center(heads[1])) >= h * 0.02
          )
            continue
          const right = records.filter(
              (item) =>
                sameRow(item) &&
                /^[\p{L}\d.+−-]{1,24}$/u.test(item.str.trim()) &&
                Math.abs(center(item) - center(heads[2])) < h * 0.02 &&
                item.transform[4] - left.transform[4] - left.width >= h
            ),
            labels = records.filter(
              (item) => sameRow(item) && item.transform[4] + item.width < left.transform[4] - h
            )
          if (
            right.length === 1 &&
            labels.length === 1 &&
            !baselines.some((before) => Math.abs(before - y) < h * 0.02)
          )
            baselines.push(y)
        }
        return baselines.length >= 3
      }
      const centeredProved = centered && proveCenteredLanes()
      if (centered && !centeredProved && !record) continue
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
        (!centered && !record && new Set(verticals.map((r) => r[0])).size < 2)
      )
        continue
      const encloses = (boxes: readonly Region[]): boolean =>
        horizontals.some(
          ([x, y, right]) =>
            x <= Math.min(...boxes.map((b) => b.x)) &&
            right >= Math.max(...boxes.map((b) => b.x + b.width)) &&
            y < Math.min(...boxes.map((b) => b.y))
        ) &&
        horizontals.some(
          ([x, y, right]) =>
            x <= Math.min(...boxes.map((b) => b.x)) &&
            right >= Math.max(...boxes.map((b) => b.x + b.width)) &&
            y >= Math.max(...boxes.map((b) => b.y + b.height))
        )
      const advanceFrame = (centeredProved || record) && encloses(selectedBoxes)
      let nativeFrame = advanceFrame
      if (record && (zero || !nativeFrame)) {
        const keys = new Set<string>(),
          stack: string[] = []
        let font = ''
        for (const [index, op] of operators.fnArray.entries()) {
          const a = operators.argsArray[index]
          if (op === OPS.setFont) font = a[0]
          else if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op))
            stack.push(font)
          else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op))
            font = stack.pop() ?? ''
          else if (op === OPS.showText)
            for (const glyph of a[0])
              if (typeof glyph?.fontChar === 'string') keys.add(font + '_path_' + glyph.fontChar)
        }
        const inkCurrent = nativeInkPageCurrent(page, content, viewport, operators, [...keys])
        if (!inkCurrent) continue
        checks.push(inkCurrent)
        if (
          zero &&
          JSON.stringify([...zero]) !==
            JSON.stringify([...(await nativeZeroAdvanceRegions(page, content, viewport, number))])
        )
          return empty
        if (!current()) return empty
      }
      if (record && !nativeFrame) {
        // Prove real glyph overhangs independently; never pad a rail or relax
        // the original advance/frame comparison for a known table marker.
        const ink = await nativeAlgorithmInkRegions(
            page,
            content,
            viewport,
            number,
            selected,
            operators
          ),
          boxes = [...selected].flatMap((index) => (ink?.get(index) ? [ink.get(index)!] : []))
        if (!current()) return empty
        nativeFrame = boxes.length === selected.size && encloses(boxes)
      }
      const recordProved =
        nativeFrame &&
        records.some((code) => nativeRecordFamily(code, content, selected, viewport, rules))
      if ((centered || record) && !recordProved && !(centeredProved && advanceFrame)) continue
      const retainBody =
        recordProved ||
        ((advanceFrame || (multirow && lastRule >= body.y + body.height)) &&
          captionItems.every(([, b]) => b.y > lastRule))
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
