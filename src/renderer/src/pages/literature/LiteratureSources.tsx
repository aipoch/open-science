import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ExternalTextLink } from '@/components/ExternalTextLink'
import { ErrorNotice } from '@/components/error-notice'
import { useLiteratureChanges } from './useLiteratureChanges'
import type { LiteratureSourceRecordView } from '../../../../shared/literature'

const sourceLink = (value: string): string | undefined => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

const SourceRecord = ({ source }: { source: LiteratureSourceRecordView }): React.JSX.Element => {
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
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [sources, setSources] = useState<LiteratureSourceRecordView[]>()
  const [failed, setFailed] = useState(false)
  useLiteratureChanges(() => {
    if (open) setAttempt((value) => value + 1)
  })
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.api.literature.sources(itemId).then(
      (records) => {
        if (!cancelled) {
          setSources(records)
          setFailed(false)
        }
      },
      () => {
        if (!cancelled) setFailed(true)
      }
    )
    return () => {
      cancelled = true
    }
  }, [itemId, open, attempt])

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
      <summary className="cursor-pointer rounded font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t('Metadata sources')}
      </summary>
      {open ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">
            {t(
              'Saved source records, not a complete change history. Times show when each record was saved.'
            )}
          </p>
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
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              {t('Loading…')}
            </p>
          ) : sources.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {t('No saved metadata sources for this reference.')}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {sources.map((source) => (
                <SourceRecord key={source.id} source={source} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </details>
  )
}

export { LiteratureSources }
