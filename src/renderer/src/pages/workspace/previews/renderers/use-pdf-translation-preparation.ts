import type { PdfTranslationCheckpoint } from '../../../../../../shared/pdf-translation'
import {
  getPdfTranslationLayoutSnapshot,
  rememberPdfTranslationExtraction,
  restorePdfTranslationExtraction
} from './pdf-translation-snapshot'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  extractPdfTranslationSource,
  type PdfTranslationExtraction
} from './pdf-translation-extraction'

import {
  applyCachedPdfTableSources,
  type PdfTranslationSourceIdentity
} from './pdf-translation-table-source'

export type PdfPreparationState =
  | { status: 'idle' | 'cancelled' | 'error' }
  | { status: 'running'; pagesRead: number }
  | { status: 'ready'; extraction: PdfTranslationExtraction }
const idle: PdfPreparationState = { status: 'idle' }
type Document = Pick<PDFDocumentProxy, 'numPages' | 'fingerprints' | 'getPage'>

// Mount with the reader so closing navigation does not discard the preparation.
export function usePdfTranslationPreparation(
  document: Document | null,
  resourceRequestKey: string,
  attachmentVersionId?: string,
  sourceIdentity?: PdfTranslationSourceIdentity,
  checkpoint?: PdfTranslationCheckpoint | null
): {
  state: PdfPreparationState
  start: () => void
  cancel: () => void
} {
  const run = useRef<AbortController | undefined>(undefined)
  const [stored, setStored] = useState<{
    document: Document
    key: string
    checkpointKey?: string
    attachmentVersionId?: string
    sourceIdentity?: PdfTranslationSourceIdentity
    value: PdfPreparationState
  }>()
  if (
    stored &&
    (stored.document !== document ||
      stored.key !== resourceRequestKey ||
      stored.attachmentVersionId !== attachmentVersionId ||
      stored.sourceIdentity !== sourceIdentity ||
      (checkpoint && stored.checkpointKey !== checkpoint.key))
  )
    setStored(undefined)
  const restored = useMemo<PdfPreparationState | undefined>(() => {
    const snapshot = checkpoint?.layoutSnapshot
    if (!snapshot || !document) return undefined
    if (
      snapshot.fingerprint !== document.fingerprints[0] ||
      snapshot.pages.length !== document.numPages
    )
      return { status: 'error' }
    return {
      status: 'ready',
      extraction: restorePdfTranslationExtraction(snapshot, resourceRequestKey)
    }
  }, [checkpoint, document, resourceRequestKey])
  const state =
    restored ??
    (stored?.document === document &&
    stored.key === resourceRequestKey &&
    stored.attachmentVersionId === attachmentVersionId &&
    stored.sourceIdentity === sourceIdentity &&
    (!checkpoint || stored.checkpointKey === checkpoint.key)
      ? stored.value
      : idle)
  useLayoutEffect(
    () => () => {
      run.current?.abort()
      run.current = undefined
    },
    [document, resourceRequestKey, attachmentVersionId, sourceIdentity]
  )
  const start = useCallback((): void => {
    if (!document || restored || (run.current && !run.current.signal.aborted)) return
    const controller = new AbortController()
    run.current = controller
    const publish = (value: PdfPreparationState): void => {
      if (!controller.signal.aborted && run.current === controller)
        setStored({
          document,
          key: resourceRequestKey,
          checkpointKey: checkpoint?.key,
          attachmentVersionId,
          sourceIdentity,
          value
        })
    }
    publish({ status: 'running', pagesRead: 0 })
    void extractPdfTranslationSource({
      document,
      resourceRequestKey,
      signal: controller.signal,
      onProgress: (pagesRead) => publish({ status: 'running', pagesRead })
    })
      .then(async (extraction) => {
        const prepared =
          attachmentVersionId && sourceIdentity && window.api.pdfStructure?.readCached
            ? await applyCachedPdfTableSources({
                extraction,
                document,
                attachmentVersionId,
                sourceIdentity,
                signal: controller.signal,
                readCached: (request) => window.api.pdfStructure.readCached(request)
              })
            : extraction
        controller.signal.throwIfAborted()
        rememberPdfTranslationExtraction(prepared)
        if (checkpoint && !checkpoint.layoutSnapshot && window.api.pdfTranslation?.saveSnapshot) {
          try {
            await window.api.pdfTranslation.saveSnapshot({
              source: checkpoint.documentSource ?? checkpoint.attachmentVersionId!,
              checkpointKey: checkpoint.key,
              snapshot: getPdfTranslationLayoutSnapshot(prepared.source)!
            })
          } catch (error) {
            // Keep readable legacy results; a failed adoption must never discard them.
            if (!controller.signal.aborted)
              console.warn('PDF translation layout snapshot could not be saved', error)
          }
        }
        publish({ status: 'ready', extraction: prepared })
      })
      .catch(() => publish({ status: 'error' }))
      .finally(() => {
        if (run.current === controller) run.current = undefined
      })
  }, [attachmentVersionId, document, resourceRequestKey, sourceIdentity, checkpoint, restored])
  const cancel = useCallback((): void => {
    if (!document || !run.current) return
    run.current.abort()
    run.current = undefined
    setStored({
      document,
      key: resourceRequestKey,
      checkpointKey: checkpoint?.key,
      attachmentVersionId,
      sourceIdentity,
      value: { status: 'cancelled' }
    })
  }, [attachmentVersionId, document, resourceRequestKey, sourceIdentity, checkpoint?.key])
  return { state, start, cancel }
}
