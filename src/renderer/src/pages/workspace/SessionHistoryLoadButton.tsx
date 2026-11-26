import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import {
  SESSION_OPEN_PAGE_SIZE,
  ensureSessionContentLoaded,
  loadSessionHistoryPage,
  sessionReadErrorMessage
} from '@/lib/session-persistence/session-history'
import type { ChatSession } from '@/stores/session-store'

export const SessionHistoryLoadButton = ({
  session,
  onRequestEarlier,
  viewport
}: {
  onRequestEarlier?: () => void
  viewport?: HTMLDivElement | null
  session: ChatSession
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [pending, setPending] = useState<'earlier' | 'full'>()
  const [failure, setFailure] = useState<{ target: 'earlier' | 'full'; message: string }>()
  // A run of folded tools can occupy one row. Bound automatic reads even in that case.
  const remainingFillPages = useRef(2)
  const { projectId, id: sessionId, historyPage } = session
  useEffect(() => {
    if (!viewport || !historyPage?.hasMore || !remainingFillPages.current || pending || failure)
      return
    const frame = requestAnimationFrame(() => {
      if (!viewport.clientHeight || viewport.scrollHeight > viewport.clientHeight + 1) {
        if (viewport.clientHeight) remainingFillPages.current = 0
        return
      }
      remainingFillPages.current--
      setPending('earlier')
      void loadSessionHistoryPage(
        { projectId, sessionId, reportReadFailure: true },
        true,
        window.api.sessions,
        SESSION_OPEN_PAGE_SIZE
      )
        .catch((error) =>
          setFailure({ target: 'earlier', message: sessionReadErrorMessage(error) })
        )
        .finally(() => setPending(undefined))
    })
    return () => cancelAnimationFrame(frame)
  }, [viewport, historyPage, pending, failure, projectId, sessionId])
  if (!session.historyPage || session.contentLoaded !== false) return null
  const load = async (target: 'earlier' | 'full'): Promise<void> => {
    remainingFillPages.current = 0
    setPending(target)
    setFailure(undefined)
    const request = {
      projectId: session.projectId,
      sessionId: session.id,
      reportReadFailure: true as const
    }
    try {
      if (target === 'earlier') {
        onRequestEarlier?.()
        await loadSessionHistoryPage(request, true)
      } else await ensureSessionContentLoaded(request)
    } catch (error) {
      setFailure({ target, message: sessionReadErrorMessage(error) })
    } finally {
      setPending(undefined)
    }
  }
  return (
    <div className="flex flex-wrap justify-center gap-2 py-3">
      {failure && (
        <div className="w-full">
          <ErrorNotice inline role="alert" description={t(failure.message)} />
        </div>
      )}
      {session.historyPage.hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending !== undefined}
          onClick={() => void load('earlier')}
        >
          {pending === 'earlier'
            ? t('Loading earlier messages…')
            : failure?.target === 'earlier'
              ? t('Retry loading earlier messages')
              : t('Load earlier messages')}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        title={t('Load the complete conversation to access message revisions and subagents.')}
        disabled={pending !== undefined}
        onClick={() => void load('full')}
      >
        {pending === 'full'
          ? t('Loading…')
          : failure?.target === 'full'
            ? t('Retry')
            : t('Load full conversation')}
      </Button>
    </div>
  )
}
