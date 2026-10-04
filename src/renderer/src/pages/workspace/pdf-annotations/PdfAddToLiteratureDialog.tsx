import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LiteratureImportDialogFrame } from '../../literature/imports/LiteratureImportDialogFrame'
import type { PdfAnnotationSource } from '../../../../../shared/pdf-annotations'
import type { LiteratureItemView } from '../../../../../shared/literature'

export function PdfAddToLiteratureDialog({
  source,
  onClose
}: {
  source: PdfAnnotationSource
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<LiteratureItemView[]>([])
  const [selected, setSelected] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [operationId] = useState(() => crypto.randomUUID())
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      void window.api.literature
        .search({ scope: 'library', entryKind: 'paper', query, limit: 30 })
        .then((result) => {
          if (active)
            setItems(result.entries.filter((entry): entry is LiteratureItemView => 'item' in entry))
        })
        .catch(() => {
          if (active) setError(t('References could not be loaded.'))
        })
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [query, t])
  const add = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await window.api.literature.addPdf({
        source,
        operationId,
        ...(selected
          ? { itemId: selected }
          : { title: query.trim() || source.name.replace(/\.pdf$/i, '') })
      })
      onClose()
    } catch {
      setError(t('PDF could not be added.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <LiteratureImportDialogFrame
      title={t('Add to Literature')}
      description={t(
        'Choose a reference for this PDF. Notes and annotations are shared automatically across projects.'
      )}
      busy={busy}
      onClose={onClose}
      footer={
        <Button disabled={busy} onClick={() => void add()}>
          {selected ? t('Attach to reference') : t('Add to Literature')}
        </Button>
      }
    >
      <div className="space-y-3 overflow-y-auto p-5">
        <Input
          aria-label={t('Search references')}
          placeholder={t('Search references')}
          value={query}
          disabled={busy}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(undefined)
          }}
        />
        <Button
          variant={selected ? 'ghost' : 'secondary'}
          disabled={busy}
          onClick={() => setSelected(undefined)}
        >
          {t('Create a reference if this PDF is not in Literature')}
        </Button>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {items.map((item) => (
            <Button
              key={item.id}
              variant={selected === item.id ? 'secondary' : 'ghost'}
              className="h-auto w-full justify-start whitespace-normal text-left"
              disabled={busy}
              aria-pressed={selected === item.id}
              onClick={() => setSelected(item.id)}
            >
              {item.item.title}
            </Button>
          ))}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </LiteratureImportDialogFrame>
  )
}
