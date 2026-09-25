import { Bookmark as BookmarkIcon, Loader2, ArrowUpRight, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { Bookmark } from '../../../../../shared/bookmarks'
import { requestBookmarkReveal } from '../annotations/annotation-reveal'
import { useBookmarks } from './bookmark-context'

const bookmarkQuote = (
  bookmark: Bookmark,
  pdfRegionLabel: (page: number) => string,
  documentNoteLabel: string
): string => {
  if (bookmark.target.kind === 'text') return bookmark.target.quote
  if (bookmark.target.selector.kind === 'text') return bookmark.target.selector.exact
  if (bookmark.target.selector.kind === 'region') {
    return bookmark.target.selector.text ?? pdfRegionLabel(bookmark.target.selector.pageNumber)
  }
  if (bookmark.target.selector.kind === 'page-note') {
    return pdfRegionLabel(bookmark.target.selector.pageNumber)
  }
  return documentNoteLabel
}

const sourceLabel = (bookmark: Bookmark, agentMessage: string, sessionItem: string): string => {
  const source = bookmark.target.source
  if ('name' in source && source.name) return source.name
  if ('path' in source) return source.path.split(/[\\/]/).at(-1) ?? source.path
  return source.kind === 'agent-message' ? agentMessage : sessionItem
}

const BookmarksPopover = (): React.JSX.Element | null => {
  const { t } = useTranslation()
  const { available, bookmarks, total, loading, loadError, retryLoad, updateNote, remove } =
    useBookmarks()
  const [editingId, setEditingId] = useState<string>()
  const [editingNote, setEditingNote] = useState('')
  const [pendingId, setPendingId] = useState<string>()
  const [operationError, setOperationError] = useState<string>()

  const saveNote = async (): Promise<void> => {
    if (!editingId) return
    setPendingId(editingId)
    setOperationError(undefined)
    try {
      await updateNote(editingId, editingNote.trim())
      setEditingId(undefined)
    } catch (error) {
      console.error('Failed to update bookmark note', error)
      setOperationError(t('Bookmark note could not be saved. Try again.'))
    } finally {
      setPendingId(undefined)
    }
  }

  const deleteBookmark = async (id: string): Promise<void> => {
    setPendingId(id)
    setOperationError(undefined)
    try {
      await remove(id)
    } catch (error) {
      console.error('Failed to delete bookmark', error)
      setOperationError(t('Bookmark could not be deleted. Try again.'))
    } finally {
      setPendingId(undefined)
    }
  }

  const revealBookmark = async (bookmark: Bookmark): Promise<void> => {
    setPendingId(bookmark.id)
    setOperationError(undefined)
    try {
      const outcome = await requestBookmarkReveal(bookmark)
      if (outcome === 'source-unavailable') {
        setOperationError(t('Bookmark source is no longer available.'))
      } else if (outcome === 'locator-unsupported') {
        setOperationError(t('The exact bookmark location could not be found.'))
      }
    } catch (error) {
      console.error('Failed to reveal bookmark', error)
      setOperationError(t('The exact bookmark location could not be found.'))
    } finally {
      setPendingId(undefined)
    }
  }

  if (total === 0 && !loadError) return null

  return (
    <Popover>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t('Bookmarks ({{count}})', { count: total })}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] font-normal text-text-100 transition-colors duration-200 ease-out hover:bg-bg-300 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <BookmarkIcon className="size-3" strokeWidth={1.5} aria-hidden="true" />
                <span className="tabular-nums">{total}</span>
                <span>{t('Bookmarks')}</span>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-52 text-[11px]">
            {t('Bookmarks in this session. Click one to jump there.')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        collisionPadding={12}
        className="z-modal w-[410px] max-w-[calc(100vw-24px)] rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-menu"
      >
        <section aria-label={t('Bookmarks')}>
          <div className={loading ? 'flex items-center justify-between px-2 py-1' : 'sr-only'}>
            <h2 className="text-sm font-semibold">{t('Bookmarks')}</h2>
            {loading ? (
              <Loader2
                className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-label={t('Loading bookmarks…')}
              />
            ) : null}
          </div>
          {loadError ? (
            <div className="space-y-2 rounded-lg bg-status-warning-surface p-2 text-xs text-status-warning-foreground">
              <p>{t('Bookmarks could not be loaded. Try again.')}</p>
              <Button type="button" size="sm" variant="outline" onClick={retryLoad}>
                {t('Retry')}
              </Button>
            </div>
          ) : null}
          {!loading && bookmarks.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t('No bookmarks yet.')}
            </p>
          ) : bookmarks.length > 0 ? (
            <ol className="max-h-80 overflow-y-auto overscroll-contain">
              {bookmarks.map((bookmark) => {
                const canReveal =
                  bookmark.target.kind !== 'pdf' ||
                  bookmark.target.selector.kind !== 'document-note'
                return (
                  <li key={bookmark.id}>
                    <div className="group relative flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/50 focus-within:bg-muted/50">
                      <BookmarkIcon
                        className="size-3 shrink-0 text-status-warning-foreground/65"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        title={sourceLabel(bookmark, t('Agent message'), t('Session activity'))}
                        disabled={!canReveal || pendingId === bookmark.id}
                        onClick={canReveal ? () => void revealBookmark(bookmark) : undefined}
                        className="after:absolute after:inset-0 after:rounded-[inherit] disabled:after:hidden flex min-w-0 flex-1 items-baseline gap-2 rounded-sm text-left text-[11px] leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="max-w-[55%] truncate font-mono text-muted-foreground">
                          {bookmarkQuote(
                            bookmark,
                            (page) => t('PDF region on page {{page}}', { page }),
                            t('Document note')
                          )}
                        </span>
                        {bookmark.note ? (
                          <>
                            <span className="text-muted-foreground/60" aria-hidden="true">
                              —
                            </span>
                            <span className="truncate text-foreground/85">{bookmark.note}</span>
                          </>
                        ) : null}
                      </button>
                      <div className="relative z-10 flex shrink-0 items-center gap-0.5 text-muted-foreground/65">
                        <button
                          type="button"
                          aria-label={t('Show bookmark source')}
                          disabled={!canReveal || pendingId === bookmark.id}
                          onClick={canReveal ? () => void revealBookmark(bookmark) : undefined}
                          className="grid size-5 place-items-center rounded hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <ArrowUpRight className="size-3" strokeWidth={1.5} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('Edit bookmark note')}
                          disabled={!available || pendingId === bookmark.id}
                          className="grid size-5 place-items-center rounded hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => {
                            setEditingId(bookmark.id)
                            setEditingNote(bookmark.note)
                            setOperationError(undefined)
                          }}
                        >
                          <Pencil className="size-3" strokeWidth={1.5} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('Delete bookmark')}
                          disabled={!available || pendingId === bookmark.id}
                          className="grid size-5 place-items-center rounded hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                          onClick={() => void deleteBookmark(bookmark.id)}
                        >
                          <Trash2 className="size-3" strokeWidth={1.5} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    {editingId === bookmark.id ? (
                      <div className="ml-5 mt-1 space-y-1.5 pb-1">
                        <Textarea
                          aria-label={t('Bookmark note')}
                          className="min-h-[60px] resize-none rounded-md px-2 py-1.5 text-xs md:text-xs"
                          autoFocus
                          value={editingNote}
                          maxLength={2_000}
                          disabled={pendingId === bookmark.id}
                          onChange={(event) => setEditingNote(event.target.value)}
                        />
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setEditingId(undefined)}
                          >
                            {t('Cancel')}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={pendingId === bookmark.id}
                            onClick={() => void saveNote()}
                          >
                            {t('Save')}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ol>
          ) : null}
          {operationError ? (
            <p role="alert" className="mt-2 px-1 text-xs text-destructive">
              {operationError}
            </p>
          ) : null}
        </section>
      </PopoverContent>
    </Popover>
  )
}

export { BookmarksPopover }
