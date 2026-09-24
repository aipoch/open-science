import {
  AUTOMATIC_CLASSIFICATION_RUN_LIMIT,
  AUTOMATIC_CLASSIFICATION_DAY_LIMIT
} from '../../../../shared/classification'
import { SMART_RULE_MAX_LENGTH } from '../../../../shared/smart-collection-rule'
import { formatSmartRule, parseSmartRule, type SmartRuleFields } from './smart-rule-fields'
import { CollectionOptionHelp } from './CollectionOptionHelp'
import { SmartCollectionDraftPreview } from './SmartCollectionDraftPreview'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
  SelectLabel
} from '@/components/ui/select'
import type { SmartScope, SmartEvidenceMode } from '../../../../shared/literature-smart-collections'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { useLiteratureChanges } from './useLiteratureChanges'
import * as Dialog from '@/components/ui/dialog'
import { Info, LoaderCircle, X } from 'lucide-react'
import { forwardRef, useImperativeHandle, useRef, useState, type ReactElement } from 'react'
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
  scopes?: { id: string; name: string; kind: 'project' | 'collection' }[]
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
>(({ onSaved, scopes = [] }, ref) => {
  const { t } = useTranslation()
  const generation = useRef(0)
  const latestRead = useRef(0)
  const [mode, setMode] = useState<CollectionEditorMode>()
  const dialogMode = useRetainedDialogValue(mode)
  const [editingCollection, setEditingCollection] = useState<LiteratureCollectionView>()
  const [smart, setSmart] = useState(false)
  const [scope, setScope] = useState<SmartScope>({ kind: 'library' })
  const scopeMarker = (kind: 'project' | 'collection'): ReactElement => (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 text-[10px] font-semibold leading-4 uppercase',
        kind === 'project' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
      )}
    >
      {kind === 'project' ? t('Project') : t('Collection')}
    </span>
  )
  const [evidenceMode, setEvidenceMode] = useState<SmartEvidenceMode>('abstract')
  const [autoUpdate, setAutoUpdate] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [ruleFields, setRuleFields] = useState<SmartRuleFields>({
    description: '',
    inclusion: '',
    exclusion: ''
  })
  const ruleText = smart ? formatSmartRule(ruleFields) : description
  const ruleLength =
    ruleFields.description.trim().length +
    ruleFields.inclusion.trim().length +
    ruleFields.exclusion.trim().length
  const ruleTooLong = smart
    ? ruleLength > SMART_RULE_MAX_LENGTH
    : description.trim().length > LITERATURE_COLLECTION_DESCRIPTION_MAX_LENGTH
  const ruleMissing = smart && !ruleFields.inclusion.trim()
  const loadRule = (text: string, isSmart: boolean): void => {
    setDescription(text)
    setRuleFields(
      (isSmart && parseSmartRule(text)) || { description: text, inclusion: '', exclusion: '' }
    )
  }
  const ruleChanged =
    smart &&
    mode === 'edit' &&
    editingCollection &&
    (ruleText !== editingCollection.description ||
      JSON.stringify(scope) !==
        JSON.stringify(editingCollection.smartScope ?? { kind: 'library' }) ||
      evidenceMode !== (editingCollection.smartEvidenceMode ?? 'abstract'))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<LiteratureCollectionView>()

  useImperativeHandle(ref, () => ({
    openCreate: () => {
      generation.current += 1
      setSmart(false)
      setEvidenceMode('abstract')
      setAutoUpdate(false)
      setScope({ kind: 'library' })
      setEditingCollection(undefined)
      setName('')
      setDescription('')
      setRuleFields({ description: '', inclusion: '', exclusion: '' })
      setError(undefined)
      setConflict(false)
      setLatest(undefined)
      setMode('create')
    },
    openEdit: (collection) => {
      generation.current += 1
      setSmart(Boolean(collection.smart))
      setScope(collection.smartScope ?? { kind: 'library' })
      setEvidenceMode(collection.smartEvidenceMode ?? 'abstract')
      setAutoUpdate(collection.smartAutoUpdate ?? false)
      setEditingCollection(collection)
      setName(collection.name)
      loadRule(collection.description, Boolean(collection.smart))
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
    if (!trimmedName || saving || !mode || conflict || ruleMissing || ruleTooLong) return
    if (mode === 'edit' && !editingCollection) return

    setSaving(true)
    setError(undefined)
    try {
      const trimmedDescription = ruleText.trim()
      let createdId: string | undefined
      if (mode === 'create') {
        const receipt = await window.api.literature.transact(
          smart
            ? {
                kind: 'create-smart-collection',
                name: trimmedName,
                description: trimmedDescription,
                scope,
                evidenceMode,
                autoUpdate
              }
            : { kind: 'create-collection', name: trimmedName, description: trimmedDescription }
        )
        createdId = receipt.id
      } else if (editingCollection) {
        await window.api.literature.transact({
          kind: 'update-collection',
          ...(smart
            ? { smartScope: scope, smartEvidenceMode: evidenceMode, smartAutoUpdate: autoUpdate }
            : {}),
          expectedRevision: editingCollection.revision,
          collectionId: editingCollection.id,
          name: trimmedName,
          description: trimmedDescription
        })
      }
      setMode(undefined)
      onSaved({
        id: mode === 'edit' ? editingCollection?.id : createdId,
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
          className={dialogPanelClassName(
            cn(
              'max-h-[calc(100svh-2rem)] overflow-hidden p-0',
              smart ? 'w-[min(720px,calc(100vw-2rem))]' : 'w-[min(500px,calc(100vw-2rem))]'
            )
          )}
        >
          <form
            className="flex max-h-[calc(100svh-2rem)] min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <Dialog.Title className={dialogTitleClassName}>
                  {dialogMode === 'create' ? t('New collection') : t('Edit collection')}
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
            <div className="min-h-0 flex-1 overflow-y-auto">
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
                {(dialogMode === 'create' || smart) && (
                  <div className="space-y-3">
                    {dialogMode === 'create' && (
                      <div className="flex items-center justify-between gap-4 py-1">
                        <label htmlFor="collection-form-smart" className="text-sm">
                          {t('Smart collection')}
                        </label>
                        <Switch
                          id="collection-form-smart"
                          checked={smart}
                          disabled={saving}
                          onCheckedChange={setSmart}
                        />
                      </div>
                    )}
                    {smart && (
                      <div>
                        <label className={dialogFormLabelClassName} htmlFor="collection-form-scope">
                          {t('Scope')}
                        </label>
                        <Select
                          disabled={saving}
                          value={JSON.stringify(scope)}
                          onValueChange={(value) => setScope(JSON.parse(value))}
                        >
                          <SelectTrigger
                            id="collection-form-scope"
                            aria-label={t('Scope')}
                            className="w-full"
                          >
                            <SelectValue>
                              {scope.kind === 'library' ? (
                                t('All references')
                              ) : (
                                <span className="flex items-center gap-2">
                                  {scopeMarker(scope.kind)}
                                  <span className="truncate">
                                    {scopes.find(
                                      (entry) => entry.kind === scope.kind && entry.id === scope.id
                                    )?.name ?? t('Unavailable')}
                                  </span>
                                </span>
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={JSON.stringify({ kind: 'library' })}>
                              {t('All references')}
                            </SelectItem>
                            {scope.kind !== 'library' &&
                              !scopes.some(
                                (entry) => entry.kind === scope.kind && entry.id === scope.id
                              ) && (
                                <SelectItem value={JSON.stringify(scope)} disabled>
                                  {t('Unavailable')}
                                </SelectItem>
                              )}
                            {(['project', 'collection'] as const).map((kind) => (
                              <SelectGroup key={kind}>
                                {scopes.some(
                                  (entry) =>
                                    entry.kind === kind && entry.id !== editingCollection?.id
                                ) && (
                                  <SelectLabel>
                                    {kind === 'project' ? t('Projects') : t('Collections')}
                                  </SelectLabel>
                                )}
                                {scopes
                                  .filter(
                                    (entry) =>
                                      entry.kind === kind && entry.id !== editingCollection?.id
                                  )
                                  .map((entry) => (
                                    <SelectItem
                                      key={entry.id}
                                      value={JSON.stringify({ kind, id: entry.id })}
                                      textValue={entry.name}
                                    >
                                      <span className="inline-flex items-center gap-2">
                                        {scopeMarker(kind)} {entry.name}
                                      </span>
                                    </SelectItem>
                                  ))}
                              </SelectGroup>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                )}
                {smart ? (
                  <div className="space-y-4">
                    <div>
                      <label
                        className={dialogFormLabelClassName}
                        htmlFor="collection-rule-background"
                      >
                        {t('Description')}{' '}
                        <span className="font-normal text-muted-foreground">{t('(optional)')}</span>
                      </label>
                      <Textarea
                        id="collection-rule-background"
                        disabled={saving}
                        value={ruleFields.description}
                        onChange={(event) =>
                          setRuleFields({ ...ruleFields, description: event.target.value })
                        }
                        rows={2}
                        maxLength={SMART_RULE_MAX_LENGTH}
                        placeholder={t('Summarize the topic and purpose of this collection…')}
                        className={`${dialogFormTextareaClassName} min-h-16 resize-y`}
                      />
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label
                          className={dialogFormLabelClassName}
                          htmlFor="collection-rule-inclusion"
                        >
                          {t('Inclusion criteria')} <span aria-hidden="true">*</span>
                        </label>
                        <Textarea
                          id="collection-rule-inclusion"
                          aria-required
                          disabled={saving}
                          value={ruleFields.inclusion}
                          onChange={(event) =>
                            setRuleFields({ ...ruleFields, inclusion: event.target.value })
                          }
                          rows={5}
                          maxLength={SMART_RULE_MAX_LENGTH}
                          placeholder={t(
                            'e.g. Adults with hypertension; randomized controlled trials.'
                          )}
                          className={`${dialogFormTextareaClassName} min-h-32 resize-y`}
                        />
                      </div>
                      <div>
                        <label
                          className={dialogFormLabelClassName}
                          htmlFor="collection-rule-exclusion"
                        >
                          {t('Exclusion criteria')}{' '}
                          <span className="font-normal text-muted-foreground">
                            {t('(optional)')}
                          </span>
                        </label>
                        <Textarea
                          id="collection-rule-exclusion"
                          disabled={saving}
                          value={ruleFields.exclusion}
                          onChange={(event) =>
                            setRuleFields({ ...ruleFields, exclusion: event.target.value })
                          }
                          rows={5}
                          maxLength={SMART_RULE_MAX_LENGTH}
                          placeholder={t('e.g. Animal studies, reviews, and study protocols.')}
                          className={`${dialogFormTextareaClassName} min-h-32 resize-y`}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'The description provides context for evaluation. All inclusion criteria must be met, and no exclusion criterion may apply. Unclear results need review.'
                      )}
                    </p>
                    <p
                      role={ruleTooLong ? 'alert' : undefined}
                      className={cn(
                        'text-right text-xs tabular-nums',
                        ruleTooLong ? 'text-destructive' : 'text-muted-foreground'
                      )}
                    >
                      {t('Rule length: {{used}} / {{limit}} characters', {
                        used: ruleLength,
                        limit: SMART_RULE_MAX_LENGTH
                      })}
                    </p>
                  </div>
                ) : (
                  <div>
                    <div className="mb-1 flex items-center gap-1">
                      <label
                        className={cn(dialogFormLabelClassName, 'mb-0')}
                        htmlFor="collection-form-description"
                      >
                        {t('Description')}
                      </label>
                      {
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
                      }
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
                )}
              </div>
              {mode && smart && (
                <div className="px-5 pb-4">
                  <div className="space-y-3 border-t border-border pt-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1">
                          <label htmlFor="collection-full-text" className="text-sm font-medium">
                            {t('Use available full text')}
                          </label>
                          <CollectionOptionHelp label={t('Use available full text')}>
                            {t(
                              'Send text from the primary PDF to the classification service. Long papers use relevant passages; unavailable PDFs fall back to title and abstract.'
                            )}
                          </CollectionOptionHelp>
                        </div>
                        <Switch
                          id="collection-full-text"
                          checked={evidenceMode === 'full-text'}
                          onCheckedChange={(checked) =>
                            setEvidenceMode(checked ? 'full-text' : 'abstract')
                          }
                          disabled={saving}
                        />
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {t('Sends available PDF text to the classification service.')}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1">
                          <label htmlFor="collection-auto-update" className="text-sm font-medium">
                            {t('Update automatically')}
                          </label>
                          <CollectionOptionHelp label={t('Update automatically')}>
                            {t(
                              'Evaluate new or changed references while the app is open. Requests may incur costs. Manual decisions are kept.'
                            )}
                          </CollectionOptionHelp>
                        </div>
                        <Switch
                          id="collection-auto-update"
                          checked={autoUpdate}
                          onCheckedChange={setAutoUpdate}
                          disabled={saving}
                        />
                      </div>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {t('Updates new or changed references; may incur costs.')}
                      </p>
                      {autoUpdate && (
                        <p className="text-xs leading-5 text-muted-foreground">
                          {t(
                            'Automatic updates pause after {{run}} requests per run or {{day}} across all collections in 24 hours. Retries count toward these limits.',
                            {
                              run: AUTOMATIC_CLASSIFICATION_RUN_LIMIT,
                              day: AUTOMATIC_CLASSIFICATION_DAY_LIMIT
                            }
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  <SmartCollectionDraftPreview
                    evidenceMode={evidenceMode}
                    description={ruleMissing || ruleTooLong ? '' : ruleText}
                    scope={scope}
                    disabled={saving || conflict || ruleMissing || ruleTooLong}
                  />
                </div>
              )}
              {error ? (
                <div className="px-5 pb-4">
                  <ErrorNotice
                    inline
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
                                loadRule(latest.description, Boolean(latest.smart))
                                setScope(latest.smartScope ?? { kind: 'library' })
                                setEvidenceMode(latest.smartEvidenceMode ?? 'abstract')
                                setAutoUpdate(latest.smartAutoUpdate ?? false)
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
            </div>
            {ruleChanged && (
              <div
                role="status"
                className="shrink-0 border-t border-border px-5 py-3 text-xs text-muted-foreground space-y-1"
              >
                <p>
                  {t(
                    'Saving creates a new rule version. Existing AI results will need review; manual decisions are kept. Any running evaluation of the old rule will stop.'
                  )}
                </p>
                <p>
                  {autoUpdate
                    ? t('Automatic updates are on. Re-evaluation may incur costs.')
                    : t('Save changes, then update the collection to evaluate the new rule.')}
                </p>
              </div>
            )}
            <div
              className={`${dialogFooterClassName} shrink-0 flex-wrap items-center [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:h-auto [&_button]:min-h-8 [&_button]:py-1`}
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
              <Button
                type="submit"
                disabled={!name.trim() || saving || conflict || ruleMissing || ruleTooLong}
                aria-busy={Boolean(saving)}
              >
                <span key={String(saving)} className="button-feedback">
                  {saving ? (
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : null}
                  {dialogMode === 'create' ? t('Create collection') : t('Save changes')}
                </span>
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
})

CollectionEditorDialog.displayName = 'CollectionEditorDialog'
