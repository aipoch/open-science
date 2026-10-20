import { useContext, useEffect, useId, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import type { ArtifactLiteratureReference } from '../../../../shared/artifact-literature'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { isCollectionOnlyChange, useLiteratureChanges } from '../literature/public/events'
import { ArtifactLiteratureDetailDialog } from './ArtifactLiteratureDetailDialog'
import { LiteratureCandidateSessionContext } from './literature-candidate-session-context'

const ReferenceList = ({ itemIds }: { itemIds: string[] }): React.JSX.Element => {
  const { t } = useTranslation()
  const [limit, setLimit] = useState(3)
  const listId = useId()
  const [revision, refresh] = useReducer((value: number) => value + 1, 0)
  const [result, setResult] = useState<{
    items?: LiteratureItemView[]
    limit: number
    revision: number
    idsKey: string
  }>()
  const [selected, setSelected] = useState<ArtifactLiteratureReference>()
  const trigger = useRef<HTMLButtonElement>(null)
  const region = useRef<HTMLDivElement>(null)
  const idsKey = JSON.stringify(itemIds.slice(0, limit))
  useLiteratureChanges((event) => {
    if (!isCollectionOnlyChange(event)) refresh()
  })
  useEffect(() => {
    let active = true
    const read = async (): Promise<void> => {
      try {
        const ids: string[] = JSON.parse(idsKey)
        const items: LiteratureItemView[] = []
        for (let offset = 0; offset < ids.length; offset += 100) {
          const batch = ids.slice(offset, offset + 100)
          let pageOffset = 0
          do {
            const page = await window.api.literature.search({
              scope: 'library',
              itemIds: batch,
              limit: 100,
              offset: pageOffset
            })
            if (!active) return
            for (const entry of page.entries) {
              if ('item' in entry && 'metadataRevision' in entry) items.push(entry)
            }
            if (page.nextOffset === undefined) break
            if (page.nextOffset <= pageOffset || page.nextOffset >= batch.length)
              throw new Error('Invalid reference page offset')
            pageOffset = page.nextOffset
          } while (active)
        }
        setResult({ items, limit, revision, idsKey })
      } catch {
        if (active) setResult({ limit, revision, idsKey })
      }
    }
    void read()
    return () => {
      active = false
    }
  }, [idsKey, limit, revision])

  const byId = new Map(result?.items?.map((item) => [item.id, item]))
  const queriedIds = new Set<string>(result ? JSON.parse(result.idsKey) : [])
  const busy = result?.idsKey !== idsKey || result?.limit !== limit || result?.revision !== revision
  return (
    <div ref={region} tabIndex={-1} className="min-w-0 outline-none" aria-busy={busy}>
      {itemIds.length === 0 ? null : !result ? (
        <p className="py-1 text-xs text-text-200">{t('Loading references…')}</p>
      ) : !result.items ? (
        <ErrorNotice
          inline
          tone="amber"
          icon={TriangleAlert}
          description={t('Could not load references.')}
          primaryButton={{ label: t('Retry'), onClick: refresh }}
        />
      ) : (
        <>
          {itemIds.length > 0 ? (
            <ul
              id={listId}
              className="divide-y divide-border-200 border-t border-border-200"
              aria-label={t('References')}
            >
              {itemIds.slice(0, Math.min(limit, result.limit)).map((id) => {
                const entry = byId.get(id)
                if (!entry)
                  return (
                    <li key={id} className="py-1.5 text-xs text-text-200">
                      {queriedIds.has(id) ? t('Reference unavailable') : t('Loading references…')}
                    </li>
                  )
                const author = entry.item.creators.find(
                  (creator) => creator.creatorType === 'author'
                )
                const name =
                  author?.nameMode === 'organization' ? author.literalName : author?.familyName
                const metadata = [
                  name,
                  entry.item.issuedYear ?? entry.item.issuedText,
                  entry.item.containerTitle
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <li key={id}>
                    <button
                      type="button"
                      className="group flex w-full min-w-0 items-center gap-2 rounded-sm px-1 py-1.5 text-left hover:bg-bg-200 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                      aria-label={entry.item.title}
                      aria-haspopup="dialog"
                      onClick={(event) => {
                        trigger.current = event.currentTarget
                        setSelected({
                          itemId: entry.id,
                          metadataRevision: entry.metadataRevision,
                          item: entry.item
                        })
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-[12px] leading-4 text-text-000"
                          title={entry.item.title}
                        >
                          {entry.item.title}
                        </span>
                        {metadata ? (
                          <span
                            className="block truncate text-[10px] leading-4 text-text-200"
                            title={metadata}
                          >
                            {metadata}
                          </span>
                        ) : null}
                      </span>
                      <ChevronRight
                        className="size-3 shrink-0 text-text-200 group-hover:text-text-000"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
          {itemIds.length > 3 ? (
            <div className="flex items-center gap-2 pt-0.5">
              {limit < itemIds.length ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1 text-[11px]"
                  disabled={busy}
                  aria-label={t('Show more')}
                  aria-controls={listId}
                  aria-expanded={limit > 3}
                  onClick={() => setLimit((value) => Math.min(value + 10, itemIds.length))}
                >
                  {t('Show more')}
                  <span className="tabular-nums text-text-200">({itemIds.length - limit})</span>
                </Button>
              ) : null}
              {limit > 3 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-1 text-[11px]"
                  aria-controls={listId}
                  aria-expanded={true}
                  onClick={() => setLimit(3)}
                >
                  {t('Show less')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <ArtifactLiteratureDetailDialog
        liveMetadata
        reference={selected}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined)
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          ;(trigger.current?.isConnected ? trigger.current : region.current)?.focus()
        }}
      />
    </div>
  )
}

export const LiteratureToolReferenceList = ({
  itemIds,
  activityId
}: {
  itemIds: readonly string[]
  activityId?: string
}): React.JSX.Element | null => {
  const context = useContext(LiteratureCandidateSessionContext)
  if (
    !context ||
    (context.liveActivityIds && (!activityId || !context.liveActivityIds.has(activityId)))
  )
    return null
  const ids = [...new Set(itemIds)]
  return <ReferenceList key={JSON.stringify([context.sessionId, activityId])} itemIds={ids} />
}
