import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useTranslation } from 'react-i18next'
import type { PdfTranslationResults, PdfTranslationFragment } from '@aipoch/pdf-translation/reader'
import {
  pdfReflowContentKinds,
  preservePdfFigureSources,
  applyPdfContentFirstPolicy,
  isPdfTranslationResultExtension
} from '@aipoch/pdf-translation/reader'
import {
  pdfGenerationFailure,
  type PdfTranslationLayoutFailure
} from '@aipoch/pdf-translation/contracts'
import { pdfTranslationCheckpointRequestSchema } from '../../../../../../shared/pdf-translation'
import { pdfjsLib } from '../pdfjs'
import type { PdfTranslationDocumentState } from './pdf-translation-document-state'

const textKey = (text: string): string => text.normalize('NFC').replace(/\s/gu, '')

/** Owns content-first output independently of the fixed-layout PDF validator/cache. */
export function usePdfReflowDocument(
  original: PDFDocumentProxy | null,
  latestResults: PdfTranslationResults | undefined,
  resourceRequestKey: string,
  enabled: boolean,
  beforeReady?: () => void,
  translating = false
): {
  state: PdfTranslationDocumentState
  ready: Extract<PdfTranslationDocumentState, { status: 'ready' }> | undefined
  updateAvailable: boolean
  isCurrent: boolean
  unchangedLayoutUnitIds: readonly string[]
  unfilledUnitIds: readonly string[]
  layoutFailures: Readonly<Record<string, PdfTranslationLayoutFailure>>
  refresh: (unitId?: string) => void
  retry: () => void
  registerDisposer: (dispose: () => void) => () => void
} {
  const { t } = useTranslation()
  const [revision, setRevision] = useState(0)
  type Snapshot = { original: PDFDocumentProxy; results: PdfTranslationResults }
  const [selection, setSelection] = useState<Snapshot>()
  const [displayed, setDisplayed] = useState<
    Snapshot & {
      state: Extract<PdfTranslationDocumentState, { status: 'ready' }>
      failures: Record<string, PdfTranslationLayoutFailure>
    }
  >()
  const [stored, setStored] = useState<{
    original: PDFDocumentProxy
    results: PdfTranslationResults
    state: PdfTranslationDocumentState
    failures: Record<string, PdfTranslationLayoutFailure>
  }>()
  const live = useRef<{ release: () => void } | undefined>(undefined)
  const disposers = useRef(new Set<() => void>())
  const registerDisposer = useCallback((dispose: () => void) => {
    disposers.current.add(dispose)
    return () => {
      disposers.current.delete(dispose)
    }
  }, [])
  const admitted = Boolean(
    enabled &&
    original &&
    latestResults &&
    (latestResults.units.length || latestResults.failedUnitIds?.length) &&
    latestResults.source.resourceRequestKey === resourceRequestKey &&
    latestResults.source.fingerprint === original.fingerprints[0]
  )
  const sameContext = (snapshot: Snapshot | undefined): boolean =>
    Boolean(
      admitted &&
      snapshot?.original === original &&
      latestResults &&
      snapshot.results.source === latestResults.source &&
      snapshot.results.checkpoint?.key === latestResults.checkpoint?.key
    )
  // Pin a generation snapshot. Progress only marks the preview as out of date;
  // completion or an explicit refresh selects the newest accepted paragraphs.
  const results = sameContext(selection) ? selection?.results : undefined
  if (admitted && original && latestResults && !translating && results !== latestResults)
    setSelection({ original, results: latestResults })
  else if (!admitted && selection) setSelection(undefined)
  const canDisplay =
    sameContext(displayed) &&
    Boolean(
      displayed &&
      latestResults &&
      isPdfTranslationResultExtension(displayed.results, latestResults, true)
    )
  useEffect(() => () => live.current?.release(), [])
  useEffect(() => {
    if (!admitted || !original || !results) return
    const api = window.api?.pdfTranslation
    if (!api?.generatePdf) return
    let cancelled = false,
      released = false
    let task: ReturnType<typeof pdfjsLib.getDocument> | undefined
    let validating = false
    const id = crypto.randomUUID()
    const controller = new AbortController()
    const failures: Record<string, PdfTranslationLayoutFailure> = {}
    const publish = (state: PdfTranslationDocumentState): void => {
      if (!cancelled) setStored({ original, results, state, failures: { ...failures } })
    }
    const release = (): void => {
      if (released) return
      released = true
      if (live.current?.release === release) {
        for (const dispose of disposers.current) {
          try {
            dispose()
          } catch {
            /* release remaining pages */
          }
        }
        disposers.current.clear()
        live.current = undefined
      }
      void task?.destroy().catch(() => undefined)
    }
    publish({ status: 'loading', phase: 'generating' })
    const timer = window.setTimeout(() => {
      void (async () => {
        const accepted = new Map(results.units.map((u) => [u.id, u]))
        const units = results.source.units
        // Derive visual ownership locally even for historical editions. Only the
        // rendering request changes; saved source indices and translations do not.
        const protectedSource = applyPdfContentFirstPolicy(
          (
            await preservePdfFigureSources({
              document: original,
              extraction: { source: results.source },
              operators: pdfjsLib.OPS,
              signal: controller.signal
            })
          ).source
        )
        if (cancelled) return
        const kinds = pdfReflowContentKinds(protectedSource)
        const requestUnits = protectedSource.units.map((u) => {
          const result = accepted.get(u.id)
          return {
            source: u.source,
            kind: kinds.get(u.id),
            fragments: u.fragments,
            translation:
              !u.sourceOnly && result?.translationSource === u.source && result.translation.trim()
                ? result.translation
                : u.source
          }
        })
        const data = await original.getData()
        if (cancelled) return
        const output = await api.generatePdf({
          id,
          layout: 'reflow',
          sourceLinksLabel: t('Original links'),
          originalRegions: protectedSource.originalRegions,
          data,
          pages: results.source.pages,
          units: requestUnits
        })
        if (cancelled) return
        if (!output || output instanceof Uint8Array || !output.reflow)
          throw new Error('Missing PDF reflow layout')
        validating = true
        publish({ status: 'loading', phase: 'validating' })
        task = pdfjsLib.getDocument({ data: output.data.slice() })
        const document = await task.promise
        if (cancelled) return
        if (document.numPages !== output.reflow.sourcePageNumbers.length)
          throw new Error('Invalid reflow page mapping')
        const placements = new Map(output.reflow.units.map((u) => [u.unitIndex, u.fragments]))
        if (placements.size !== output.reflow.units.length)
          throw new Error('Duplicate reflow units')
        const retained = new Set<string>()
        for (const { unitIndex, ...failure } of output.layoutFailures) {
          if (!units[unitIndex]) throw new Error('Invalid reflow failure')
          if (accepted.has(units[unitIndex].id)) {
            retained.add(units[unitIndex].id)
            failures[units[unitIndex].id] = failure
          }
        }
        const pages: { width: number; height: number; rotation: number }[] = []
        const pageText = new Map<
          number,
          { str: string; transform: number[]; width: number; height: number }[]
        >()
        for (let number = 1; number <= document.numPages; number++) {
          if (cancelled) return
          const page = await document.getPage(number)
          try {
            const viewport = page.getViewport({ scale: 1 })
            pages.push({
              width: viewport.width,
              height: viewport.height,
              rotation: viewport.rotation
            })
            const text = await page.getTextContent()
            pageText.set(
              number,
              text.items.flatMap((item) => ('str' in item ? [item] : []))
            )
          } finally {
            page.cleanup()
          }
        }
        const unitFragments: Record<string, readonly PdfTranslationFragment[]> = {}
        for (const [index, fragments] of placements) {
          const unit = units[index]
          if (!unit) throw new Error('Unknown reflow unit')
          unitFragments[unit.id] = fragments.map((f) => ({
            pageNumber: f.pageNumber,
            rect: f.rect,
            items: []
          }))
          if (retained.has(unit.id) || !fragments.some((fragment) => fragment.text)) continue
          if (
            textKey(fragments.map((f) => f.text).join('')) !==
            textKey(requestUnits[index].translation)
          )
            throw new Error('Reflow translation incomplete')
          for (const fragment of fragments) {
            const geometry = pages[fragment.pageNumber - 1]
            if (!geometry) throw new Error('Invalid reflow placement')
            const target = fragment.rect
            const extracted = (pageText.get(fragment.pageNumber) ?? [])
              .filter((item) => {
                const x = (item.transform[4] + item.width / 2) / geometry.width
                const y = 1 - (item.transform[5] + item.height / 2) / geometry.height
                return (
                  x >= target.x - 0.001 &&
                  x <= target.x + target.width + 0.001 &&
                  y >= target.y - 0.001 &&
                  y <= target.y + target.height + 0.001
                )
              })
              .map((item) => item.str)
              .join('')
            if (textKey(extracted) !== textKey(fragment.text))
              throw new Error('Reflow PDF text changed')
          }
        }
        for (const [index, unit] of units.entries()) {
          if (
            accepted.has(unit.id) &&
            requestUnits[index].translation !== unit.source &&
            !placements.has(index)
          )
            throw new Error('Reflow translation missing')
        }
        if (cancelled) return
        const checkpoint = results.checkpoint
        const sourceIndices = new Map(
          units.filter((u) => !u.sourceOnly).map((u, index) => [u.id, index])
        )
        if (checkpoint && results.units.length && api.recordLayout)
          void api
            .recordLayout({
              source: pdfTranslationCheckpointRequestSchema.parse(checkpoint.source),
              checkpointKey: checkpoint.key,
              generatedAt: Date.now(),
              units: results.units.map((u) => ({
                sourceIndex: sourceIndices.get(u.id)!,
                source: u.translationSource,
                translation: u.translation,
                ...(failures[u.id] ? { failure: failures[u.id] } : {})
              }))
            })
            .catch(() => console.warn('[pdf-translation] Could not save reflow layout diagnostics'))
        beforeReady?.()
        live.current?.release()
        live.current = { release }
        const ready: Extract<PdfTranslationDocumentState, { status: 'ready' }> = {
          status: 'ready',
          document,
          pages,
          retainedUnitIds: [...retained],
          originalUnitCount:
            retained.size +
            (results.failedUnitIds?.length ?? 0) +
            protectedSource.units.filter((unit) => unit.figure).length,
          sourcePageNumbers: output.reflow.sourcePageNumbers,
          sourcePages: output.reflow.sourcePages,
          originalPageNumbers: output.reflow.originalPageNumbers,
          unitFragments
        }
        setDisplayed({ original, results, state: ready, failures: { ...failures } })
        publish(ready)
      })().catch((error) => {
        release()
        if (!cancelled)
          publish({
            status: 'error',
            failure: validating ? { code: 'validation-failed' } : pdfGenerationFailure(error),
            details: error instanceof Error ? error.message : undefined
          })
      })
    }, 500)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
      void api.cancelPdf(id).catch(() => undefined)
      if (live.current?.release !== release) release()
    }
  }, [admitted, original, results, revision, beforeReady, t])
  const current = admitted && stored?.original === original && stored.results === results
  if (!admitted && stored) setStored(undefined)
  useEffect(() => {
    if (!canDisplay) {
      live.current?.release()
    }
  }, [canDisplay])
  const state: PdfTranslationDocumentState = current ? stored.state : { status: 'idle' }
  const ready = canDisplay ? displayed?.state : undefined
  const refresh = useCallback(() => {
    if (!admitted || !original || !latestResults) return
    setSelection({ original, results: latestResults })
    setRevision((value) => value + 1)
  }, [admitted, original, latestResults])
  const unfilledUnitIds = useMemo(() => {
    const rendered = new Map((canDisplay ? displayed?.results.units : [])?.map((u) => [u.id, u]))
    const retained = new Set(ready?.retainedUnitIds)
    return (
      latestResults?.units.flatMap((unit) => {
        const previous = rendered.get(unit.id)
        return retained.has(unit.id) ||
          previous?.translation !== unit.translation ||
          previous?.translationSource !== unit.translationSource
          ? [unit.id]
          : []
      }) ?? []
    )
  }, [ready, latestResults, canDisplay, displayed])
  const isCurrent = Boolean(
    ready &&
    displayed &&
    latestResults &&
    displayed.results.units.length === latestResults.units.length &&
    isPdfTranslationResultExtension(displayed.results, latestResults) &&
    JSON.stringify(displayed.results.failedUnitIds ?? []) ===
      JSON.stringify(latestResults.failedUnitIds ?? [])
  )
  return {
    state,
    ready,
    updateAvailable: Boolean(admitted && latestResults && !isCurrent),
    isCurrent,
    unchangedLayoutUnitIds: [],
    unfilledUnitIds,
    layoutFailures: current ? stored.failures : {},
    refresh,
    retry: refresh,
    registerDisposer
  }
}
