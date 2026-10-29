import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
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
    <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
      <dt>{t('Creators')}</dt>
      <dd>{creators || t('Not provided')}</dd>
      <dt>{t('Year')}</dt>
      <dd>{item.issuedYear ?? t('Not provided')}</dd>
      <dt>{t('Publication date')}</dt>
      <dd>{item.issuedText || t('Not provided')}</dd>
      <dt>{t('Publication')}</dt>
      <dd>{item.containerTitle || t('Not provided')}</dd>
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
  const [collectionKey, setCollectionKey] = useState('')
  const [preview, setPreview] = useState<CollectorResult>()
  const [result, setResult] = useState<CollectorResult>()
  const [selected, setSelected] = useState<string[]>([])
  const [editingKey, setEditingKey] = useState<string>()
  const [includePdfs, setIncludePdfs] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; request: CollectorRequest }>()
  const run = async (request: CollectorRequest): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const response = await api.literature.collect(request)
      if (request.kind === 'zotero-preview' || request.kind === 'zotero-revise') {
        setEditingKey(undefined)
        setPreview(response)
        setResult(undefined)
        setSelected(
          response.entries
            .filter(
              ({ key, identity, policy }) =>
                (['new', 'reuse'].includes(identity.status) || policy === 'separate') &&
                (request.kind === 'zotero-preview' || selected.includes(key) || key === request.key)
            )
            .map(({ key }) => key)
        )
      } else setResult(response)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const changed = message.includes(ZOTERO_PREVIEW_CHANGED)
      if (changed) {
        setPreview(undefined)
        setSelected([])
        setResult(undefined)
      }
      const explanation = [
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
      ].find(([code]) => message.includes(code))?.[1]
      setError({
        message: explanation ?? message,
        request:
          changed || message.includes(ZOTERO_BATCH_POLICY_CONFLICT)
            ? { kind: 'zotero-preview', ...(collectionKey ? { collectionKey } : {}) }
            : request
      })
    } finally {
      setBusy(false)
    }
  }
  const selectable =
    preview?.entries.filter(
      ({ identity, policy }) => ['new', 'reuse'].includes(identity.status) || policy === 'separate'
    ) ?? []
  const statusLabels = {
    new: t('New reference'),
    reuse: t('Reuse existing'),
    review: t('Needs review'),
    conflict: t('Identifier conflict')
  }
  const reasonLabels = {
    trash: t('The match is in Trash. Review the import options before continuing.'),
    new: t('No matching source or identifier. A new reference will be created.'),
    source: t('The source matches an existing reference.'),
    identifier: t('The identifier matches an existing reference.'),
    metadata: t(
      'Metadata differs. Review authors, year and publication before reusing this reference.'
    ),
    title: t('The matched title differs. Review the metadata and import options.'),
    conflict: t(
      'Identifiers disagree or match multiple references. Edit the import metadata, keep a separate reference, or skip it.'
    )
  }
  return (
    <LiteratureImportDialogFrame
      title={t('Import from Zotero')}
      description={t(
        'Enable the local API in Zotero 10 or later Settings → Advanced. Zotero data will not be changed.'
      )}
      busy={busy}
      onClose={onClose}
      footer={
        <div className="flex shrink-0 justify-end gap-2 border-t border-border p-4">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('Close')}
          </Button>
          <Button
            disabled={
              busy ||
              (selected.length === 0 &&
                (preview?.entries.length !== 0 ||
                  !preview?.collectionCount ||
                  !!preview?.failures.length)) ||
              !preview?.snapshotId ||
              (!!result && result.failures.length === 0)
            }
            onClick={() =>
              void run({
                kind: 'zotero-commit',
                snapshotId: preview!.snapshotId!,
                keys: selected,
                includePdfs
              })
            }
          >
            {busy ? t('Importing…') : result?.failures.length ? t('Retry') : t('Import references')}
          </Button>
        </div>
      }
    >
      <ScrollArea className="flex min-h-0 flex-1 flex-col overflow-hidden [&>[data-slot=scroll-area-viewport]]:min-h-0">
        <div className="space-y-4 p-5">
          <label className="block space-y-2 text-sm">
            <span>{t('Zotero collection key (optional)')}</span>
            <Input
              value={collectionKey}
              disabled={busy}
              maxLength={8}
              onChange={(event) => {
                setCollectionKey(event.target.value.toUpperCase())
                setPreview(undefined)
                setResult(undefined)
                setError(undefined)
              }}
            />
          </label>
          <Button
            variant="outline"
            disabled={busy || (!!collectionKey && !/^[A-Z0-9]{8}$/.test(collectionKey))}
            onClick={() =>
              void run({ kind: 'zotero-preview', ...(collectionKey ? { collectionKey } : {}) })
            }
          >
            {busy ? t('Loading…') : t('Preview Zotero library')}
          </Button>
          <p className="text-sm text-muted-foreground">
            {t(
              'Imports up to 1,000 references with tags, collection paths and source links. Existing references are reused.'
            )}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-primary"
              checked={includePdfs}
              disabled={busy}
              onChange={(event) => setIncludePdfs(event.target.checked)}
            />
            {t('Copy local PDF attachments')}
          </label>
          {error ? (
            <LiteratureErrorNotice
              title={error.message}
              primaryButton={{
                label: t('Retry'),
                disabled: busy,
                onClick: () => void run(error.request)
              }}
            />
          ) : null}
          {preview?.failures.length ? (
            <ul role="status" className="list-inside list-disc text-sm">
              {preview.failures.map(({ key, message }) => (
                <li key={key}>
                  {message === ZOTERO_TAG_LIMIT
                    ? t('Skipped {{key}}: use at most 100 tags of 64 characters each.', { key })
                    : `${key}: ${message}`}
                </li>
              ))}
            </ul>
          ) : null}
          {preview ? (
            <fieldset disabled={busy || !!result} className="space-y-2">
              <legend className="mb-2 flex flex-wrap items-baseline gap-x-2 text-sm">
                <span>{t('Select references')} </span>
                <span>
                  {selected.length}/{preview.entries.length}
                </span>
              </legend>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-primary"
                  disabled={selectable.length === 0}
                  checked={
                    selectable.length > 0 && selectable.every(({ key }) => selected.includes(key))
                  }
                  onChange={(event) =>
                    setSelected(event.target.checked ? selectable.map(({ key }) => key) : [])
                  }
                />
                {t('Select all')}
              </label>
              <div className="space-y-2 rounded-md border border-border p-3">
                {preview.entries.length === 0 ? (
                  <p role="status">{t('No valid references found.')}</p>
                ) : (
                  preview.entries.map(({ key, title, item, policy, pdfCount, identity }) => (
                    <div key={key} className="space-y-1 border-b border-border pb-2 last:border-0">
                      <label className="flex items-start gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 accent-primary"
                          disabled={identity.status === 'conflict' && policy !== 'separate'}
                          aria-describedby={`zotero-review-${key}`}
                          checked={selected.includes(key)}
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, key]
                                : current.filter((value) => value !== key)
                            )
                          }
                        />
                        <span className="min-w-0 break-words">
                          {title}
                          <span className="ml-2 text-muted-foreground">
                            {t('PDF')}: {pdfCount}
                          </span>
                        </span>
                      </label>
                      <div className="ml-5 space-y-1 text-xs text-muted-foreground">
                        <p
                          id={`zotero-review-${key}`}
                          className="flex flex-wrap items-baseline gap-x-2"
                        >
                          <span className="font-medium text-foreground">
                            {statusLabels[identity.status]}{' '}
                          </span>
                          <span>{reasonLabels[identity.reason]}</span>
                        </p>
                        {identity.matches.length > 0 ? (
                          <details>
                            <summary className="cursor-pointer">{t('Compare references')}</summary>
                            <p>
                              {t('Incoming reference')}: {title}
                            </p>
                            <ZoteroReferenceSummary
                              item={item ?? { identifiers: identity.identifiers }}
                            />
                            {identity.matches.map((match, index) => (
                              <div key={index} className="mt-2">
                                <p>
                                  {t('Matched reference')}: {match.title}
                                </p>
                                <ZoteroReferenceSummary item={match} />
                              </div>
                            ))}
                          </details>
                        ) : null}
                        {item && !result ? (
                          <details>
                            <summary className="cursor-pointer">{t('Import options')}</summary>
                            <div className="space-y-3 pt-2">
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
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => setEditingKey(editingKey === key ? undefined : key)}
                              >
                                {t('Edit import metadata')}
                              </Button>
                              {editingKey === key ? (
                                <>
                                  <p>
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
                              ) : null}
                            </div>
                          </details>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </fieldset>
          ) : null}
          {result ? (
            <div role="status" className="space-y-2 text-sm">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span>
                  {t('Import complete')} {result.savedItemIds.length}{' '}
                </span>
                <span>
                  {t('PDF')}: {result.pdfCount}
                </span>
              </p>
              {result.failures.length ? (
                <>
                  <p>
                    {t(
                      'References were saved. Some PDFs could not be copied; restore them in Zotero and retry.'
                    )}
                  </p>
                  <ul className="list-inside list-disc">
                    {result.failures.map(({ key, message }) => (
                      <li key={key}>
                        {key}: {message}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
          {preview?.collectionCount ? (
            <p className="text-sm">
              {t('Collections')}: {preview.collectionCount}
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </LiteratureImportDialogFrame>
  )
}
