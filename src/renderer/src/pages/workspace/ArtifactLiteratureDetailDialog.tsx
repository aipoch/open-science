import { ErrorNotice } from '@/components/error-notice'
import { useLiteratureChanges } from '@/pages/literature/useLiteratureChanges'
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import * as Dialog from '@/components/ui/dialog'
import { FileText, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  dialogCloseButtonClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { cn } from '@/lib/utils'
import type { ArtifactLiteratureReference } from '../../../../shared/artifact-literature'
import {
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierValue,
  type LiteratureItemInput,
  type LiteratureItemType,
  type LiteratureItemView
} from '../../../../shared/literature'

type ArtifactLiteratureDetailDialogProps = Readonly<{
  reference: ArtifactLiteratureReference | undefined
  onOpenChange: (open: boolean) => void
}>

type LiveReferenceState =
  | { itemId?: undefined; status: 'idle'; item?: undefined }
  | { itemId: string; status: 'missing' | 'error'; item?: undefined }
  | { itemId: string; status: 'ready'; item: LiteratureItemView }

const creatorNames = (item: LiteratureItemInput): string[] =>
  item.creators.map((creator) =>
    creator.nameMode === 'organization'
      ? creator.literalName
      : [creator.givenName, creator.familyName].filter(Boolean).join(' ')
  )

const typeFieldText = (item: LiteratureItemInput, field: string): string => {
  const value = item.typeFields[field]
  return typeof value === 'string' ? value.trim() : ''
}

const publicationSummary = (item: LiteratureItemInput): string => {
  const publication = item.shortTitle || item.containerTitle
  const date = item.issuedText || item.issuedYear?.toString() || ''
  const volume = typeFieldText(item, 'volume')
  const issue = typeFieldText(item, 'issue')
  const pages = typeFieldText(item, 'pages')
  const volumeIssue = `${volume}${issue ? `(${issue})` : ''}`
  const volumeIssuePages = volumeIssue && pages ? `${volumeIssue}:${pages}` : volumeIssue || pages
  return `${[publication, date].filter(Boolean).join('. ')}${
    volumeIssuePages ? `${publication || date ? ';' : ''}${volumeIssuePages}` : ''
  }`
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const ArtifactLiteratureDetailDialog = ({
  reference,
  onOpenChange
}: ArtifactLiteratureDetailDialogProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [literatureRevision, setLiteratureRevision] = useState(0)
  useLiteratureChanges(() => {
    if (reference) setLiteratureRevision((value) => value + 1)
  })
  const [liveReference, setLiveReference] = useState<LiveReferenceState>({ status: 'idle' })

  useEffect(() => {
    if (!reference) return

    let active = true
    void window.api.literature.get(reference.itemId).then(
      (item) => {
        if (!active) return
        setLiveReference(
          item
            ? { itemId: reference.itemId, status: 'ready', item }
            : { itemId: reference.itemId, status: 'missing' }
        )
      },
      () => {
        if (active) setLiveReference({ itemId: reference.itemId, status: 'error' })
      }
    )

    return () => {
      active = false
    }
  }, [reference, literatureRevision])

  const resolvedReference =
    reference && liveReference.itemId === reference.itemId ? liveReference : undefined
  const loadStatus = resolvedReference?.status ?? (reference ? 'loading' : 'idle')
  const item = reference?.item
  const attachments = resolvedReference?.item?.attachments ?? []
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

  return (
    <Dialog.Root open={Boolean(reference)} onOpenChange={onOpenChange}>
      {item ? (
        <Dialog.Portal>
          {/* Artifact preview panels occupy layers 60/61; keep both child surfaces above them. */}
          <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[65]')} />
          <Dialog.Content
            className={dialogPanelClassName(
              'z-[65] flex max-h-[85svh] w-[min(680px,calc(100vw-2rem))] flex-col p-0'
            )}
          >
            <div className={cn(dialogHeaderClassName, 'shrink-0 items-start')}>
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span className="rounded bg-bg-200 px-1.5 py-0.5 font-medium text-foreground">
                    {itemTypeLabels[item.itemType]}
                  </span>
                  {publicationSummary(item) ? (
                    <span className="min-w-0 break-words">{publicationSummary(item)}</span>
                  ) : null}
                </div>
                <Dialog.Title
                  className={cn(
                    dialogTitleClassName,
                    'line-clamp-3 break-words text-base leading-snug'
                  )}
                >
                  {item.title}
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  {creatorNames(item).join(', ') || itemTypeLabels[item.itemType]}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className={cn(dialogCloseButtonClassName, 'shrink-0')}
                  aria-label={t('Close')}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </div>

            <div aria-live="polite" className="sr-only">
              {loadStatus === 'loading' ? t('Loading…') : ''}
            </div>

            <div className="min-h-0 flex-1 divide-y divide-border-300/80 overflow-y-auto px-5 text-sm">
              <p className="py-3 text-xs text-muted-foreground">
                {t('Saved reference metadata. Attachments reflect the current Library entry.')}
              </p>
              {loadStatus === 'missing' || loadStatus === 'error' ? (
                <ErrorNotice
                  role="alert"
                  tone="amber"
                  className="my-4"
                  description={
                    loadStatus === 'missing'
                      ? t('This reference is no longer in your Library.')
                      : t('Literature could not be loaded.')
                  }
                />
              ) : null}

              {creatorNames(item).length > 0 ? (
                <section className="py-4">
                  <h3 className="font-medium text-text-000">{t('Authors')}</h3>
                  <p className="mt-2 max-w-[72ch] leading-6 text-text-200">
                    {creatorNames(item).join(', ')}
                  </p>
                </section>
              ) : null}

              {item.abstract ? (
                <section className="py-4">
                  <h3 className="font-medium text-text-000">{t('Abstract')}</h3>
                  <p className="mt-2 max-w-[72ch] whitespace-pre-wrap leading-6 text-text-200">
                    {item.abstract}
                  </p>
                </section>
              ) : null}

              <section className="py-4">
                <h3 className="font-medium text-text-000">{t('Publication metadata')}</h3>
                <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
                  {[
                    [t('Reference type'), itemTypeLabels[item.itemType]],
                    [t('Year'), item.issuedYear?.toString() ?? ''],
                    [t('Publication'), item.containerTitle],
                    [t('Publisher'), typeFieldText(item, 'publisher')],
                    [t('Volume'), typeFieldText(item, 'volume')],
                    [t('Issue'), typeFieldText(item, 'issue')],
                    [t('Pages'), typeFieldText(item, 'pages')],
                    [t('Language'), item.language]
                  ]
                    .filter((entry): entry is [string, string] => Boolean(entry[1]))
                    .map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{label}</dt>
                        <dd className="mt-0.5 truncate text-text-100" title={value}>
                          {value}
                        </dd>
                      </div>
                    ))}
                </dl>

                {item.identifiers.length > 0 ? (
                  <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-border-300/70 pt-3">
                    {item.identifiers.map((identifier) => {
                      const value = normalizeLiteratureIdentifierValue(
                        identifier.scheme,
                        identifier.value
                      )
                      const href = createLiteratureIdentifierUrl(identifier.scheme, value)
                      return (
                        <div
                          key={`${identifier.scheme}:${identifier.value}`}
                          className="flex min-w-0 items-baseline gap-2"
                        >
                          <dt className="text-xs uppercase text-muted-foreground">
                            {identifier.scheme}
                          </dt>
                          <dd className="min-w-0 break-all">
                            {href ? (
                              <ExternalTextLink
                                href={href}
                                aria-label={`${identifier.scheme.toUpperCase()}: ${value}`}
                                className="rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:text-primary/70"
                              >
                                {value}
                              </ExternalTextLink>
                            ) : (
                              value
                            )}
                          </dd>
                        </div>
                      )
                    })}
                  </dl>
                ) : null}
              </section>

              {attachments.length > 0 ? (
                <section className="py-4">
                  <h3 className="font-medium text-text-000">{t('Attachments')}</h3>
                  <div className="mt-2 space-y-2">
                    {attachments.map((attachment) => {
                      const version = attachment.versions[0]
                      return version ? (
                        <div
                          key={attachment.id}
                          className="flex items-center gap-3 rounded-lg border border-border-300/80 bg-bg-100 px-3 py-2"
                        >
                          <FileText className="size-4 shrink-0 text-primary" aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-text-000">{version.filename}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatBytes(version.sizeBytes)}
                            </p>
                          </div>
                        </div>
                      ) : null
                    })}
                  </div>
                </section>
              ) : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  )
}

export { ArtifactLiteratureDetailDialog }
