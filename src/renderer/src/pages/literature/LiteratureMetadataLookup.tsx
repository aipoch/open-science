import { LoaderCircle, Search } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { LiteratureItemView } from '../../../../shared/literature'
import { normalizeLiteratureIdentifierValue } from '../../../../shared/literature'

const DOI_EXAMPLE = '10.1000/example'
const PMID_EXAMPLE = '12345678'

type LiteratureMetadataIdentifier = {
  scheme: 'doi' | 'pmid'
  value: string
}

const initialIdentifier = (item: LiteratureItemView): LiteratureMetadataIdentifier => {
  const identifier =
    item.item.identifiers.find(({ scheme }) => scheme === 'doi') ??
    item.item.identifiers.find(({ scheme }) => scheme === 'pmid')
  return {
    scheme: identifier?.scheme === 'pmid' ? 'pmid' : 'doi',
    value: identifier ? normalizeLiteratureIdentifierValue(identifier.scheme, identifier.value) : ''
  }
}

type LiteratureMetadataLookupProps = Readonly<{
  busy: boolean
  children?: ReactNode
  error?: string
  hasResult: boolean
  item: LiteratureItemView
  onOpenChange: (open: boolean) => void
  onReset: () => void
  onSearch: (identifier: LiteratureMetadataIdentifier) => void
}>

const LiteratureMetadataLookup = ({
  busy,
  children,
  error,
  hasResult,
  item,
  onOpenChange,
  onReset,
  onSearch
}: LiteratureMetadataLookupProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [identifier, setIdentifier] = useState(() => initialIdentifier(item))
  const [dirty, setDirty] = useState(false)

  const updateIdentifier = (next: LiteratureMetadataIdentifier): void => {
    setIdentifier(next)
    if (dirty) return
    setDirty(true)
    onReset()
  }

  const search = (): void => {
    const value = normalizeLiteratureIdentifierValue(identifier.scheme, identifier.value)
    if (!value || busy) return
    setIdentifier({ ...identifier, value })
    setDirty(false)
    onReset()
    onSearch({ ...identifier, value })
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="literature-metadata-lookup" className="font-medium">
          {identifier.scheme === 'doi' ? t('DOI') : t('PMID')}
        </label>
        <div className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_auto]">
          <Select
            onOpenChange={onOpenChange}
            value={identifier.scheme}
            onValueChange={(value) => {
              const scheme = value as 'doi' | 'pmid'
              updateIdentifier({
                scheme,
                value:
                  item.item.identifiers.find((candidate) => candidate.scheme === scheme)?.value ??
                  ''
              })
            }}
          >
            <SelectTrigger
              aria-label={t('Type')}
              className="h-9 text-xs"
              style={{ pointerEvents: 'auto' }}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="doi">{t('DOI')}</SelectItem>
              <SelectItem value="pmid">{t('PMID')}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            id="literature-metadata-lookup"
            aria-label={identifier.scheme === 'doi' ? t('DOI') : t('PMID')}
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? 'literature-metadata-lookup-error' : undefined}
            className="h-9"
            value={identifier.value}
            placeholder={identifier.scheme === 'doi' ? DOI_EXAMPLE : PMID_EXAMPLE}
            onChange={(event) =>
              updateIdentifier({ ...identifier, value: event.currentTarget.value })
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') search()
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            disabled={busy || !identifier.value.trim()}
            onClick={search}
          >
            {busy ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Search className="size-3.5" aria-hidden="true" />
            )}
            {hasResult && !dirty ? t('Check again') : t('Search')}
          </Button>
        </div>
      </div>
      {error ? (
        <p id="literature-metadata-lookup-error" role="alert" className="text-sm text-danger-000">
          {error}
        </p>
      ) : null}
      {!dirty ? children : null}
    </section>
  )
}

export { LiteratureMetadataLookup }
export type { LiteratureMetadataIdentifier }
