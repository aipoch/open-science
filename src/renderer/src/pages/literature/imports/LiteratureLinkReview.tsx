import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import type { LiteratureDuplicatePolicy } from '@aipoch/literature-library/contracts'
import type { LiteratureItemInput } from '@aipoch/literature-library/item'
import { LoaderCircle } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LiteratureMetadataEditor } from '../detail/LiteratureMetadataEditor'
import { fullCreatorLabel } from '../literature-item-display'
import { LiteratureDuplicatePolicyField } from './LiteratureDuplicatePolicyField'

// Object key order is not a metadata change when the editor rebuilds creator records.
const metadataSnapshot = (item: LiteratureItemInput): string =>
  JSON.stringify(item, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        )
      : value
  )

export function LiteratureLinkReview({
  item,
  saving,
  createdItemId,
  error,
  duplicatePolicy,
  onDuplicatePolicyChange,
  onDirtyChange,
  onCancel,
  onSave,
  onRetry
}: {
  item: LiteratureItemInput
  saving: boolean
  createdItemId: string | undefined
  error: string | undefined
  duplicatePolicy: LiteratureDuplicatePolicy
  onDuplicatePolicyChange: (policy: LiteratureDuplicatePolicy) => void
  onDirtyChange: (dirty: boolean) => void
  onCancel: () => void
  onSave: (item: LiteratureItemInput) => void
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [initialItem, setInitialItem] = useState(item)
  const [draft, setDraft] = useState(item)
  const [editing, setEditing] = useState(false)
  const [editorDirty, setEditorDirty] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)

  // A new lookup starts a new review, even if the previous dialog is still exiting.
  if (item !== initialItem) {
    setInitialItem(item)
    setDraft(item)
    setEditing(false)
    setEditorDirty(false)
  }
  const dirty = editorDirty || metadataSnapshot(draft) !== metadataSnapshot(initialItem)
  useLayoutEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])
  useLayoutEffect(() => {
    if (!editing) editButton.current?.focus()
  }, [editing])

  if (editing) {
    return (
      <LiteratureMetadataEditor
        item={draft}
        saving={saving}
        error={error}
        className="min-h-0"
        saveLabel={t('Back to review')}
        onDirtyChange={setEditorDirty}
        onCancel={onCancel}
        onSave={(edited) => {
          setDraft(edited)
          setEditorDirty(false)
          setEditing(false)
        }}
      />
    )
  }

  const locked = saving || Boolean(createdItemId)
  return (
    <div className="flex min-h-0 min-w-0 flex-col text-sm">
      <div className="min-h-0 space-y-4 overflow-y-auto p-5">
        <h3 className="text-base leading-6 font-semibold wrap-anywhere whitespace-pre-wrap">
          {draft.title}
        </h3>
        <dl className="space-y-3">
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t('Creators')}</dt>
            <dd className="wrap-anywhere">{fullCreatorLabel(draft) || t('Unknown')}</dd>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            <div className="space-y-1">
              <dt className="text-xs text-muted-foreground">{t('Year')}</dt>
              <dd>{draft.issuedYear ?? (draft.issuedText || t('Unknown'))}</dd>
            </div>
            {draft.containerTitle ? (
              <div className="min-w-0 flex-1 basis-40 space-y-1">
                <dt className="text-xs text-muted-foreground">{t('Publication')}</dt>
                <dd className="wrap-anywhere">{draft.containerTitle}</dd>
              </div>
            ) : null}
          </div>
          <div className="space-y-1">
            <dt className="text-xs text-muted-foreground">{t('Identifiers')}</dt>
            <dd className="space-y-1.5">
              {draft.identifiers.length ? (
                draft.identifiers.map((identifier, index) => (
                  <div key={index} className="flex flex-wrap gap-x-2">
                    <span className="text-muted-foreground">{identifier.scheme.toUpperCase()}</span>
                    <span className="min-w-0 wrap-anywhere">{identifier.value}</span>
                  </div>
                ))
              ) : (
                <span>{t('Unknown')}</span>
              )}
            </dd>
          </div>
        </dl>
      </div>
      <div className="shrink-0 space-y-4 border-t border-border-300/80 bg-background px-5 py-3">
        {error ? <ErrorNotice inline role="alert" description={error} /> : null}
        <LiteratureDuplicatePolicyField
          value={duplicatePolicy}
          onChange={onDuplicatePolicyChange}
          disabled={locked}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
            {createdItemId ? t('Close') : t('Cancel')}
          </Button>
          <Button
            ref={editButton}
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() => setEditing(true)}
          >
            {t('Edit details')}
          </Button>
          <Button
            type="button"
            disabled={saving || (!createdItemId && !draft.title.trim())}
            aria-busy={saving}
            onClick={() => {
              if (saving) return
              if (createdItemId) onRetry()
              else onSave(draft)
            }}
          >
            {saving ? (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : null}
            {saving
              ? createdItemId
                ? t('Retrying…')
                : t('Saving…')
              : createdItemId
                ? t('Retry')
                : t('Save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
