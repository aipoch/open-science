import type { PDFPageProxy } from 'pdfjs-dist'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'
import type { PdfStructureResult } from '@aipoch/pdf-structure/result'
import type { retainPdfWholeRegionSources } from './whole-region-retention.js'
import { createPdfTranslationSource } from './source.js'
import { getPdfTranslationTextContent } from './text-content.js'
import { rememberNativeCaptionEligibility } from './caption-eligibility.js'
import {
  nativeInkPageIdentity,
  nativeInkPageCurrent,
  createAuxiliaryNativeCaptionInkReader
} from './auxiliary-native-ink.js'
import {
  nativeIsolatedPlotCaptionScope,
  nativeIsolatedPlotCaptionInk,
  nativeIsolatedPlotImageEpoch
} from './native-source-geometry.js'

type Input = Parameters<typeof retainPdfWholeRegionSources>[0]
type Region = PdfStructureResult['elements'][number]['regions'][number]
type Content = Awaited<ReturnType<PDFPageProxy['getTextContent']>>
type Viewport = ReturnType<PDFPageProxy['getViewport']>

const stable = (x: unknown): string => JSON.stringify(x),
  referenceFigureCaption = /^(?:(?:Extended Data\s+)?(?:Figure|Fig\.))\s+[1-9]\d*:\s+[A-Z]/u,
  finite = (x: unknown, n: number): x is number[] =>
    Array.isArray(x) && x.length === n && x.every(Number.isFinite),
  valid = (r: Region): boolean =>
    !!r &&
    [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
    r.x >= 0 &&
    r.y >= 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.x + r.width <= 1 &&
    r.y + r.height <= 1,
  hit = (a: number[], b: number[]): boolean =>
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1],
  inside = (a: number[], b: number[]): boolean =>
    a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3],
  union = (rs: number[][]): number[] => [
    Math.min(...rs.map((r) => r[0])),
    Math.min(...rs.map((r) => r[1])),
    Math.max(...rs.map((r) => r[2])),
    Math.max(...rs.map((r) => r[3]))
  ],
  rect = (r: Omit<Region, 'page'>, v: Viewport): number[] => [
    r.x * v.width,
    r.y * v.height,
    (r.x + r.width) * v.width,
    (r.y + r.height) * v.height
  ]
function references(value: unknown, budget = 100000): () => boolean {
  const seen = new Set<object>(),
    entries: [object, string, object][] = []
  function visit(v: unknown): void {
    if (!v || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (seen.size > budget) throw Error('reference budget')
    if (ArrayBuffer.isView(v)) return
    for (const key of Object.keys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key)
      if (!d || !('value' in d)) throw Error('accessor')
      if (d.value && typeof d.value === 'object') {
        entries.push([v, key, d.value])
        visit(d.value)
      }
    }
  }
  try {
    visit(value)
  } catch {
    return () => false
  }
  return () => entries.every(([p, k, v]) => Object.getOwnPropertyDescriptor(p, k)?.value === v)
}
/** Restore one complete native caption owner at a time; never reset the bibliography interval. */
export async function restoreReferenceFigureCaptions(input: Input): Promise<Input['extraction']> {
  const { extraction, document, results, sourceIdentity, signal, nativeDocumentFactory } = input,
    source = extraction.source
  signal.throwIfAborted()
  if (
    !source.units.some(
      (u) =>
        u.sourceOnly === true && u.preserve === 'reference' && referenceFigureCaption.test(u.source)
    )
  )
    return extraction
  if (new Set(source.units.map((unit) => unit.id)).size !== source.units.length) return extraction
  const rootRefs = references([source, results]),
    sourceKey = stable(source),
    resultKey = stable(results),
    identityKey = stable(sourceIdentity),
    fingerprints = document.fingerprints,
    fingerprint = fingerprints[0],
    getPage = document.getPage,
    identityRef = sourceIdentity
  const current = (): boolean => {
    signal.throwIfAborted()
    return (
      input.extraction === extraction &&
      extraction.source === source &&
      input.document === document &&
      input.results === results &&
      input.sourceIdentity === identityRef &&
      document.getPage === getPage &&
      document.fingerprints === fingerprints &&
      document.fingerprints[0] === fingerprint &&
      source.fingerprint === fingerprint &&
      source.pages.length === document.numPages &&
      rootRefs() &&
      stable(source) === sourceKey &&
      stable(results) === resultKey &&
      stable(sourceIdentity) === identityKey
    )
  }
  if (!current() || results.length > 64) return extraction
  const elements = results.flatMap((r) => r.elements),
    claims = new Map<string, number>()
  for (const u of source.units)
    for (const f of u.fragments)
      for (const i of f.items) {
        const k = f.pageNumber + ':' + i.index
        claims.set(k, (claims.get(k) ?? 0) + 1)
      }
  const candidates = source.units.filter(
    (u) =>
      u.sourceOnly === true &&
      u.preserve === 'reference' &&
      u.fragments.length === 1 &&
      u.fragments[0].items.length === 2 &&
      referenceFigureCaption.test(u.source)
  )
  if (!candidates.length) return extraction
  const aux = createAuxiliaryNativeCaptionInkReader({
      document,
      nativeDocumentFactory,
      sourceIdentity,
      signal
    }),
    accepted = new Set<string>(),
    guards: (() => Promise<boolean>)[] = [],
    finalGuards: (() => boolean)[] = [],
    pages = new Map<number, { page: PDFPageProxy; content: Content; viewport: Viewport }>()
  let attempts = 0
  try {
    for (const unit of candidates) {
      if (attempts >= 4) break
      if (!current()) return extraction
      const f = unit.fragments[0],
        n = f.pageNumber,
        ids = f.items.map((i) => i.index)
      if (
        ids.some(
          (i, k) =>
            !Number.isSafeInteger(i) ||
            i < 0 ||
            (k > 0 && i <= ids[k - 1]) ||
            claims.get(n + ':' + i) !== 1
        )
      )
        continue
      const matching = elements.filter(
        (e) =>
          e.kind === 'figure' &&
          e.caption?.text === unit.source &&
          e.regions.length === 1 &&
          e.caption.regions.length === 1 &&
          e.regions[0].page === n &&
          e.caption.regions[0].page === n &&
          e.issues.length === 0
      )
      if (matching.length !== 1) continue
      if (
        elements.some((e) =>
          (e.sourceItems ?? [])
            .concat(e.nativeBody?.sourceItems ?? [])
            .some((i) => i.pageNumber === n && ids.includes(i.index))
        )
      )
        continue
      const figure = matching[0],
        caption = figure.caption!
      if (!valid(figure.regions[0]) || !valid(caption.regions[0])) continue
      const parent = results.find((r) => r.elements.includes(figure))
      if (
        !parent ||
        parent.sourceChecksum !== sourceIdentity.sourceChecksum ||
        parent.sourceSizeBytes !== sourceIdentity.sourceSizeBytes ||
        parent.pageCount !== document.numPages ||
        !parent.processedPages.includes(n)
      )
        continue
      if (!pages.has(n)) {
        const page = await document.getPage(n)
        if (!current()) return extraction
        const content = await getPdfTranslationTextContent(page)
        if (!current()) return extraction
        pages.set(n, { page, content, viewport: page.getViewport({ scale: 1 }) })
      }
      const { page, content, viewport } = pages.get(n)!
      if (
        viewport.rotation !== 0 ||
        !source.pages[n - 1] ||
        viewport.width !== source.pages[n - 1].width ||
        viewport.height !== source.pages[n - 1].height ||
        f.items.some((i) => {
          const item = content.items[i.index]
          return !item || !('str' in item) || item.str !== i.text
        }) ||
        f.items.map((i) => i.text).join(' ') !== unit.source
      )
        continue
      const apis = [
          page.getOperatorList,
          page.getTextContent,
          page.getViewport,
          page.commonObjs,
          page.commonObjs.get,
          page.commonObjs.has
        ],
        before = await nativeInkPageIdentity(page, content, viewport)
      if (!current()) return extraction
      if (!before) continue
      const nativeOperators = await page.getOperatorList(),
        nativeOpRefs = references([nativeOperators]),
        nativeRefs = references([content, before.operators]),
        nativeRef = page.ref,
        nativeView = page.view,
        fontRefs = [
          ...new Set(content.items.flatMap((i) => ('str' in i && i.str.trim() ? [i.fontName] : [])))
        ].map((id) => [id, page.commonObjs.get(id)]),
        epoch = async (): Promise<boolean> => {
          if (
            !current() ||
            page !== (await document.getPage(n)) ||
            page.ref !== nativeRef ||
            page.view !== nativeView ||
            ![
              page.getOperatorList,
              page.getTextContent,
              page.getViewport,
              page.commonObjs,
              page.commonObjs.get,
              page.commonObjs.has
            ].every((v, i) => v === apis[i]) ||
            !nativeRefs() ||
            !nativeOpRefs() ||
            (await page.getOperatorList()) !== nativeOperators ||
            fontRefs.some(([id, font]) => page.commonObjs.get(id) !== font)
          )
            return false
          const after = await nativeInkPageIdentity(page, content, viewport)
          return current() && !!after && after.key === before.key && nativeRefs() && nativeOpRefs()
        }
      const selected = new Set(ids),
        scope = await nativeIsolatedPlotCaptionScope(
          content,
          viewport,
          selected,
          before.operators,
          n
        )
      if (!scope) continue
      const advance = union(
          ids.map((i) => {
            const r = content.items[i] as TextItem
            return [
              r.transform[4],
              viewport.height - r.transform[5] - r.height,
              r.transform[4] + r.width,
              viewport.height - r.transform[5]
            ]
          })
        ),
        captionRect = rect(caption.regions[0], viewport),
        bodyRect = rect(figure.regions[0], viewport)
      if (
        advance.some((x, i) => Math.abs(x - captionRect[i]) > 1e-5) ||
        !inside(bodyRect, scope.body.bounds) ||
        hit(bodyRect, advance) ||
        elements.some(
          (e) =>
            e !== figure &&
            (e.caption?.regions ?? [])
              .concat(e.regions)
              .some((r) => r.page === n && valid(r) && hit(rect(r, viewport), advance))
        ) ||
        elements.filter((e) =>
          e.regions.some(
            (r) => r.page === n && valid(r) && inside(rect(r, viewport), scope.body.bounds)
          )
        ).length !== 1
      )
        continue
      const nativeCurrent = nativeInkPageCurrent(
        page,
        content,
        viewport,
        nativeOperators,
        scope.outlineKeys
      )
      if (!nativeCurrent) continue
      const imageEpoch = await nativeIsolatedPlotImageEpoch(page, scope)
      if (!current()) return extraction
      if (!imageEpoch || !(await imageEpoch.verify())) continue
      attempts++
      const ink =
        (await nativeIsolatedPlotCaptionInk(
          page,
          content,
          viewport,
          n,
          selected,
          before.operators
        )) ??
        (await aux.read({
          page,
          content,
          viewport,
          pageNumber: n,
          selected,
          operatorSnapshot: before.operators
        }))
      if (!(await epoch()) || !(await imageEpoch.verify())) return extraction
      if (!ink) continue
      const bounds = ids.flatMap((i) => {
        const r = ink.get(i)
        return r ? [rect(r, viewport)] : []
      })
      if (bounds.length !== ids.length) continue
      const bound = union(bounds)
      if (
        !finite(bound, 4) ||
        bound[0] < 0 ||
        bound[1] < 0 ||
        bound[2] > viewport.width ||
        bound[3] > viewport.height ||
        elements.some(
          (e) =>
            e !== figure &&
            (e.caption?.regions ?? [])
              .concat(e.regions)
              .some((r) => r.page === n && valid(r) && hit(rect(r, viewport), bound))
        )
      )
        continue
      accepted.add(unit.id)
      guards.push(async () => (await epoch()) && (await imageEpoch.verify()))
      finalGuards.push(() => nativeCurrent() && imageEpoch.current())
    }
    for (const guard of guards) if (!(await guard())) return extraction
  } catch {
    signal.throwIfAborted()
    return extraction
  } finally {
    await aux.dispose()
  }
  // Cleanup is the final await. Recheck every retained native frame and image,
  // then Source/Worker identity synchronously before constructing the result.
  if (!finalGuards.every((guard) => guard()) || !current() || !accepted.size) return extraction
  const restored = createPdfTranslationSource({
    ...source,
    units: source.units.map((u) => {
      if (!accepted.has(u.id)) return u
      const rest = { ...u }
      delete rest.sourceOnly
      delete rest.preserve
      return rest
    })
  })
  rememberNativeCaptionEligibility(restored, accepted)
  return Object.freeze({
    ...extraction,
    source: restored
  })
}
