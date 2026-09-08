import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
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
  error?: string
  className?: string
  beforeFields?: React.ReactNode
  onCancel: () => void
  onSave: (item: LiteratureItemInput) => void
}>

const emptyAuthor = (): LiteratureCreatorInput => ({
  nameMode: 'person',
  givenName: '',
  familyName: '',
  creatorType: 'author'
})

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
  error,
  className,
  beforeFields,
  onCancel,
  onSave
}: LiteratureMetadataEditorProps): React.JSX.Element => {
  const { t } = useTranslation()
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
  const [draft, setDraft] = useState<LiteratureItemInput>(() => ({
    ...item,
    creators: item.creators.map((creator) => ({ ...creator })),
    identifiers: normalizeLiteratureIdentifierPreferences(item.identifiers),
    typeFields: { ...item.typeFields }
  }))
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    ADVANCED_FIELD_KEYS.some((key) => {
      const value = item.typeFields[key]
      return typeof value === 'string' && value.trim().length > 0
    })
  )

  const updateCreator = (index: number, creator: LiteratureCreatorInput): void => {
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
    if (saving) return
    const creators = draft.creators.filter((creator) =>
      creator.nameMode === 'organization'
        ? creator.literalName.trim()
        : creator.givenName.trim() || creator.familyName.trim()
    )
    const identifiers = draft.identifiers.filter(({ value }) => value.trim())
    onSave({ ...draft, title: draft.title.trim(), creators, identifiers })
  }

  return (
    <fieldset
      disabled={saving}
      className={cn('min-w-0 max-h-[70vh] space-y-5 overflow-y-auto p-5 text-sm', className)}
    >
      {beforeFields}
      <div className="block space-y-1.5">
        <label htmlFor="literature-reference-type" className="font-medium">
          {t('Reference type')}
        </label>
        <Select
          disabled={saving}
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
            type="number"
            min={0}
            max={9999}
            value={draft.issuedYear ?? ''}
            onChange={(event) => {
              const value = event.target.value
              const parsedYear = Number.parseInt(value, 10)
              setDraft((current) => ({
                ...current,
                issuedYear: value && Number.isInteger(parsedYear) ? parsedYear : undefined
              }))
            }}
          />
        </label>
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
          </div>
        ) : null}
      </div>

      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium">{t('Authors')}</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                creators: [...current.creators, emptyAuthor()]
              }))
            }
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t('Add author')}
          </Button>
        </div>
        <div className="space-y-2">
          {draft.creators.map((creator, index) => (
            <div key={index} className="flex items-center gap-2">
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
                aria-label={t('Remove author')}
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
                disabled={saving}
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
                    identifiers: current.identifiers.filter((_, entryIndex) => entryIndex !== index)
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

      {error ? (
        <p role="alert" className="text-sm text-danger-000">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border-300/80 pt-4">
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
          {t('Cancel')}
        </Button>
        <Button type="button" disabled={saving || !draft.title.trim()} onClick={submit}>
          {t('Save')}
        </Button>
      </div>
    </fieldset>
  )
}

export { LiteratureMetadataEditor }
