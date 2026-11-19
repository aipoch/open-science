import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureRelatedRecord } from '@aipoch/literature-discovery/contracts'
import {
  citationMetadataReference,
  supplementedCitation,
  verifiedCitationMetadata,
  type CitationMetadata
} from './citation-graph'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { parseApplicationCommandError } from '../../../../../shared/application-command-contract'
import { ErrorNotice } from '@/components/error-notice'
import { lookupCachedLiteratureMetadata } from '../literature-metadata-lookup'
import {
  fullCreatorLabel,
  getExternalLiteratureUrl,
  publicationCitation
} from '../literature-item-display'
import { useLiteratureHost } from '../renderer-host'
import { CollapsibleAbstract } from './LiteratureDetailText'
import { LiteratureIdentifiers } from './LiteratureIdentifiers'

export function CitationPaperDetails({
  record,
  paperMetadata,
  conflicting
}: {
  record: LiteratureRelatedRecord
  paperMetadata: CitationMetadata
  conflicting?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const base = record.item
  const reference = conflicting ? undefined : citationMetadataReference(base)
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<{ reference: string; retryable: boolean }>()
  useEffect(() => {
    if (!reference) return
    const reader = new AbortController()
    void lookupCachedLiteratureMetadata(api, reference, attempt > 0, reader.signal).then(
      (candidate) => {
        if (reader.signal.aborted) return
        if (verifiedCitationMetadata(base, candidate, reference))
          paperMetadata.set(reference, candidate)
        setSettled({ reference, retryable: false })
      },
      (error) => {
        if (!reader.signal.aborted)
          setSettled({
            reference,
            retryable:
              parseApplicationCommandError(error)?.code ===
              'literature-metadata-temporarily-unavailable'
          })
      }
    )
    return () => reader.abort()
  }, [api, base, reference, attempt, paperMetadata])

  const supplement = supplementedCitation(base, conflicting ? undefined : paperMetadata)
  const { item } = supplement
  const pending = Boolean(reference && settled?.reference !== reference && !supplement.reference)
  const authors = fullCreatorLabel(item)
  const publication = publicationCitation(item)
  const { identifiers, abstract } = item
  const href = getExternalLiteratureUrl(item.url)?.href
  return (
    <div className="space-y-4 text-sm">
      {conflicting && <p className="text-xs">{t('Conflicting identifiers')}</p>}
      <div className="space-y-1.5">
        {pending && !authors && (
          <div
            aria-hidden="true"
            className="h-3 w-2/3 rounded bg-muted motion-safe:animate-pulse"
          />
        )}
        {pending && !publication && (
          <div
            aria-hidden="true"
            className="h-3 w-1/2 rounded bg-muted motion-safe:animate-pulse"
          />
        )}
        {authors && <p className="break-words leading-snug">{authors}</p>}
        {publication && (
          <p className="break-words text-xs leading-relaxed text-muted-foreground">{publication}</p>
        )}
        {href && (
          <ExternalTextLink href={href} className="text-xs">
            {t('Open in {{source}}', {
              source: record.paperId.startsWith('europe-pmc:') ? t('Europe PMC') : 'OpenCitations'
            })}
          </ExternalTextLink>
        )}
      </div>
      {identifiers.length > 0 && (
        <LiteratureIdentifiers
          identifiers={identifiers}
          className="border-t border-border-300 pt-3 text-xs"
        />
      )}
      <section className="border-t border-border-300 pt-3">
        <h4 className="font-medium">{t('Abstract')}</h4>
        {abstract ? (
          <CollapsibleAbstract text={abstract} />
        ) : pending ? (
          <div
            data-slot="abstract-skeleton"
            aria-hidden="true"
            className="mt-3 space-y-2.5 motion-safe:animate-pulse"
          >
            {['w-full', 'w-11/12', 'w-full', 'w-3/5'].map((width, index) => (
              <div key={index} className={`h-2.5 rounded bg-muted ${width}`} />
            ))}
          </div>
        ) : settled?.reference === reference && settled?.retryable ? (
          <ErrorNotice
            inline
            role="alert"
            description={t('The provider is temporarily unavailable. Please try again later.')}
            primaryButton={{
              label: t('Retry'),
              onClick: () => {
                setSettled(undefined)
                setAttempt((n) => n + 1)
              }
            }}
          />
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">{t('No abstract available.')}</p>
        )}
      </section>
      {pending && (
        <p role="status" className="sr-only">
          {t('Loading…')}
        </p>
      )}
    </div>
  )
}
