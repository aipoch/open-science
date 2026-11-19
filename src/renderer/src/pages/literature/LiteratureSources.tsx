import { literatureOpenCitationsModeSchema } from '@aipoch/literature-discovery/contracts'
import { getExternalLiteratureUrl } from './literature-item-display'
import { z } from 'zod'
import { ChevronRight } from 'lucide-react'
import { useLiteratureHost } from './renderer-host'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { ErrorNotice } from '@/components/error-notice'
import type { LiteratureSourceRecordView } from '@aipoch/literature-library/contracts'
import { useLiteratureChanges } from './useLiteratureChanges'

const discoveryContext = z
  .object({
    rootItemId: z.string().min(1),
    lookupMode: literatureOpenCitationsModeSchema.optional().catch(undefined),
    rootMetadataRevision: z.number().int().positive().optional().catch(undefined),
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
  const retrievedAt = z
    .number()
    .int()
    .nonnegative()
    .max(8640000000000000)
    .safeParse(source.rawMetadata.retrievedAt)
  const href = source.sourceUrl && getExternalLiteratureUrl(source.sourceUrl)?.href
  const contexts = contextsFor(source)
  const revisions = new Map<string, Set<number>>()
  for (const { rootItemId, rootMetadataRevision } of contexts) {
    if (rootMetadataRevision === undefined) continue
    const values = revisions.get(rootItemId) ?? new Set<number>()
    values.add(rootMetadataRevision)
    revisions.set(rootItemId, values)
  }
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
      {retrievedAt.success ? (
        <p className="text-xs text-muted-foreground">
          {t('Fetched: {{time}}', {
            time: new Date(retrievedAt.data).toLocaleString(i18n.language)
          })}
        </p>
      ) : null}
      {contexts.map((context, index) => (
        <div key={index} className="space-y-1 text-xs text-muted-foreground">
          <p>
            {t('Exploration started from {{paper}}', {
              paper: titles[context.rootItemId] ?? context.rootItemId
            })}
          </p>
          {context.rootMetadataRevision && (revisions.get(context.rootItemId)?.size ?? 0) > 1 ? (
            <p>{t('Metadata revision {{revision}}', { revision: context.rootMetadataRevision })}</p>
          ) : null}
          {source.provider === 'opencitations' && context.lookupMode ? (
            <p>
              {context.lookupMode === 'index'
                ? t('OpenCitations · Index v2')
                : t('OpenCitations · SKG-IF')}
            </p>
          ) : null}
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
