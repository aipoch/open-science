import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureRelatedRecord } from '@aipoch/literature-discovery/contracts'
import type { LiteratureItemInput } from '@aipoch/literature-library/item'
import {
  createLiteratureIdentifierUrl,
  normalizeLiteratureIdentifierKey
} from '@aipoch/literature-citations/contracts'
import { ExternalTextLink } from '@/components/ExternalTextLink'
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

const lookupSchemes = ['pmid', 'pmcid', 'doi', 'arxiv'] as const
type Identifier = LiteratureItemInput['identifiers'][number]
const identity = ({ scheme, value }: Identifier): string =>
  `${scheme}:${normalizeLiteratureIdentifierKey(scheme, value)}`

export function CitationPaperDetails({
  record
}: {
  record: LiteratureRelatedRecord
}): React.JSX.Element {
  const { t } = useTranslation()
  const { api } = useLiteratureHost()
  const item = record.item
  const identifier = lookupSchemes.flatMap((scheme) => {
    const matches = item.identifiers.filter((entry) => entry.scheme === scheme)
    return matches.length === 1 && createLiteratureIdentifierUrl(scheme, matches[0].value)
      ? matches
      : []
  })[0]
  const reference = identifier && identity(identifier)
  const [response, setResponse] = useState<{ reference: string; metadata?: LiteratureItemInput }>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!reference) return
    let active = true
    void lookupCachedLiteratureMetadata(api, reference, attempt > 0).then(
      (metadata) => {
        if (active) setResponse({ reference, metadata })
      },
      () => {
        if (active) setResponse({ reference })
      }
    )
    return () => {
      active = false
    }
  }, [api, reference, attempt])

  const current = response?.reference === reference ? response : undefined
  const candidate = current?.metadata
  const metadata =
    candidate?.identifiers.some((entry) => identity(entry) === reference) &&
    !item.identifiers.some(
      (local) =>
        lookupSchemes.some((scheme) => scheme === local.scheme) &&
        candidate.identifiers.some((remote) => remote.scheme === local.scheme) &&
        !candidate.identifiers.some((remote) => identity(remote) === identity(local))
    )
      ? candidate
      : undefined
  const authors = fullCreatorLabel(item) || (metadata && fullCreatorLabel(metadata))
  const publication = publicationCitation({
    ...item,
    containerTitle: item.containerTitle || metadata?.containerTitle || '',
    issuedYear: item.issuedYear ?? metadata?.issuedYear,
    issuedText:
      item.issuedText ||
      (metadata?.issuedYear === item.issuedYear || !item.issuedYear ? metadata?.issuedText : '') ||
      '',
    typeFields: { ...metadata?.typeFields, ...item.typeFields }
  })
  const identifiers = [
    ...item.identifiers,
    ...(metadata?.identifiers ?? []).filter(
      (entry) => !item.identifiers.some((local) => identity(local) === identity(entry))
    )
  ]
  const pending = Boolean(reference && !current)
  const abstract = item.abstract || metadata?.abstract
  const href = getExternalLiteratureUrl(item.url)?.href
  return (
    <div className="space-y-4 text-sm">
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
        ) : (
          (!reference || metadata) && (
            <p className="mt-2 text-xs text-muted-foreground">{t('No abstract available.')}</p>
          )
        )}
      </section>
      {pending && (
        <p role="status" className="sr-only">
          {t('Loading…')}
        </p>
      )}
      {current && !metadata && (
        <ErrorNotice
          inline
          role="alert"
          description={t('Lookup failed')}
          primaryButton={{
            label: t('Retry'),
            onClick: () => {
              setResponse(undefined)
              setAttempt((n) => n + 1)
            }
          }}
        />
      )}
    </div>
  )
}
