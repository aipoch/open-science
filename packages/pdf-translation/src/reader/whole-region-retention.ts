import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import type { PdfTranslationExtraction } from './extraction.js'
import type { PdfTranslationSourceIdentity } from './table-source.js'
import { createPdfTranslationSource } from './source.js'
import { nativeLabelRegion, nativeZeroAdvanceRegions } from './native-source-geometry.js'

type Region = PdfStructureResult['elements'][number]['regions'][number]
const inside = (r: Region, outer: Region): boolean =>
  r.page === outer.page &&
  r.x >= outer.x - 1e-6 &&
  r.y >= outer.y - 1e-6 &&
  r.x + r.width <= outer.x + outer.width + 1e-6 &&
  r.y + r.height <= outer.y + outer.height + 1e-6
const overlaps = (a: Region, b: Region): boolean =>
  a.page === b.page &&
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height

/** Results have passed the cache schema/identity checks at the reader entry point. */
export async function retainPdfWholeRegionSources({
  extraction,
  document,
  results,
  sourceIdentity,
  signal
}: {
  extraction: PdfTranslationExtraction
  document: Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>
  results: readonly PdfStructureResult[]
  sourceIdentity: PdfTranslationSourceIdentity
  signal: AbortSignal
}): Promise<PdfTranslationExtraction> {
  signal.throwIfAborted()
  const source = extraction.source,
    identity = { ...sourceIdentity }
  const current = (): boolean =>
    !!source.fingerprint &&
    source.fingerprint === document.fingerprints[0] &&
    source.pages.length === document.numPages
  if (!current()) return extraction
  const elements = results.flatMap((result) => result.elements)
  const owners = new Map<string, (typeof source.units)[number]>(),
    unitIds = new Set<string>(),
    claims = new Map<string, number>()
  const unitKeys = (unit: (typeof source.units)[number]): string[] =>
    unit.fragments.flatMap((f) => f.items.map((i) => `${f.pageNumber}:${i.index}`))
  for (const unit of source.units) {
    if (unitIds.has(unit.id)) return extraction
    unitIds.add(unit.id)
    for (const key of unitKeys(unit)) {
      if (owners.has(key)) return extraction
      owners.set(key, unit)
    }
  }
  for (const element of elements)
    for (const item of [
      ...(element.sourceItems ?? []),
      ...(element.nativeBody?.sourceItems ?? [])
    ]) {
      const key = `${item.pageNumber}:${item.index}`
      claims.set(key, (claims.get(key) ?? 0) + 1)
    }
  const native = new Map<
      number,
      {
        content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>
        viewport: ReturnType<PDFPageProxy['getViewport']>
        page: PDFPageProxy
        zero?: Awaited<ReturnType<typeof nativeZeroAdvanceRegions>>
      }
    >(),
    retained = new Set<string>(),
    proseCaptions = new Set<string>(),
    mathWarnings = new Set<string>()
  // A successful body proof does not by itself release its title. Restore only
  // a complete, uniquely owned plain-text caption with its own native evidence.
  const algorithmCaption = (element: (typeof elements)[number]): string | undefined => {
    const caption = element.caption
    if (!caption || caption.regions.length !== 1) return
    const region = caption.regions[0],
      evidence = native.get(region.page)
    if (
      !evidence ||
      evidence.viewport.rotation !== 0 ||
      extraction.coverage.pageDiagnostics?.some((d) => d.pageNumber === region.page)
    )
      return
    const title = /^(Algorithm\s+(?:[A-Z]\.?)?\d+)\s+(.+)$/u.exec(caption.text),
      tail = title?.[2]
    if (
      !tail ||
      !/^[\p{Script=Latin}]+(?:[’'–-][\p{Script=Latin}]+)*(?:\s+[\p{Script=Latin}]+(?:[’'–-][\p{Script=Latin}]+)*){4,}[.]?$/u.test(
        tail
      )
    )
      return
    const items: { index: number; item: TextItem; region: Region }[] = []
    for (const [index, item] of evidence.content.items.entries()) {
      if (!('str' in item) || !item.str.trim()) continue
      const style = evidence.content.styles[item.fontName]
      // Unknown geometry anywhere on this page cannot exclude foreign text
      // from the caption. This never changes the separate body proof.
      if (
        !style ||
        style.vertical !== false ||
        !Number.isFinite(style.ascent) ||
        !Number.isFinite(style.descent) ||
        style.ascent <= 0 ||
        style.ascent > 1 ||
        style.descent > 0 ||
        style.descent < -1 ||
        style.ascent <= style.descent ||
        item.dir !== 'ltr' ||
        item.transform.length !== 6 ||
        ![...item.transform, item.height, item.width].every(Number.isFinite) ||
        item.transform[0] <= 0 ||
        item.transform[1] !== 0 ||
        item.transform[2] !== 0 ||
        Math.abs(item.transform[3] - item.height) > 1e-6 ||
        item.height <= 0 ||
        item.width <= 0
      )
        return
      const nativeRegion = nativeLabelRegion(item, style, evidence.viewport, region.page)
      if (!nativeRegion) return
      if (!overlaps(nativeRegion, region)) continue
      if (!inside(nativeRegion, region)) return
      items.push({ index, item, region: nativeRegion })
    }
    // One whole label run and one whole prose run: never assemble a title
    // by admitting separately styled mathematical letters into plain words.
    if (items.length !== 2 || items[0].item.str !== title![1] || items[1].item.str !== tail) return
    const first = items[0].item,
      unit = owners.get(region.page + ':' + items[0].index)
    if (
      !unit?.sourceOnly ||
      unit.fragments.length !== 1 ||
      unit.source !== caption.text ||
      extraction.coverage.warnings.some((w) => w.unitId === unit.id) ||
      items.map(({ item }) => item.str.trim()).join(' ') !== caption.text
    )
      return
    const keys = new Set(items.map(({ index }) => region.page + ':' + index))
    if (unitKeys(unit).length !== keys.size || unitKeys(unit).some((key) => !keys.has(key))) return
    for (const { index, item, region: nativeRegion } of items) {
      const key = region.page + ':' + index
      if (
        claims.has(key) ||
        owners.get(key) !== unit ||
        Math.abs(item.height - first.height) > 1e-6 ||
        Math.abs(item.transform[5] - first.transform[5]) > 1e-6 ||
        !unit.fragments[0].items.some((i) => i.index === index && i.text === item.str) ||
        elements.some(
          (other) =>
            other !== element &&
            [...other.regions, ...(other.caption?.regions ?? [])].some((r) =>
              overlaps(nativeRegion, r)
            )
        )
      )
        return
    }
    return unit.id
  }
  for (const result of results) {
    if (
      result.sourceChecksum !== identity.sourceChecksum ||
      result.sourceSizeBytes !== identity.sourceSizeBytes ||
      result.pageCount !== document.numPages
    )
      continue
    for (const element of result.elements) {
      const body = element.nativeBody
      if (!body || !element.caption || !body.sourceItems.length) continue
      const math = body.kind === 'math-table'
      if (
        math
          ? element.kind !== 'table' ||
            !!element.table ||
            !!element.tableParts ||
            element.issues.length !== 1 ||
            element.issues[0].code !== 'no-source-cell-grid'
          : body.kind !== 'algorithm' || element.kind !== 'algorithm' || element.issues.length > 0
      )
        continue
      try {
        const wanted = new Map(body.sourceItems.map((i) => [`${i.pageNumber}:${i.index}`, i])),
          bodyOwners = new Set<(typeof source.units)[number]>()
        if (wanted.size !== body.sourceItems.length) continue
        let valid = true
        for (const [key, item] of wanted) {
          const owner = owners.get(key)
          if (
            claims.get(key) !== 1 ||
            !owner ||
            !owner.fragments.some(
              (f) =>
                f.pageNumber === item.pageNumber &&
                f.items.some((i) => i.index === item.index && i.text === item.text)
            )
          ) {
            valid = false
            break
          }
          bodyOwners.add(owner)
        }
        if (!valid || [...bodyOwners].some((u) => unitKeys(u).some((k) => !wanted.has(k)))) continue
        for (const owner of bodyOwners)
          for (const fragment of owner.fragments) {
            const region = { page: fragment.pageNumber, ...fragment.rect }
            if (
              !element.regions.some((r) => inside(region, r)) ||
              elements.some(
                (e) =>
                  (e !== element && e.regions.some((r) => overlaps(region, r))) ||
                  e.caption?.regions.some((r) => overlaps(region, r))
              )
            )
              valid = false
          }
        if (!valid) continue
        const seen = new Set<string>()
        for (const pageNumber of new Set(element.regions.map((r) => r.page))) {
          signal.throwIfAborted()
          if (!current()) return extraction
          if (!result.processedPages.includes(pageNumber)) {
            valid = false
            break
          }
          if (!native.has(pageNumber)) {
            const page = await document.getPage(pageNumber),
              viewport = page.getViewport({ scale: 1 }),
              expected = source.pages[pageNumber - 1]
            if (
              !expected ||
              ![viewport.width, viewport.height].every((n) => Number.isFinite(n) && n > 0) ||
              Math.abs(viewport.width - expected.width) > 1e-6 ||
              Math.abs(viewport.height - expected.height) > 1e-6
            ) {
              valid = false
              break
            }
            native.set(pageNumber, { content: await page.getTextContent(), viewport, page })
          }
          signal.throwIfAborted()
          if (!current()) return extraction
          const evidence = native.get(pageNumber)!
          const { content, viewport } = evidence
          for (const [index, item] of content.items.entries()) {
            if (!('str' in item) || !item.str.trim()) continue
            const region = nativeLabelRegion(
                item,
                content.styles?.[item.fontName],
                viewport,
                pageNumber
              ),
              key = `${pageNumber}:${index}`,
              claim = wanted.get(key)
            // Unknown native geometry cannot prove that a text item lies outside the body.
            if (!region) {
              if (!claim && item.width === 0 && owners.has(key)) {
                evidence.zero ??= await nativeZeroAdvanceRegions(
                  evidence.page,
                  content,
                  viewport,
                  pageNumber
                )
                signal.throwIfAborted()
                if (!current()) return extraction
                const ink = evidence.zero.get(index)
                const external = owners.get(key)
                const protectedRegions = [
                  ...elements.flatMap((e) => [...e.regions, ...(e.caption?.regions ?? [])]),
                  ...source.units
                    .filter((u) => u !== external)
                    .flatMap((u) => u.fragments.map((f) => ({ page: f.pageNumber, ...f.rect })))
                ]
                if (
                  ink &&
                  protectedRegions.every(
                    (r) =>
                      r.page !== ink.page ||
                      ink.x + ink.width < r.x ||
                      r.x + r.width < ink.x ||
                      ink.y + ink.height < r.y ||
                      r.y + r.height < ink.y
                  )
                )
                  continue
              }
              valid = false
              break
            }
            if (!element.regions.some((r) => overlaps(region, r))) {
              if (claim) valid = false
              continue
            }
            const captionOverlap = element.caption.regions.some((r) => overlaps(region, r))
            if (!claim && captionOverlap && element.caption.regions.some((r) => inside(region, r)))
              continue
            if (
              !claim ||
              claim.text !== item.str ||
              captionOverlap ||
              !element.regions.some((r) => inside(region, r)) ||
              elements.some(
                (e) =>
                  (e !== element && e.regions.some((r) => overlaps(region, r))) ||
                  e.caption?.regions.some((r) => overlaps(region, r))
              )
            ) {
              valid = false
              break
            }
            seen.add(key)
          }
          if (!valid) break
        }
        if (!valid || seen.size !== wanted.size) continue
        if (!math) {
          const caption = algorithmCaption(element)
          if (caption) proseCaptions.add(caption)
        }
        for (const owner of bodyOwners) {
          retained.add(owner.id)
          if (math) mathWarnings.add(owner.id)
        }
      } catch {
        signal.throwIfAborted()
        // A body without complete evidence cannot affect independently proved bodies.
      }
    }
  }
  signal.throwIfAborted()
  if (!current() || !retained.size) return extraction
  const units = source.units.map((u) => {
    if (proseCaptions.has(u.id)) {
      const caption = { ...u }
      delete caption.sourceOnly
      return caption
    }
    return retained.has(u.id) && !u.sourceOnly ? { ...u, sourceOnly: true as const } : u
  })
  const warnings = new Map(extraction.coverage.warnings.map((w) => [w.unitId, new Set(w.reasons)]))
  for (const id of mathWarnings) {
    if (!warnings.has(id)) warnings.set(id, new Set())
    warnings.get(id)!.add('table-structure-unreliable')
  }
  return Object.freeze({
    ...extraction,
    source: createPdfTranslationSource({ ...source, units }),
    coverage: mathWarnings.size
      ? Object.freeze({
          ...extraction.coverage,
          warnings: Object.freeze(
            [...warnings].map(([unitId, reasons]) =>
              Object.freeze({ unitId, reasons: Object.freeze([...reasons]) })
            )
          )
        })
      : extraction.coverage
  })
}
