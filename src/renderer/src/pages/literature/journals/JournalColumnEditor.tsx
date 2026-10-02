import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { TAG_COLORS } from '@/pages/settings/tag-presentation'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Palette,
  X
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  JOURNAL_FIELD_KINDS,
  type JournalDataset,
  type JournalField,
  type JournalResult
} from '../../../../../shared/journal-attributes'
import { TAG_COLOR_KEYS, type TagColorKey } from '../../../../../shared/tags'
import { JournalAttributeValue } from '../JournalAttributes'
import { JournalFieldRow } from './JournalFieldRow'
import { ColumnVisibility } from '../list/LiteratureColumnCustomizer'
import { journalFieldKindIcons } from './journal-field-icons'
function JournalChoiceColor({
  choice,
  field,
  dataset,
  disabled,
  labels,
  onChange
}: {
  choice: string
  field: JournalField
  dataset: Pick<JournalDataset, 'source' | 'year'>
  disabled: boolean
  labels: Record<TagColorKey, string>
  onChange: (color: TagColorKey | undefined) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const selected = field.colors[choice]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          disabled={disabled}
          aria-label={t('Color for {{value}}', { value: choice })}
          className="h-10 w-full justify-start gap-2 px-2"
        >
          <JournalAttributeValue
            attribute={{
              key: field.id,
              label: field.label,
              kind: 'singleSelect',
              value: choice,
              colors: field.colors,
              source: dataset.source,
              year: dataset.year
            }}
            singleLine
          />
          <ChevronDown
            className="ml-auto size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="left"
        className="w-48 space-y-3 rounded-xl border border-border bg-card p-3 text-sm text-foreground shadow-dialog"
        aria-label={t('Color for {{value}}', { value: choice })}
      >
        <div className="grid grid-cols-4 gap-2">
          {TAG_COLOR_KEYS.map((color) => (
            <button
              key={color}
              type="button"
              disabled={disabled}
              aria-label={labels[color]}
              title={labels[color]}
              aria-pressed={selected === color}
              className={`flex size-8 items-center justify-center rounded-md border focus-visible:keyboard-focus hover:ring-2 hover:ring-ring/40 ${TAG_COLORS[color]} ${selected === color ? 'ring-2 ring-primary ring-offset-2 ring-offset-card' : ''}`}
              onClick={() => {
                onChange(color)
                setOpen(false)
              }}
            >
              {selected === color ? <Check className="size-4" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          className="w-full justify-start"
          disabled={disabled}
          aria-pressed={selected === undefined}
          onClick={() => {
            onChange(undefined)
            setOpen(false)
          }}
        >
          {t('Automatic')}
          {selected === undefined ? <Check className="ml-auto size-4" aria-hidden="true" /> : null}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
export function JournalColumnEditor({
  identityDraft,
  busy,
  setIdentityDraft,
  fieldDraft,
  choiceField,
  choiceResult,
  setFieldDraft,
  moveField,
  kinds,
  setChoiceField,
  setChoiceQuery,
  setChoiceOffset,
  choiceQuery,
  dataset,
  colors,
  choiceOffset,
  setChoicePage,
  remoteDatasets,
  saveFields
}: {
  identityDraft: { issn: boolean; externalIds: boolean }
  busy: boolean
  setIdentityDraft: React.Dispatch<React.SetStateAction<{ issn: boolean; externalIds: boolean }>>
  fieldDraft: JournalField[] | undefined
  choiceField: string
  choiceResult: JournalResult | undefined
  setFieldDraft: React.Dispatch<React.SetStateAction<JournalField[] | undefined>>
  moveField: (id: string, targetId: string) => void
  kinds: { text: string; number: string; singleSelect: string; multiSelect: string }
  setChoiceField: React.Dispatch<React.SetStateAction<string>>
  setChoiceQuery: React.Dispatch<React.SetStateAction<string>>
  setChoiceOffset: React.Dispatch<React.SetStateAction<number>>
  choiceQuery: string
  dataset: JournalDataset
  colors: Record<'gray' | 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink', string>
  choiceOffset: number
  setChoicePage: React.Dispatch<
    React.SetStateAction<{ key: string; result: JournalResult } | undefined>
  >
  remoteDatasets: JournalDataset[] | undefined
  saveFields: () => Promise<void>
}): React.JSX.Element | null {
  const { t } = useTranslation()
  return (
    <div className="flex max-h-[45vh] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2">
        <p className="text-sm font-medium">{t('Customize columns')}</p>
        <div className="flex flex-wrap items-center gap-4">
          {(['issn', 'externalIds'] as const).map((key) => (
            <div key={key} className="flex items-center gap-1 text-sm">
              <ColumnVisibility
                label={key === 'issn' ? t('ISSN') : t('External IDs')}
                checked={identityDraft[key]}
                disabled={busy}
                onCheckedChange={(checked) =>
                  setIdentityDraft((current) => ({ ...current, [key]: checked }))
                }
              />
              <span>{key === 'issn' ? t('ISSN') : t('External IDs')}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="min-h-0 space-y-1 overflow-y-auto p-2">
        {fieldDraft?.map((field) => {
          const categorical = field.kind === 'singleSelect' || field.kind === 'multiSelect'
          const choices = choiceField === field.id ? (choiceResult?.choices ?? []) : []
          const update = (patch: Partial<typeof field>): void =>
            setFieldDraft((fields) =>
              fields?.map((value) => (value.id === field.id ? { ...value, ...patch } : value))
            )
          return (
            <JournalFieldRow
              key={field.id}
              id={field.id}
              name={field.label}
              disabled={busy}
              onMove={moveField}
            >
              <div className="flex flex-wrap items-center gap-2">
                <ColumnVisibility
                  label={field.label}
                  checked={field.visible}
                  disabled={busy}
                  onCheckedChange={(visible) => update({ visible })}
                />
                <div className="min-w-36 flex-1 text-sm">
                  <Input
                    aria-label={t('Attribute name')}
                    value={field.label}
                    disabled={busy}
                    maxLength={100}
                    onChange={(event) => update({ label: event.target.value })}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={field.kind}
                    disabled={busy}
                    onValueChange={(value) => update({ kind: value as JournalField['kind'] })}
                  >
                    <SelectTrigger aria-label={t('Attribute type')} className="w-44">
                      <span className="flex min-w-0 items-center gap-2 [&>svg]:shrink-0">
                        {(() => {
                          const Icon = journalFieldKindIcons[field.kind]
                          return (
                            <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                          )
                        })()}
                        <SelectValue className="truncate" />
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {JOURNAL_FIELD_KINDS.map((kind) => {
                        const Icon = journalFieldKindIcons[kind]
                        return (
                          <SelectItem
                            key={kind}
                            value={kind}
                            icon={
                              <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                            }
                          >
                            {kinds[kind]}
                          </SelectItem>
                        )
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex w-44 shrink-0 items-center">
                  {categorical ? (
                    <Popover
                      open={choiceField === field.id}
                      onOpenChange={(open) => {
                        setChoiceField(open ? field.id : '')
                        if (open) {
                          setChoiceQuery('')
                          setChoiceOffset(0)
                        }
                      }}
                    >
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" disabled={busy}>
                          <Palette className="size-4" aria-hidden="true" />
                          {t('Edit category colors')}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="end"
                        className="flex w-60 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl border border-border bg-card p-3 text-sm text-foreground shadow-dialog"
                        aria-label={`${field.label}: ${t('Edit category colors')}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate font-medium">{field.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {t('Edit category colors')}
                            </p>
                          </div>
                          <PopoverClose asChild>
                            <Button variant="ghost" size="icon" aria-label={t('Close')}>
                              <X className="size-4" aria-hidden="true" />
                            </Button>
                          </PopoverClose>
                        </div>
                        <Input
                          aria-label={t('Search choices')}
                          placeholder={t('Search choices')}
                          value={choiceQuery}
                          disabled={busy}
                          onChange={(event) => {
                            setChoiceQuery(event.target.value)
                            setChoiceOffset(0)
                          }}
                        />
                        <div
                          className="max-h-64 min-h-12 overflow-y-auto space-y-1"
                          aria-busy={!choiceResult}
                        >
                          {!choiceResult ? (
                            <p
                              role="status"
                              className="flex items-center gap-2 p-2 text-xs text-muted-foreground"
                            >
                              <LoaderCircle
                                className="size-4 animate-spin motion-reduce:animate-none"
                                aria-hidden="true"
                              />
                              {t('Loading…')}
                            </p>
                          ) : null}
                          {choiceResult && !choices.length ? (
                            <p className="p-2 text-xs text-muted-foreground">
                              {t('No results found')}
                            </p>
                          ) : null}
                          {choices.map((choice) => (
                            <JournalChoiceColor
                              key={choice}
                              choice={choice}
                              field={field}
                              dataset={dataset}
                              disabled={busy}
                              labels={colors}
                              onChange={(color) => {
                                const next = { ...field.colors }
                                if (color === undefined) delete next[choice]
                                else next[choice] = color
                                update({ colors: next })
                              }}
                            />
                          ))}
                        </div>
                        {(choiceResult?.total ?? 0) > 50 || choiceOffset > 0 ? (
                          <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label={t('Previous')}
                              disabled={busy || !choiceResult || choiceOffset === 0}
                              onClick={() => setChoiceOffset(choiceOffset - 50)}
                            >
                              <ChevronLeft className="size-4" aria-hidden="true" />
                            </Button>
                            {choiceResult?.total ? (
                              <span className="text-xs text-muted-foreground">
                                {t('{{start}}–{{end}} of {{total}}', {
                                  start: choiceOffset + 1,
                                  end: Math.min(choiceOffset + 50, choiceResult.total),
                                  total: choiceResult.total
                                })}
                              </span>
                            ) : null}
                            <Button
                              variant="outline"
                              size="icon"
                              aria-label={t('Next')}
                              disabled={
                                busy ||
                                !choiceResult ||
                                choiceOffset + 50 >= (choiceResult.total ?? 0)
                              }
                              onClick={() => setChoiceOffset(choiceOffset + 50)}
                            >
                              <ChevronRight className="size-4" aria-hidden="true" />
                            </Button>
                          </div>
                        ) : null}
                      </PopoverContent>
                    </Popover>
                  ) : null}
                </div>
              </div>
            </JournalFieldRow>
          )
        })}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-border px-3 py-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setFieldDraft(undefined)
            setChoiceField('')
            setChoicePage(undefined)
          }}
        >
          {t('Cancel')}
        </Button>
        <Button
          disabled={
            busy || Boolean(remoteDatasets) || fieldDraft?.some((field) => !field.label.trim())
          }
          onClick={() => void saveFields()}
        >
          {busy ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {busy ? t('Saving…') : t('Save')}
        </Button>
      </div>
    </div>
  )
}
