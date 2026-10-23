import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLiteratureHost } from '../renderer-host'
import { useLiteratureClient } from '../literature-read-pages'
import {
  readScreeningExport,
  screeningResultsCsv,
  screeningResultsFilename,
  ScreeningExportChanged
} from './screening-results-csv'

export function useLiteratureScreeningExport(collectionId: string): {
  exportResults(): Promise<boolean>
  exporting: boolean
  error: string | undefined
} {
  const host = useLiteratureHost()
  const client = useLiteratureClient()
  const { t } = useTranslation()
  const context = useMemo(() => ({ collectionId, host }), [collectionId, host])
  const current = useRef<typeof context | undefined>(context)
  const pending = useRef<{ cancel(): void } | undefined>(undefined)
  const [status, setStatus] = useState<{
    context: typeof context
    error?: string
    pending?: boolean
  }>()
  useLayoutEffect(() => {
    current.current = context
    return () => {
      current.current = undefined
      pending.current?.cancel()
      pending.current = undefined
    }
  }, [context])

  const exportResults = async (): Promise<boolean> => {
    if (current.current !== context || pending.current) return false
    let changed = false
    const cleanup: (() => void)[] = []
    const task = {
      cancel: (): void => {
        changed = true
        cleanup.splice(0).forEach((remove) => remove())
      }
    }
    pending.current = task
    setStatus({ context, pending: true })
    const invalidate = (): void => {
      changed = true
    }
    const check = (): void => {
      if (changed || current.current !== context) throw new ScreeningExportChanged()
    }
    try {
      // Listen directly: the UI invalidation helper deliberately batches collection events.
      cleanup.push(host.api.literature.onChanged(invalidate))
      cleanup.push(host.onRecovered(invalidate))
      const removeProjectDeleted = host.api.projects?.onDeleted?.(invalidate)
      if (removeProjectDeleted) cleanup.push(removeProjectDeleted)
      const removeProjectCleanup = host.api.projects?.onDeletionCleanupChanged?.(invalidate)
      if (removeProjectCleanup) cleanup.push(removeProjectCleanup)
      window.addEventListener('focus', invalidate)
      window.addEventListener('open-science:web-events-open', invalidate)
      cleanup.push(() => {
        window.removeEventListener('focus', invalidate)
        window.removeEventListener('open-science:web-events-open', invalidate)
      })
      const snapshot = await readScreeningExport(collectionId, {
        search: (request) => host.api.literature.search(request),
        readItems: (request) =>
          client.readLiteratureSelectionPage(
            request,
            () => !changed && current.current === context
          ),
        readSmart: async (offset, summaryOnly) =>
          (
            await host.api.literature.transact({
              kind: 'smart-collection',
              collectionId,
              action: 'read',
              filter: 'all',
              offset,
              summaryOnly
            })
          ).smart,
        check
      })
      const data = new TextEncoder().encode(screeningResultsCsv(snapshot))
      check()
      // The snapshot boundary is this handoff. Later edits (including while the save dialog is
      // open) do not alter these bytes, and cannot make the already assembled CSV partial.
      const result = await host.api.saveBlobFile({
        suggestedName: screeningResultsFilename(snapshot.collection.name),
        mimeType: 'text/csv;charset=utf-8',
        data: data.buffer
      })
      return result.saved
    } catch (failure) {
      if (current.current === context)
        setStatus({
          context,
          error:
            failure instanceof ScreeningExportChanged
              ? t('Screening data changed during export. Please try again.')
              : t('Screening results could not be exported.')
        })
      return false
    } finally {
      task.cancel()
      if (pending.current === task) pending.current = undefined
      if (current.current === context) setStatus((value) => ({ ...value, context, pending: false }))
    }
  }
  return {
    exportResults,
    exporting: status?.context === context && Boolean(status.pending),
    error: status?.context === context ? status.error : undefined
  }
}
