import '../annotations/annotation-controls.css'

import { MessageSquareText as NoteIcon, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { usePdfAnnotations } from './pdf-annotations-context'

const isEditableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  (target instanceof HTMLElement && target.isContentEditable)

export const PdfAnnotationMarker = ({
  id,
  left,
  top,
  note
}: {
  id: string
  left: string
  top: string
  note: string
}): React.JSX.Element => {
  const { t } = useTranslation()
  const { available, update, remove } = usePdfAnnotations()
  const [open, setOpen] = useState(false)
  const [hoverOpen, setHoverOpen] = useState(false)
  const [draft, setDraft] = useState(note)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const deleteAnnotation = (): void => {
    if (!available || saving) return
    setSaving(true)
    setDeleting(true)
    setError(false)
    void remove(id)
      .then(() => setOpen(false))
      .catch(() => {
        setEditing(true)
        setError(true)
      })
      .finally(() => setSaving(false))
  }
  return (
    <TooltipProvider>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          setHoverOpen(false)
          if (next) {
            setDraft(note)
            setEditing(!note.trim())
            setError(false)
          }
        }}
      >
        <Tooltip open={!open && hoverOpen} onOpenChange={setHoverOpen}>
          <TooltipTrigger
            asChild
            onFocus={(event) => {
              if (!event.currentTarget.matches(':focus-visible')) event.preventDefault()
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                data-pdf-annotation-marker="true"
                data-annotation-trigger="true"
                aria-label={t('Annotation note')}
                className="pointer-events-auto absolute z-50 grid size-6 place-items-center rounded-md border border-border bg-popover text-primary shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ left, top }}
                onKeyDown={(event) => {
                  if (
                    !event.nativeEvent.isComposing &&
                    !event.altKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    (event.key === 'Backspace' || event.key === 'Delete')
                  ) {
                    event.preventDefault()
                    event.stopPropagation()
                    deleteAnnotation()
                  }
                }}
              >
                <NoteIcon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            collisionPadding={8}
            className="z-[120] max-w-80 border border-border bg-popover p-3 text-popover-foreground shadow-md"
          >
            <p className="line-clamp-6 whitespace-pre-wrap break-words text-xs leading-5">
              {note || t('Annotation note')}
            </p>
          </TooltipContent>
        </Tooltip>
        <PopoverContent
          className="annotation-popover z-[110] max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[calc(100vw-1rem)] space-y-2 overflow-y-auto border border-border bg-popover p-3 text-popover-foreground"
          collisionPadding={8}
          aria-label={t('Annotation note')}
          align="start"
          side="bottom"
          onKeyDown={(event) => {
            if (
              isEditableTarget(event.target) ||
              event.nativeEvent.isComposing ||
              event.altKey ||
              event.ctrlKey ||
              event.metaKey ||
              (event.key !== 'Backspace' && event.key !== 'Delete')
            ) {
              return
            }
            event.preventDefault()
            event.stopPropagation()
            deleteAnnotation()
          }}
        >
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('Annotation note')}
          </div>
          {!editing ? (
            <p
              className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6"
              tabIndex={0}
            >
              {note}
            </p>
          ) : (
            <>
              <label className="block text-xs font-medium" htmlFor={`bookmark-note-${id}`}>
                {t('Annotation note')}
              </label>
              <Textarea
                id={`bookmark-note-${id}`}
                autoFocus
                value={draft}
                maxLength={20_000}
                disabled={!available || saving}
                onChange={(event) => setDraft(event.target.value)}
              />
            </>
          )}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {deleting
                ? t('Annotation could not be deleted. Try again.')
                : t('Annotation note could not be saved. Try again.')}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-3">
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={!available || saving}
              onClick={deleteAnnotation}
            >
              <Trash2 className="mr-1.5 size-3.5" aria-hidden="true" />
              {t('Delete annotation')}
            </Button>
            {!editing ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={!available || saving}
                onClick={() => setEditing(true)}
              >
                <Pencil className="mr-1.5 size-3.5" aria-hidden="true" />
                {t('Edit annotation note')}
              </Button>
            ) : (
              <div className="flex items-center gap-2">
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
                    void update(id, { note: draft.trim() })
                      .then(() => setOpen(false))
                      .catch(() => setError(true))
                      .finally(() => setSaving(false))
                  }}
                >
                  {t('Save')}
                </Button>
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}
