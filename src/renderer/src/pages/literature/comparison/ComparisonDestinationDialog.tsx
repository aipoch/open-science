import { ChevronRight, Info } from 'lucide-react'
import { Collapsible } from 'radix-ui'
import { useEffect, useRef, useState } from 'react'
import { useLiteratureHost } from '../renderer-host'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'
import {
  dialogPanelClassName,
  dialogOverlayClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogBodyClassName,
  dialogFooterClassName
} from '@/components/ui/dialog-chrome'
import type {
  ComparisonRequest,
  ComparisonTableSummary,
  ComparisonResult
} from '../../../../../shared/literature-comparison'

function ContextHelp({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="size-6 text-muted-foreground"
          aria-label={label}
        >
          <Info aria-hidden="true" className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={label}
        className="max-w-[min(18rem,85vw)] leading-relaxed"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

export function ComparisonDestinationDialog({
  tables,
  mode = 'create',
  itemIds,
  command,
  onClose,
  onAdded
}: {
  mode?: 'create' | 'existing'
  tables: Pick<ComparisonTableSummary, 'id' | 'name'>[]
  itemIds: string[]
  command: (request: ComparisonRequest) => Promise<ComparisonResult>
  onClose: () => void
  onAdded: (id: string) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { api } = useLiteratureHost()
  const getReference = api.literature.get
  const [destination, setDestination] = useState(tables[0]?.id ?? '')
  const nameInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [sourcePolicy, setSourcePolicy] = useState<'abstract' | 'full-text'>('full-text')
  const [template, setTemplate] = useState('clinical')
  const startingFields = (): { id: string; name: string; rule: string }[] => [
    {
      id: crypto.randomUUID(),
      name: t('Outcome and time point'),
      rule: t('Report the primary outcome measure and assessment time point.')
    },
    {
      id: crypto.randomUUID(),
      name: t('Primary outcome results'),
      rule: t(
        'Report the primary outcome results by group, including effect estimates and uncertainty. Do not infer missing values.'
      )
    },
    {
      id: crypto.randomUUID(),
      name: t('Analysis population'),
      rule: t(
        'Report the number analyzed in each group, the analysis population and time point. Do not substitute randomized counts.'
      )
    }
  ]
  const [fields, setFields] = useState(startingFields)
  const [fieldsExpanded, setFieldsExpanded] = useState(false)
  const editFields = (update: (current: typeof fields) => typeof fields): void => {
    setTemplate('custom')
    setFields(update)
  }
  const [sourceRetry, setSourceRetry] = useState(0)
  const selectionKey = JSON.stringify(itemIds)
  const lookupKey = `${selectionKey}:${sourceRetry}`
  const [lookup, setLookup] = useState<{
    key: string
    value?: { pdf: number; missing: number; abstract: number }
    error?: boolean
  }>()
  const sources = lookup?.key === lookupKey ? lookup.value : undefined
  const sourceError = lookup?.key === lookupKey && lookup.error
  useEffect(() => {
    if (mode !== 'create') return
    let active = true
    void Promise.all((JSON.parse(selectionKey) as string[]).map((id) => getReference(id))).then(
      (items) => {
        if (!active) return
        if (items.some((item) => !item)) {
          setLookup({ key: lookupKey, error: true })
          return
        }
        const pdf = items.filter((item) =>
          item!.attachments.some((attachment) =>
            attachment.versions.some((version) => version.contentType === 'application/pdf')
          )
        ).length
        setLookup({
          key: lookupKey,
          value: {
            pdf,
            missing: items.length - pdf,
            abstract: items.filter((item) => Boolean(item!.item.abstract?.trim())).length
          }
        })
      },
      () => {
        if (active) setLookup({ key: lookupKey, error: true })
      }
    )
    return () => {
      active = false
    }
  }, [getReference, selectionKey, mode, lookupKey])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    setError(false)
    try {
      const result = await command(
        mode === 'create'
          ? {
              action: 'create',
              name: name.trim(),
              language: i18n.resolvedLanguage ?? i18n.language,
              sourcePolicy,
              fields: fields.map((field) => ({
                ...field,
                name: field.name.trim(),
                rule: field.rule.trim()
              })),
              itemIds
            }
          : { action: 'add-members', tableId: destination, itemIds }
      )
      onAdded(result.tables[0].id)
      onClose()
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          onOpenAutoFocus={(event) => {
            if (nameInput.current) {
              event.preventDefault()
              nameInput.current.focus()
            }
          }}
          className={dialogPanelClassName(
            'flex max-h-[85svh] w-[min(36rem,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>
              {mode === 'create'
                ? t('Create comparison table')
                : t('Add to existing comparison table')}
            </Dialog.Title>
          </div>
          <div className={`${dialogBodyClassName} min-h-0 overflow-y-auto`}>
            <div className="flex items-center gap-1">
              <Dialog.Description className="text-sm text-muted-foreground">
                {t('{{count}} selected', { count: itemIds.length })}
              </Dialog.Description>
              {mode === 'create' && (
                <ContextHelp label={t('Selected references')}>
                  {t(
                    'Selected references are saved as independent member snapshots. Project and collection changes do not add or remove members automatically.'
                  )}
                </ContextHelp>
              )}
            </div>
            {mode === 'existing' && (
              <p className="mt-2 text-sm text-muted-foreground">
                {t(
                  'References stay in their collections. Extraction starts only when you choose to run it.'
                )}
              </p>
            )}
            {mode === 'existing' && (
              <label className="mt-4 block text-sm">
                {t('Comparison table')}
                <Select value={destination} disabled={busy} onValueChange={setDestination}>
                  <SelectTrigger aria-label={t('Comparison table')} className="mt-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {tables.map((table) => (
                      <SelectItem key={table.id} value={table.id}>
                        {table.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            )}
            {mode === 'create' && (
              <>
                <label className="mt-3 block text-sm font-medium">
                  {t('Table name')}
                  <Input
                    className="mt-2"
                    ref={nameInput}
                    value={name}
                    maxLength={160}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="mt-3 block text-sm">
                  {t('Source policy')}
                  <Select
                    value={sourcePolicy}
                    disabled={busy}
                    onValueChange={(value) => setSourcePolicy(value as 'abstract' | 'full-text')}
                  >
                    <SelectTrigger aria-label={t('Source policy')} className="mt-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="abstract">{t('Abstract only')}</SelectItem>
                      <SelectItem value="full-text">
                        {t('Full text required, no abstract fallback')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <div className="mt-1.5 text-xs text-muted-foreground" role="status">
                  {sources ? (
                    <div className="flex items-center gap-1">
                      <span>
                        {t(
                          'PDF linked: {{pdf}}; missing PDF: {{missing}}; abstract available: {{abstract}}.',
                          sources
                        )}
                      </span>
                      <ContextHelp label={t('Actual coverage')}>
                        {t(
                          'A linked PDF does not mean its full text has been read. Actual coverage is recorded for each result.'
                        )}
                      </ContextHelp>
                    </div>
                  ) : sourceError ? (
                    <ErrorNotice
                      title={t('Source availability could not be loaded.')}
                      primaryButton={{
                        label: t('Retry'),
                        onClick: () => setSourceRetry((value) => value + 1)
                      }}
                    />
                  ) : (
                    <p>{t('Loading')}</p>
                  )}
                </div>
                <label className="mt-3 block text-sm">
                  {t('Starting fields')}
                  <Select
                    value={template}
                    disabled={busy}
                    onValueChange={(value) => {
                      setTemplate(value)
                      setFieldsExpanded(value === 'custom')
                      setFields(
                        value === 'clinical'
                          ? startingFields()
                          : [{ id: crypto.randomUUID(), name: '', rule: '' }]
                      )
                    }}
                  >
                    <SelectTrigger aria-label={t('Starting fields')} className="mt-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="clinical">
                        {t('Clinical trial methods and results (3 fields)')}
                      </SelectItem>
                      <SelectItem value="custom">{t('Custom fields')}</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <Collapsible.Root
                  open={fieldsExpanded}
                  onOpenChange={setFieldsExpanded}
                  disabled={busy}
                  className="mt-3"
                >
                  <Collapsible.Trigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="group gap-2">
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 text-muted-foreground group-data-[state=open]:rotate-90"
                      />
                      {t('Configure fields')}
                    </Button>
                  </Collapsible.Trigger>
                  <Collapsible.Content className="mt-2 space-y-3">
                    {fields.map((field, index) => (
                      <div key={field.id} className="space-y-2 rounded-lg border border-border p-3">
                        <Input
                          aria-label={t('Field name')}
                          placeholder={t('Field name')}
                          value={field.name}
                          maxLength={120}
                          disabled={busy}
                          onChange={(event) =>
                            editFields((list) =>
                              list.map((entry, at) =>
                                at === index ? { ...entry, name: event.target.value } : entry
                              )
                            )
                          }
                        />
                        <Textarea
                          aria-label={t('Extraction requirements')}
                          placeholder={t('Extraction requirements')}
                          value={field.rule}
                          maxLength={4000}
                          disabled={busy}
                          onChange={(event) =>
                            editFields((list) =>
                              list.map((entry, at) =>
                                at === index ? { ...entry, rule: event.target.value } : entry
                              )
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          disabled={busy || fields.length === 1}
                          onClick={() =>
                            editFields((list) => list.filter((entry) => entry.id !== field.id))
                          }
                        >
                          {t('Remove')}
                        </Button>
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      disabled={busy || fields.length >= 12}
                      onClick={() =>
                        editFields((list) => [
                          ...list,
                          { id: crypto.randomUUID(), name: '', rule: '' }
                        ])
                      }
                    >
                      {t('Add field')}
                    </Button>
                  </Collapsible.Content>
                </Collapsible.Root>
              </>
            )}
            {error && <ErrorNotice title={t('Comparison table could not be saved.')} />}
          </div>
          <div className={`${dialogFooterClassName} shrink-0`}>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button
              disabled={
                busy ||
                (mode === 'create'
                  ? !name.trim() ||
                    !itemIds.length ||
                    fields.some((field) => !field.name.trim() || !field.rule.trim()) ||
                    new Set(fields.map((field) => field.name.trim().toLowerCase())).size !==
                      fields.length
                  : !destination)
              }
              onClick={() => void save()}
            >
              {mode === 'create' ? t('Create and open matrix') : t('Add to comparison table')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
