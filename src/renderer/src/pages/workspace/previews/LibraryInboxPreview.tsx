import { readMatchingCandidateIds } from '../../literature/literature-inbox-reconciliation'
/* Hallmark · component: inbox preview · genre: modern-minimal · theme: existing workspace
 * Pre-emit critique: P5 H4 E4 S5 R5 V4. Reuse semantic tokens and shared control states.
 */
import { ErrorNotice } from '@/components/error-notice'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Inbox,
  LoaderCircle,
  Undo2,
  X
} from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  createLiteratureIdentifierUrl,
  type LiteratureCatalogSearchPage,
  type LiteratureInboxCandidateView
} from '../../../../../shared/literature'
import { readLiteratureDisplayPage } from '../../literature/literature-read-pages'
import { useLiteratureChanges } from '../../literature/useLiteratureChanges'

const PAGE_SIZE = 20
const isCandidate = (
  entry: LiteratureCatalogSearchPage['entries'][number]
): entry is LiteratureInboxCandidateView => 'candidate' in entry && 'state' in entry

type UndoEntry = Pick<LiteratureInboxCandidateView, 'id'> & { title: string; confirmed?: boolean }

function InboxRow({
  entry,
  busy,
  disabled,
  onAccept,
  onDismiss,
  selectable,
  selected,
  onSelect
}: {
  entry: LiteratureInboxCandidateView
  busy: boolean
  disabled: boolean
  onAccept: () => void
  onDismiss: () => void
  selectable: boolean
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const detailId = useId()
  const { item, source } = entry.candidate
  const authors = item.creators
    .map((creator) =>
      creator.nameMode === 'organization'
        ? creator.literalName
        : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
    )
    .filter(Boolean)
    .join(', ')
  const provider = source.provider.trim().toLowerCase() === 'pubmed' ? 'PubMed' : source.provider
  return (
    <li className="min-w-0 border-b border-border px-4 py-4 last:border-b-0">
      <div className="flex items-start gap-2">
        {selectable && (
          <input
            type="checkbox"
            className="mt-1 size-3.5 shrink-0 accent-primary"
            aria-label={t('Select {{title}}', { title: item.title })}
            checked={selected}
            disabled={disabled}
            onChange={onSelect}
          />
        )}
        <button
          type="button"
          className="group flex w-full min-w-0 items-start gap-2 rounded-sm text-left focus-visible:keyboard-focus"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="min-w-0 flex-1 break-words text-sm font-semibold leading-5 group-hover:text-primary">
            {item.title}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'mt-0.5 size-3.5 shrink-0 text-muted-foreground',
              expanded && 'rotate-180'
            )}
          />
        </button>
      </div>
      {authors && (
        <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-foreground/80">
          {authors}
        </p>
      )}
      <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">
        {[item.containerTitle, item.issuedYear].filter(Boolean).join(' · ')}
      </p>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{t('Found via {{provider}}', { provider })}</span>
        {entry.pdfs?.length ? (
          <span>
            {t('PDF')} · {entry.pdfs.length}
          </span>
        ) : null}
      </div>
      {item.abstract && !expanded && (
        <p className="mt-2 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
          {item.abstract}
        </p>
      )}
      <div id={detailId} hidden={!expanded} className="mt-3 space-y-2">
        {item.abstract && (
          <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
            {item.abstract}
          </p>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-2 text-xs">
          {item.identifiers.map(({ scheme, value }) => {
            const href = createLiteratureIdentifierUrl(scheme, value)
            return href ? (
              <ExternalTextLink key={`${scheme}:${value}`} href={href}>
                {scheme.toUpperCase()}: {value}
              </ExternalTextLink>
            ) : null
          })}
        </div>
      </div>
      {!selectable && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {busy && (
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 animate-spin motion-reduce:animate-none text-muted-foreground"
            />
          )}
          <Button size="sm" variant="outline" disabled={disabled} onClick={onDismiss}>
            <X aria-hidden="true" />
            {t('Dismiss')}
          </Button>
          <Button size="sm" disabled={disabled} onClick={onAccept}>
            <Check aria-hidden="true" />
            {t('Accept')}
          </Button>
        </div>
      )}
    </li>
  )
}

export function LibraryInboxPreview({
  query,
  batchMode = false,
  onClearSearch,
  openLiterature
}: {
  query: string
  batchMode?: boolean
  onClearSearch: () => void
  openLiterature: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [cursor, setCursor] = useState({ query, offsets: [0] })
  if (cursor.query !== query) setCursor({ query, offsets: [0] })
  const offsets = cursor.query === query ? cursor.offsets : [0]
  const offset = offsets.at(-1) ?? 0
  const selectionKey = JSON.stringify([query, offset, batchMode])
  const [checked, setChecked] = useState<{ key: string; ids: string[] }>({
    key: selectionKey,
    ids: []
  })
  if (checked.key !== selectionKey) setChecked({ key: selectionKey, ids: [] })
  const [revision, setRevision] = useState(0)
  const token = useMemo(() => ({ query, offset, revision }), [query, offset, revision])
  const [snapshot, setSnapshot] = useState<{
    token: typeof token
    page: LiteratureCatalogSearchPage
  }>()
  const [failure, setFailure] = useState<typeof token>()
  const [skeleton, setSkeleton] = useState<typeof token>()
  const generation = useRef(0)
  const mounted = useRef(false)
  const writing = useRef(false)
  const selectAllInput = useRef<HTMLInputElement>(null)
  const [busyId, setBusyId] = useState<string>()
  const [undo, setUndo] = useState<UndoEntry[]>([])
  const [uncertain, setUncertain] = useState(false)
  const refresh = (): void => {
    generation.current += 1
    setRevision((value) => value + 1)
  }
  useLiteratureChanges(refresh)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [])
  useLayoutEffect(() => {
    generation.current += 1
  }, [token])
  useEffect(() => {
    const ticket = ++generation.current
    const delay = query.trim() ? 200 : 0
    const skeletonTimer = window.setTimeout(() => setSkeleton(token), delay + 160)
    const timer = window.setTimeout(() => {
      void readLiteratureDisplayPage({
        scope: 'inbox',
        inboxState: 'pending',
        query: query.trim() || undefined,
        offset,
        limit: PAGE_SIZE
      })
        .then((page) => {
          if (generation.current !== ticket) return
          if (!page.entries.length && offset > 0) {
            setCursor((current) => ({ ...current, offsets: current.offsets.slice(0, -1) }))
            return
          }
          setChecked((current) => ({
            ...current,
            ids: current.ids.filter((id) =>
              page.entries.some((entry) => isCandidate(entry) && entry.id === id)
            )
          }))
          setSnapshot({ token, page })
        })
        .catch(() => {
          if (generation.current === ticket) setFailure(token)
        })
    }, delay)
    return () => {
      clearTimeout(timer)
      clearTimeout(skeletonTimer)
      generation.current += 1
    }
  }, [query, offset, token])

  // Only the exceptional Undo conflict path scans dismissed rows. Never restore an accepted row.
  const stillDismissed = async (id: string): Promise<boolean> =>
    (await readMatchingCandidateIds(new Set([id]), 'dismissed', () => mounted.current)).has(id)
  const change = async (
    entry: UndoEntry,
    action: 'accept' | 'dismiss' | 'restore'
  ): Promise<void> => {
    if (writing.current) return
    writing.current = true
    setBusyId(entry.id)
    setUncertain(false)
    try {
      // Retain recovery even when a dismissal commits but its response is lost.
      if (action === 'dismiss')
        setUndo((current) => [...current.filter(({ id }) => id !== entry.id), entry])
      try {
        await window.api.literature.transact(
          action === 'restore'
            ? { kind: 'restore-candidates', candidateIds: [entry.id] }
            : {
                kind: action === 'accept' ? 'accept-candidate' : 'dismiss-candidate',
                candidateId: entry.id
              }
        )
        if (mounted.current && action === 'dismiss')
          setUndo((current) =>
            current.map((saved) => (saved.id === entry.id ? { ...saved, confirmed: true } : saved))
          )
        if (mounted.current && action === 'restore')
          setUndo((current) => current.filter(({ id }) => id !== entry.id))
      } catch {
        if (!mounted.current) return
        setUncertain(true)
        if (action === 'restore') {
          try {
            if (!(await stillDismissed(entry.id)) && mounted.current)
              setUndo((current) => current.filter(({ id }) => id !== entry.id))
          } catch {
            /* Keep the Undo entry available when reconciliation is offline. */
          }
        }
      }
      // A committed write is never rolled back because this independent read fails.
      if (mounted.current) refresh()
    } finally {
      writing.current = false
      if (mounted.current) setBusyId(undefined)
    }
  }
  const page = snapshot?.token === token ? snapshot.page : undefined
  const failed = failure === token
  const entries = page?.entries.filter(isCandidate) ?? []
  const disabled = Boolean(busyId) || !page || failed
  const selectedEntries =
    batchMode && checked.key === selectionKey
      ? entries.filter(({ id }) => checked.ids.includes(id))
      : []
  const allSelected = entries.length > 0 && selectedEntries.length === entries.length
  useLayoutEffect(() => {
    if (selectAllInput.current)
      selectAllInput.current.indeterminate = selectedEntries.length > 0 && !allSelected
  }, [selectedEntries.length, allSelected, batchMode])
  const acceptSelected = async (): Promise<void> => {
    if (writing.current || disabled || !selectedEntries.length) return
    writing.current = true
    setBusyId(selectedEntries[0].id)
    setUncertain(false)
    // A single existing catalog transaction settles this page's explicitly selected candidates.
    setChecked({ key: selectionKey, ids: [] })
    try {
      await window.api.literature.transact({
        kind: 'settle-candidates',
        candidateIds: selectedEntries.map(({ id }) => id),
        state: 'accepted'
      })
    } catch {
      if (mounted.current) setUncertain(true)
    } finally {
      writing.current = false
      if (mounted.current) {
        setBusyId(undefined)
        refresh()
      }
    }
  }
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs text-muted-foreground">
        <span>{t('All projects')}</span>
        {page?.totalCount !== undefined && (
          <span className="tabular-nums">
            {t('Pending review: {{total}}', { total: page.totalCount })}
          </span>
        )}
      </div>
      {batchMode && (
        <div className="mx-4 my-2 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/40 p-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              ref={selectAllInput}
              type="checkbox"
              className="size-3.5 shrink-0 accent-primary"
              aria-label={t('Select all references')}
              checked={allSelected}
              disabled={disabled || entries.length === 0}
              onChange={() =>
                setChecked({
                  key: selectionKey,
                  ids: allSelected ? [] : entries.map(({ id }) => id)
                })
              }
            />
            {t('Select all')}
          </label>
          <span className="mr-auto text-xs">
            {t('Selected: {{selected}}', { selected: selectedEntries.length })}
          </span>
          <Button
            size="xs"
            disabled={disabled || !selectedEntries.length}
            onClick={() => void acceptSelected()}
          >
            {busyId ? (
              <LoaderCircle
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Check aria-hidden="true" />
            )}
            {t('Accept')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || !selectedEntries.length}
            onClick={() => setChecked({ key: selectionKey, ids: [] })}
          >
            {t('Clear selection')}
          </Button>
        </div>
      )}
      {uncertain && (
        <div className="p-4">
          <ErrorNotice
            inline
            tone="amber"
            description={t(
              'The update could not be confirmed. Check the Inbox before trying again.'
            )}
            primaryButton={{ label: t('Open in Literature'), onClick: openLiterature }}
          />
        </div>
      )}
      {undo.length > 0 && (
        <div className="space-y-2 border-b border-border bg-muted/40 px-4 py-3">
          {undo.map((entry) => (
            <div key={entry.id} className="flex min-w-0 items-center gap-3">
              <div className="min-w-0 flex-1 text-xs">
                <p className="text-muted-foreground">
                  {entry.confirmed ? t('Dismissed from Inbox') : t('Inbox')}
                </p>
                <p className="truncate" title={entry.title}>
                  {entry.title}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={Boolean(busyId)}
                onClick={() => void change(entry, 'restore')}
              >
                <Undo2 aria-hidden="true" />
                {t('Undo')}
              </Button>
            </div>
          ))}
        </div>
      )}
      {failed ? (
        <div className="p-4">
          <ErrorNotice
            title={t('Could not load references.')}
            primaryButton={{ label: t('Retry'), onClick: refresh }}
            secondaryButton={{ label: t('Open in Literature'), onClick: openLiterature }}
          />
        </div>
      ) : !page ? (
        <div role="status" aria-label={t('Loading references…')} className="p-4">
          <span className="sr-only">{t('Loading references…')}</span>
          {skeleton === token && (
            <div aria-hidden="true" className="space-y-4 animate-pulse motion-reduce:animate-none">
              {[0, 1, 2].map((key) => (
                <div key={key} className="space-y-2 py-3">
                  <div className="h-4 w-4/5 rounded bg-muted" />
                  <div className="h-3 w-3/5 rounded bg-muted" />
                  <div className="h-3 w-full rounded bg-muted" />
                </div>
              ))}
            </div>
          )}
        </div>
      ) : entries.length ? (
        <ul aria-label={t('Inbox')} className="min-w-0">
          {entries.map((entry) => (
            <InboxRow
              key={entry.id}
              entry={entry}
              selectable={batchMode}
              selected={selectedEntries.includes(entry)}
              onSelect={() =>
                setChecked({
                  key: selectionKey,
                  ids: selectedEntries.includes(entry)
                    ? selectedEntries.filter(({ id }) => id !== entry.id).map(({ id }) => id)
                    : [...selectedEntries.map(({ id }) => id), entry.id]
                })
              }
              busy={busyId === entry.id}
              disabled={disabled}
              onAccept={() =>
                void change({ id: entry.id, title: entry.candidate.item.title }, 'accept')
              }
              onDismiss={() =>
                void change({ id: entry.id, title: entry.candidate.item.title }, 'dismiss')
              }
            />
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center px-6 py-12 text-center">
          <Inbox aria-hidden="true" className="size-7 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">
            {query.trim() ? t('No matching references') : t('Inbox is clear')}
          </h3>
          <p className="mt-2 max-w-72 text-xs leading-5 text-muted-foreground">
            {query.trim()
              ? t('Try another search or clear the search field.')
              : t('New Agent discoveries will appear here for review.')}
          </p>
          {query.trim() && (
            <Button className="mt-4" size="sm" variant="outline" onClick={onClearSearch}>
              {t('Clear search')}
            </Button>
          )}
        </div>
      )}
      {page && (offset > 0 || page.nextOffset !== undefined) && (
        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('Previous page')}
            disabled={offset === 0 || Boolean(busyId)}
            onClick={() => setCursor({ query, offsets: offsets.slice(0, -1) })}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('Page {{page}}', { page: offsets.length })}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t('Next page')}
            disabled={page.nextOffset === undefined || Boolean(busyId)}
            onClick={() => setCursor({ query, offsets: [...offsets, page.nextOffset!] })}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      )}
    </div>
  )
}
