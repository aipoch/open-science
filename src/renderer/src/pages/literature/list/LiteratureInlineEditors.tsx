import { Star } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { LiteratureItemType, LiteratureItemView } from '../../../../../shared/literature'

export function LiteratureRatingControl({
  value,
  labels,
  disabled = false,
  onCommit
}: Readonly<{
  disabled?: boolean
  value: number
  labels: readonly string[]
  onCommit: (rating: number) => Promise<void>
}>): React.JSX.Element {
  const [rating, setRating] = useState(value)
  const [isSaving, setIsSaving] = useState(false)

  const commitRating = async (nextRating: number): Promise<void> => {
    if (isSaving) return
    const previousRating = rating
    setRating(nextRating)
    setIsSaving(true)
    try {
      await onCommit(nextRating)
    } catch {
      setRating(previousRating)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex items-center gap-0.5" aria-busy={isSaving}>
      {[1, 2, 3, 4, 5].map((option) => {
        const active = option <= rating
        return (
          <button
            key={option}
            type="button"
            disabled={isSaving || disabled}
            aria-label={labels[option - 1]}
            aria-pressed={active}
            className="rounded-sm p-0.5 text-muted-foreground outline-none transition-colors hover:text-amber-500 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
            onClick={() => void commitRating(rating === option ? 0 : option)}
          >
            <Star
              className={cn(
                'size-3.5',
                active && 'fill-amber-400 text-amber-500 dark:fill-amber-400 dark:text-amber-400'
              )}
              aria-hidden="true"
            />
          </button>
        )
      })}
    </div>
  )
}

export function LiteratureTypeControl({
  value,
  title,
  labels,
  disabled = false,
  onCommit
}: Readonly<{
  disabled?: boolean
  value: LiteratureItemType
  title: string
  labels: Record<LiteratureItemType, string>
  onCommit: (itemType: LiteratureItemType) => Promise<void>
}>): React.JSX.Element {
  const { t } = useTranslation()
  const [itemType, setItemType] = useState(value)
  const [isSaving, setIsSaving] = useState(false)

  const commitItemType = async (nextItemType: LiteratureItemType): Promise<void> => {
    if (isSaving || nextItemType === itemType) return
    const previousItemType = itemType
    setItemType(nextItemType)
    setIsSaving(true)
    try {
      await onCommit(nextItemType)
    } catch {
      setItemType(previousItemType)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Select
      value={itemType}
      disabled={isSaving || disabled}
      onValueChange={(nextValue) => void commitItemType(nextValue as LiteratureItemType)}
    >
      <SelectTrigger
        aria-label={`${t('Reference type')}: ${title}`}
        aria-busy={isSaving}
        className="h-7 w-full border-transparent bg-transparent px-1.5 text-xs hover:border-border hover:bg-muted"
      >
        <SelectValue>{labels[itemType]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {Object.entries(labels).map(([option, label]) => (
          <SelectItem key={option} value={option}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function LiteratureNoteControl({
  entry,
  disabled = false,
  onCommit
}: Readonly<{
  disabled?: boolean
  entry: LiteratureItemView
  onCommit: (
    base: LiteratureItemView,
    note: string,
    onPersisted: (reload: () => Promise<LiteratureItemView>) => void
  ) => Promise<void>
}>): React.JSX.Element {
  const { t } = useTranslation()
  const [edit, setEdit] = useState<{ base: LiteratureItemView; draft: string }>()
  const [isSaving, setIsSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const savingRef = useRef(false)
  const recoveryRef = useRef<
    { note: string; reload: () => Promise<LiteratureItemView> } | undefined
  >(undefined)
  const cancelNextBlurRef = useRef(false)
  const dirty = edit !== undefined && edit.draft !== (edit.base.item.personalNote ?? '')
  // A dirty draft keeps its original full item and revision, including across rating refreshes.
  const base = dirty ? edit.base : entry
  const draft = dirty ? edit.draft : (entry.item.personalNote ?? '')

  const commitNote = async (): Promise<void> => {
    if (cancelNextBlurRef.current) {
      cancelNextBlurRef.current = false
      return
    }
    if (disabled || savingRef.current) return
    const note = draft.trim()
    if (!recoveryRef.current && note === (base.item.personalNote ?? '')) {
      setEdit(undefined)
      setFailed(false)
      return
    }
    savingRef.current = true
    setIsSaving(true)
    try {
      const recovery = recoveryRef.current
      if (recovery) {
        const updated = await recovery.reload()
        // New typing during recovery remains a draft. Only rebase it when the saved note
        // still matches our acknowledged write; otherwise retain conflict protection.
        setEdit(
          note === recovery.note
            ? undefined
            : {
                base: (updated.item.personalNote ?? '') === recovery.note ? updated : base,
                draft
              }
        )
      } else {
        await onCommit(base, note, (reload) => {
          recoveryRef.current = { note, reload }
        })
        setEdit(undefined)
      }
      recoveryRef.current = undefined
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      savingRef.current = false
      setIsSaving(false)
    }
  }

  return (
    <div>
      <Input
        value={draft}
        readOnly={isSaving || disabled}
        aria-label={t('Note for {{title}}', { title: entry.item.title })}
        aria-busy={isSaving}
        aria-invalid={failed || undefined}
        placeholder={t('Add a note…')}
        className="h-8 border-transparent bg-transparent px-2 text-xs placeholder:text-muted-foreground/70 hover:border-border hover:bg-bg-100 focus-visible:border-border focus-visible:bg-bg-000"
        onFocus={() => {
          if (disabled) return
          if (!dirty) setEdit({ base: entry, draft: entry.item.personalNote ?? '' })
        }}
        onChange={(event) => setEdit({ base, draft: event.currentTarget.value })}
        onKeyDown={(event) => {
          if (isSaving || event.nativeEvent.isComposing) return
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            cancelNextBlurRef.current = true
            setEdit(undefined)
            setFailed(false)
            event.currentTarget.blur()
          }
        }}
        onBlur={() => {
          if (!disabled) void commitNote()
        }}
      />
      {failed ? (
        <div className="flex items-center gap-2 px-2 text-xs text-status-warning-foreground">
          <p
            role="alert"
            className="whitespace-normal [overflow-wrap:anywhere]"
            title={t('Draft preserved. Escape to discard.')}
          >
            {t('Draft preserved. Escape to discard.')}
          </p>
          <button
            type="button"
            className="shrink-0 underline"
            disabled={isSaving || disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void commitNote()}
          >
            {t('Retry')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
