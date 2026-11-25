import { pdfTranslationCheckpointRequestSchema } from '../../../../../../shared/pdf-translation'
import {
  pdfTranslationLayoutFragments,
  getPdfTranslationLayoutSnapshot,
  extractPdfTranslationSource,
  isPdfTranslationResultExtension,
  type PdfTranslationResults
} from '@aipoch/pdf-translation/reader'
import {
  createPdfTranslationVerification,
  type PdfTranslationRenderUnit,
  type VerifiedPdfTranslationRegions
} from './pdf-translation-verification'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { pdfjsLib } from '../pdfjs'
import { usePdfReflowDocument } from './use-pdf-reflow-document'
import { decidePdfTranslationRecovery } from './pdf-translation-recovery'
import { includeJoinedPdfPages } from './pdf-translation-page-groups'
import {
  preparePdfTranslationStructure,
  type PdfTranslationStructureContext
} from './pdf-translation-structure'
import type { PdfTranslationDocumentState } from './pdf-translation-document-state'

export type { PdfTranslationDocumentState } from './pdf-translation-document-state'

import {
  pdfGenerationFailure,
  type PdfTranslationLayoutFailure
} from '@aipoch/pdf-translation/contracts'
import { type PdfTranslationRecordLayoutRequest } from '../../../../../../shared/pdf-translation'

/** A generated file belongs to exactly one accepted result snapshot, never a filename alone. */
export type PdfTranslationArtifact = Readonly<{ results: PdfTranslationResults; data: Uint8Array }>
type State = PdfTranslationDocumentState
const idle: State = { status: 'idle' }
// Some PDFs emit a single paragraph as one fragment per line. Treat adjacent
// lines in its own column as one layout area; never cross another unit's space.

function partialPdfSnapshot(results: PdfTranslationResults): Readonly<{
  ready: boolean
  readyPages: readonly number[]
  units: readonly PdfTranslationRenderUnit[]
}> {
  const sourceUnits = results.source.units.filter((unit) => !unit.sourceOnly)
  const sourceById = new Map(sourceUnits.map((unit) => [unit.id, unit]))
  const accepted = results.units.filter((unit) => {
    const source = sourceById.get(unit.id)
    return Boolean(source && unit.translationSource === source.source && unit.translation.trim())
  })
  const translations = new Map(accepted.map((unit) => [unit.id, unit]))
  const completed = new Set([...accepted.map((unit) => unit.id), ...(results.failedUnitIds ?? [])])
  const pageUnits = new Map<number, Set<string>>()
  for (const unit of sourceUnits) {
    for (const fragment of unit.fragments) {
      const owners = pageUnits.get(fragment.pageNumber) ?? new Set<string>()
      owners.add(unit.id)
      pageUnits.set(fragment.pageNumber, owners)
    }
  }
  const readyPages = [...pageUnits]
    .filter(([, ids]) => ids.size > 0 && [...ids].every((id) => completed.has(id)))
    .map(([page]) => page)
    .sort((left, right) => left - right)
  return {
    ready: readyPages.length > 0 && accepted.length > 0,
    readyPages,
    units: sourceUnits.map((unit) => ({
      source: unit.source,
      // Retained source has no output capacity to reserve. Enlarging its region
      // can include rotated figure labels excluded from prose extraction.
      fragments:
        !translations.has(unit.id) || translations.get(unit.id)!.translation === unit.source
          ? unit.fragments
          : pdfTranslationLayoutFragments(unit, results.source),
      translation: translations.get(unit.id)?.translation ?? unit.source
    }))
  }
}

// Borrows the verified original/results. Owns the writer request and translated PDF.js task only.
export function usePdfTranslationDocument(
  original: PDFDocumentProxy | null,
  results: PdfTranslationResults | undefined,
  artifact: PdfTranslationArtifact | undefined,
  resourceRequestKey: string,
  beforeReady?: () => void,
  layout?: 'reflow',
  translating = false,
  structureContext?: PdfTranslationStructureContext
): {
  state: State
  ready: Extract<State, { status: 'ready' }> | undefined
  updateAvailable: boolean
  isCurrent: boolean
  unchangedLayoutUnitIds: readonly string[]
  unfilledUnitIds: readonly string[]
  layoutFailures: Readonly<Record<string, PdfTranslationLayoutFailure>>
  refresh: (unitId?: string) => void
  retry: () => void
  registerDisposer: (dispose: () => void) => () => void
} {
  const reflow = usePdfReflowDocument(
    original,
    results,
    resourceRequestKey,
    layout === 'reflow',
    beforeReady,
    translating,
    structureContext
  )
  const [request, setRequest] = useState<{
    failed?: {
      original: PDFDocumentProxy
      results: PdfTranslationResults
      value: Extract<State, { status: 'error' }>
    }
    rebuildArtifact?: PdfTranslationArtifact
    retryUnitId?: string
    baseline?: Displayed
    bypassCache?: { original: PDFDocumentProxy; results: PdfTranslationResults }
    originalPlacementOwners?: {
      original: PDFDocumentProxy
      results: PdfTranslationResults
      ids: ReadonlySet<string>
    }
    originalLinkOwners?: {
      original: PDFDocumentProxy
      results: PdfTranslationResults
      byPage: ReadonlyMap<number, ReadonlyMap<number, string>>
    }
    originalPages?: {
      original: PDFDocumentProxy
      source: PdfTranslationResults['source']
      reasons: ReadonlyMap<number, Pick<PdfTranslationLayoutFailure, 'code' | 'phase'>>
    }
  }>({})
  const generationClock = useRef(0)
  const [layoutReports, setLayoutReports] = useState<{
    original: PDFDocumentProxy
    source: PdfTranslationResults['source']
    units: Record<
      string,
      { translation: string; source: string; failure?: PdfTranslationLayoutFailure }
    >
  }>()
  const useArtifact = Boolean(artifact && artifact !== request.rebuildArtifact)
  const disposers = useRef(new Set<() => void>())
  const registerDisposer = useCallback((dispose: () => void) => {
    disposers.current.add(dispose)
    return () => {
      disposers.current.delete(dispose)
    }
  }, [])
  const [stored, setStored] = useState<{
    original: PDFDocumentProxy
    results: PdfTranslationResults
    artifact: PdfTranslationArtifact | undefined
    value: State
  }>()
  const [selection, setSelection] = useState<{
    original: PDFDocumentProxy
    artifact: PdfTranslationArtifact | undefined
    results: PdfTranslationResults
    ready: boolean
  }>()
  type Displayed = {
    original: PDFDocumentProxy
    artifact: PdfTranslationArtifact | undefined
    results: PdfTranslationResults
    value: Extract<State, { status: 'ready' }>
    release: () => void
    data: Uint8Array
    validation: VerifiedPdfTranslationRegions
  }
  const [displayed, setDisplayed] = useState<Displayed>()
  const live = useRef<Displayed | undefined>(undefined)
  const admitted =
    layout !== 'reflow' &&
    original &&
    results &&
    (!artifact || artifact.results === results) &&
    results.source.resourceRequestKey === resourceRequestKey &&
    results.source.fingerprint === original.fingerprints[0]
  // Progress remains live, but appending paragraphs must not replace the PDF
  // under the reader. Completed pages advance the snapshot between generation jobs.
  const selected = admitted
    ? selection?.original === original &&
      selection.artifact === artifact &&
      selection.ready &&
      isPdfTranslationResultExtension(selection.results, results, true)
      ? selection.results
      : results
    : undefined
  const snapshot = useMemo(() => (selected ? partialPdfSnapshot(selected) : undefined), [selected])
  if (
    selection?.results !== selected ||
    (selected && (selection?.original !== original || selection.artifact !== artifact))
  )
    setSelection(
      selected && original
        ? { original, artifact, results: selected, ready: snapshot?.ready ?? false }
        : undefined
    )
  const canDisplay = Boolean(
    admitted &&
    displayed?.original === original &&
    displayed.artifact === artifact &&
    isPdfTranslationResultExtension(displayed.results, results, true)
  )
  useLayoutEffect(() => {
    if (!canDisplay && live.current) {
      live.current.release()
      setDisplayed(undefined)
    }
  }, [canDisplay])
  useEffect(() => () => live.current?.release(), [])
  const storedState =
    admitted &&
    stored?.original === original &&
    stored.artifact === artifact &&
    isPdfTranslationResultExtension(stored.results, results, true)
      ? stored.value
      : idle
  const state = useMemo(
    () =>
      storedState.status === 'error' &&
      storedState.retryUnchanged &&
      stored &&
      results &&
      !isPdfTranslationResultExtension(stored.results, results)
        ? { ...storedState, retryUnchanged: false }
        : storedState,
    [storedState, stored, results]
  )

  useEffect(() => {
    if (!admitted) return
    const runResults = selected
    if (!runResults || !snapshot) return
    const sourceUnits = runResults.source.units.filter((unit) => !unit.sourceOnly)
    const originalPages = new Map(
      request.originalPages?.original === original &&
        request.originalPages.source === runResults.source
        ? request.originalPages.reasons
        : []
    )
    const originalLinkOwners = new Map(
      request.originalLinkOwners?.original === original &&
        request.originalLinkOwners.results === runResults
        ? request.originalLinkOwners.byPage
        : []
    )
    const retainedPlacementOwners = new Set(
      request.originalPlacementOwners?.original === original &&
        request.originalPlacementOwners.results === runResults
        ? request.originalPlacementOwners.ids
        : []
    )
    const retainedLinks = new Set(
      [...originalLinkOwners.values()].flatMap((owners) => [...owners.values()])
    )
    // Retain every fragment of an owner touching an original page. The other
    // pages can still accept translations in unrelated regions.
    const preservedIds = new Set(
      sourceUnits
        .filter(
          (unit) =>
            retainedLinks.has(unit.id) ||
            retainedPlacementOwners.has(unit.id) ||
            unit.fragments.some((fragment) => originalPages.has(fragment.pageNumber))
        )
        .map((unit) => unit.id)
    )
    let runSnapshot = preservedIds.size
      ? {
          ...snapshot,
          units: snapshot.units.map((unit, index) =>
            preservedIds.has(sourceUnits[index].id)
              ? { ...unit, fragments: sourceUnits[index].fragments, translation: unit.source }
              : unit
          )
        }
      : snapshot
    const units = sourceUnits.map((unit, index) => ({
      ...unit,
      fragments: runSnapshot.units[index].fragments
    }))
    const acceptedById = new Map(runResults.units.map((unit) => [unit.id, unit]))
    const complete =
      units.length > 0 &&
      runResults.units.length === units.length &&
      units.every((unit) => {
        const result = acceptedById.get(unit.id)
        return (
          result?.id === unit.id &&
          result.translationSource === unit.source &&
          Boolean(result.translation.trim())
        )
      })
    const api = window.api?.pdfTranslation
    if (
      (!useArtifact && !runSnapshot.ready) ||
      (useArtifact && !complete) ||
      (!useArtifact && !api?.generatePdf)
    )
      return
    let cancelled = false
    const nativeVerification = new AbortController()
    const verification = createPdfTranslationVerification(nativeVerification.signal)
    const { location } = verification
    let task: ReturnType<typeof pdfjsLib.getDocument> | undefined
    let released = false
    let validating = false
    const baseline = request.baseline
    const reusable =
      !useArtifact &&
      !originalPages.size &&
      !preservedIds.size &&
      baseline?.original === original &&
      live.current?.release === baseline.release &&
      baseline.artifact === artifact &&
      baseline.results.source === runResults.source
        ? baseline
        : undefined
    const dirtyPages = new Set<number>()
    if (reusable) {
      const before = new Map(reusable.results.units.map((unit) => [unit.id, unit]))
      const retryRetained =
        reusable.results.units.length === runResults.units.length &&
        isPdfTranslationResultExtension(reusable.results, runResults)
      for (const unit of units) {
        const previous = before.get(unit.id),
          next = acceptedById.get(unit.id)
        if (
          previous?.translation !== next?.translation ||
          previous?.translationSource !== next?.translationSource ||
          ((retryRetained || request.retryUnitId === unit.id) &&
            reusable.value.retainedUnitIds.includes(unit.id) &&
            (!request.retryUnitId || request.retryUnitId === unit.id))
        )
          for (const fragment of unit.fragments) dirtyPages.add(fragment.pageNumber)
      }
      // Whole joined units must participate in the rebuild, even when another
      // changed paragraph touches only one of their pages. Close transitively.
      includeJoinedPdfPages(dirtyPages, units)
    }
    let incremental =
      reusable && dirtyPages.size > 0 && dirtyPages.size < original.numPages
        ? { data: reusable.data, pageNumbers: [...dirtyPages].sort((a, b) => a - b) }
        : undefined
    const generatedAt = Math.max(Date.now(), generationClock.current + 1)
    generationClock.current = generatedAt
    let generatedUnits = units.flatMap((unit, sourceIndex) =>
      acceptedById.has(unit.id)
        ? [{ unit, sourceIndex, snapshot: snapshot.units[sourceIndex] }]
        : []
    )
    let nativeFailures: Record<string, PdfTranslationLayoutFailure> = {}
    let cacheToken: string | undefined
    let cacheHit = false
    const bypassCache =
      request.bypassCache?.original === original && request.bypassCache.results === runResults
    let cache =
      complete && !originalPages.size && !preservedIds.size && runResults.checkpoint
        ? {
            source: pdfTranslationCheckpointRequestSchema.parse(runResults.checkpoint.source),
            checkpointKey: runResults.checkpoint.key,
            ...(bypassCache ? { bypass: true } : {})
          }
        : undefined
    const recordLayout = (
      entries: PdfTranslationRecordLayoutRequest['units'],
      pdfCacheToken?: string
    ): void => {
      if (cancelled || useArtifact || !entries.length) return
      setLayoutReports((previous) => ({
        original,
        source: runResults.source,
        units: {
          ...(previous?.original === original && previous.source === runResults.source
            ? previous.units
            : {}),
          ...Object.fromEntries(entries.map((entry) => [units[entry.sourceIndex].id, entry]))
        }
      }))
      if (runResults.checkpoint && api?.recordLayout) {
        void api
          .recordLayout({
            source: pdfTranslationCheckpointRequestSchema.parse(runResults.checkpoint.source),
            checkpointKey: runResults.checkpoint.key,
            generatedAt,
            units: entries,
            ...(pdfCacheToken ? { pdfCacheToken } : {})
          })
          .catch(() => {
            console.warn('[pdf-translation] Could not save PDF layout diagnostics')
          })
      }
    }
    const id = crypto.randomUUID()
    const publish = (value: State): void => {
      if (!cancelled)
        setStored({
          original,
          results: runResults,
          artifact,
          value
        })
    }
    const release = (): void => {
      if (released) return
      released = true
      if (live.current?.release === release) {
        for (const dispose of disposers.current) {
          try {
            dispose()
          } catch {
            /* Release remaining pages. */
          }
        }
        disposers.current.clear()
        live.current = undefined
      }
      void task?.destroy().catch(() => undefined)
    }
    const generation = (async () => {
      publish({ status: 'loading', phase: 'generating' })
      if (structureContext && typeof window.api?.pdfStructure?.readCached === 'function') {
        const coverage =
          getPdfTranslationLayoutSnapshot(runResults.source)?.coverage ??
          (
            await extractPdfTranslationSource({
              document: original,
              resourceRequestKey,
              signal: nativeVerification.signal
            })
          ).coverage
        const structure = await preparePdfTranslationStructure({
          document: original,
          extraction: { source: runResults.source, coverage },
          context: structureContext,
          preserveUnitIdentity: true,
          nativeDocumentFactory: pdfjsLib.getDocument,
          signal: nativeVerification.signal
        })
        if (cancelled) return
        for (const id of structure.retainedUnitIds) if (acceptedById.has(id)) preservedIds.add(id)
        for (const page of structure.retainedSourcePageNumbers ?? [])
          if (!originalPages.has(page))
            originalPages.set(page, { code: 'unsupported-layout', phase: 'generation' })
        for (const unit of sourceUnits)
          if (unit.fragments.some((fragment) => originalPages.has(fragment.pageNumber)))
            preservedIds.add(unit.id)
        if (preservedIds.size || originalPages.size) {
          // Only current native-proved negative ownership may override a saved target.
          // The historical source, accepted translation and checkpoint stay unchanged.
          runSnapshot = {
            ...snapshot,
            units: snapshot.units.map((unit, index) =>
              preservedIds.has(sourceUnits[index].id)
                ? { ...unit, fragments: sourceUnits[index].fragments, translation: unit.source }
                : unit
            )
          }
          for (const [index, unit] of units.entries())
            units[index] = { ...unit, fragments: runSnapshot.units[index].fragments }
          generatedUnits = units.flatMap((unit, sourceIndex) =>
            acceptedById.has(unit.id)
              ? [{ unit, sourceIndex, snapshot: snapshot.units[sourceIndex] }]
              : []
          )
          cache = undefined
          incremental = undefined
        }
        if (useArtifact && (originalPages.size || preservedIds.size)) {
          validating = true
          location.pageNumber =
            originalPages.keys().next().value ??
            sourceUnits.find((unit) => preservedIds.has(unit.id))?.fragments[0]?.pageNumber
          throw verification.reject('Retained neighboring PDF glyph changed')
        }
      }
      let data = useArtifact ? artifact?.data : undefined
      if (!data) {
        const source = await original.getData()
        if (cancelled) return
        if (originalPages.size) {
          // Transplant only verified replacement pages into the original PDF.
          // Preserved page streams must not pass through PDFium serialization.
          const pageNumbers = Array.from(
            { length: original.numPages },
            (_, index) => index + 1
          ).filter((number) => !originalPages.has(number))
          incremental = pageNumbers.length ? { data: source, pageNumbers } : undefined
        }
        const generate = async (): Promise<Uint8Array | undefined> => {
          cacheToken = undefined
          cacheHit = false
          nativeFailures = {}
          for (const { unit } of generatedUnits)
            if (preservedIds.has(unit.id))
              nativeFailures[unit.id] = {
                ...([...originalPages].find(([page]) =>
                  unit.fragments.some((fragment) => fragment.pageNumber === page)
                )?.[1] ??
                  (retainedLinks.has(unit.id) || retainedPlacementOwners.has(unit.id)
                    ? { code: 'validation-failed', phase: 'verification' }
                    : { code: 'unsupported-layout', phase: 'generation' })),
                pageNumbers: [...new Set(unit.fragments.map((fragment) => fragment.pageNumber))],
                fragmentCount: unit.fragments.length
              }
          if (originalPages.size === original.numPages) return source.slice()
          const output = await api!.generatePdf({
            id,
            preserveUnsupported: true,
            preserveUnmatched: true,
            data: source,
            ...(incremental ? { incremental } : {}),
            ...(cache ? { cache } : {}),
            pages: runResults.source.pages,
            // The native indices refer to this accepted subset, not the full source.
            units: generatedUnits.map(({ unit, sourceIndex }) => {
              const renderUnit = runSnapshot.units[sourceIndex]
              if (!originalPages.size || !preservedIds.has(unit.id)) return renderUnit
              const fragments = renderUnit.fragments.filter(
                (fragment) => !originalPages.has(fragment.pageNumber)
              )
              if (!fragments.length || fragments.length === renderUnit.fragments.length)
                return renderUnit
              // Generation rebuilds healthy pages from the original PDF. Give the
              // writer their native no-op regions only; validation still checks the
              // complete owner on every page using the original snapshot.
              const source =
                fragments
                  .flatMap((fragment) => fragment.items.map((item) => item.text))
                  .join(' ')
                  .trim() || renderUnit.source
              return { source, fragments, translation: source }
            })
          })
          if (!output || output instanceof Uint8Array) return output ?? undefined
          cacheToken = cache ? output.cacheToken : undefined
          cacheHit = Boolean(cache && output.cacheHit)
          // A persisted PDF has not been validated in this reader; check every page.
          if (cacheHit) incremental = undefined
          for (const { unitIndex, ...failure } of output.layoutFailures) {
            const entry = generatedUnits[unitIndex]
            if (
              entry &&
              !retainedLinks.has(entry.unit.id) &&
              !retainedPlacementOwners.has(entry.unit.id) &&
              !entry.unit.fragments.some((fragment) => originalPages.has(fragment.pageNumber))
            )
              nativeFailures[entry.unit.id] = failure
          }
          return output.data
        }
        try {
          data = await generate()
        } catch (error) {
          // Unsupported page transplantation falls back once to the original full
          // generation/validation path. Capacity/timeouts remain explicit errors.
          const code = pdfGenerationFailure(error).code
          if (
            !incremental ||
            originalPages.size > 0 ||
            !['worker-failed', 'invalid-input'].includes(code) ||
            cancelled
          )
            throw error
          incremental = undefined
          data = await generate()
        }
      }
      if (cancelled) return
      if (!data?.byteLength) throw new Error('PDF generation was not admitted')
      validating = true
      publish({ status: 'loading', phase: 'validating' })
      // PDF.js transfers its input; the producer retains its bytes for retry/export.
      task = pdfjsLib.getDocument({ data: data.slice() })
      const translated = await task.promise
      if (cancelled) return
      const verified = await verification.validate({
        original,
        translated,
        data,
        runResults,
        units,
        renderUnits: runSnapshot.units,
        previousValidation:
          incremental && !originalPages.size && !preservedIds.size
            ? reusable?.validation
            : undefined,
        dirtyPages,
        originalPages,
        originalLinkOwners,
        preservedIds,
        acceptedById,
        useArtifact
      })
      if (!verified) return
      const { pages, originalUnitCount, retainedUnitIds, validation } = verified
      if (!cancelled) {
        recordLayout(
          generatedUnits.flatMap(({ unit, sourceIndex, snapshot }) => {
            if (
              incremental &&
              !preservedIds.has(unit.id) &&
              (!cacheToken || retainedUnitIds.includes(unit.id)) &&
              !unit.fragments.some((fragment) =>
                incremental?.pageNumbers.includes(fragment.pageNumber)
              )
            )
              return []
            const failure = retainedUnitIds.includes(unit.id)
              ? (nativeFailures[unit.id] ?? {
                  code: 'unsupported-layout' as const,
                  phase: 'verification' as const,
                  pageNumbers: [...new Set(unit.fragments.map((fragment) => fragment.pageNumber))],
                  fragmentCount: unit.fragments.length
                })
              : undefined
            return [
              {
                sourceIndex,
                source: snapshot.source,
                translation: snapshot.translation,
                ...(failure ? { failure } : {})
              }
            ]
          }),
          cacheToken
        )
        if (cancelled) return
        const baseline = request.baseline
        const sameSource =
          baseline?.original === original &&
          live.current?.release === baseline.release &&
          baseline.artifact === artifact &&
          baseline.results.source === runResults.source
        const sameSnapshot =
          sameSource &&
          baseline.results.units.length === runResults.units.length &&
          isPdfTranslationResultExtension(baseline.results, runResults)
        const unchangedLayoutUnitIds = sameSource
          ? retainedUnitIds.filter((id) => {
              const before = baseline.results.units.find((unit) => unit.id === id)
              const after = acceptedById.get(id)
              const rebuiltPages = incremental?.pageNumbers
              const rebuilt =
                !rebuiltPages ||
                units
                  .find((unit) => unit.id === id)
                  ?.fragments.some((fragment) => rebuiltPages.includes(fragment.pageNumber))
              return (
                baseline.value.retainedUnitIds.includes(id) &&
                (baseline.value.unchangedLayoutUnitIds?.includes(id) ||
                  (rebuilt && (!request.retryUnitId || request.retryUnitId === id))) &&
                before?.translation === after?.translation &&
                before?.translationSource === after?.translationSource
              )
            })
          : []
        // An identical rebuild must not replace the reader's verified document
        // or reset its scroll and selection.
        if (
          sameSnapshot &&
          unchangedLayoutUnitIds.length > 0 &&
          unchangedLayoutUnitIds.length === retainedUnitIds.length &&
          retainedUnitIds.length === baseline.value.retainedUnitIds.length
        ) {
          const previousData = await baseline.value.document.getData()
          if (cancelled) return
          if (
            data.length === previousData.length &&
            data.every((byte, index) => byte === previousData[index])
          ) {
            release()
            const value = { ...baseline.value, unchangedLayoutUnitIds }
            const next = { ...baseline, value }
            live.current = next
            setDisplayed(next)
            publish(value)
            return
          }
        }
        beforeReady?.()
        live.current?.release()
        const value: Extract<State, { status: 'ready' }> = {
          status: 'ready',
          document: translated,
          pages,
          originalUnitCount,
          retainedUnitIds,
          unchangedLayoutUnitIds
        }
        const next = {
          original,
          artifact,
          results: runResults,
          value,
          release,
          data,
          validation
        }
        live.current = next
        setDisplayed(next)
        publish(value)
      }
    })()
    void generation.finally(verification.dispose).catch((error) => {
      if (!cancelled) {
        release()
        const recovery = decidePdfTranslationRecovery({
          cause: error,
          verification: validating ? location : undefined,
          cacheHit,
          bypassCache: Boolean(bypassCache),
          useArtifact,
          pageCount: original.numPages,
          originalPages,
          canKeepUnit: (unitId) => !preservedIds.has(unitId) && acceptedById.has(unitId),
          hasOtherTranslationOnPage: (unitId, pageNumber) =>
            units.some(
              (unit, index) =>
                unit.id !== unitId &&
                unit.source !== runSnapshot.units[index].translation &&
                unit.fragments.some((fragment) => fragment.pageNumber === pageNumber)
            )
        })
        if (recovery.action === 'bypass-cache') {
          setRequest({ ...request, bypassCache: { original, results: runResults } })
          return
        }
        if (validating && location.details)
          console.warn('[pdf-translation] Candidate verification rejected', {
            reason: location.details,
            pageNumber: location.pageNumber,
            unitId: location.unitId
          })
        const recoveryRequest = { ...request, bypassCache: { original, results: runResults } }
        if (recovery.action === 'keep-links') {
          setRequest({
            ...recoveryRequest,
            originalLinkOwners: {
              original,
              results: runResults,
              byPage: new Map(originalLinkOwners).set(recovery.pageNumber, recovery.links)
            }
          })
          return
        }
        if (recovery.action === 'keep-unit') {
          setRequest({
            ...recoveryRequest,
            originalPlacementOwners: {
              original,
              results: runResults,
              ids: new Set(retainedPlacementOwners).add(recovery.unitId)
            }
          })
          return
        }
        if (recovery.action === 'keep-page') {
          setRequest({
            ...recoveryRequest,
            originalPages: {
              original,
              source: runResults.source,
              reasons: new Map(originalPages).set(recovery.pageNumber, recovery.reason)
            }
          })
          return
        }
        const previous = request.failed
        const details = error instanceof Error ? error.message : undefined
        const retryUnchanged =
          validating &&
          previous?.original === original &&
          previous.results === runResults &&
          previous.value.failure.code === 'validation-failed' &&
          previous.value.failure.pageNumber === location.pageNumber &&
          previous.value.unitId === location.unitId &&
          previous.value.details === details
        const { failure } = recovery
        if (
          [
            'source-mismatch',
            'annotations',
            'overflow',
            'multi-region',
            'font',
            'unsupported-layout',
            'validation-failed'
          ].includes(failure.code)
        ) {
          recordLayout(
            generatedUnits.flatMap(({ unit, sourceIndex, snapshot }) => {
              const affected = location.unitId
                ? unit.id === location.unitId
                : failure.pageNumber !== undefined &&
                  unit.fragments.some((fragment) => fragment.pageNumber === failure.pageNumber)
              if (!affected) return []
              return [
                {
                  sourceIndex,
                  source: snapshot.source,
                  translation: snapshot.translation,
                  failure: {
                    code: failure.code as PdfTranslationLayoutFailure['code'],
                    phase: validating ? ('verification' as const) : ('generation' as const),
                    pageNumbers: failure.pageNumber
                      ? [failure.pageNumber]
                      : [...new Set(unit.fragments.map((fragment) => fragment.pageNumber))],
                    fragmentCount: unit.fragments.length
                  }
                }
              ]
            })
          )
        }
        publish({
          status: 'error',
          retryUnchanged,
          failure,
          details,
          unitId: validating ? location.unitId : undefined
        })
      }
    })
    return () => {
      cancelled = true
      nativeVerification.abort()
      setStored(undefined)
      if (!useArtifact) void api?.cancelPdf(id).catch(() => undefined)
      // Keep the verified display alive while its explicit replacement loads.
      // Source replacement and unmount release it through the display owner.
      if (live.current?.release !== release) release()
    }
  }, [
    admitted,
    original,
    artifact,
    beforeReady,
    request,
    useArtifact,
    selected,
    snapshot,
    structureContext,
    resourceRequestKey
  ])
  // Batch at page boundaries, never cancel a running generation for incoming paragraphs.
  // A failed early snapshot may be superseded once translation stops. Only
  // different ready-page content can retry automatically; unchanged errors stay explicit.
  const latestSnapshot = useMemo(
    () => (results ? partialPdfSnapshot(results) : undefined),
    [results]
  )
  useEffect(() => {
    const recoverNewResults =
      state.status === 'error' &&
      !translating &&
      ['timeout', 'worker-failed'].includes(state.failure.code)
    if (
      !admitted ||
      artifact ||
      !results ||
      !selected ||
      !snapshot ||
      !latestSnapshot ||
      (!(state.status === 'ready' && canDisplay) && !recoverNewResults)
    )
      return
    const readyPages = new Set(latestSnapshot.readyPages)
    const before = new Map(selected.units.map((unit) => [unit.id, unit.translation]))
    const after = new Map(results.units.map((unit) => [unit.id, unit.translation]))
    const pageChanged =
      latestSnapshot.readyPages.some((page) => !snapshot.readyPages.includes(page)) ||
      results.source.units.some(
        (unit) =>
          unit.fragments.some((fragment) => readyPages.has(fragment.pageNumber)) &&
          before.get(unit.id) !== after.get(unit.id)
      )
    if (!pageChanged) return
    const timer = window.setTimeout(() => {
      setSelection({ original, artifact, results, ready: true })
      setRequest({ baseline: displayed })
    }, 200)
    return () => window.clearTimeout(timer)
  }, [
    admitted,
    artifact,
    original,
    results,
    selected,
    snapshot,
    latestSnapshot,
    state,
    translating,
    canDisplay,
    displayed
  ])

  const retry = useCallback(() => {
    if (state.status !== 'error' || state.retryUnchanged) return
    setStored(undefined)
    if (admitted && results) setSelection({ original, artifact, results, ready: true })
    setRequest({
      rebuildArtifact: artifact,
      baseline: displayed,
      ...(admitted && results ? { bypassCache: { original, results } } : {}),
      ...(admitted && results && state.status === 'error'
        ? { failed: { original, results, value: state } }
        : {})
    })
  }, [state, admitted, original, artifact, results, displayed])
  const refresh = useCallback(
    (unitId?: string) => {
      if (!admitted || !results || state.status === 'loading') return
      setSelection({ original, artifact, results, ready: true })
      setRequest({
        rebuildArtifact: artifact,
        retryUnitId: unitId,
        baseline: displayed,
        bypassCache: { original, results }
      })
    },
    [admitted, original, artifact, results, state.status, displayed]
  )
  const unfilledUnitIds = useMemo(() => {
    if (!admitted || !results) return []
    const rendered = new Map(
      canDisplay ? displayed?.results.units.map((unit) => [unit.id, unit]) : []
    )
    const retained = new Set(canDisplay ? displayed?.value.retainedUnitIds : [])
    return results.units.flatMap((unit) => {
      const previous = rendered.get(unit.id)
      return retained.has(unit.id) ||
        previous?.translation !== unit.translation ||
        previous?.translationSource !== unit.translationSource
        ? [unit.id]
        : []
    })
  }, [admitted, results, canDisplay, displayed])
  const layoutFailures = useMemo(() => {
    if (!admitted || !results) return {}
    const failures = { ...results.layoutFailures }
    if (layoutReports?.original === original && layoutReports.source === results.source) {
      for (const unit of results.units) {
        const report = layoutReports.units[unit.id]
        if (report?.source !== unit.translationSource || report.translation !== unit.translation)
          continue
        if (report.failure) failures[unit.id] = report.failure
        else delete failures[unit.id]
      }
    }
    return failures
  }, [admitted, results, original, layoutReports])
  return layout === 'reflow'
    ? reflow
    : {
        state,
        unfilledUnitIds,
        layoutFailures,
        ready: canDisplay ? displayed?.value : undefined,
        unchangedLayoutUnitIds:
          canDisplay && displayed
            ? (displayed.value.unchangedLayoutUnitIds ?? []).filter((id) => {
                const before = displayed.results.units.find((unit) => unit.id === id)
                const after = results?.units.find((unit) => unit.id === id)
                return (
                  before?.translation === after?.translation &&
                  before?.translationSource === after?.translationSource
                )
              })
            : [],
        updateAvailable: Boolean(
          admitted &&
          selected &&
          (results.units.length !== selected.units.length ||
            !isPdfTranslationResultExtension(selected, results))
        ),
        isCurrent: Boolean(
          canDisplay &&
          displayed &&
          results &&
          displayed.results.units.length === results.units.length &&
          isPdfTranslationResultExtension(displayed.results, results)
        ),
        refresh,
        retry,
        registerDisposer
      }
}
