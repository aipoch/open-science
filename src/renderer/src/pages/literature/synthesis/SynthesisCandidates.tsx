import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ErrorNotice } from '@/components/error-notice'
import {
  annotationQuote,
  type SynthesisCandidate
} from '../../../../../shared/literature-synthesis'
import { candidateKey } from './synthesis-state'

export function SynthesisCandidates({
  itemIds,
  candidates,
  titles,
  busy,
  append,
  secondary,
  onOpenSource,
  onDraftChange,
  onCancel,
  onConfirm
}: {
  itemIds: string[]
  candidates: SynthesisCandidate[]
  titles: Record<string, string>
  busy: boolean
  append: boolean
  secondary?: ReactNode
  onOpenSource?(candidate: SynthesisCandidate, initiator: HTMLButtonElement): void
  onDraftChange?(dirty: boolean): void
  onCancel(): void
  onConfirm(title: string, candidates: SynthesisCandidate[]): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [title, setTitle] = useState('')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [tagQuery, setTagQuery] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(() => new Set<string>())
  const [selectionLimitHit, setSelectionLimitHit] = useState(false)
  const dirty = Boolean(title.trim() || selected.size)
  useEffect(() => {
    onDraftChange?.(dirty)
  }, [dirty, onDraftChange])
  const tags = useMemo(
    () => [
      ...new Map(
        candidates.flatMap((candidate) => candidate.tags).map((tag) => [tag.id, tag])
      ).values()
    ],
    [candidates]
  )
  const tagKeyword = tagQuery.trim().toLowerCase()
  const visibleTags = tags.filter(
    (tag) => tagIds.includes(tag.id) || !tagKeyword || tag.name.toLowerCase().includes(tagKeyword)
  )
  const keyword = query.trim().toLowerCase()
  const hasFilters = Boolean(query.trim() || tagIds.length)
  const shown = candidates.filter(
    (candidate) =>
      tagIds.every((id) => candidate.tags.some((tag) => tag.id === id)) &&
      (!keyword ||
        annotationQuote(candidate.annotation.target.selector).toLowerCase().includes(keyword) ||
        candidate.annotation.note?.toLowerCase().includes(keyword))
  )
  const shownKeys = new Set(shown.map(candidateKey))
  const groups = new Map<
    string,
    { candidates: SynthesisCandidate[]; shown: SynthesisCandidate[]; selectedCount: number }
  >(itemIds.map((id) => [id, { candidates: [], shown: [], selectedCount: 0 }]))
  const selectedCandidates: SynthesisCandidate[] = []
  let hiddenSelectedCount = 0
  for (const candidate of candidates) {
    const key = candidateKey(candidate)
    const group = groups.get(candidate.itemId)
    group?.candidates.push(candidate)
    if (shownKeys.has(key)) group?.shown.push(candidate)
    if (selected.has(key)) {
      selectedCandidates.push(candidate)
      if (group) group.selectedCount++
      if (!shownKeys.has(key)) hiddenSelectedCount++
    }
  }
  const remaining = Math.max(0, 100 - selected.size)
  const exceedsCapacity = hiddenSelectedCount + shownKeys.size > 100
  const selectShown = (): void => {
    if (exceedsCapacity) {
      setSelectionLimitHit(true)
      return
    }
    setSelectionLimitHit(false)
    setSelected(new Set([...selected, ...shownKeys]))
  }
  return (
    <div
      className="flex min-h-0 flex-col max-[640px]:flex-1"
      aria-label={append ? t('Append excerpts') : t('New synthesis note')}
    >
      <div className="min-h-0 space-y-4 overflow-y-auto pr-1 max-[640px]:flex-1 max-[640px]:scroll-pt-48">
        <span id="synthesis-candidate-help" className="sr-only">
          {t(
            'Choose annotations to keep as snapshots. Source annotations and tags stay unchanged.'
          )}
        </span>
        <div className="sticky top-0 z-10 -mx-1 bg-card px-1 pb-3 pt-1">
          <div className="grid grid-cols-[minmax(0,1fr)_104px] items-end gap-2 sm:grid-cols-[240px_104px_minmax(0,1fr)] sm:gap-3">
            <div className="contents">
              <label className="min-w-0 space-y-1 text-sm">
                <span className="block">{t('Search excerpts and notes')}</span>
                <Input
                  type="search"
                  value={query}
                  disabled={busy}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-8 w-full"
                />
              </label>
              <div className="w-[104px] space-y-1 text-sm">
                <span className="block">{t('Filter by Tag')}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 w-full max-w-64"
                      aria-label={t('Filter by Tag')}
                      aria-describedby="synthesis-tag-filter-help"
                      disabled={busy || tags.length === 0}
                    >
                      <span className="truncate">
                        {tagIds.length
                          ? t('{{count}} tags selected', {
                              count: tagIds.length,
                              defaultValue_one: '{{count}} tag selected'
                            })
                          : t('All tags')}
                      </span>
                      <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    aria-label={t('Filter by Tag')}
                    className="w-64"
                  >
                    <div className="p-1">
                      <Input
                        type="search"
                        value={tagQuery}
                        disabled={busy}
                        aria-label={t('Search Tags')}
                        placeholder={t('Search Tags…')}
                        onChange={(event) => setTagQuery(event.target.value)}
                        onKeyDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                      />
                    </div>
                    {visibleTags.length > 0 ? (
                      visibleTags.map((tag) => (
                        <DropdownMenuCheckboxItem
                          key={tag.id}
                          checked={tagIds.includes(tag.id)}
                          disabled={busy}
                          onSelect={(event) => event.preventDefault()}
                          onCheckedChange={(checked) =>
                            setTagIds((current) =>
                              checked ? [...current, tag.id] : current.filter((id) => id !== tag.id)
                            )
                          }
                        >
                          {tag.name}
                        </DropdownMenuCheckboxItem>
                      ))
                    ) : (
                      <p className="px-2 py-2 text-sm text-muted-foreground">
                        {t('No tags match this search.')}
                      </p>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="col-span-2 flex w-full flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 sm:col-span-1 sm:ml-auto sm:border-t-0 sm:pt-0">
              <div className="flex h-8 flex-wrap items-center gap-1">
                {hasFilters ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-24"
                    disabled={busy}
                    onClick={() => {
                      setQuery('')
                      setTagQuery('')
                      setTagIds([])
                    }}
                  >
                    {t('Clear filters')}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className="min-w-24"
                  disabled={busy || shown.length === 0}
                  onClick={selectShown}
                >
                  {t('Select current results')}
                </Button>
                {selected.size > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-24"
                    disabled={busy}
                    onClick={() => {
                      setSelected(new Set())
                      setSelectionLimitHit(false)
                    }}
                  >
                    {t('Clear selection')}
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  role="status"
                  className="rounded-md bg-muted/60 px-2 py-1 text-sm tabular-nums text-muted-foreground"
                >
                  {t('{{count}} selected', { count: selected.size })}
                </span>
                {hiddenSelectedCount > 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t('{{count}} selected excerpts hidden by the filter', {
                      count: hiddenSelectedCount,
                      defaultValue_one: '{{count}} selected excerpt hidden by the filter'
                    })}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <p id="synthesis-tag-filter-help" className="sr-only">
            {t('Only excerpts with every selected tag are shown.')}
          </p>
          {selectionLimitHit && exceedsCapacity ? (
            <ErrorNotice
              title={t('Select at most 100 excerpts.')}
              description={t(
                '{{remaining}} more can be selected. Narrow the results or clear part of your selection.',
                { remaining }
              )}
            />
          ) : null}
        </div>
        <div className="space-y-4">
          {itemIds.map((itemId) => {
            const group = groups.get(itemId)!
            const paperCandidates = group.candidates
            const paperShown = group.shown
            return (
              <section
                key={itemId}
                className="scroll-mt-48 rounded-lg border border-border bg-muted/5 p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <h3 className="min-w-0 font-medium [overflow-wrap:anywhere] max-[640px]:sticky max-[640px]:top-32 max-[640px]:z-10 max-[640px]:bg-muted/95 max-[640px]:py-2">
                    {paperCandidates[0]?.bibliography.title || titles[itemId] || itemId}
                  </h3>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t('{{count}} selected', { count: group.selectedCount })}
                  </span>
                </div>
                {paperCandidates.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t(
                      'No unique annotations found for this reference. Shared PDF annotations appear once.'
                    )}
                  </p>
                ) : paperShown.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t('No annotations match these filters.')}
                  </p>
                ) : (
                  <div className="mt-2 divide-y divide-border">
                    {paperShown.map((candidate) => {
                      const key = candidateKey(candidate)
                      const original = annotationQuote(candidate.annotation.target.selector)
                      const isSelected = selected.has(key)
                      return (
                        <label
                          key={key}
                          className={`-mx-2 flex gap-3 rounded-md px-2 py-3 text-sm transition-colors ${isSelected ? 'bg-primary/5' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={busy || (!isSelected && remaining === 0)}
                            className="mt-1 size-4 shrink-0"
                            onChange={(event) => {
                              setSelectionLimitHit(false)
                              setSelected((current) => {
                                const next = new Set(current)
                                if (event.target.checked) {
                                  if (next.size >= 100) return current
                                  next.add(candidateKey(candidate))
                                } else next.delete(candidateKey(candidate))
                                return next
                              })
                            }}
                          />
                          <span className="min-w-0 flex-1 space-y-2">
                            <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span>
                                {'pageNumber' in candidate.annotation.target.selector
                                  ? t('Page {{page}}', {
                                      page: candidate.annotation.target.selector.pageNumber
                                    })
                                  : t('Document')}
                              </span>
                              {onOpenSource ? (
                                <button
                                  type="button"
                                  className="font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  aria-label={`${t('Open source')}: ${candidate.bibliography.title}`}
                                  disabled={busy}
                                  onClick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    onOpenSource(candidate, event.currentTarget)
                                  }}
                                >
                                  {t('Open source')}
                                </button>
                              ) : null}
                            </span>
                            {original ? (
                              <blockquote className="whitespace-pre-wrap border-l-2 border-primary/40 pl-3">
                                {original}
                              </blockquote>
                            ) : null}
                            {candidate.annotation.note ? (
                              <span className="block whitespace-pre-wrap">
                                {candidate.annotation.note}
                              </span>
                            ) : null}
                            {!original && !candidate.annotation.note ? (
                              <span className="block text-muted-foreground">
                                {t('Annotation without text')}
                              </span>
                            ) : null}
                            <span className="flex flex-wrap gap-1">
                              {candidate.tags.map((tag) => (
                                <span
                                  key={tag.id}
                                  className="rounded bg-muted px-1.5 py-0.5 text-xs"
                                >
                                  {tag.name}
                                </span>
                              ))}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
        </div>
        {!append ? (
          <label className="block scroll-mt-48 space-y-1 text-sm">
            <span>{t('Note title')}</span>
            <Input
              value={title}
              maxLength={300}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        ) : null}
        {secondary ? (
          <div className="rounded-lg border border-border bg-muted/20 p-3">{secondary}</div>
        ) : null}
      </div>
      <div className="relative z-20 flex shrink-0 justify-end gap-2 border-t border-border bg-background py-3">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button
          title={t('Use selected excerpts')}
          disabled={
            busy ||
            (!append && !title.trim()) ||
            selectedCandidates.length === 0 ||
            selectedCandidates.length > 100
          }
          onClick={() => onConfirm(title.trim(), selectedCandidates)}
        >
          {busy
            ? t('Saving…')
            : `${append ? t('Append excerpts') : t('Create synthesis note')} (${selectedCandidates.length})`}
        </Button>
      </div>
    </div>
  )
}
