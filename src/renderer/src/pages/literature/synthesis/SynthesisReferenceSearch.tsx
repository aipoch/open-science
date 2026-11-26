import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'
import { useLiteratureHost } from '../renderer-host'

export function SynthesisReferenceSearch({
  itemIds,
  disabled,
  onAdd
}: {
  itemIds: string[]
  disabled: boolean
  onAdd(id: string): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Array<{ id: string; title: string }>>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [searched, setSearched] = useState(false)
  const searchGeneration = useRef(0)
  useEffect(
    () => () => {
      searchGeneration.current++
    },
    []
  )

  const search = async (): Promise<void> => {
    if (disabled || busy) return
    const generation = ++searchGeneration.current
    setBusy(true)
    setFailed(false)
    setSearched(false)
    setResults([])
    try {
      const page = await api.literature.search({
        scope: 'library',
        lifecycle: 'active',
        query,
        limit: 25,
        offset: 0,
        sortBy: 'title',
        sortDirection: 'asc'
      })
      if (generation !== searchGeneration.current) return
      setResults(
        page.entries
          .filter((entry) => 'item' in entry)
          .map((entry) => ({ id: entry.id, title: entry.item.title }))
      )
      setSearched(true)
    } catch {
      if (generation === searchGeneration.current) setFailed(true)
    } finally {
      if (generation === searchGeneration.current) setBusy(false)
    }
  }

  return (
    <>
      <p id="synthesis-reference-search-help" className="mb-2 text-sm text-muted-foreground">
        {t('Search your library for references to add to this synthesis note.')}
      </p>
      <form
        className="flex flex-wrap gap-2"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault()
          void search()
        }}
      >
        <Input
          className="min-w-40 flex-1"
          aria-label={t('Find references to add')}
          aria-describedby="synthesis-reference-search-help"
          value={query}
          disabled={disabled}
          onChange={(event) => {
            searchGeneration.current++
            setQuery(event.target.value)
            setResults([])
            setFailed(false)
            setSearched(false)
            setBusy(false)
          }}
        />
        <Button variant="outline" disabled={disabled || busy} type="submit">
          {t('Find references')}
        </Button>
      </form>
      {failed ? (
        <ErrorNotice
          title={t('References could not be loaded.')}
          primaryButton={{
            label: t('Retry'),
            onClick: () => void search(),
            disabled: disabled || busy
          }}
        />
      ) : null}
      {searched && !results.length ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {t('No matching references')}
        </p>
      ) : null}
      {results.length ? (
        <ul className="max-h-40 overflow-y-auto">
          {results.map((entry) => (
            <li key={entry.id}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-start whitespace-normal text-left"
                disabled={disabled || busy || itemIds.includes(entry.id)}
                onClick={() => onAdd(entry.id)}
              >
                {entry.title}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}
