import { z } from 'zod'
import { ChevronRight } from 'lucide-react'
import { useLiteratureHost } from './renderer-host'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { ErrorNotice } from '@/components/error-notice'
import type { LiteratureSourceRecordView } from '@aipoch/literature-library/contracts'
import { useLiteratureChanges } from './useLiteratureChanges'

const sourceLink = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

const discoveryContext = z
  .object({
    rootItemId: z.string().min(1),
    seedPaperId: z.string().optional(),
    exploredPaperId: z.string().optional(),
    direction: z.enum(['references', 'citations']).optional(),
    directions: z.array(z.enum(['references', 'citations'])).optional()
  })
  .refine((value) => value.seedPaperId || value.exploredPaperId)

const contextsFor = (source: LiteratureSourceRecordView): z.infer<typeof discoveryContext>[] => {
  if (!['europe-pmc', 'opencitations'].includes(source.provider)) return []
  const stored = source.rawMetadata.citationContexts
  return (Array.isArray(stored) ? stored : [source.rawMetadata]).flatMap((value) => {
    const parsed = discoveryContext.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}

const SourceRecord = ({
  source,
  titles
}: {
  source: LiteratureSourceRecordView
  titles: Record<string, string>
}): React.JSX.Element => {
  const { i18n, t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const href = source.sourceUrl ? sourceLink(source.sourceUrl) : undefined
  return (
    <li className="min-w-0 space-y-2 py-3">
      <p className="break-words font-medium">{source.provider}</p>
      {source.externalId ? (
        <p className="break-all text-xs text-muted-foreground">{source.externalId}</p>
      ) : null}
      {source.sourceUrl ? (
        <p className="break-all text-xs">
          {href ? (
            <ExternalTextLink href={href}>{source.sourceUrl}</ExternalTextLink>
          ) : (
            source.sourceUrl
          )}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t('Source record saved: {{time}}', {
          time: new Date(source.savedAt).toLocaleString(i18n.language)
        })}
      </p>
      {contextsFor(source).map((context, index) => (
        <div key={index} className="space-y-1 text-xs text-muted-foreground">
          <p>
            {t('Exploration started from {{paper}}', {
              paper: titles[context.rootItemId] ?? context.rootItemId
            })}
          </p>
          <p className="break-all">
            {context.exploredPaperId
              ? t('Current center')
              : [...new Set(context.directions ?? (context.direction ? [context.direction] : []))]
                  .map((direction) =>
                    direction === 'references' ? t('References') : t('Cited by')
                  )
                  .join(' · ')}
            {' · '}
            {context.seedPaperId ?? context.exploredPaperId}
          </p>
        </div>
      ))}
      <details onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer rounded text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('Stored metadata')}
        </summary>
        {expanded ? (
          <pre
            tabIndex={0}
            aria-label={t('Stored metadata')}
            className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {JSON.stringify(source.rawMetadata, null, 2)}
          </pre>
        ) : null}
      </details>
    </li>
  )
}

const LiteratureSources = ({ itemId }: { itemId: string }): React.JSX.Element => {
  const { api: hostApi } = useLiteratureHost()

  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [sources, setSources] = useState<LiteratureSourceRecordView[]>()
  const [failed, setFailed] = useState(false)
  const [titles, setTitles] = useState<Record<string, string>>({})
  useLiteratureChanges(() => {
    if (open) setAttempt((value) => value + 1)
  })
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void hostApi.literature.sources(itemId).then(
      async (records) => {
        if (!cancelled) {
          setSources(records)
          setFailed(false)
          const ids = [
            ...new Set(
              records.flatMap((source) => contextsFor(source).map((context) => context.rootItemId))
            )
          ]
          const entries = await Promise.all(
            ids.map(async (id): Promise<[string, string]> => {
              try {
                const root = await hostApi.literature.get(id)
                return [id, root?.item.title || id]
              } catch {
                return [id, id]
              }
            })
          )
          if (!cancelled) setTitles(Object.fromEntries(entries))
        }
      },
      () => {
        if (!cancelled) setFailed(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [itemId, open, attempt, hostApi.literature])

  return (
    <details
      className="py-4"
      onToggle={(event) => {
        // Nested raw-metadata disclosures must not change the outer load lifecycle.
        if (event.target === event.currentTarget && event.currentTarget.open !== open) {
          setSources(undefined)
          setFailed(false)
          setOpen(event.currentTarget.open)
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {t('Metadata sources')}
        <ChevronRight
          className={`size-4 shrink-0 text-muted-foreground ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
      </summary>
      {open ? (
        <div className="mt-3">
          {failed ? (
            <div className="mt-3">
              <ErrorNotice
                role="alert"
                tone="amber"
                title={t('Could not load metadata sources')}
                primaryButton={{
                  label: t('Retry'),
                  onClick: () => {
                    setSources(undefined)
                    setFailed(false)
                    setAttempt((value) => value + 1)
                  }
                }}
              />
            </div>
          ) : sources === undefined ? (
            <p role="status" className="text-xs text-muted-foreground">
              {t('Loading…')}
            </p>
          ) : sources.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('No sources saved')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {sources.map((source) => (
                <SourceRecord key={source.id} source={source} titles={titles} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </details>
  )
}

export { LiteratureSources }
