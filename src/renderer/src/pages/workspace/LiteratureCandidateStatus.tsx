import { useContext, useEffect, useReducer, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useNavigationStore } from '@/stores/navigation-store'
import type { LiteratureCandidateStatesResult } from '../../../../shared/literature'
import { isCollectionOnlyChange, useLiteratureChanges } from '../literature/public/events'
import { LibraryPreviewNavigationContext } from './previews/library-reference-actions'

import { LiteratureToolReferenceList } from './LiteratureToolReferenceList'
import { LiteratureCandidateSessionContext } from './literature-candidate-session-context'

const CurrentCandidateStatus = ({
  candidateIds,
  sessionId,
  activityId
}: {
  candidateIds: readonly string[]
  sessionId: string
  activityId?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const openPreview = useContext(LibraryPreviewNavigationContext)
  const [revision, refresh] = useReducer((value: number) => value + 1, 0)
  const key = JSON.stringify([sessionId, [...new Set(candidateIds)].sort()])
  const [result, setResult] = useState<{
    key: string
    revision: number
    candidates?: LiteratureCandidateStatesResult['candidates']
  }>()
  useLiteratureChanges((event) => {
    if (!isCollectionOnlyChange(event)) refresh()
  })
  useEffect(() => {
    let cancelled = false
    const [, ids] = JSON.parse(key) as [string, string[]]
    const read = async (): Promise<void> => {
      try {
        const candidates: LiteratureCandidateStatesResult['candidates'] = []
        for (let offset = 0; offset < ids.length; offset += 200) {
          const page = await window.api.literature.getCandidateStates({
            candidateIds: ids.slice(offset, offset + 200)
          })
          if (cancelled) return
          candidates.push(...page.candidates)
        }
        setResult({ key, revision, candidates })
      } catch {
        if (!cancelled) setResult({ key, revision })
      }
    }
    void read()
    return () => {
      cancelled = true
    }
  }, [key, revision])

  if (result?.key !== key || (!result.candidates && result.revision !== revision)) {
    return <p role="status">{t('Checking current library status…')}</p>
  }
  if (!result.candidates) {
    return (
      <ErrorNotice
        inline
        icon={TriangleAlert}
        tone="amber"
        description={t('Could not check current library status.')}
        primaryButton={{ label: t('Retry'), onClick: refresh }}
      />
    )
  }
  const byId = new Map(result.candidates.map((candidate) => [candidate.candidateId, candidate]))
  const states = [...new Set(candidateIds)].map((id) => byId.get(id))
  const pending = states.filter((candidate) => candidate?.state === 'pending').length
  const accepted = states.filter(
    (candidate) => candidate?.state === 'accepted' && candidate.acceptedItemId
  )
  const dismissed = states.filter((candidate) => candidate?.state === 'dismissed').length
  const unavailable = states.length - pending - accepted.length - dismissed
  const itemIds = [...new Set(accepted.map((candidate) => candidate!.acceptedItemId!))]

  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <div
          className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]"
          role="status"
          aria-busy={result.revision !== revision}
        >
          <span className="sr-only">{t('Current library status')}</span>
          {accepted.length > 0 ? (
            <span className="text-text-100">
              {t('Imported: {{total}}', { total: accepted.length })}
            </span>
          ) : null}
          {pending > 0 ? <span>{t('Pending review: {{total}}', { total: pending })}</span> : null}
          {dismissed > 0 ? <span>{t('Dismissed: {{total}}', { total: dismissed })}</span> : null}
          {unavailable > 0 ? (
            <span>{t('Current status unavailable: {{total}}', { total: unavailable })}</span>
          ) : null}
        </div>
        {pending > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-1.5 text-[11px] text-primary"
            onClick={() => {
              if (openPreview) openPreview({ section: 'inbox' })
              else useNavigationStore.getState().openLibrary('user')
            }}
          >
            {t('Open Inbox')}
          </Button>
        ) : null}
      </div>
      <LiteratureToolReferenceList itemIds={itemIds} activityId={activityId} />
    </div>
  )
}

export const LiteratureCandidateStatus = ({
  candidateIds,
  activityId
}: {
  candidateIds?: readonly string[]
  activityId?: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const context = useContext(LiteratureCandidateSessionContext)
  const sessionId =
    context && (!context.liveActivityIds || (activityId && context.liveActivityIds.has(activityId)))
      ? context.sessionId
      : null
  return (
    <div className="text-xs text-text-200">
      {sessionId && candidateIds?.length ? (
        <CurrentCandidateStatus
          candidateIds={candidateIds}
          sessionId={sessionId}
          activityId={activityId}
        />
      ) : (
        <p>{t('Historical result; current library status is unavailable.')}</p>
      )}
    </div>
  )
}
