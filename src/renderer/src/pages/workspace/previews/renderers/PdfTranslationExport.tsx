import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { Download, Info } from 'lucide-react'
import { usePdfTranslationExportRegistration } from '../../pdf-annotations/pdf-export-context'

// Mounted only for an independently verified complete PDF; never exports the text fallback.
export function PdfTranslationExport({
  document,
  path,
  versionId,
  name,
  hasRetainedOriginalText,
  showExportButton = true
}: {
  document: PDFDocumentProxy
  path?: string
  versionId?: string
  name: string
  hasRetainedOriginalText?: boolean
  showExportButton?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const register = usePdfTranslationExportRegistration()
  const active = useRef<AbortController | undefined>(undefined)
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  useEffect(
    () => () => {
      active.current?.abort()
      active.current = undefined
    },
    [document]
  )
  const cancel = useCallback((): void => {
    active.current?.abort()
    active.current = undefined
    setState('idle')
  }, [])
  const save = useCallback(async (): Promise<void> => {
    if (active.current) return
    const controller = new AbortController()
    active.current = controller
    setState('saving')
    try {
      const bytes = await document.getData()
      controller.signal.throwIfAborted()
      if (!bytes.length || bytes.length > 64 * 1024 * 1024)
        throw new Error('Invalid PDF export size')
      const result = await window.api.saveBlobFile({
        data: bytes.slice().buffer as ArrayBuffer,
        mimeType: 'application/pdf',
        suggestedName: `${name.replace(/\.pdf$/iu, '')}-translated.pdf`
      })
      if (!controller.signal.aborted) setState(result.saved ? 'saved' : 'idle')
    } catch {
      if (!controller.signal.aborted) setState('error')
    } finally {
      if (active.current === controller) active.current = undefined
    }
  }, [document, name])
  const action = useMemo(
    () => ({
      path: path ?? '',
      versionId,
      busy: state === 'saving',
      saving: state === 'saving',
      disabled: !path,
      unavailableReason: !path ? t('File unavailable') : undefined,
      label: t('Export translated PDF'),
      execute: save,
      cancel
    }),
    [cancel, path, save, state, t, versionId]
  )
  useEffect(() => {
    if (!register || !path) return
    register(action)
    return () => register((current) => (current === action ? undefined : current))
  }, [action, path, register])
  if (!showExportButton && state !== 'saved' && state !== 'error') return null
  return (
    <div className="shrink-0 space-y-1 px-5 py-2 text-xs">
      {showExportButton ? (
        <>
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            disabled={state === 'saving'}
            onClick={() => void save()}
          >
            <Download className="size-4" aria-hidden="true" />
            {state === 'saving' ? t('Saving translated PDF…') : t('Export translated PDF')}
          </Button>
          <div className="flex gap-2 rounded-md bg-muted/30 px-2 py-2 leading-5 text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <div className="space-y-1">
              <p>
                {hasRetainedOriginalText
                  ? t(
                      'Some passages retain the original text. View their translations in the sidebar.'
                    )
                  : t('Untranslated content remains in its original language in the exported PDF.')}
              </p>
              <p>
                {t(
                  'Annotations stay in the original PDF. Links are retained in the translated PDF.'
                )}
              </p>
            </div>
          </div>
        </>
      ) : null}
      {state === 'saved' ? <p role="status">{t('Translated PDF saved.')}</p> : null}
      {state === 'error' ? (
        <ErrorNotice
          inline
          role="alert"
          title={t('Could not export translated PDF')}
          description={t('Try saving the PDF again.')}
        />
      ) : null}
    </div>
  )
}
