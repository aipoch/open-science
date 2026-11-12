import { BookOpenText, FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  LiteratureItemView,
  LiteratureCollectionView
} from '@aipoch/literature-library/contracts'
import { useLiteratureHost } from '../renderer-host'
import { useLiteratureClient } from '../literature-read-pages'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { SmartCollectionIcon } from '@/components/app-icons/custom-glyphs'
import { LiteratureSearchInput } from '../list/LiteratureSearchInput'
import { ErrorNotice } from '@/components/error-notice'
import * as Dialog from '@/components/ui/dialog'
import {
  dialogPanelClassName,
  dialogOverlayClassName,
  dialogHeaderClassName,
  dialogTitleClassName,
  dialogBodyClassName,
  dialogFooterClassName,
  dialogDescriptionClassName
} from '@/components/ui/dialog-chrome'

function collectionIcon(collection?: LiteratureCollectionView): React.JSX.Element {
  if (collection?.smart)
    return <SmartCollectionIcon className="size-4 text-primary" aria-hidden="true" />
  const Icon = collection ? FolderOpen : BookOpenText
  return <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
}

export function ComparisonMemberPicker({
  existing,
  confirmLabel,
  onAdd,
  onClose
}: {
  existing: string[]
  confirmLabel?: string
  onAdd: (ids: string[]) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const { api } = useLiteratureHost()
  const client = useLiteratureClient()
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [collectionId, setCollectionId] = useState('')
  const [collections, setCollections] = useState<LiteratureCollectionView[]>([])
  const [items, setItems] = useState<LiteratureItemView[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [itemsError, setItemsError] = useState(false)
  const [collectionsError, setCollectionsError] = useState(false)
  const [addError, setAddError] = useState(false)
  const [itemsRetry, setItemsRetry] = useState(0)
  const [collectionsRetry, setCollectionsRetry] = useState(0)
  const additions = selected.filter((id) => !existing.includes(id))
  const atLimit = existing.length + additions.length >= 100
  const commitQuery = useCallback((value: string) => {
    setLoading(true)
    setQuery(value)
  }, [])
  useEffect(() => {
    let active = true
    void client
      .readLiteratureSelectionPage({
        scope: 'library',
        lifecycle: 'active',
        query,
        ...(collectionId ? { collectionId } : {}),
        limit: 100
      })
      .then(
        (page) => {
          if (active) {
            setItems(
              page.entries.filter(
                (entry): entry is LiteratureItemView =>
                  'item' in entry && 'metadataRevision' in entry
              )
            )
            setItemsError(false)
            setLoading(false)
          }
        },
        () => {
          if (active) {
            setItems([])
            setItemsError(true)
            setLoading(false)
          }
        }
      )
    return () => {
      active = false
    }
  }, [client, query, collectionId, itemsRetry])
  useEffect(() => {
    let active = true
    void api.literature.search({ scope: 'collections', limit: 100 }).then(
      (page) => {
        if (!active) return
        setCollections(
          page.entries.filter(
            (entry): entry is LiteratureCollectionView => 'itemCount' in entry && 'name' in entry
          )
        )
        setCollectionsError(false)
      },
      () => {
        if (active) setCollectionsError(true)
      }
    )
    return () => {
      active = false
    }
  }, [api, collectionsRetry])
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
            'flex max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden p-0'
          )}
        >
          <div className={dialogHeaderClassName}>
            <Dialog.Title className={dialogTitleClassName}>{t('Choose references')}</Dialog.Title>
          </div>
          <div className={`${dialogBodyClassName} flex min-h-0 flex-col`}>
            <Dialog.Description className={dialogDescriptionClassName}>
              {t(
                'References stay in their collections. Extraction starts only when you choose to run it.'
              )}
            </Dialog.Description>
            <div className="my-3 grid shrink-0 grid-cols-[minmax(0,min(40%,12rem))_minmax(0,1fr)] items-center gap-2">
              <Select
                value={collectionId ? 'collection:' + collectionId : 'all'}
                onValueChange={(value) => {
                  setLoading(true)
                  setCollectionId(value === 'all' ? '' : value.slice('collection:'.length))
                }}
              >
                <SelectTrigger aria-label={t('Collections')}>
                  <span className="flex min-w-0 items-center gap-2 [&>svg]:shrink-0">
                    {collectionIcon(
                      collections.find((collection) => collection.id === collectionId)
                    )}
                    <span className="truncate">
                      <SelectValue />
                    </span>
                  </span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" icon={collectionIcon()}>
                    {t('All references')}
                  </SelectItem>
                  {collections.map((collection) => (
                    <SelectItem
                      key={collection.id}
                      value={'collection:' + collection.id}
                      icon={collectionIcon(collection)}
                    >
                      {collection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <LiteratureSearchInput
                className="w-full sm:w-full"
                initialValue=""
                resetRevision={0}
                onCommit={commitQuery}
              />
            </div>
            {collectionsError && (
              <ErrorNotice
                inline
                title={t('Collections could not be loaded.')}
                primaryButton={{
                  label: t('Retry'),
                  onClick: () => setCollectionsRetry((n) => n + 1)
                }}
              />
            )}
            {itemsError && !loading && (
              <ErrorNotice
                inline
                title={t('Literature could not be loaded.')}
                primaryButton={{
                  label: t('Retry'),
                  onClick: () => {
                    setLoading(true)
                    setItemsRetry((n) => n + 1)
                  }
                }}
              />
            )}
            {addError && <ErrorNotice inline title={t('Comparison table could not be saved.')} />}
            {!loading && !itemsError && !items.length && (
              <p role="status" className="py-3 text-sm text-muted-foreground">
                {t('No matching references')}
              </p>
            )}
            {loading && (
              <p role="status" className="py-3 text-sm text-muted-foreground">
                {t('Loading')}
              </p>
            )}
            <ul className="min-h-0 overflow-y-auto overscroll-contain divide-y divide-border">
              {!loading &&
                items.map((item) => (
                  <li key={item.id}>
                    <label className="flex gap-3 py-3 text-sm">
                      <input
                        type="checkbox"
                        checked={existing.includes(item.id) || selected.includes(item.id)}
                        disabled={
                          busy ||
                          existing.includes(item.id) ||
                          (atLimit && !selected.includes(item.id))
                        }
                        onChange={(e) =>
                          setSelected((ids) =>
                            e.target.checked
                              ? [...ids, item.id]
                              : ids.filter((id) => id !== item.id)
                          )
                        }
                      />
                      {item.item.title}
                    </label>
                  </li>
                ))}
            </ul>
            <p className="mt-2 shrink-0 text-xs text-muted-foreground">
              {atLimit
                ? t('A comparison table can contain up to 100 references.')
                : items.length >= 100
                  ? t('Showing up to 100 references. Search to narrow the list.')
                  : null}
            </p>
          </div>
          <div className={dialogFooterClassName}>
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button
              disabled={busy || !additions.length || existing.length + additions.length > 100}
              onClick={() => {
                setBusy(true)
                setAddError(false)
                void onAdd(additions)
                  .then(onClose, () => setAddError(true))
                  .finally(() => setBusy(false))
              }}
            >
              {confirmLabel ?? t('Add to comparison table')}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
