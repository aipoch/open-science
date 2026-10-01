import { useId, useState } from 'react'
import { Download, ListChecks, LoaderCircle, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ActionMenuProvider, ActionMenuTarget, useActionMenu } from '@/components/action-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName,
  dialogDescriptionClassName
} from '@/components/ui/dialog-chrome'
import { JournalAlignment } from './JournalAlignment'
import { CollectionOptionHelp } from '../collections/CollectionOptionHelp'
import { LiteratureErrorNotice } from '../LiteratureErrorNotice'
import { journalDatasetLabel, type JournalDataset } from '../../../../../shared/journal-attributes'

function MenuTrigger({
  disabled,
  loading
}: {
  disabled: boolean
  loading: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { openMenu } = useActionMenu()
  return (
    <Button
      variant="outline"
      size="icon"
      disabled={disabled}
      aria-label={t('More actions')}
      aria-busy={loading || undefined}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        openMenu({
          targetId: 'journal-dataset-actions',
          pointer: { x: bounds.right, y: bounds.bottom },
          align: 'end',
          focusTarget: event.currentTarget
        })
      }}
    >
      {loading ? (
        <LoaderCircle
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <MoreHorizontal className="size-4" aria-hidden="true" />
      )}
    </Button>
  )
}

export function JournalDatasetActions({
  dataset,
  disabled,
  loading = false,
  onRenamed,
  onDelete,
  onExport,
  onOpenItem
}: {
  dataset: JournalDataset
  disabled: boolean
  loading?: boolean
  onRenamed: (datasets: JournalDataset[]) => void
  onExport?: () => void
  onDelete: () => void
  onOpenItem: (id: string, initiator?: HTMLElement) => void | Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const inputId = useId()
  const descriptionId = useId()
  const [mode, setMode] = useState<'rename' | 'alignment'>()
  const [draft, setDraft] = useState('')
  const [source, setSource] = useState('')
  const [year, setYear] = useState('')
  const valid = Boolean(
    draft.trim() &&
    source.trim() &&
    /^\d{4}$/.test(year) &&
    Number(year) >= 1800 &&
    Number(year) <= 9999
  )
  const [revision, setRevision] = useState(dataset.revision)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const save = async (): Promise<void> => {
    if (saving || !valid || draft.trim().length > 100) return
    setSaving(true)
    setError('')
    try {
      const result = await window.api.literature.journals({
        action: 'rename',
        datasetId: dataset.id,
        expectedRevision: revision,
        name: draft.trim(),
        source: source.trim(),
        year: Number(year)
      })
      onRenamed(result.datasets ?? [])
      setMode(undefined)
    } catch (error) {
      setError(
        error instanceof Error &&
          error.message.includes('Journal data changed. Reload the dataset.')
          ? t('Journal data changed. Reload the dataset.')
          : error instanceof Error &&
              error.message.includes('A dataset with this source and year already exists.')
            ? t('A dataset with this source and year already exists.')
            : t('Could not save changes.')
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <ActionMenuProvider>
        <ActionMenuTarget
          asChild
          targetId="journal-dataset-actions"
          identityKey={dataset.id}
          invocation={dataset}
          catalog={{
            rename: { labelKey: 'Edit dataset', icon: Pencil },
            alignment: { labelKey: 'Journal alignment', icon: ListChecks },
            export: { labelKey: 'Export journal bundle', icon: Download },
            remove: { labelKey: 'Delete', icon: Trash2, danger: true }
          }}
          recipe={[
            { kind: 'action', action: 'rename' },
            { kind: 'action', action: 'alignment' },
            { kind: 'action', action: 'export' },
            { kind: 'separator' },
            { kind: 'action', action: 'remove' }
          ]}
          bindings={{
            rename: {
              disabled,
              execute: (current) => {
                setDraft(journalDatasetLabel(current))
                setSource(current.source)
                setYear(String(current.year))
                setRevision(current.revision)
                setError('')
                setMode('rename')
              }
            },
            alignment: { disabled, execute: () => setMode('alignment') },
            export: { disabled: disabled || !onExport, execute: () => onExport?.() },
            remove: { disabled, execute: onDelete }
          }}
        >
          <div className="shrink-0">
            <MenuTrigger disabled={disabled} loading={loading} />
          </div>
        </ActionMenuTarget>
      </ActionMenuProvider>
      <Dialog.Root
        open={Boolean(mode)}
        onOpenChange={(open) => !open && !saving && setMode(undefined)}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            aria-describedby={mode === 'rename' ? descriptionId : undefined}
            onInteractOutside={(event) => {
              // Reference details are a sibling dialog; closing them must preserve this scan.
              if (mode === 'alignment') event.preventDefault()
            }}
            className={dialogPanelClassName(
              mode === 'alignment'
                ? 'flex max-h-[min(760px,calc(100dvh-2rem))] has-[table]:h-[min(760px,calc(100dvh-2rem))] w-[min(1100px,calc(100vw-2rem))] flex-col overflow-hidden'
                : 'w-[min(440px,calc(100vw-2rem))]'
            )}
          >
            <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
              <Dialog.Title className={dialogTitleClassName}>
                {mode === 'rename' ? t('Edit dataset') : t('Journal alignment')}
              </Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" disabled={saving} aria-label={t('Close')}>
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>
            {mode === 'rename' ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void save()
                }}
              >
                <Dialog.Description id={descriptionId} className={dialogDescriptionClassName}>
                  {t(
                    'Edit the name, source and metric year. References show the latest year for each source.'
                  )}
                </Dialog.Description>
                <div className="mb-1 mt-4 flex items-center gap-1">
                  <label htmlFor={inputId} className="text-sm font-medium">
                    {t('Name')}
                  </label>
                  <CollectionOptionHelp label={t('Name')}>
                    {t(
                      'Display name for this dataset. Changing it does not change the source or metric year.'
                    )}
                  </CollectionOptionHelp>
                </div>
                <Input
                  autoFocus
                  id={inputId}
                  value={draft}
                  maxLength={100}
                  disabled={saving}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className="mt-4 grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <label htmlFor={`${inputId}-source`} className="text-sm font-medium">
                        {t('Source')}
                      </label>
                      <CollectionOptionHelp label={t('Source')}>
                        {t(
                          'Groups datasets by source. References use the latest metric year for each source.'
                        )}
                      </CollectionOptionHelp>
                    </div>
                    <Input
                      id={`${inputId}-source`}
                      value={source}
                      maxLength={100}
                      disabled={saving}
                      onChange={(event) => setSource(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <label htmlFor={`${inputId}-year`} className="text-sm font-medium">
                        {t('Metric year')}
                      </label>
                      <CollectionOptionHelp label={t('Metric year')}>
                        {t('Year the values describe; it can differ from the file release year.')}
                      </CollectionOptionHelp>
                    </div>
                    <Input
                      id={`${inputId}-year`}
                      value={year}
                      inputMode="numeric"
                      maxLength={4}
                      disabled={saving}
                      onChange={(event) => setYear(event.target.value)}
                    />
                  </div>
                </div>
                {error ? (
                  <div className="mt-3">
                    <LiteratureErrorNotice tone="amber" title={error} />
                  </div>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={() => setMode(undefined)}
                  >
                    {t('Cancel')}
                  </Button>
                  <Button type="submit" disabled={saving || !valid} aria-busy={saving}>
                    {saving ? (
                      <LoaderCircle
                        className="size-4 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : null}
                    {saving ? t('Saving…') : t('Save')}
                  </Button>
                </div>
              </form>
            ) : mode === 'alignment' ? (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <JournalAlignment expanded onOpenItem={onOpenItem} />
              </div>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
