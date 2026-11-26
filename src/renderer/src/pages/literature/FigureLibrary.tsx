import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type { PdfAnnotation, PdfAnnotationListResult } from '../../../../shared/pdf-annotations'
import { useLiteratureHost } from './renderer-host'
import { useLiteratureChanges } from './useLiteratureChanges'

type Cursor = NonNullable<PdfAnnotationListResult['nextCursor']>

export function FigureLibrary({
  onOpen,
  revealError
}: {
  onOpen: (annotation: PdfAnnotation) => void
  revealError?: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api, useTagStore } = useLiteratureHost()
  const tags = useTagStore((state) => state.tags)
  const [tagId, setTagId] = useState('')
  const [history, setHistory] = useState<Cursor[]>([])
  const cursor = history.at(-1)
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([tagId, cursor, revision])
  const [response, setResponse] = useState<{ key: string; page?: PdfAnnotationListResult }>()
  const page = response?.key === key ? response.page : undefined
  const failed = response?.key === key && !response.page

  useLiteratureChanges(() => setRevision((value) => value + 1))
  useEffect(() => api.pdfAnnotations.onChanged(() => setRevision((value) => value + 1)), [api])
  useEffect(() => {
    let current = true
    void api.pdfAnnotations.listFigures({ tagIds: tagId ? [tagId] : [], cursor }).then(
      (result) => {
        if (current) setResponse({ key, page: result })
      },
      () => {
        if (current) setResponse({ key })
      }
    )
    return () => {
      current = false
    }
  }, [api, tagId, cursor, key])

  function selectTag(id: string): void {
    setHistory([])
    setTagId(id)
  }

  return (
    <div className="flex min-h-0 w-full flex-col gap-5 overflow-y-auto p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t('Saved figures')}</h2>
        <label className="flex items-center gap-2 text-sm">
          {t('Tags')}
          <select
            className="max-w-56 rounded-md border border-border bg-bg-000 px-2 py-1"
            value={tagId}
            onChange={(event) => selectTag(event.target.value)}
          >
            <option value="">{t('All tags')}</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {'name' in tag ? tag.name : t('Favorites')}
              </option>
            ))}
          </select>
        </label>
      </header>
      {revealError && <ErrorNotice inline role="alert" tone="amber" description={revealError} />}
      {failed ? (
        <ErrorNotice
          inline
          role="alert"
          tone="amber"
          description={t('Saved figures could not be loaded.')}
          primaryButton={{ label: t('Retry'), onClick: () => setRevision((value) => value + 1) }}
        />
      ) : !page ? (
        <p role="status">{t('Loading')}</p>
      ) : page.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {tagId || cursor
            ? t('No results found')
            : t('Select a region in a library PDF to save a figure or table here.')}
        </p>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] items-start gap-4">
          {page.items.map((annotation) => {
            const { figure, target } = annotation
            if (!figure || target.selector.kind !== 'region') return null
            const title = annotation.sourceTitle || target.source.name
            const pageLabel = t('Page {{page}}', { page: target.selector.pageNumber })
            return (
              <li
                key={annotation.id}
                className="overflow-hidden rounded-lg border border-border bg-bg-000"
              >
                <button
                  type="button"
                  onClick={() => onOpen(annotation)}
                  className="block w-full text-left focus-visible:outline-ring focus-visible:-outline-offset-2"
                  aria-label={t('Open {{figure}} in {{source}}, {{page}}', {
                    figure: figure.figureNumber || t('Saved figure'),
                    source: title,
                    page: pageLabel
                  })}
                >
                  <img
                    className="h-44 w-full bg-white object-contain"
                    alt={figure.caption}
                    src={'data:image/png;base64,' + figure.image.data}
                  />
                  <span className="flex flex-col gap-1 p-3">
                    {figure.figureNumber && (
                      <strong className="break-words text-sm">{figure.figureNumber}</strong>
                    )}
                    {figure.caption && (
                      <span className="whitespace-pre-wrap break-words text-sm">
                        {figure.caption}
                      </span>
                    )}
                    <span className="break-words text-xs text-muted-foreground">
                      {title} · {pageLabel}
                    </span>
                  </span>
                </button>
                {annotation.note && (
                  <p className="whitespace-pre-wrap break-words px-3 pb-3 text-sm">
                    {annotation.note}
                  </p>
                )}
                {annotation.tagIds.length > 0 && (
                  <div className="flex flex-wrap gap-1 px-3 pb-3">
                    {tags
                      .filter((tag) => annotation.tagIds.includes(tag.id))
                      .map((tag) => (
                        <button
                          key={tag.id}
                          type="button"
                          className="max-w-full truncate rounded bg-bg-200 px-2 py-1 text-xs hover:bg-bg-300"
                          onClick={() => selectTag(tag.id)}
                        >
                          {'name' in tag ? tag.name : t('Favorites')}
                        </button>
                      ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {(cursor || page?.nextCursor) && (
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!cursor}
            onClick={() => setHistory((values) => values.slice(0, -1))}
          >
            {t('Previous page')}
          </Button>
          <Button
            variant="outline"
            disabled={!page?.nextCursor}
            onClick={() => {
              if (page?.nextCursor) setHistory([...history, page.nextCursor])
            }}
          >
            {t('Next page')}
          </Button>
        </div>
      )}
    </div>
  )
}
