import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FileText, Plus, SearchX, X } from 'lucide-react'
import * as Dialog from '@/components/ui/dialog'
import { ErrorNotice } from '@/components/error-notice'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogFormInputClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
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
  const [loadedQuery, setLoadedQuery] = useState<string>()
  const loading = loadedQuery !== query
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
          if (active) {
            setItems([])
            setError(t('References could not be loaded.'))
          }
        })
        .finally(() => {
          if (active) setLoadedQuery(query)
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
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          className={dialogPanelClassName(
            'flex w-[min(32rem,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div className={dialogHeaderClassName}>
            <div className="min-w-0">
              <Dialog.Title className={dialogTitleClassName}>{t('Add to Literature')}</Dialog.Title>
              <Dialog.Description className={dialogDescriptionClassName}>
                {t(
                  'Choose a reference for this PDF. Notes and annotations are shared automatically across projects.'
                )}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close')}
                disabled={busy}
                className={cn(dialogCloseButtonClassName, 'shrink-0 self-start')}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className={cn(dialogBodyClassName, 'flex min-h-0 flex-col gap-3 overflow-hidden')}>
            <p className="truncate text-sm text-muted-foreground" title={source.name}>
              {source.name}
            </p>
            <Input
              autoFocus
              className={cn(dialogFormInputClassName, 'shrink-0')}
              aria-label={t('Search references')}
              placeholder={t('Search references')}
              value={query}
              disabled={busy}
              onChange={(event) => {
                setQuery(event.target.value)
                setSelected(undefined)
              }}
            />
            <div className="min-h-0 max-h-[45vh] overflow-y-auto space-y-1">
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  'h-auto w-full justify-start gap-2 rounded-lg px-2 py-2 text-left whitespace-normal',
                  !selected && 'bg-bg-200 text-text-000'
                )}
                aria-pressed={!selected}
                disabled={busy}
                onClick={() => setSelected(undefined)}
              >
                <Plus className="size-4 shrink-0" aria-hidden="true" />
                {t('Create a reference if this PDF is not in Literature')}
              </Button>
              {!loading &&
                items.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    variant="ghost"
                    className={cn(
                      'h-auto w-full justify-start items-start gap-2 rounded-lg px-2 py-2 text-left whitespace-normal',
                      selected === item.id && 'bg-bg-200 text-text-000'
                    )}
                    disabled={busy}
                    aria-pressed={selected === item.id}
                    onClick={() => setSelected(item.id)}
                  >
                    <FileText className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{item.item.title}</span>
                      {item.item.issuedText || item.item.containerTitle ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {[item.item.issuedText, item.item.containerTitle]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      ) : null}
                    </span>
                  </Button>
                ))}
              {loading || (!items.length && query.trim()) ? (
                <p
                  role="status"
                  className="flex items-center gap-3 px-2 py-3 text-sm text-muted-foreground"
                >
                  {!loading ? <SearchX className="size-4 shrink-0" aria-hidden="true" /> : null}
                  {loading ? t('Loading…') : t('No matching references')}
                </p>
              ) : null}
            </div>
            {error ? <ErrorNotice inline tone="amber" description={error} /> : null}
          </div>
          <div className={dialogFooterClassName}>
            <Button
              variant="ghost"
              className={dialogCancelButtonClassName}
              disabled={busy}
              onClick={onClose}
            >
              {t('Cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void add()}>
              {selected ? t('Attach to reference') : t('Add to Literature')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
