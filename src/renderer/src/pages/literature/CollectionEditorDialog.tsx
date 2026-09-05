import * as Dialog from '@/components/ui/dialog'
import { Info, LoaderCircle, X } from 'lucide-react'
import { forwardRef, useImperativeHandle, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogFooterClassName,
  dialogFormInputClassName,
  dialogFormLabelClassName,
  dialogFormTextareaClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { LiteratureCollectionView } from '../../../../shared/literature'
import {
  LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH,
  LITERATURE_COLLECTION_NAME_MAX_LENGTH
} from '../../../../shared/literature'

type CollectionEditorMode = 'create' | 'edit'

export type CollectionEditorDialogHandle = {
  openCreate: () => void
  openEdit: (collection: LiteratureCollectionView) => void
}

type CollectionEditorDialogProps = {
  onSaved: (collection: { id?: string; name: string; description: string }) => void
}

export const CollectionEditorDialog = forwardRef<
  CollectionEditorDialogHandle,
  CollectionEditorDialogProps
>(({ onSaved }, ref) => {
  const { t } = useTranslation()
  const [mode, setMode] = useState<CollectionEditorMode>()
  const [editingCollection, setEditingCollection] = useState<LiteratureCollectionView>()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  useImperativeHandle(ref, () => ({
    openCreate: () => {
      setEditingCollection(undefined)
      setName('')
      setDescription('')
      setError(undefined)
      setMode('create')
    },
    openEdit: (collection) => {
      setEditingCollection(collection)
      setName(collection.name)
      setDescription(collection.description)
      setError(undefined)
      setMode('edit')
    }
  }))

  const close = (): void => {
    if (!saving) setMode(undefined)
  }

  const save = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (!trimmedName || saving || !mode) return
    if (mode === 'edit' && !editingCollection) return

    setSaving(true)
    setError(undefined)
    try {
      const trimmedDescription = description.trim()
      if (mode === 'create') {
        await window.api.literature.transact({
          kind: 'create-collection',
          name: trimmedName,
          description: trimmedDescription
        })
      } else if (editingCollection) {
        await window.api.literature.transact({
          kind: 'update-collection',
          collectionId: editingCollection.id,
          name: trimmedName,
          description: trimmedDescription
        })
      }
      setMode(undefined)
      onSaved({
        id: mode === 'edit' ? editingCollection?.id : undefined,
        name: trimmedName,
        description: trimmedDescription
      })
    } catch {
      setError(
        mode === 'create'
          ? t('Collection could not be created.')
          : t('Collection could not be updated.')
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog.Root
      open={Boolean(mode)}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          onInteractOutside={(event) => {
            if (saving) event.preventDefault()
          }}
          className={dialogPanelClassName('w-[min(460px,calc(100vw-2rem))] p-0')}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <Dialog.Title className={dialogTitleClassName}>
                  {mode === 'create' ? t('New collection') : t('Edit collection')}
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  {t('Organize references with a name and optional description.')}
                </Dialog.Description>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={dialogCloseButtonClassName}
                aria-label={t('Close')}
                disabled={saving}
                onClick={close}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            <div className={`${dialogBodyClassName} space-y-4`}>
              <div>
                <label className={dialogFormLabelClassName} htmlFor="collection-form-name">
                  {t('Name')}
                </label>
                <Input
                  id="collection-form-name"
                  aria-required={true}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('Collection name')}
                  autoFocus
                  maxLength={LITERATURE_COLLECTION_NAME_MAX_LENGTH}
                  className={`${dialogFormInputClassName} h-9 px-3 text-sm`}
                />
              </div>
              <div>
                <div className="mb-1 flex items-center gap-1">
                  <label
                    className={cn(dialogFormLabelClassName, 'mb-0')}
                    htmlFor="collection-form-description"
                  >
                    {t('Description')}
                  </label>
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={t(
                            "Shown in the Library for your reference — not included in the agent's prompt."
                          )}
                        >
                          <Info className="size-3.5" aria-hidden="true" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-72">
                        {t(
                          "Shown in the Library for your reference — not included in the agent's prompt."
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <Textarea
                  id="collection-form-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('Describe what this collection is for…')}
                  rows={3}
                  maxLength={LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH}
                  className={`${dialogFormTextareaClassName} min-h-24 resize-y`}
                />
              </div>
            </div>
            {error ? (
              <p className="px-5 pb-4 text-sm text-danger-000" role="alert">
                {error}
              </p>
            ) : null}
            <div className={dialogFooterClassName}>
              <Button
                type="button"
                variant="ghost"
                className={dialogCancelButtonClassName}
                disabled={saving}
                onClick={close}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim() || saving}>
                {saving ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {mode === 'create' ? t('Create collection') : t('Save changes')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
})

CollectionEditorDialog.displayName = 'CollectionEditorDialog'
