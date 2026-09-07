/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
import { Check, Eye, LoaderCircle, SlidersHorizontal } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'

import type {
  ArtifactLiteratureManifest,
  ArtifactLiteratureReference
} from '../../../../shared/artifact-literature'
import type {
  LiteratureCitationStyleView,
  LiteratureFormattedReference
} from '../../../../shared/literature'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ArtifactLiteratureDetailDialog } from './ArtifactLiteratureDetailDialog'

const creatorName = (creator: ArtifactLiteratureReference['item']['creators'][number]): string =>
  creator.nameMode === 'organization'
    ? creator.literalName
    : [creator.familyName, creator.givenName].filter(Boolean).join(', ')

const referenceAuthors = (reference: ArtifactLiteratureReference): string =>
  reference.item.creators.map(creatorName).filter(Boolean).join('; ')

const referencePublication = (reference: ArtifactLiteratureReference): string => {
  const date = reference.item.issuedYear?.toString() ?? reference.item.issuedText
  return [date, reference.item.containerTitle].filter(Boolean).join(' · ')
}

const ArtifactSourcesPanel = ({
  literature,
  versionSummary,
  formatContext
}: {
  literature: ArtifactLiteratureManifest
  versionSummary?: ReactNode
  formatContext?: {
    projectId: string
    sessionId: string
    artifactId: string
    versionId: string
    expectedHeadVersionId: string
  }
}): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const [selectedReference, setSelectedReference] = useState<
    ArtifactLiteratureReference | undefined
  >()
  const [formatOpen, setFormatOpen] = useState(false)
  const [styleId, setStyleId] = useState(literature.styleId)
  const [styles, setStyles] = useState<LiteratureCitationStyleView[]>()
  const [formatPreviewResult, setFormatPreviewResult] = useState<{
    key: string
    references?: LiteratureFormattedReference[]
    error?: string
  }>()
  const [formatError, setFormatError] = useState<string>()
  const [savingFormat, setSavingFormat] = useState(false)
  const [savedVersion, setSavedVersion] = useState<number>()
  const citationLocale = literature.locale === 'zh-CN' ? 'zh-CN' : 'en-US'
  const formatRequestKey = formatContext
    ? `${formatContext.versionId}:${styleId}:${citationLocale}`
    : undefined
  const formatPreview =
    formatPreviewResult && formatPreviewResult.key === formatRequestKey
      ? formatPreviewResult.references
      : undefined
  const visibleFormatError =
    formatError ??
    (formatPreviewResult && formatPreviewResult.key === formatRequestKey
      ? formatPreviewResult.error
      : undefined)

  useEffect(() => {
    if (styles) return
    let active = true
    void window.api.literature.citationStyles({ kind: 'list' }).then(
      (result) => {
        if (active) setStyles(result.styles)
      },
      () => {
        if (active && formatOpen) setFormatError(t('Citation styles could not be loaded.'))
      }
    )
    return () => {
      active = false
    }
  }, [formatOpen, styles, t])

  useEffect(() => {
    if (!formatOpen || !formatContext || !formatRequestKey) return
    let active = true
    void window.api.literature
      .formatDocument({
        mode: 'preview',
        projectId: formatContext.projectId,
        sessionId: formatContext.sessionId,
        artifactId: formatContext.artifactId,
        versionId: formatContext.versionId,
        styleId,
        locale: citationLocale
      })
      .then(
        (result) => {
          if (active && result.mode === 'preview') {
            setFormatPreviewResult({ key: formatRequestKey, references: result.references })
          }
        },
        () => {
          if (active) {
            setFormatPreviewResult({
              key: formatRequestKey,
              error: t('Citation preview could not be prepared.')
            })
          }
        }
      )
    return () => {
      active = false
    }
  }, [citationLocale, formatContext, formatOpen, formatRequestKey, styleId, t])

  const saveFormat = async (): Promise<void> => {
    if (!formatContext || savingFormat || !formatPreview) return
    setSavingFormat(true)
    setFormatError(undefined)
    try {
      const result = await window.api.literature.formatDocument({
        mode: 'save',
        ...formatContext,
        styleId,
        locale: citationLocale,
        operationId: crypto.randomUUID()
      })
      if (result.mode === 'save') setSavedVersion(result.versionNumber)
    } catch {
      setFormatError(t('The formatted document could not be saved.'))
    } finally {
      setSavingFormat(false)
    }
  }
  const scopeLabel = (
    scope: NonNullable<typeof literature.corpus>['retrievals'][number]['scope']
  ): string =>
    scope === 'project'
      ? t('This project')
      : scope === 'collection'
        ? t('Collections')
        : scope === 'items'
          ? t('Selected references')
          : t('All references')

  return (
    <section className="@container/sources p-4" data-testid="artifact-sources">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-sm font-semibold text-text-000">{t('Literature')}</h2>
          <span className="text-xs tabular-nums text-text-300">
            {t('{{count}} references', {
              count: literature.references.length,
              defaultValue_one: '{{count}} reference'
            })}
          </span>
        </div>
        {formatContext ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            aria-expanded={formatOpen}
            onClick={() => {
              setFormatOpen((open) => !open)
              setFormatError(undefined)
            }}
          >
            <SlidersHorizontal aria-hidden="true" />
            {t('Format citations')}
          </Button>
        ) : null}
      </div>
      <div className="mt-2 space-y-1.5 text-xs text-text-300">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span>{t('Citation style')}</span>
          <span className="min-w-0 break-words font-medium text-text-100">
            {styles?.find((style) => style.id === literature.styleId)?.title ?? literature.styleId}
          </span>
          <span>{literature.locale}</span>
        </p>
        {versionSummary}
      </div>
      {formatOpen && formatContext ? (
        <section className="mt-3 rounded-lg border border-border-300/70 bg-bg-100 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 basis-56 flex-1 text-xs font-medium text-text-200">
              {t('Citation style')}
              <Select
                value={styleId}
                disabled={savingFormat || savedVersion !== undefined}
                onValueChange={(value) => {
                  setStyleId(value)
                  setFormatError(undefined)
                }}
              >
                <SelectTrigger className="mt-1 w-full" aria-label={t('Citation style')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(styles ?? []).map((style) => (
                    <SelectItem key={style.id} value={style.id}>
                      {style.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <Button
              type="button"
              size="sm"
              disabled={
                !formatPreview ||
                savingFormat ||
                savedVersion !== undefined ||
                styleId === literature.styleId
              }
              onClick={() => void saveFormat()}
            >
              {savingFormat ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : (
                <Check aria-hidden="true" />
              )}
              {savingFormat ? t('Saving…') : t('Save as new version')}
            </Button>
          </div>
          {visibleFormatError ? (
            <p className="mt-3 text-xs text-danger-000" role="alert">
              {visibleFormatError}
            </p>
          ) : savedVersion ? (
            <p className="mt-3 text-xs text-success-000">
              {t('Saved as version {{version}}.', { version: savedVersion })}
            </p>
          ) : formatPreview ? (
            <div className="mt-3 grid gap-2 @min-[32rem]/sources:grid-cols-2">
              {formatPreview.slice(0, 2).map((reference) => (
                <div
                  key={reference.itemId}
                  className="rounded-md border border-border-300 bg-bg-000 p-3"
                >
                  <p className="text-xs font-medium text-text-300">{t('In-text citation')}</p>
                  <p className="mt-1 text-sm text-text-000">{reference.inText}</p>
                  <p className="mt-3 text-xs font-medium text-text-300">{t('Reference')}</p>
                  <p className="mt-1 line-clamp-4 text-xs leading-5 text-text-100">
                    {reference.reference}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 flex h-24 items-center justify-center text-text-300">
              <LoaderCircle className="size-4 animate-spin" aria-label={t('Loading citation…')} />
            </div>
          )}
        </section>
      ) : null}
      {literature.corpus ? (
        <div className="mt-3 rounded-lg border border-border-300/60 bg-bg-100 px-3 py-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium text-text-000">{t('Frozen review corpus')}</h3>
            <span className="text-xs tabular-nums text-text-300">
              {t('{{count}} references', {
                count: literature.corpus.items.length,
                defaultValue_one: '{{count}} reference'
              })}
              {' · '}
              {formatDate(literature.corpus.capturedAt, 'dateTime')}
            </span>
          </div>
          <ul className="mt-2 space-y-1 text-xs text-text-300">
            {literature.corpus.retrievals.map((retrieval, index) => (
              <li key={`${retrieval.scope}:${retrieval.collectionId ?? ''}:${index}`}>
                <span className="font-medium text-text-200">{scopeLabel(retrieval.scope)}</span>
                {retrieval.query ? <span> · {retrieval.query}</span> : null}
                <span className="ml-1 tabular-nums text-text-400">
                  · {retrieval.resultCount} / {retrieval.totalCount}
                </span>
              </li>
            ))}
          </ul>
          <dl className="mt-3 grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border-300/60 bg-border-300/60 @min-[32rem]/sources:grid-cols-6">
            {[
              [t('Searched'), literature.corpus.coverage.searchedCount],
              [t('Candidates'), literature.corpus.coverage.candidateCount],
              [t('Included'), literature.corpus.items.length],
              [t('Full text'), literature.corpus.coverage.fullTextCount],
              [t('Abstract only'), literature.corpus.coverage.abstractOnlyCount],
              [t('Unprocessed'), literature.corpus.coverage.unprocessedCount]
            ].map(([label, count]) => (
              <div key={label} className="min-w-0 bg-bg-000 px-2 py-2 text-center">
                <dt className="truncate text-[10px] text-text-300">{label}</dt>
                <dd className="mt-0.5 text-sm font-medium tabular-nums text-text-000">{count}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      <ol className="mt-3 divide-y divide-border-300/60 border-y border-border-300/60">
        {literature.references.map((reference, index) => {
          const authors = referenceAuthors(reference)
          const publication = referencePublication(reference)

          return (
            <li key={reference.itemId}>
              <button
                type="button"
                aria-label={`${t('View details')}: ${reference.item.title}`}
                onClick={() => setSelectedReference(reference)}
                className="group grid w-full grid-cols-[1.25rem_minmax(0,1fr)_1rem] gap-2 py-3 text-left outline-none transition-colors duration-150 hover:bg-bg-200/60 focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 active:bg-bg-300 motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="pt-0.5 text-right text-xs tabular-nums text-text-300">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="line-clamp-2 text-sm font-semibold leading-5 text-text-000 transition-colors duration-150 group-hover:text-primary motion-reduce:transition-none">
                    {reference.item.title}
                  </h3>
                  {authors ? (
                    <p className="mt-1 line-clamp-1 text-xs leading-5 text-text-100">{authors}</p>
                  ) : null}
                  {publication ? (
                    <p className="text-xs leading-5 text-text-300">{publication}</p>
                  ) : null}
                  {reference.item.abstract ? (
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-text-300">
                      {reference.item.abstract}
                    </p>
                  ) : null}
                </div>
                <Eye
                  aria-hidden="true"
                  className="mt-0.5 size-4 text-text-300 transition-colors duration-150 group-hover:text-primary group-focus-visible:text-primary motion-reduce:transition-none"
                />
              </button>
            </li>
          )
        })}
      </ol>
      <ArtifactLiteratureDetailDialog
        reference={selectedReference}
        onOpenChange={(open) => {
          if (!open) setSelectedReference(undefined)
        }}
      />
    </section>
  )
}

export { ArtifactSourcesPanel }
