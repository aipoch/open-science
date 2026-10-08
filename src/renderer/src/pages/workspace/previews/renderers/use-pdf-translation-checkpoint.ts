import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  pdfTranslationCheckpointSchema,
  pdfTranslationCheckpointMatchesSource,
  pdfTranslationSourceKey,
  type PdfTranslationCheckpointRequest,
  type PdfTranslationCheckpoint,
  type PdfTranslationEdition
} from '../../../../../../shared/pdf-translation'

export function usePdfTranslationCheckpoint(
  source: PdfTranslationCheckpointRequest | undefined,
  enabled: boolean
): {
  checkpoint?: PdfTranslationCheckpoint | null
  editions: readonly PdfTranslationEdition[]
  loading: boolean
  selecting: boolean
  error: boolean
  editionError: boolean
  retry: () => void
  refreshEditions: () => void
  selectEdition: (id: string) => Promise<boolean>
  deleteEdition: (id: string) => Promise<boolean>
} {
  const [stored, setStored] = useState<{
    key: string
    checkpoint?: PdfTranslationCheckpoint | null
    error: boolean
  }>()
  const [listing, setListing] = useState<{
    key: string
    editions: readonly PdfTranslationEdition[]
    error: boolean
  }>()
  const [selection, setSelection] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const key = source === undefined ? undefined : pdfTranslationSourceKey(source)
  const requests = useRef({ list: 0, select: 0 })
  const context = useRef<string | undefined>(undefined)
  const [scope, setScope] = useState(enabled ? key : undefined)
  if (scope !== (enabled ? key : undefined)) {
    setScope(enabled ? key : undefined)
    if (selection !== undefined) setSelection(undefined)
  }
  useLayoutEffect(() => {
    const pending = requests.current
    context.current = enabled ? key : undefined
    return () => {
      context.current = undefined
      ++pending.list
      ++pending.select
    }
  }, [enabled, key])
  const value = stored?.key === key ? stored : undefined
  const editions = useMemo(
    () => (listing && listing.key === key ? listing.editions : []),
    [listing, key]
  )
  const api = window.api?.pdfTranslation
  const refreshEditions = useCallback(() => {
    if (!enabled || !source || !key || !api?.listEditions) return
    const request = ++requests.current.list
    void api.listEditions(source).then(
      (editions) => {
        if (context.current === key && requests.current.list === request)
          setListing({ key, editions, error: false })
      },
      () => {
        if (context.current === key && requests.current.list === request)
          setListing((previous) => ({
            key,
            editions: previous?.key === key ? previous.editions : [],
            error: true
          }))
      }
    )
  }, [api, enabled, key, source])
  useEffect(refreshEditions, [refreshEditions, attempt])
  useEffect(() => {
    if (!enabled || !source || !key || !api?.readCheckpoint || value) return
    let cancelled = false
    const request = requests.current.select
    void api
      .readCheckpoint(source)
      .then((input) => {
        const checkpoint = input === null ? null : pdfTranslationCheckpointSchema.parse(input)
        if (checkpoint && !pdfTranslationCheckpointMatchesSource(checkpoint, source))
          throw new Error('Source changed')
        if (!cancelled && requests.current.select === request)
          setStored({ key, checkpoint, error: false })
      })
      .catch(() => {
        if (!cancelled && requests.current.select === request) setStored({ key, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [api, source, key, enabled, value, attempt])
  const selectEdition = useCallback(
    async (id: string): Promise<boolean> => {
      if (!enabled || !source || !key || !api?.selectEdition) return false
      const request = ++requests.current.select
      ++requests.current.list
      setSelection(key)
      try {
        const checkpoint = pdfTranslationCheckpointSchema.parse(
          await api.selectEdition({ source, translationId: id })
        )
        if (!pdfTranslationCheckpointMatchesSource(checkpoint, source))
          throw new Error('Source changed')
        if (context.current !== key || requests.current.select !== request) return false
        setStored({ key, checkpoint, error: false })
        setListing((previous) => (previous?.key === key ? { ...previous, error: false } : previous))
        return true
      } catch {
        if (context.current === key && requests.current.select === request)
          setListing((previous) => ({
            key,
            editions: previous?.key === key ? previous.editions : [],
            error: true
          }))
        return false
      } finally {
        if (context.current === key && requests.current.select === request) setSelection(undefined)
      }
    },
    [api, enabled, key, source]
  )
  const deleteEdition = useCallback(
    async (id: string): Promise<boolean> => {
      if (!enabled || !source || !key || !api?.deleteEdition || selection === key) return false
      const request = ++requests.current.select
      ++requests.current.list
      setSelection(key)
      try {
        await api.deleteEdition({ source, translationId: id })
        if (context.current !== key || requests.current.select !== request) return false
        setListing({ key, editions: editions.filter((edition) => edition.id !== id), error: false })
        // Deletion has committed. A failed fallback read must not report that deletion failed.
        try {
          const checkpoint = await api.readCheckpoint(source)
          const restored =
            checkpoint === null ? null : pdfTranslationCheckpointSchema.parse(checkpoint)
          if (restored && !pdfTranslationCheckpointMatchesSource(restored, source))
            throw new Error('Source changed')
          if (context.current !== key || requests.current.select !== request) return false
          setStored({ key, checkpoint: restored, error: false })
        } catch {
          if (context.current !== key || requests.current.select !== request) return false
          setStored({ key, error: true })
        }
        refreshEditions()
        return true
      } catch {
        return false
      } finally {
        if (context.current === key && requests.current.select === request) setSelection(undefined)
      }
    },
    [api, enabled, key, source, selection, editions, refreshEditions]
  )
  return {
    checkpoint: value?.checkpoint,
    editions,
    loading: Boolean(enabled && source && api?.readCheckpoint && !value),
    selecting: selection !== undefined && selection === key,
    error: value?.error ?? false,
    editionError: Boolean(listing && listing.key === key && listing.error),
    refreshEditions,
    selectEdition,
    deleteEdition,
    retry: useCallback(() => {
      setStored(undefined)
      setAttempt((current) => current + 1)
    }, [])
  }
}
