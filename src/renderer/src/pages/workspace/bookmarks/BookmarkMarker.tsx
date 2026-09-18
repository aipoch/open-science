import { Bookmark as BookmarkIcon, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useBookmarks } from './bookmark-context'

export const BookmarkMarker = ({
  id,
  left,
  top,
  note
}: {
  id: string
  left: number
  top: number
  note: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { available, updateNote, remove } = useBookmarks()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(note)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const [deleting, setDeleting] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setDraft(note)
          setError(false)
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-bookmark-marker="true"
          data-annotation-trigger="true"
          title={note}
          aria-label={t('Edit bookmark note')}
          className="absolute z-10 rounded-sm text-status-warning-foreground hover:bg-status-warning-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{ left, top }}
        >
          <BookmarkIcon className="h-2.5 w-2" strokeWidth={1.5} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="z-[110] w-80 space-y-2 border border-border bg-popover text-popover-foreground"
        align="start"
        side="bottom"
      >
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('For me')}
        </div>
        <label className="block text-xs font-medium" htmlFor={`bookmark-note-${id}`}>
          {t('Bookmark note')}
        </label>
        <Textarea
          id={`bookmark-note-${id}`}
          autoFocus
          value={draft}
          maxLength={2_000}
          disabled={!available || saving}
          onChange={(event) => setDraft(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {deleting
              ? t('Bookmark could not be deleted. Try again.')
              : t('Bookmark note could not be saved. Try again.')}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="mr-auto text-destructive hover:text-destructive"
            aria-label={t('Delete bookmark')}
            disabled={!available || saving}
            onClick={() => {
              setSaving(true)
              setDeleting(true)
              setError(false)
              void remove(id)
                .then(() => setOpen(false))
                .catch(() => setError(true))
                .finally(() => setSaving(false))
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t('Cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!available || saving}
            onClick={() => {
              setSaving(true)
              setDeleting(false)
              setError(false)
              void updateNote(id, draft.trim())
                .then(() => setOpen(false))
                .catch(() => setError(true))
                .finally(() => setSaving(false))
            }}
          >
            {t('Save')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
