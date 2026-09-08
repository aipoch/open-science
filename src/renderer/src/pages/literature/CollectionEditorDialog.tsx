import { useLiteratureChanges } from './useLiteratureChanges'
import * as Dialog from '@/components/ui/dialog'
import { Info, LoaderCircle, X } from 'lucide-react'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ErrorNotice } from '@/components/error-notice'
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
  LITERATURE_COLLECTION_NAME_CONFLICT,
  LITERATURE_COLLECTION_REVISION_CONFLICT,
  LITERATURE_COLLECTION_NAME_MAX_LENGTH
} from '../../../../shared/literature'

type CollectionEditorMode = 'create' | 'edit'

export type CollectionEditorDialogHandle = {
  openCreate: () => void
  openEdit: (collection: LiteratureCollectionView) => void
}

type CollectionEditorDialogProps = {
  onSaved: (collection: {
    id?: string
    revision?: number
    name: string
    description: string
  }) => void
}

export const CollectionEditorDialog = forwardRef<
  CollectionEditorDialogHandle,
  CollectionEditorDialogProps
>(({ onSaved }, ref) => {
  const { t } = useTranslation()
  const generation = useRef(0)
  const latestRead = useRef(0)
  const [mode, setMode] = useState<CollectionEditorMode>()
  const [editingCollection, setEditingCollection] = useState<LiteratureCollectionView>()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<LiteratureCollectionView>()

  useImperativeHandle(ref, () => ({
    openCreate: () => {
      generation.current += 1
      setEditingCollection(undefined)
      setName('')
      setDescription('')
      setError(undefined)
      setConflict(false)
      setLatest(undefined)
      setMode('create')
    },
    openEdit: (collection) => {
      generation.current += 1
      setEditingCollection(collection)
      setName(collection.name)
      setDescription(collection.description)
      setError(undefined)
      setConflict(false)
      setLatest(undefined)
      setMode('edit')
    }
  }))

  const close = (): void => {
    if (!saving) {
      generation.current += 1
      setMode(undefined)
    }
  }

  const readLatest = async (checkForChanges = false): Promise<void> => {
    const opening = generation.current
    const request = ++latestRead.current
    if (!editingCollection) return
    try {
      let offset = 0
      for (;;) {
        const page = await window.api.literature.search({
          scope: 'collections',
          offset,
          limit: 100
        })
        if (opening !== generation.current || request !== latestRead.current) return
        const found = page.entries.find(
          (entry): entry is LiteratureCollectionView =>
            'revision' in entry && entry.id === editingCollection.id
        )
        if (found) {
          if (checkForChanges && found.revision === editingCollection.revision) return
          setConflict(true)
          setError('This collection changed. Your edits have been kept.')
          setLatest(found)
          return
        }
        if (page.nextOffset === undefined) break
        offset = page.nextOffset
      }
      setConflict(true)
      setLatest(undefined)
      setError('This collection no longer exists. Your edits have been kept.')
    } catch {
      if (opening !== generation.current || request !== latestRead.current) return
      setError('The latest collection could not be loaded. Your edits have been kept.')
    }
  }

  useLiteratureChanges(() => {
    if (mode === 'edit' && !saving) void readLatest(true)
  })

  const save = async (): Promise<void> => {
    const trimmedName = name.trim()
    if (!trimmedName || saving || !mode || conflict) return
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
          expectedRevision: editingCollection.revision,
          collectionId: editingCollection.id,
          name: trimmedName,
          description: trimmedDescription
        })
      }
      setMode(undefined)
      onSaved({
        id: mode === 'edit' ? editingCollection?.id : undefined,
        // A successful compare-and-swap increments the submitted revision exactly once.
        revision: mode === 'edit' && editingCollection ? editingCollection.revision + 1 : undefined,
        name: trimmedName,
        description: trimmedDescription
      })
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(LITERATURE_COLLECTION_REVISION_CONFLICT)
      ) {
        setConflict(true)
        setError('This collection changed. Your edits have been kept.')
        await readLatest()
        return
      }
      setError(
        error instanceof Error && error.message.includes(LITERATURE_COLLECTION_NAME_CONFLICT)
          ? 'name-conflict'
          : mode === 'create'
            ? 'create-failed'
            : 'update-failed'
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
                  disabled={saving}
                  aria-required={true}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('Collection name')}
                  autoFocus
                  maxLength={LITERATURE_COLLECTION_NAME_MAX_LENGTH}
                  className={`${dialogFormInputClassName} h-8 px-3 text-sm`}
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
                  disabled={saving}
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
              <div className="px-5 pb-4">
                <ErrorNotice
                  role="alert"
                  tone="amber"
                  description={
                    error === 'name-conflict'
                      ? t(
                          'A collection with this name already exists at this level. Choose another name.'
                        )
                      : error === 'create-failed'
                        ? t('Collection could not be created.')
                        : error === 'update-failed'
                          ? t('Collection could not be updated.')
                          : error === 'This collection changed. Your edits have been kept.'
                            ? t('This collection changed. Your edits have been kept.')
                            : error ===
                                'This collection no longer exists. Your edits have been kept.'
                              ? t('This collection no longer exists. Your edits have been kept.')
                              : t(
                                  'The latest collection could not be loaded. Your edits have been kept.'
                                )
                  }
                  secondaryButton={
                    conflict
                      ? latest
                        ? {
                            label: t('Load latest version'),
                            description: t(
                              'Replace your unsaved edits with the latest saved collection.'
                            ),
                            onClick: () => {
                              latestRead.current += 1
                              setEditingCollection(latest)
                              setName(latest.name)
                              setDescription(latest.description)
                              setConflict(false)
                              setLatest(undefined)
                              setError(undefined)
                            }
                          }
                        : {
                            label: t('Retry'),
                            onClick: () => {
                              void readLatest()
                            }
                          }
                      : undefined
                  }
                >
                  {latest ? (
                    <div className="min-w-0 space-y-1 text-sm break-words">
                      <p className="font-medium">{t('Latest saved version')}</p>
                      <p>{latest.name}</p>
                      <p className="whitespace-pre-wrap">{latest.description}</p>
                    </div>
                  ) : null}
                </ErrorNotice>
              </div>
            ) : null}
            <div
              className={`${dialogFooterClassName} flex-wrap items-center [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:h-auto [&_button]:min-h-8 [&_button]:py-1`}
            >
              <Button
                type="button"
                variant="ghost"
                className={dialogCancelButtonClassName}
                disabled={saving}
                onClick={close}
              >
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim() || saving || conflict}>
                {saving ? (
                  <LoaderCircle
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
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
