import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, MessageSquarePlus, Play } from 'lucide-react'
import type { ResearchMembership } from '../../../../shared/session-persistence'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useSessionStore } from '@/stores/session-store'
import { openResearchWorkspace } from './workspace-discussion-navigation'
import { showSessionReplay } from './workspace-session-actions'
import { requestComposerFocus } from './composer-focus-events'

// A narrow presentation layer over ordinary conversations and the existing preview workbench.
// Membership determines this breadcrumb; changing a reading reference never changes its parent.
export const ResearchWorkspaceHeader = ({
  source,
  historical,
  children
}: {
  source: ResearchMembership
  historical: boolean
  children: React.ReactNode
}): React.JSX.Element => {
  const { t } = useTranslation()
  const record = useSessionStore((state) =>
    state.sessions.find(
      (session) =>
        session.projectId === source.sourceProjectId && session.id === source.sourceSessionId
    )
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)
  const title = record?.title ?? source.sourceTitle
  const available = Boolean(
    record &&
    record.archivedAt === undefined &&
    (record.packageOrigin?.importId ?? record.importedResearch?.importId) === source.sourceImportId
  )
  const showReplay = (): void => {
    showSessionReplay(source.sourceProjectId, source.sourceSessionId, title)
  }
  const enterDiscussion = async (newDiscussion: boolean): Promise<void> => {
    setPending(true)
    setError(false)
    try {
      if (!(await openResearchWorkspace(source, { newDiscussion }))) setError(true)
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }
  return (
    <div className="min-w-0 flex-1 space-y-1" data-testid="research-workspace-header">
      <div className="flex min-w-0 items-center gap-2">
        <BookOpen className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="shrink-0 text-xs font-normal text-text-300">{t('Research')}</span>
        <h1 className="truncate text-sm font-semibold" title={title}>
          {title}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6">
        <span className="shrink-0 text-xs font-normal text-text-300">
          {historical ? t('Original record · Read-only') : t('Discussion')}
        </span>
        <div className="min-w-0 flex-1 text-xs">{children}</div>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={showReplay}>
          <Play className="size-3" aria-hidden="true" />
          {t('View replay')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          disabled={!available || pending}
          onClick={() => {
            if (historical) requestComposerFocus()
            else void enterDiscussion(true)
          }}
        >
          <MessageSquarePlus className="size-3" aria-hidden="true" />
          {historical ? t('Ask about this research') : t('New discussion')}
        </Button>
      </div>
      {!available ? (
        <p className="pl-6 text-xs font-normal text-text-300">
          {t('The source research is archived or unavailable. This discussion remains available.')}
        </p>
      ) : null}
      {error ? (
        <ErrorNotice
          inline
          tone="amber"
          description={t('Could not open the research discussion. Please retry.')}
        />
      ) : null}
    </div>
  )
}
