import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Check, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  LiteratureInboxCandidateView,
  LiteratureItemType
} from '../../../../shared/literature'
import {
  LiteratureSelectionBoundary,
  LiteratureSelectionCheckbox,
  LiteratureSelectPageCheckbox
} from './LiteratureSelection'
import { creatorLabel, inboxProviderLabel } from './literature-item-display'
import type { LiteratureSelectionStore } from './literature-selection'

export function LiteratureInboxList({
  selectionStore,
  candidates,
  isBatching,
  pendingCandidateId,
  clearSelection,
  inboxState,
  restoreDismissedCandidates,
  settleSelectedCandidates,
  setSelectedCandidate,
  itemTypeLabels,
  candidateProjectNames,
  changeCandidateState,
  entriesPagination
}: {
  selectionStore: LiteratureSelectionStore
  candidates: LiteratureInboxCandidateView[]
  isBatching: boolean
  pendingCandidateId: string | undefined
  clearSelection: () => void
  inboxState: 'pending' | 'dismissed'
  restoreDismissedCandidates: (candidateIds?: readonly string[]) => Promise<boolean>
  settleSelectedCandidates: (state: 'accepted' | 'dismissed') => Promise<void>
  setSelectedCandidate: React.Dispatch<
    React.SetStateAction<LiteratureInboxCandidateView | undefined>
  >
  itemTypeLabels: Record<LiteratureItemType, string>
  candidateProjectNames: (entry: LiteratureInboxCandidateView) => string[]
  changeCandidateState: (
    candidateId: string,
    kind: 'accept-candidate' | 'dismiss-candidate'
  ) => Promise<boolean>
  entriesPagination: React.JSX.Element | null
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <LiteratureSelectionBoundary store={selectionStore}>
        {(selection) => {
          const selectedCount = selection.selectedIds.size
          return (
            <div className="mb-2 flex min-h-10 shrink-0 items-center gap-2 px-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <LiteratureSelectPageCheckbox
                  itemIds={candidates.map(({ id }) => id)}
                  label={t('Select all references')}
                  store={selectionStore}
                  disabled={isBatching || Boolean(pendingCandidateId)}
                  className="size-4"
                />
                {t('Select all')}
              </label>
              {selectedCount > 0 ? (
                <>
                  <span className="ml-2 text-sm font-medium tabular-nums">
                    {t('{{count}} selected', { count: selectedCount })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isBatching || Boolean(pendingCandidateId)}
                    onClick={clearSelection}
                  >
                    {t('Clear selection')}
                  </Button>
                  <div className="ml-auto flex items-center gap-2">
                    {inboxState === 'dismissed' ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={isBatching || Boolean(pendingCandidateId)}
                        onClick={() => void restoreDismissedCandidates([...selection.selectedIds])}
                      >
                        <RotateCcw className="size-3.5" aria-hidden="true" />
                        {t('Restore')}
                      </Button>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={isBatching || Boolean(pendingCandidateId)}
                          onClick={() => void settleSelectedCandidates('dismissed')}
                        >
                          <X className="size-3.5" aria-hidden="true" />
                          {t('Dismiss')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={isBatching || Boolean(pendingCandidateId)}
                          onClick={() => void settleSelectedCandidates('accepted')}
                        >
                          <Check className="size-3.5" aria-hidden="true" />
                          {t('Accept')}
                        </Button>
                      </>
                    )}
                  </div>
                </>
              ) : null}
            </div>
          )
        }}
      </LiteratureSelectionBoundary>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 py-1 pb-3">
        {candidates.map((candidate) => {
          const item = candidate.candidate.item
          const pending = pendingCandidateId === candidate.id
          const authors = creatorLabel(item)
          const publication = [item.issuedYear, item.containerTitle].filter(Boolean).join(' · ')
          return (
            <article
              key={candidate.id}
              aria-busy={pending}
              className={cn(
                'group relative grid grid-cols-[1.25rem_minmax(0,1fr)] gap-4 rounded-xl border border-border-300/80 bg-bg-000 px-5 py-4 transition-[box-shadow,opacity] duration-150 ease-out has-[input:checked]:border-primary/30 has-[input:checked]:bg-primary/5 hover:z-10 hover:shadow-lg motion-reduce:transition-none sm:grid-cols-[1.25rem_minmax(0,1fr)_8rem]',
                pending && 'opacity-60'
              )}
            >
              <button
                type="button"
                className="absolute inset-0 cursor-pointer rounded-xl outline-none active:bg-muted/10 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed"
                aria-label={`${t('View details')}: ${item.title}`}
                disabled={isBatching || Boolean(pendingCandidateId)}
                onClick={() => setSelectedCandidate(candidate)}
              />
              <LiteratureSelectionCheckbox
                itemId={candidate.id}
                label={t('Select {{title}}', { title: item.title })}
                store={selectionStore}
                disabled={isBatching || Boolean(pendingCandidateId)}
                className="relative z-10 mt-1 size-4"
              />
              <div className="pointer-events-none relative min-w-0">
                <h3 className="line-clamp-2 text-base font-semibold leading-6 text-foreground">
                  {item.title}
                </h3>
                <p className="mt-1 text-sm leading-5 text-foreground/70">
                  {authors || itemTypeLabels[item.itemType]}
                </p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs leading-5 text-muted-foreground">
                  {candidate.pdfs?.length ? (
                    <span>
                      {t('PDF')} · {candidate.pdfs.length}
                    </span>
                  ) : null}
                  {publication ? <span>{publication}</span> : null}
                  <span className="whitespace-nowrap">
                    {t('Found via {{provider}}', {
                      provider: inboxProviderLabel(candidate.candidate.source.provider)
                    })}
                  </span>
                </div>
                {candidateProjectNames(candidate).length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('Accepting will link to: {{projects}}', {
                      projects: candidateProjectNames(candidate).join(', ')
                    })}
                  </p>
                ) : null}
                {item.abstract ? (
                  <p className="mt-3 line-clamp-2 text-[0.8125rem] leading-5 text-muted-foreground">
                    {item.abstract}
                  </p>
                ) : null}
              </div>
              <div className="relative z-10 col-start-2 grid grid-cols-2 gap-2 self-center sm:col-start-auto sm:grid-cols-1">
                {candidate.state === 'dismissed' ? (
                  <Button
                    type="button"
                    className="w-full"
                    disabled={isBatching || Boolean(pendingCandidateId)}
                    onClick={() => void restoreDismissedCandidates([candidate.id])}
                  >
                    <RotateCcw className="size-3.5" aria-hidden="true" />
                    {t('Restore')}
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      disabled={isBatching || Boolean(pendingCandidateId)}
                      onClick={() => void changeCandidateState(candidate.id, 'dismiss-candidate')}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                      {t('Dismiss')}
                    </Button>
                    <Button
                      type="button"
                      className="w-full"
                      disabled={isBatching || Boolean(pendingCandidateId)}
                      onClick={() => void changeCandidateState(candidate.id, 'accept-candidate')}
                    >
                      <Check className="size-3.5" aria-hidden="true" />
                      {t('Accept')}
                    </Button>
                  </>
                )}
              </div>
            </article>
          )
        })}
      </div>
      {entriesPagination}
    </div>
  )
}
