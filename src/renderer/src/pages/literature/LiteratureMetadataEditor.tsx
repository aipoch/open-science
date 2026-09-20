import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  LITERATURE_IDENTIFIER_SCHEMES,
  normalizeLiteratureIdentifierPreferences,
  LITERATURE_ITEM_TYPES,
  type LiteratureCreatorInput,
  type LiteratureIdentifierInput,
  type LiteratureItemInput,
  type LiteratureItemType
} from '../../../../shared/literature'

type LiteratureMetadataEditorProps = Readonly<{
  item: LiteratureItemInput
  saving: boolean
  saveDisabled?: boolean
  error?: string
  className?: string
  beforeFields?: React.ReactNode
  onRetry?: () => void
  onCancel: () => void
  onSave: (item: LiteratureItemInput) => void
}>

type CreatorDraft = {
  nameMode: LiteratureCreatorInput['nameMode']
  creatorType: string
  givenName: string
  familyName: string
  literalName: string
}

const emptyCreator = (): CreatorDraft => ({
  nameMode: 'person',
  givenName: '',
  familyName: '',
  literalName: '',
  creatorType: 'author'
})

// Match the calendar dates consumed by CSL, while retaining untouched legacy free text.
const publicationDateParts = (text: string): number[] | undefined => {
  const match = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/u.exec(text.trim())
  if (!match) return undefined
  const parts = match
    .slice(1)
    .filter((part) => part !== undefined)
    .map(Number)
  const [year, month, day] = parts
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return (month !== undefined && (year === 0 || month < 1 || month > 12)) ||
    (day !== undefined && (day < 1 || day > days[month - 1]))
    ? undefined
    : parts
}

const accessDateText = (timestamp: number | undefined): string => {
  if (timestamp === undefined) return ''
  const date = new Date(timestamp)
  return Number.isFinite(date.getTime()) ? date.toISOString().split('T')[0] : ''
}

const emptyIdentifier = (): LiteratureIdentifierInput => ({
  scheme: 'doi',
  value: '',
  isPrimary: false
})

const ADVANCED_FIELD_KEYS = [
  'volume',
  'issue',
  'pages',
  'publisher',
  'publisherPlace',
  'edition'
] as const

const LiteratureMetadataEditor = ({
  item,
  saving,
  saveDisabled = false,
  error,
  className,
  beforeFields,
  onRetry,
  onCancel,
  onSave
}: LiteratureMetadataEditorProps): React.JSX.Element => {
  const { t } = useTranslation()
  const id = useId()
  const locked = saving || Boolean(onRetry)
  const itemTypeLabels: Record<LiteratureItemType, string> = {
    journalArticle: t('Journal article'),
    review: t('Review'),
    preprint: t('Preprint'),
    conferencePaper: t('Conference paper'),
    book: t('Book'),
    bookSection: t('Book section'),
    thesis: t('Thesis'),
    report: t('Report'),
    dataset: t('Dataset'),
    standard: t('Standard'),
    patent: t('Patent'),
    webpage: t('Web page'),
    document: t('Document')
  }
  const [draft, setDraft] = useState<
    Omit<LiteratureItemInput, 'creators'> & { creators: CreatorDraft[] }
  >(() => ({
    ...item,
    creators: item.creators.map((creator) => ({ ...emptyCreator(), ...creator })),
    identifiers: normalizeLiteratureIdentifierPreferences(item.identifiers),
    typeFields: { ...item.typeFields }
  }))
  const [year, setYear] = useState(String(item.issuedYear ?? ''))
  const [publicationDate, setPublicationDate] = useState(item.issuedText)
  const [useOriginalDate, setUseOriginalDate] = useState(false)
  const [accessDate, setAccessDate] = useState(() => accessDateText(item.accessedAt))
  const [invalidField, setInvalidField] = useState<'year' | 'publication' | 'access'>()
  const yearRef = useRef<HTMLInputElement>(null)
  const publicationRef = useRef<HTMLInputElement>(null)
  const accessRef = useRef<HTMLInputElement>(null)
  const originalDate = publicationDateParts(item.issuedText)
  const datesChanged = year !== String(item.issuedYear ?? '') || publicationDate !== item.issuedText
  const legacyDateConflict =
    !datesChanged &&
    originalDate &&
    item.issuedYear !== undefined &&
    originalDate[0] !== item.issuedYear
  const creatorRoleLabels = new Map([
    ['author', t('Author')],
    ['editor', t('Editor')],
    ['translator', t('Translator')]
  ])
  const creatorRoles = [
    ...new Set([
      'author',
      'editor',
      'translator',
      ...item.creators.map(({ creatorType }) => creatorType)
    ])
  ]

  const updateYear = (value: string): void => {
    setYear(value)
    setInvalidField(undefined)
    if (useOriginalDate || (value !== '' && !/^\d{1,4}$/u.test(value))) return
    setPublicationDate((current) => {
      // Opaque historical text requires an explicit decision at Publication date.
      if (current && !/^(\d{4})(?:-\d{1,2}(?:-\d{1,2})?)?$/u.test(current.trim())) return current
      return value === '' ? '' : value.padStart(4, '0') + current.trim().slice(4)
    })
  }
  const updatePublicationDate = (value: string): void => {
    setPublicationDate(value)
    setInvalidField(undefined)
    if (useOriginalDate) return
    if (!value.trim()) setYear('')
    else {
      const parts = publicationDateParts(value)
      if (parts) setYear(String(parts[0]))
    }
  }

  const [advancedOpen, setAdvancedOpen] = useState(() =>
    ADVANCED_FIELD_KEYS.some((key) => {
      const value = item.typeFields[key]
      return typeof value === 'string' && value.trim().length > 0
    })
  )

  const updateCreator = (index: number, creator: CreatorDraft): void => {
    setDraft((current) => ({
      ...current,
      creators: current.creators.map((entry, entryIndex) =>
        entryIndex === index ? creator : entry
      )
    }))
  }

  const updateIdentifier = (index: number, identifier: LiteratureIdentifierInput): void => {
    setDraft((current) => ({
      ...current,
      identifiers: current.identifiers.map((entry, entryIndex) =>
        entryIndex === index
          ? identifier.isPrimary
            ? { ...identifier, isPrimary: true }
            : identifier
          : identifier.isPrimary && entry.scheme === identifier.scheme
            ? { ...entry, isPrimary: false }
            : entry
      )
    }))
  }

  const updateTypeField = (key: string, value: string): void => {
    setDraft((current) => ({
      ...current,
      typeFields: { ...current.typeFields, [key]: value }
    }))
  }

  const typeField = (key: string): string => {
    const value = draft.typeFields[key]
    return typeof value === 'string' ? value : ''
  }

  const submit = (): void => {
    if (locked || saveDisabled || !draft.title.trim()) return
    if (year && !/^\d{1,4}$/u.test(year)) {
      setInvalidField('year')
      yearRef.current?.focus()
      return
    }
    const issuedYear = year === '' ? undefined : Number(year)
    const parts = publicationDateParts(publicationDate)
    if (
      !useOriginalDate &&
      datesChanged &&
      publicationDate.trim() &&
      (!parts || parts[0] !== issuedYear)
    ) {
      setInvalidField('publication')
      publicationRef.current?.focus()
      return
    }
    if (accessRef.current?.validity.badInput) {
      setInvalidField('access')
      accessRef.current.focus()
      return
    }
    let accessedAt = item.accessedAt
    if (accessDate !== accessDateText(item.accessedAt)) {
      accessedAt = accessDate ? Date.parse(`${accessDate}T00:00:00Z`) : undefined
      if (
        accessedAt !== undefined &&
        (!Number.isFinite(accessedAt) ||
          accessedAt < 0 ||
          accessDateText(accessedAt) !== accessDate)
      ) {
        setInvalidField('access')
        accessRef.current?.focus()
        return
      }
    }
    const creators = draft.creators.flatMap<LiteratureCreatorInput>((creator) =>
      creator.nameMode === 'organization'
        ? creator.literalName.trim()
          ? [
              {
                nameMode: 'organization',
                creatorType: creator.creatorType,
                literalName: creator.literalName
              }
            ]
          : []
        : creator.givenName.trim() || creator.familyName.trim()
          ? [
              {
                nameMode: 'person',
                creatorType: creator.creatorType,
                givenName: creator.givenName,
                familyName: creator.familyName
              }
            ]
          : []
    )
    const identifiers = draft.identifiers.filter(({ value }) => value.trim())
    onSave({
      ...draft,
      title: draft.title.trim(),
      creators,
      identifiers,
      issuedYear,
      issuedText: datesChanged ? publicationDate.trim() : item.issuedText,
      accessedAt
    })
  }

  return (
    <div className={cn('min-w-0 max-h-[70vh] space-y-5 overflow-y-auto p-5 text-sm', className)}>
      <fieldset disabled={locked} className="min-w-0 space-y-5">
        {beforeFields}
        <div className="block space-y-1.5">
          <label htmlFor="literature-reference-type" className="font-medium">
            {t('Reference type')}
          </label>
          <Select
            disabled={locked}
            value={draft.itemType}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                itemType: value as LiteratureItemType
              }))
            }
          >
            <SelectTrigger id="literature-reference-type" className="h-8">
              <span className="truncate">{itemTypeLabels[draft.itemType]}</span>
            </SelectTrigger>
            <SelectContent>
              {LITERATURE_ITEM_TYPES.map((itemType) => (
                <SelectItem key={itemType} value={itemType}>
                  {itemTypeLabels[itemType]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <label className="block space-y-1.5">
          <span className="font-medium">{t('Title')}</span>
          <Input
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            autoFocus
          />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className="font-medium">{t('Year')}</span>
            <Input
              ref={yearRef}
              aria-label={t('Year')}
              inputMode="numeric"
              value={year}
              aria-invalid={invalidField === 'year'}
              aria-describedby={invalidField === 'year' ? `${id}-year-error` : undefined}
              onChange={(event) => updateYear(event.target.value)}
            />
            {invalidField === 'year' ? (
              <span id={`${id}-year-error`} role="alert" className="block text-destructive">
                {t('Enter a whole year from 0 to 9999, or leave it blank.')}
              </span>
            ) : null}
          </label>
          <label className="block space-y-1.5">
            <span className="font-medium">{t('Publication date')}</span>
            <Input
              ref={publicationRef}
              aria-label={t('Publication date')}
              value={publicationDate}
              placeholder={t('YYYY-MM-DD')}
              aria-invalid={invalidField === 'publication'}
              aria-describedby={`${id}-date-help${invalidField === 'publication' ? ` ${id}-date-error` : ''}`}
              onChange={(event) => updatePublicationDate(event.target.value)}
            />
            {invalidField === 'publication' ? (
              <span id={`${id}-date-error`} role="alert" className="block text-destructive">
                {t('Enter a valid publication date matching the year, or clear both fields.')}
              </span>
            ) : null}
          </label>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={useOriginalDate}
            onChange={(event) => {
              setUseOriginalDate(event.target.checked)
              setInvalidField(undefined)
            }}
          />
          {t('Use original date text')}
        </label>
        <p id={`${id}-date-help`} className="text-xs text-muted-foreground">
          {useOriginalDate
            ? t(
                'Keep uncertain or seasonal dates as written. Set the searchable year separately, if known.'
              )
            : t(
                'Use YYYY, YYYY-MM, or YYYY-MM-DD. Year and date stay in sync; clearing either clears both.'
              )}
        </p>
        {legacyDateConflict ? (
          <p className="text-xs text-status-warning-foreground">
            {t(
              'The saved year and publication date disagree. Editing either field will reconcile them.'
            )}
          </p>
        ) : null}
        <div>
          <label className="block space-y-1.5">
            <span className="font-medium">{t('Publication')}</span>
            <Input
              value={draft.containerTitle}
              onChange={(event) =>
                setDraft((current) => ({ ...current, containerTitle: event.target.value }))
              }
            />
          </label>
        </div>

        <div>
          <button
            type="button"
            className="flex items-center gap-1.5 font-medium"
            aria-expanded={advancedOpen}
            aria-controls="literature-advanced-fields"
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <ChevronDown
              className={`size-4 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
              aria-hidden="true"
            />
            {t('Advanced settings')}
          </button>
          {advancedOpen ? (
            <div id="literature-advanced-fields" className="mt-4 grid gap-4 sm:grid-cols-2">
              {[
                ['volume', t('Volume')],
                ['issue', t('Issue')],
                ['pages', t('Pages')],
                ['publisher', t('Publisher')],
                ['publisherPlace', t('Place')],
                ['edition', t('Edition')]
              ].map(([key, label]) => (
                <label key={key} className="block space-y-1.5">
                  <span className="font-medium">{label}</span>
                  <Input
                    value={typeField(key)}
                    onChange={(event) => updateTypeField(key, event.target.value)}
                  />
                </label>
              ))}
              {(
                [
                  ['shortTitle', t('Short title')],
                  ['language', t('Language')],
                  ['citationKey', t('Citation key')],
                  ['rights', t('Rights')]
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="block space-y-1.5">
                  <span className="font-medium">{label}</span>
                  <Input
                    value={draft[key] ?? ''}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                </label>
              ))}
              <label className="block space-y-1.5">
                <span className="font-medium">{t('Date accessed')}</span>
                <Input
                  ref={accessRef}
                  aria-label={t('Date accessed')}
                  type="date"
                  min="1970-01-01"
                  value={accessDate}
                  aria-invalid={invalidField === 'access'}
                  aria-describedby={invalidField === 'access' ? `${id}-access-error` : undefined}
                  onChange={(event) => {
                    setAccessDate(event.target.value)
                    setInvalidField(undefined)
                  }}
                />
                {invalidField === 'access' ? (
                  <span id={`${id}-access-error`} role="alert" className="block text-destructive">
                    {t('Enter a valid access date on or after 1970-01-01, or leave it blank.')}
                  </span>
                ) : null}
              </label>
              <label className="block space-y-1.5 sm:col-span-2">
                <span className="font-medium">{t('Extra')}</span>
                <Textarea
                  value={draft.extra}
                  rows={3}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, extra: event.target.value }))
                  }
                />
              </label>
            </div>
          ) : null}
        </div>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">{t('Creators')}</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  creators: [...current.creators, emptyCreator()]
                }))
              }
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('Add creator')}
            </Button>
          </div>
          <div className="space-y-2">
            {draft.creators.map((creator, index) => (
              <div key={index} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Select
                    disabled={locked}
                    value={creator.creatorType}
                    onValueChange={(creatorType) =>
                      updateCreator(index, { ...creator, creatorType })
                    }
                  >
                    <SelectTrigger aria-label={t('Creator role')} className="h-8 flex-1">
                      <span>
                        {creatorRoleLabels.get(creator.creatorType) ?? creator.creatorType}
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {creatorRoles.map((role) => (
                        <SelectItem key={role} value={role}>
                          {creatorRoleLabels.get(role) ?? role}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    disabled={locked}
                    value={creator.nameMode}
                    onValueChange={(nameMode: CreatorDraft['nameMode']) =>
                      updateCreator(index, { ...creator, nameMode })
                    }
                  >
                    <SelectTrigger aria-label={t('Name type')} className="h-8 flex-1">
                      <span>{creator.nameMode === 'person' ? t('Person') : t('Organization')}</span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="person">{t('Person')}</SelectItem>
                      <SelectItem value="organization">{t('Organization')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  {creator.nameMode === 'organization' ? (
                    <Input
                      aria-label={t('Organization')}
                      value={creator.literalName}
                      onChange={(event) =>
                        updateCreator(index, { ...creator, literalName: event.target.value })
                      }
                    />
                  ) : (
                    <>
                      <Input
                        aria-label={t('Given name')}
                        placeholder={t('Given name')}
                        value={creator.givenName}
                        onChange={(event) =>
                          updateCreator(index, { ...creator, givenName: event.target.value })
                        }
                      />
                      <Input
                        aria-label={t('Family name')}
                        placeholder={t('Family name')}
                        value={creator.familyName}
                        onChange={(event) =>
                          updateCreator(index, { ...creator, familyName: event.target.value })
                        }
                      />
                    </>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('Remove creator')}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        creators: current.creators.filter((_, entryIndex) => entryIndex !== index)
                      }))
                    }
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-medium">{t('Identifiers')}</h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  identifiers: [...current.identifiers, emptyIdentifier()]
                }))
              }
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('Add identifier')}
            </Button>
          </div>
          <div className="space-y-2">
            {draft.identifiers.map((identifier, index) => (
              <div key={index} className="flex items-center gap-2">
                <Select
                  disabled={locked}
                  value={identifier.scheme}
                  onValueChange={(value) =>
                    updateIdentifier(index, {
                      ...identifier,
                      scheme: value as LiteratureIdentifierInput['scheme']
                    })
                  }
                >
                  <SelectTrigger aria-label={t('Type')} className="h-8 w-24 text-xs">
                    <span className="truncate">{identifier.scheme.toUpperCase()}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {LITERATURE_IDENTIFIER_SCHEMES.map((scheme) => (
                      <SelectItem key={scheme} value={scheme}>
                        {scheme.toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  aria-label={identifier.scheme.toUpperCase()}
                  className="h-8"
                  value={identifier.value}
                  onChange={(event) =>
                    updateIdentifier(index, { ...identifier, value: event.target.value })
                  }
                />
                <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="radio"
                    name={`primary-literature-identifier-${identifier.scheme}`}
                    checked={identifier.isPrimary}
                    onChange={() => updateIdentifier(index, { ...identifier, isPrimary: true })}
                  />
                  {t('Preferred for {{scheme}}', { scheme: identifier.scheme.toUpperCase() })}
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Remove identifier')}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      identifiers: current.identifiers.filter(
                        (_, entryIndex) => entryIndex !== index
                      )
                    }))
                  }
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        </section>

        <label className="block space-y-1.5">
          <span className="font-medium">{t('URL')}</span>
          <Input
            value={draft.url}
            onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
          />
        </label>

        <label className="block space-y-1.5">
          <span className="font-medium">{t('Abstract')}</span>
          <Textarea
            value={draft.abstract}
            rows={6}
            onChange={(event) =>
              setDraft((current) => ({ ...current, abstract: event.target.value }))
            }
          />
        </label>
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-danger-000">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border-300/80 pt-4">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          {onRetry ? t('Close') : t('Cancel')}
        </Button>
        <Button
          type="button"
          disabled={saving || (!onRetry && (saveDisabled || !draft.title.trim()))}
          onClick={onRetry ?? submit}
        >
          {onRetry ? t('Retry') : t('Save')}
        </Button>
      </div>
    </div>
  )
}

export { LiteratureMetadataEditor }
