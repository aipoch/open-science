import { useEffect, useId, useState } from 'react'
import { CheckCircle2, ChevronDown, Folder, LibraryBig, LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { LiteratureImportDialogFrame } from './imports/LiteratureImportDialogFrame'
import { LiteratureMetadataEditor } from './detail/LiteratureMetadataEditor'
import { LiteratureDuplicatePolicyField } from './imports/LiteratureDuplicatePolicyField'
import type { LiteratureCreatorInput } from '@aipoch/literature-citations/contracts'
import type { LiteratureItemInput } from '@aipoch/literature-library/item'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { useLiteratureHost } from './renderer-host'
import {
  ZOTERO_COLLECTION_CONFLICT,
  ZOTERO_CONNECTION_FAILED,
  ZOTERO_PREVIEW_CHANGED,
  ZOTERO_BATCH_POLICY_CONFLICT,
  ZOTERO_FILL_TYPE_CONFLICT,
  ZOTERO_LOCAL_API_DISABLED,
  ZOTERO_TAG_LIMIT,
  ZOTERO_REQUEST_TIMED_OUT,
  type CollectorRequest,
  type CollectorResult
} from '../../../../shared/literature-collector'

function ZoteroReferenceSummary({
  item
}: {
  item: Partial<LiteratureItemInput>
}): React.JSX.Element {
  const { t } = useTranslation()
  const roles: Record<string, string> = {
    author: t('Author'),
    editor: t('Editor'),
    translator: t('Translator')
  }
  const creators = (item.creators ?? [])
    .map((creator: LiteratureCreatorInput) => {
      const name =
        creator.nameMode === 'organization'
          ? creator.literalName
          : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
      return `${name} (${roles[creator.creatorType] ?? creator.creatorType})`
    })
    .join('; ')

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
      <dt>{t('Creators')}</dt>
      <dd className="min-w-0 break-words">{creators || t('Not provided')}</dd>
      <dt>{t('Year')}</dt>
      <dd className="min-w-0 break-words">{item.issuedYear ?? t('Not provided')}</dd>
      <dt>{t('Publication date')}</dt>
      <dd className="min-w-0 break-words">{item.issuedText || t('Not provided')}</dd>
      <dt>{t('Publication')}</dt>
      <dd className="min-w-0 break-words">{item.containerTitle || t('Not provided')}</dd>
      <dt>{t('Identifiers')}</dt>
      <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 [overflow-wrap:anywhere]">
        {item.identifiers?.length
          ? item.identifiers.map(({ scheme, value }) => (
              <span key={`${scheme}:${value}`}>
                {scheme.toUpperCase()}: {value}{' '}
              </span>
            ))
          : t('Not provided')}
      </dd>
    </dl>
  )
}

export function LiteratureZoteroDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const scopeId = useId()
  const [collections, setCollections] = useState<CollectorResult['collections']>()
  const [collectionKey, setCollectionKey] = useState('')
  const [collectionSearch, setCollectionSearch] = useState('')
  const [preview, setPreview] = useState<CollectorResult>()
  const [result, setResult] = useState<CollectorResult>()
  const [selected, setSelected] = useState<string[]>([])
  const [detailKey, setDetailKey] = useState<string>()
  const [editingKey, setEditingKey] = useState<string>()
  const [search, setSearch] = useState('')
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false)
  const [includePdfs, setIncludePdfs] = useState(true)
  const [pending, setPending] = useState<CollectorRequest['kind'] | undefined>('zotero-collections')
  const [error, setError] = useState<{ message: string; request: CollectorRequest }>()
  const busy = pending !== undefined
  const previewRequest: CollectorRequest = {
    kind: 'zotero-preview',
    ...(collectionKey ? { collectionKey } : {})
  }
  useEffect(() => {
    let active = true
    const request = { kind: 'zotero-collections' } as const
    void api.literature
      .collect(request)
      .then((response) => {
        if (active) setCollections(response.collections ?? [])
      })
      .catch((cause: unknown) => {
        if (active)
          setError({ message: cause instanceof Error ? cause.message : String(cause), request })
      })
      .finally(() => {
        if (active) setPending(undefined)
      })
    return () => {
      active = false
    }
  }, [api])

  const run = async (request: CollectorRequest): Promise<void> => {
    setPending(request.kind)
    setError(undefined)
    try {
      const response = await api.literature.collect(request)
      if (request.kind === 'zotero-collections') {
        setCollections(response.collections ?? [])
      } else if (request.kind === 'zotero-preview' || request.kind === 'zotero-revise') {
        setEditingKey(undefined)
        setPreview(response)
        setResult(undefined)
        if (request.kind === 'zotero-preview') {
          setDetailKey(undefined)
          setSearch('')
          setNeedsReviewOnly(false)
        }
        setSelected((previous) =>
          response.entries
            .filter(
              ({ key, identity, policy }) =>
                (['new', 'reuse'].includes(identity.status) || policy === 'separate') &&
                (request.kind === 'zotero-preview' || previous.includes(key) || key === request.key)
            )
            .map(({ key }) => key)
        )
      } else setResult(response)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const changed = message.includes(ZOTERO_PREVIEW_CHANGED)
      if (changed || request.kind === 'zotero-preview') {
        setPreview(undefined)
        setSelected([])
        setResult(undefined)
      }
      setError({
        message,
        request:
          changed || message.includes(ZOTERO_BATCH_POLICY_CONFLICT) ? previewRequest : request
      })
    } finally {
      setPending(undefined)
    }
  }
  const explanation =
    error &&
    [
      [
        ZOTERO_COLLECTION_CONFLICT,
        t(
          'Different Zotero collections would merge under the same name. Rename them in Zotero, then preview again.'
        )
      ],
      [
        ZOTERO_BATCH_POLICY_CONFLICT,
        t(
          'These choices create new matches within the batch. Import these references separately, then preview again.'
        )
      ],
      [
        ZOTERO_FILL_TYPE_CONFLICT,
        t(
          'Empty fields cannot be filled across different reference types. Keep the existing reference or create a separate copy.'
        )
      ],
      [
        ZOTERO_PREVIEW_CHANGED,
        t('The library changed since this preview. Preview again before importing.')
      ],
      [
        ZOTERO_CONNECTION_FAILED,
        t('Could not connect to Zotero. Open Zotero 10 or later, then try again.')
      ],
      [
        ZOTERO_LOCAL_API_DISABLED,
        t(
          'In Zotero, open Settings → Advanced and enable “Allow other applications on this computer to communicate with Zotero”, then try again.'
        )
      ],
      [
        ZOTERO_REQUEST_TIMED_OUT,
        t('Zotero did not respond in time. Wait for it to finish starting, then try again.')
      ]
    ].find(([code]) => error.message.includes(code))?.[1]
  const statusLabels = {
    new: t('New reference'),
    reuse: t('Reuse existing'),
    review: t('Needs review'),
    conflict: t('Identifier conflict')
  }
  const reasonLabels = {
    trash: t('The match is in Trash. Review the import options before continuing.'),
    metadata: t(
      'Metadata differs. Review authors, year and publication before reusing this reference.'
    ),
    title: t('The matched title differs. Review the metadata and import options.'),
    conflict: t(
      'Identifiers disagree or match multiple references. Edit the import metadata, keep a separate reference, or skip it.'
    )
  }
  const scopeName =
    collections?.find(({ key }) => key === collectionKey)?.path.join(' / ') ?? t('All references')
  const visible =
    preview?.entries.filter(
      ({ title, identity }) =>
        title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) &&
        (!needsReviewOnly || ['review', 'conflict'].includes(identity.status))
    ) ?? []
  const selectable = visible.filter(
    ({ identity, policy }) => ['new', 'reuse'].includes(identity.status) || policy === 'separate'
  )
  const reviewCount =
    preview?.entries.filter(({ identity }) => ['review', 'conflict'].includes(identity.status))
      .length ?? 0
  const canImport =
    !!preview?.snapshotId &&
    (selected.length > 0 ||
      (preview.entries.length === 0 && !!preview.collectionCount && !preview.failures.length))
  const commit = (): void => {
    if (preview?.snapshotId)
      void run({
        kind: 'zotero-commit',
        snapshotId: preview.snapshotId,
        keys: selected,
        includePdfs
      })
  }
  const back = (): void => {
    setPreview(undefined)
    setResult(undefined)
    setError(undefined)
    setDetailKey(undefined)
    setEditingKey(undefined)
  }
  const pendingLabel =
    pending === 'zotero-collections'
      ? t('Reading collections…')
      : pending === 'zotero-preview'
        ? t('Preparing preview…')
        : pending === 'zotero-revise'
          ? t('Saving…')
          : t('Importing…')
  const skipped = preview?.failures ?? []
  const pdfOption = (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 shrink-0 accent-primary"
        checked={includePdfs}
        disabled={busy || !!result}
        onChange={(event) => setIncludePdfs(event.target.checked)}
      />
      {t('Copy local PDF attachments')}
    </label>
  )
  return (
    <LiteratureImportDialogFrame
      title={t('Import from Zotero')}
      busy={busy}
      onClose={onClose}
      stage={result ? 'result' : preview ? 'review' : 'scope'}
      footer={
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-4">
          {preview && !result ? <div className="w-full sm:w-auto">{pdfOption}</div> : <span />}
          <div className="ml-auto flex items-center gap-2">
            {preview && !result ? (
              <Button variant="outline" disabled={busy} onClick={back}>
                {t('Back')}
              </Button>
            ) : null}
            {result ? (
              <>
                {result.failures.length ? (
                  <Button disabled={busy} onClick={commit}>
                    {busy ? pendingLabel : t('Retry PDFs')}
                  </Button>
                ) : null}
                <Button
                  variant={result.failures.length ? 'outline' : 'default'}
                  disabled={busy}
                  onClick={onClose}
                >
                  {t('Done')}
                </Button>
              </>
            ) : (
              <Button
                disabled={busy || (preview ? !canImport : !collections)}
                onClick={preview ? commit : () => void run(previewRequest)}
              >
                {busy ? (
                  <>
                    <LoaderCircle
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    {pendingLabel}
                  </>
                ) : preview ? (
                  selected.length ? (
                    t('Import {{count}} references', {
                      count: selected.length,
                      defaultValue_one: 'Import {{count}} reference'
                    })
                  ) : preview.entries.length === 0 &&
                    preview.collectionCount &&
                    !preview.failures.length ? (
                    t('Import collections')
                  ) : (
                    t('Import references')
                  )
                ) : (
                  t('Preview Zotero library')
                )}
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div
        data-workflow-body
        className="scrollbar-auto-hide min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
      >
        <div data-workflow-content className="space-y-4 p-5" aria-busy={busy}>
          {error ? (
            <LiteratureErrorNotice
              title={explanation ?? error.message}
              primaryButton={{
                label: t('Retry'),
                disabled: busy,
                onClick: () => void run(error.request)
              }}
            />
          ) : null}
          {!preview && !result ? (
            <>
              <fieldset disabled={busy || !collections} className="min-w-0 space-y-3">
                <legend className="mb-3 text-sm font-medium">{t('Import scope')}</legend>
                <Input
                  aria-label={t('Search collections')}
                  placeholder={t('Search collections')}
                  value={collectionSearch}
                  onChange={(event) => setCollectionSearch(event.target.value)}
                />
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
                  {[
                    { key: '', path: [t('All references')] },
                    ...(collections ?? []).filter(({ path }) =>
                      path
                        .join(' / ')
                        .toLocaleLowerCase()
                        .includes(collectionSearch.trim().toLocaleLowerCase())
                    )
                  ].map(({ key, path }) => (
                    <label
                      key={key}
                      className={cn(
                        'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                        collectionKey === key ? 'bg-primary/5' : 'hover:bg-bg-300'
                      )}
                    >
                      <input
                        type="radio"
                        name={scopeId}
                        value={key}
                        checked={collectionKey === key}
                        onChange={() => setCollectionKey(key)}
                        className="size-4 shrink-0 accent-primary"
                      />
                      {key ? (
                        <Folder
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : (
                        <LibraryBig
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <span className="min-w-0 break-words">{path.join(' / ')}</span>
                    </label>
                  ))}
                  {collectionSearch &&
                  !collections?.some(({ path }) =>
                    path
                      .join(' / ')
                      .toLocaleLowerCase()
                      .includes(collectionSearch.trim().toLocaleLowerCase())
                  ) ? (
                    <p className="px-3 py-2 text-sm text-muted-foreground" role="status">
                      {t('No matching collections')}
                    </p>
                  ) : null}
                </div>
              </fieldset>
              {pdfOption}
              <details className="text-sm text-muted-foreground">
                <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-ring">
                  {t('Connection help')}
                </summary>
                <p className="pt-2">
                  {t(
                    'Enable the local API in Zotero 10 or later Settings → Advanced. Zotero data will not be changed.'
                  )}
                </p>
              </details>
            </>
          ) : null}
          {skipped.length ? (
            <details className="rounded-lg border border-border px-3 py-2 text-sm">
              <summary className="cursor-pointer font-medium">
                {t('{{count}} skipped', { count: skipped.length })}
              </summary>
              <ul className="mt-2 list-inside list-disc space-y-1 text-muted-foreground">
                {skipped.map(({ key, message }) => (
                  <li key={key}>
                    {message === ZOTERO_TAG_LIMIT
                      ? t('Skipped {{key}}: use at most 100 tags of 64 characters each.', { key })
                      : `${key}: ${message}`}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {preview && !result ? (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <p className="min-w-0 break-words font-medium">{scopeName}</p>
                {preview.collectionCount ? (
                  <span className="text-muted-foreground">
                    {t('Collections')}: {preview.collectionCount}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-0 flex-1 basis-40"
                  aria-label={t('Search references')}
                  placeholder={t('Search references')}
                  value={search}
                  disabled={busy}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {reviewCount ? (
                  <Button
                    variant={needsReviewOnly ? 'secondary' : 'outline'}
                    size="sm"
                    disabled={busy}
                    aria-pressed={needsReviewOnly}
                    onClick={() => setNeedsReviewOnly(!needsReviewOnly)}
                  >
                    {t('Needs review')} ({reviewCount})
                  </Button>
                ) : null}
              </div>
              <fieldset disabled={busy} className="min-w-0">
                <legend className="sr-only">{t('Select references')}</legend>
                <div className="flex items-center justify-between gap-3 pb-3 text-sm">
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      disabled={!selectable.length}
                      checked={
                        selectable.length > 0 &&
                        selectable.every(({ key }) => selected.includes(key))
                      }
                      ref={(node) => {
                        if (node)
                          node.indeterminate =
                            selectable.some(({ key }) => selected.includes(key)) &&
                            !selectable.every(({ key }) => selected.includes(key))
                      }}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...new Set([...current, ...selectable.map(({ key }) => key)])]
                            : current.filter(
                                (key) => !selectable.some((entry) => entry.key === key)
                              )
                        )
                      }
                    />
                    {t('Select all')}
                  </label>
                  <span className="text-muted-foreground" role="status">
                    {t('{{count}} selected', { count: selected.length })}
                  </span>
                </div>
                <div className="divide-y divide-border border-y border-border">
                  {visible.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground" role="status">
                      {preview.entries.length
                        ? t('No matching references')
                        : t('No valid references found.')}
                    </p>
                  ) : (
                    visible.map(({ key, title, item, policy, pdfCount, identity }) => {
                      const expanded = detailKey === key
                      const attention = ['review', 'conflict'].includes(identity.status)
                      return (
                        <div key={key}>
                          <div className="flex items-start gap-3 py-3">
                            <input
                              type="checkbox"
                              className="mt-1 size-4 shrink-0 accent-primary"
                              aria-label={title}
                              aria-describedby={`zotero-status-${key}`}
                              disabled={identity.status === 'conflict' && policy !== 'separate'}
                              checked={selected.includes(key)}
                              onChange={(event) =>
                                setSelected((current) =>
                                  event.target.checked
                                    ? [...current, key]
                                    : current.filter((value) => value !== key)
                                )
                              }
                            />
                            <button
                              type="button"
                              aria-label={t('Review {{title}}', { title })}
                              aria-expanded={expanded}
                              aria-controls={`zotero-detail-${key}`}
                              className="group flex min-w-0 flex-1 items-start justify-between gap-3 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
                              onClick={() => {
                                setDetailKey(expanded ? undefined : key)
                                setEditingKey(undefined)
                              }}
                            >
                              <span className="min-w-0 space-y-1">
                                <span className="block break-words text-sm font-medium group-hover:underline">
                                  {title}
                                </span>
                                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                                  <span
                                    id={`zotero-status-${key}`}
                                    className={
                                      attention
                                        ? 'text-status-warning-foreground dark:text-status-warning-dark-foreground'
                                        : 'text-muted-foreground'
                                    }
                                  >
                                    {statusLabels[identity.status]}
                                  </span>
                                  {pdfCount > 0 ? (
                                    <span className="text-muted-foreground">
                                      {t('PDF')}: {pdfCount}
                                    </span>
                                  ) : null}
                                </span>
                              </span>
                              <ChevronDown
                                className={cn(
                                  'mt-1 size-4 shrink-0 text-muted-foreground',
                                  expanded && 'rotate-180'
                                )}
                                aria-hidden="true"
                              />
                            </button>
                          </div>
                          {expanded ? (
                            <div
                              id={`zotero-detail-${key}`}
                              className="space-y-4 rounded-lg bg-muted/40 p-3 mb-3 sm:ml-7 sm:p-4"
                            >
                              {identity.reason in reasonLabels ? (
                                <p className="text-sm">
                                  {reasonLabels[identity.reason as keyof typeof reasonLabels]}
                                </p>
                              ) : null}
                              <div className="grid min-w-0 gap-4 text-xs sm:grid-cols-2">
                                <div className="min-w-0 space-y-2">
                                  <p className="font-medium">
                                    {t('Incoming reference')}: {title}
                                  </p>
                                  <ZoteroReferenceSummary
                                    item={item ?? { identifiers: identity.identifiers }}
                                  />
                                </div>
                                {identity.matches.map((match, index) => (
                                  <div key={index} className="min-w-0 space-y-2">
                                    <p className="font-medium">
                                      {t('Matched reference')}: {match.title}
                                    </p>
                                    <ZoteroReferenceSummary item={match} />
                                  </div>
                                ))}
                              </div>
                              {item ? (
                                <div className="space-y-3 border-t border-border pt-4">
                                  <LiteratureDuplicatePolicyField
                                    value={policy ?? 'reuse'}
                                    disabled={busy}
                                    onChange={(next) =>
                                      void run({
                                        kind: 'zotero-revise',
                                        snapshotId: preview.snapshotId!,
                                        key,
                                        policy: next
                                      })
                                    }
                                  />
                                  {editingKey !== key ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={busy}
                                      onClick={() => setEditingKey(key)}
                                    >
                                      {t('Edit import metadata')}
                                    </Button>
                                  ) : (
                                    <>
                                      <p className="text-xs text-muted-foreground">
                                        {t(
                                          'Edits apply to this import only. Zotero will not be changed.'
                                        )}
                                      </p>
                                      <LiteratureMetadataEditor
                                        key={`${preview.snapshotId}:${key}`}
                                        item={item}
                                        saving={busy}
                                        className="max-h-none overflow-visible p-0 text-foreground"
                                        onCancel={() => setEditingKey(undefined)}
                                        onSave={(edited) =>
                                          void run({
                                            kind: 'zotero-revise',
                                            snapshotId: preview.snapshotId!,
                                            key,
                                            item: edited
                                          })
                                        }
                                      />
                                    </>
                                  )}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      )
                    })
                  )}
                </div>
              </fieldset>
            </>
          ) : null}
          {result ? (
            <div className="space-y-4" role="status">
              <div className="flex items-start gap-3 py-3">
                <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0 space-y-2">
                  <h3 className="text-base font-semibold">{t('Import complete')}</h3>
                  <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span>
                      {t('{{count}} references', {
                        count: result.savedItemIds.length,
                        defaultValue_one: '{{count}} reference'
                      })}
                    </span>
                    <span>
                      {t('PDF')}: {result.pdfCount}
                    </span>
                    {result.collectionCount ? (
                      <span>
                        {t('Collections')}: {result.collectionCount}
                      </span>
                    ) : null}
                  </p>
                </div>
              </div>
              {result.failures.length ? (
                <LiteratureErrorNotice
                  title={t(
                    'References were saved. Some PDFs could not be copied; restore them in Zotero and retry.'
                  )}
                >
                  <ul className="list-inside list-disc space-y-1 text-sm">
                    {result.failures.map(({ key, message }) => (
                      <li key={key}>
                        {key}: {message}
                      </li>
                    ))}
                  </ul>
                </LiteratureErrorNotice>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </LiteratureImportDialogFrame>
  )
}
