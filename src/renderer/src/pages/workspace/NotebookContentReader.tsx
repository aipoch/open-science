import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import type {
  NotebookContentChunk,
  NotebookContentCursor,
  NotebookRunRecord,
  NotebookSessionStateRequest,
  NotebookSessionState
} from '../../../../shared/notebook'

// One active reader per renderer. Selecting another run unmounts and releases the previous output;
// there is no full-Run cache. Text retains one 64K-character page, images at most 8 MiB of base64.
const MAX_IMAGE_CHARACTERS = 8 * 1024 * 1024
let selected: string | undefined
const listeners = new Set<() => void>()
const select = (key?: string): void => {
  selected = key
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Preload exposes promises rather than abortable reads. Keep one outstanding detail RPC even if a
// closed reader's request has not settled; a new reader gets a local retry instead of building a queue.
let pendingRead: Promise<NotebookSessionState> | undefined
const readContentState = async (
  request: NotebookSessionStateRequest
): Promise<NotebookSessionState> => {
  if (pendingRead) throw new Error('A Notebook content read is still finishing')
  const pending = window.api.notebook.state(request)
  pendingRead = pending
  try {
    return await pending
  } finally {
    if (pendingRead === pending) pendingRead = undefined
  }
}

const ContentWindow = ({
  run,
  initialPart
}: {
  run: NotebookRunRecord
  initialPart: number
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [cursor, setCursor] = useState<NotebookContentCursor>({ part: initialPart, offset: 0 })
  const [chunk, setChunk] = useState<NotebookContentChunk>()
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const reference = run.contentRead!
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let image = ''
    const load = async (): Promise<void> => {
      await Promise.resolve()
      if (cancelled) return
      setLoading(true)
      setError(false)
      setChunk(undefined)
      let next = cursor
      let revision = reference.revision
      if (attempt > 0) {
        const fresh = await readContentState({
          projectId: reference.projectId,
          sessionId: reference.sessionId,
          workspaceCwd: reference.workspaceCwd,
          readMode: 'bounded',
          runIds: [run.runId]
        })
        if (cancelled) return
        revision = fresh.runs[0]?.contentRead?.revision ?? revision
      }
      while (!cancelled) {
        const state = await Promise.race([
          readContentState({
            projectId: reference.projectId,
            sessionId: reference.sessionId,
            workspaceCwd: reference.workspaceCwd,
            readMode: 'bounded',
            contentRead: { runId: run.runId, revision, cursor: next }
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Notebook read timed out')), 15_000)
          })
        ])
        clearTimeout(timer)
        if (cancelled) return
        const value = state.contentChunk
        if (!value) throw new Error('Notebook content unavailable')
        if (value.mime?.startsWith('image/')) {
          if (image.length + value.data.length > MAX_IMAGE_CHARACTERS)
            throw new Error('Notebook image exceeds viewer budget')
          image += value.data
          if (!value.partComplete && value.next) {
            next = value.next
            continue
          }
          setChunk({ ...value, data: image })
        } else setChunk(value)
        return
      }
    }
    void load()
      .catch(() => {
        if (!cancelled) setError(true)
      })
      .finally(() => {
        clearTimeout(timer)
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      image = ''
    }
  }, [reference, run.runId, cursor, attempt])
  return (
    <div className="mt-2 space-y-2" data-testid="notebook-content-reader">
      {loading ? <p role="status">{t('Loading…')}</p> : null}
      {error ? (
        <ErrorNotice
          tone="amber"
          title={t('Could not load Notebook content')}
          primaryButton={{
            label: t('Retry'),
            onClick: () => {
              setCursor({ part: initialPart, offset: 0 })
              setAttempt((value) => value + 1)
            }
          }}
        />
      ) : null}
      {chunk ? (
        <>
          <p className="text-xs text-text-300">{chunk.label}</p>
          {chunk.mime?.startsWith('image/') ? (
            <img
              src={`data:${chunk.mime};base64,${chunk.data}`}
              alt={t('Notebook output')}
              className="max-w-full"
            />
          ) : (
            <pre
              className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs"
              data-testid="notebook-content-page"
            >
              {chunk.data}
            </pre>
          )}
          {chunk.next ? (
            <button type="button" onClick={() => setCursor(chunk.next!)}>
              {t('Continue reading')}
            </button>
          ) : (
            <p role="status">{t('End of run')}</p>
          )}
        </>
      ) : null}
    </div>
  )
}

export const NotebookContentReader = ({
  run,
  initialPart = 0
}: {
  run: NotebookRunRecord
  initialPart?: number
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const active = useSyncExternalStore(
    subscribe,
    () => selected,
    () => undefined
  )
  const reference = run.contentRead
  const instance = useId()
  const key = reference
    ? JSON.stringify([
        instance,
        reference.projectId,
        reference.sessionId,
        run.runId,
        reference.revision
      ])
    : ''
  useEffect(
    () => () => {
      if (selected === key) select()
    },
    [key]
  )
  if (!reference) return null
  return (
    <div className="mt-2 text-xs">
      <button
        type="button"
        aria-expanded={active === key}
        onClick={() => select(active === key ? undefined : key)}
      >
        {active === key ? t('Hide output') : t('Read complete run')}
      </button>
      {active === key ? <ContentWindow key={key} run={run} initialPart={initialPart} /> : null}
    </div>
  )
}
