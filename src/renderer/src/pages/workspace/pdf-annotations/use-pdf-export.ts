import { tagPresentation } from '../../settings/tag-presentation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import {
  type PdfAnnotationSource,
  type PdfAnnotationListResult
} from '../../../../../shared/pdf-annotations'
import { usePdfAnnotations } from './pdf-annotations-context'
import { usePdfExportRegistration } from './pdf-export-context'
import { PDF_EXPORT_MAX_BYTES, PDF_EXPORT_MAX_MARKS } from './pdf-export-contract'
import { preparePdfExportMarks } from './pdf-export-prepare'
import { runPdfExportWorker, waitForPdfExport } from './pdf-export-client'

// A single renderer may show multiple preview surfaces; cap heavy exports across those surfaces.
let activeExport: AbortController | undefined
export const usePdfExport = ({
  document,
  source,
  path,
  name,
  versionId,
  size
}: {
  document: PDFDocumentProxy | null
  source?: PdfAnnotationSource
  path: string
  name: string
  versionId?: string
  size?: number
}): { message?: string; busy: boolean; saving?: boolean; cancel: () => void } => {
  const { t } = useTranslation()
  const port = usePdfAnnotations()
  const register = usePdfExportRegistration()
  const annotations = port.forSource(source)
  const [state, setState] = useState<{ busy: boolean; saving?: boolean; message?: string }>({
    busy: false
  })
  const current = useRef<AbortController | undefined>(undefined)
  const cancel = useCallback((): void => {
    const controller = current.current
    current.current = undefined
    controller?.abort()
    if (activeExport === controller) activeExport = undefined
    setState({ busy: false })
  }, [])
  const [owner, setOwner] = useState({ document, source })
  if (owner.document !== document || owner.source !== source) {
    setOwner({ document, source })
    setState({ busy: false })
  }
  useEffect(() => {
    return () => {
      const controller = current.current
      current.current = undefined
      controller?.abort()
      if (activeExport === controller) activeExport = undefined
    }
  }, [document, source, cancel])
  const unavailable =
    !source ||
    !document ||
    port.loading ||
    Boolean(port.loadError) ||
    (source ? port.history(source).busy : false)
  const execute = useCallback(async (): Promise<void> => {
    if (unavailable || !document || !source || current.current) return
    if (activeExport) {
      setState({ busy: false, message: t('Another PDF export is in progress.') })
      return
    }
    const controller = new AbortController()
    const { signal } = controller
    current.current = controller
    activeExport = controller
    setState({ busy: true })
    // This timer covers range reads and preparation too, not only the writer.
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 120_000)
    try {
      if (!size || size > PDF_EXPORT_MAX_BYTES || annotations.length > PDF_EXPORT_MAX_MARKS)
        throw new Error('too-large')
      // Read a fresh, complete document snapshot, including the import receipt after the last
      // visible annotation was deleted. Empty notebooks can still change the exported PDF.
      const scope =
        source.kind === 'literature-attachment-version'
          ? { literatureVersionId: source.versionId }
          : { projectId: source.projectId, sessionId: port.sessionId }
      let page = await waitForPdfExport(
        window.api.pdfAnnotations.list({
          ...scope,
          sourceFileId: source.sourceFileId,
          versionId: source.versionId,
          limit: 100
        }),
        signal
      )
      const nativeRefs = page.nativeImport?.nativeRefs
      const exportAnnotations = [...page.items]
      while (page.nextCursor) {
        page = (await waitForPdfExport(
          window.api.pdfAnnotations.list({
            ...scope,
            sourceFileId: source.sourceFileId,
            versionId: source.versionId,
            limit: 100,
            cursor: page.nextCursor
          }),
          signal
        )) as PdfAnnotationListResult
        exportAnnotations.push(...page.items)
        if (exportAnnotations.length > PDF_EXPORT_MAX_MARKS) throw new Error('too-large')
      }
      const tags = exportAnnotations.some((item) => item.tagIds.length)
        ? (await waitForPdfExport(window.api.tags.snapshot(), signal)).tags
        : []
      signal.throwIfAborted()
      const tagNames = new Map(tags.map((tag) => [tag.id, tagPresentation(tag, t).name]))
      const marks = await waitForPdfExport(
        preparePdfExportMarks(document, exportAnnotations, signal, (annotation) => {
          const names = annotation.tagIds.map((id) => tagNames.get(id)).filter(Boolean)
          return [
            annotation.kind === 'document-note'
              ? t('Document note')
              : annotation.kind === 'page-note'
                ? t('Page note')
                : '',
            annotation.note,
            names.length ? t('Tags: {{tags}}', { tags: names.join(', ') }) : ''
          ]
            .filter(Boolean)
            .join('\n\n')
        }),
        signal
      )
      const bytes = await waitForPdfExport(document.getData(), signal)
      signal.throwIfAborted()
      const data = await runPdfExportWorker(
        { data: bytes.buffer as ArrayBuffer, checksum: source.checksum, marks, nativeRefs },
        signal
      )
      signal.throwIfAborted()
      clearTimeout(timer)
      setState({ busy: true, saving: true })
      const result = await window.api.saveBlobFile({
        data,
        mimeType: 'application/pdf',
        suggestedName: `${name.replace(/\.pdf$/iu, '')}-annotated.pdf`
      })
      if (!signal.aborted)
        setState({ busy: false, message: result.saved ? t('Annotated PDF saved.') : undefined })
    } catch (error) {
      if (
        signal.aborted &&
        !(signal.reason instanceof Error && signal.reason.message === 'timeout')
      )
        return
      const reason = error instanceof Error ? error.message : ''
      const message =
        reason === 'too-large'
          ? t('Annotated PDF export supports files up to 128 MB and 20,000 annotations.')
          : reason === 'source-changed'
            ? t('The PDF no longer matches these annotations. Reopen the file and try again.')
            : reason === 'encrypted' || reason === 'signed'
              ? t('Encrypted or digitally signed PDFs cannot be exported with annotations.')
              : t('Could not export the annotated PDF. Try again.')
      if (current.current === controller) setState({ busy: false, message })
    } finally {
      clearTimeout(timer)
      if (current.current === controller) {
        current.current = undefined
        setState((value) => ({ ...value, busy: false }))
      }
      if (activeExport === controller) activeExport = undefined
    }
  }, [unavailable, document, source, size, annotations, name, t, port])
  const action = useMemo(
    () => ({
      path,
      versionId,
      busy: state.busy,
      saving: Boolean(state.saving),
      disabled: unavailable,
      unavailableReason: port.loading
        ? t('Loading annotations…')
        : port.loadError
          ? t('PDF annotations could not be loaded.')
          : undefined,
      label: t('Download PDF with annotations'),
      execute,
      cancel
    }),
    [
      path,
      versionId,
      state.busy,
      state.saving,
      unavailable,
      port.loading,
      port.loadError,
      t,
      execute,
      cancel
    ]
  )
  useEffect(() => {
    if (!source) return
    register?.(action)
    return () => register?.((previous) => (previous === action ? undefined : previous))
  }, [register, action, source])
  return { ...state, cancel }
}
