import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  ensureSessionContentLoaded,
  loadSessionHistoryPage
} from '@/lib/session-persistence/session-history'
import type { ChatSession } from '@/stores/session-store'

export const SessionHistoryLoadButton = ({
  session
}: {
  session: ChatSession
}): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loadingFull, setLoadingFull] = useState(false)
  const [fullFailed, setFullFailed] = useState(false)
  if (!session.historyPage || session.contentLoaded !== false) return null
  return (
    <div className="flex flex-wrap justify-center gap-2 py-3">
      {session.historyPage.hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={loading || loadingFull}
          onClick={() => {
            setLoading(true)
            setFailed(false)
            void loadSessionHistoryPage(
              { projectId: session.projectId, sessionId: session.id },
              true
            )
              .catch(() => setFailed(true))
              .finally(() => setLoading(false))
          }}
        >
          {loading
            ? t('Loading earlier messages…')
            : failed
              ? t('Retry loading earlier messages')
              : t('Load earlier messages')}
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        title={t('Load the complete conversation to access message revisions and subagents.')}
        disabled={loading || loadingFull}
        onClick={() => {
          setLoadingFull(true)
          setFullFailed(false)
          void ensureSessionContentLoaded({ projectId: session.projectId, sessionId: session.id })
            .catch(() => setFullFailed(true))
            .finally(() => setLoadingFull(false))
        }}
      >
        {loadingFull ? t('Loading…') : fullFailed ? t('Retry') : t('Load full conversation')}
      </Button>
    </div>
  )
}
