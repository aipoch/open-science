import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Info, LoaderCircle } from 'lucide-react'
import {
  getPublicationCheckDoi,
  literaturePublicationCheckResultSchema,
  type LiteraturePublicationCheckResult,
  type LiteraturePublicationCheckSnapshot
} from '@aipoch/literature-discovery/contracts'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import { ErrorNotice } from '@/components/error-notice'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLiteratureHost } from '../renderer-host'
import { isCollectionOnlyChange, useLiteratureChanges } from '../useLiteratureChanges'

type Issue = NonNullable<LiteraturePublicationCheckResult['issue']>
type Mode = 'get' | 'check'

export function LiteraturePublicationCheck({
  item
}: {
  item: LiteratureItemView
}): React.JSX.Element {
  const doi = getPublicationCheckDoi(item.item.identifiers)
  return (
    <PublicationCheck
      key={JSON.stringify([
        item.id,
        item.metadataRevision,
        doi,
        item.deletedAt,
        item.mergedIntoItemId
      ])}
      item={item}
      doi={doi}
    />
  )
}

function PublicationCheck({
  item,
  doi
}: {
  item: LiteratureItemView
  doi: string | undefined
}): React.JSX.Element {
  const { api } = useLiteratureHost()
  const { t, i18n } = useTranslation()
  const headingId = useId()
  const helpId = useId()
  const unavailable = Boolean(item.deletedAt !== undefined || item.mergedIntoItemId)
  const [snapshot, setSnapshot] = useState<LiteraturePublicationCheckSnapshot>()
  const [issue, setIssue] = useState<Issue>()
  const [loading, setLoading] = useState(Boolean(doi && !unavailable))
  const [checking, setChecking] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [retryMode, setRetryMode] = useState<Mode>('get')
  const readRequest = useRef<object | undefined>(undefined)
  const checkRequest = useRef<object | undefined>(undefined)
  const identityGeneration = useRef(0)
  const checkVersion = useRef(0)
  const checkOwnsOutcome = useRef(false)

  const run = useCallback(
    async (mode: Mode, refresh = false): Promise<void> => {
      if (
        !doi ||
        unavailable ||
        (mode === 'get' && readRequest.current && !refresh) ||
        (mode === 'check' && (checkRequest.current || readRequest.current))
      )
        return
      const token = {}
      const generation = identityGeneration.current
      const version = checkVersion.current
      if (mode === 'check') {
        checkRequest.current = token
        checkOwnsOutcome.current = true
        setChecking(true)
        setIssue(undefined)
        setRetryMode('check')
      } else {
        readRequest.current = token
        setLoading(true)
        if (!checkOwnsOutcome.current) {
          setIssue(undefined)
          setRetryMode('get')
        }
      }
      const current = (): boolean =>
        generation === identityGeneration.current &&
        (mode === 'check' ? checkRequest.current === token : readRequest.current === token)
      const invalidateIdentity = (reason: Issue): void => {
        identityGeneration.current += 1
        checkOwnsOutcome.current = false
        setSnapshot(undefined)
        setLoaded(false)
        setIssue(reason)
        setRetryMode('get')
      }
      const reportIssue = (reason?: Issue): void => {
        if (mode === 'check') {
          checkVersion.current += 1
          // A failed manual command keeps its retry ownership. A successful one
          // must not suppress errors from later, independent saved-result reads.
          checkOwnsOutcome.current = reason !== undefined
          setIssue(reason)
          setRetryMode('check')
        } else if (!checkOwnsOutcome.current && version === checkVersion.current) {
          setIssue(reason)
          setRetryMode('get')
        }
      }
      try {
        const parsed = literaturePublicationCheckResultSchema.safeParse(
          await api.literature.publicationCheck({
            mode,
            itemId: item.id,
            expectedMetadataRevision: item.metadataRevision
          })
        )
        if (!current()) return
        if (!parsed.success) {
          reportIssue('response-invalid')
          return
        }
        const result = parsed.data
        if (
          result.itemId !== item.id ||
          result.metadataRevision !== item.metadataRevision ||
          (result.snapshot && result.snapshot.doi !== doi)
        ) {
          if (mode === 'get') invalidateIdentity('response-invalid')
          else reportIssue('response-invalid')
          return
        }
        if (
          result.issue === 'reference-changed' ||
          result.issue === 'reference-unavailable' ||
          result.issue === 'doi-required'
        ) {
          invalidateIdentity(result.issue)
          return
        }
        // Identity failures above always win. A same-identity saved read may not replace
        // the outcome of a manual check that settled after that read began.
        if (mode === 'get' && version !== checkVersion.current) return
        if (mode === 'check' && !result.snapshot && !result.issue) {
          reportIssue('response-invalid')
          return
        }
        if (result.snapshot) {
          const incoming = result.snapshot
          setSnapshot((previous) =>
            previous && previous.checkedAt > incoming.checkedAt ? previous : incoming
          )
        } else if (!result.issue && !checkOwnsOutcome.current) {
          setSnapshot(undefined)
        }
        if (!result.issue) setLoaded(true)
        reportIssue(result.issue)
      } catch {
        if (current()) reportIssue('unavailable')
      } finally {
        if (checkRequest.current === token) {
          checkRequest.current = undefined
          setChecking(false)
        }
        if (readRequest.current === token) {
          readRequest.current = undefined
          setLoading(false)
        }
      }
    },
    [api.literature, doi, item.id, item.metadataRevision, unavailable]
  )

  useLayoutEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void run('get', true)
    })
    return () => {
      active = false
      identityGeneration.current += 1
      readRequest.current = undefined
    }
  }, [run])
  useLayoutEffect(
    () => () => {
      checkRequest.current = undefined
    },
    []
  )
  useLiteratureChanges((event) => {
    if (!isCollectionOnlyChange(event)) void run('get', true)
  })

  const issueMessage = (): string => {
    switch (issue) {
      case 'doi-required':
        return t('Add one valid DOI to check this reference.')
      case 'reference-changed':
        return t('This reference changed. Reload its details before checking again.')
      case 'reference-unavailable':
        return t('This reference is no longer available.')
      case 'rate-limited':
        return t('Crossref is receiving too many requests. Try again later.')
      case 'timeout':
        return t('The publication check timed out. Try again.')
      case 'response-invalid':
        return t('The publication check returned an invalid response. Try again.')
      case 'not-found':
        return t('Crossref has no record for this DOI.')
      default:
        return t('Could not load the publication check. Try again.')
    }
  }
  const noticeLabel = (type: string): string => {
    switch (type.toLowerCase().replace(/[\s-]+/g, '_')) {
      case 'retraction':
        return t('Retraction notice')
      case 'partial_retraction':
        return t('Partial retraction notice')
      case 'withdrawal':
        return t('Withdrawal notice')
      case 'correction':
      case 'erratum':
      case 'corrigendum':
        return t('Correction notice')
      case 'expression_of_concern':
        return t('Expression of concern')
      case 'reinstatement':
        return t('Reinstatement notice')
      default:
        return t('Publication update')
    }
  }

  const helpMessage = t(
    'Checking sends only this DOI to Crossref. Coverage is incomplete; no notices does not establish that a reference is reliable.'
  )

  return (
    <section className="py-6" aria-labelledby={headingId}>
      <h3 id={headingId} className="sr-only">
        {t('Retractions and corrections')}
      </h3>
      <p id={helpId} className="sr-only">
        {helpMessage}
      </p>
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 flex-1 space-y-3">
          {unavailable ? (
            <p className="text-sm text-muted-foreground">
              {t('This reference is no longer available.')}
            </p>
          ) : !doi ? (
            <p className="text-sm text-muted-foreground">
              {t('Add one valid DOI to check this reference.')}
            </p>
          ) : null}
          {loading || checking ? (
            <p
              role="status"
              className={snapshot || checking ? 'sr-only' : 'text-sm text-muted-foreground'}
            >
              {checking ? t('Checking Crossref…') : t('Loading saved publication check…')}
            </p>
          ) : null}
          {issue ? (
            <ErrorNotice inline role="alert" tone="amber" description={issueMessage()} />
          ) : null}
          {snapshot ? (
            snapshot.notices.length === 0 ? (
              <div className="flex min-h-9 items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <FileText className="size-4" aria-hidden="true" />
                </span>
                <p role="status" className="text-sm font-medium">
                  {t('No related notices found.')}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {snapshot.notices.map((notice, index) => (
                  <li
                    key={JSON.stringify([
                      notice.doi,
                      notice.type,
                      notice.date,
                      notice.source,
                      index
                    ])}
                    className="space-y-1 py-3 first:pt-0 last:pb-0"
                  >
                    <p className="font-medium">{noticeLabel(notice.type)}</p>
                    <p className="break-words text-xs text-muted-foreground">{notice.type}</p>
                    <p className="text-xs text-muted-foreground">
                      {notice.source === 'publisher'
                        ? t('Publisher via Crossref')
                        : notice.source === 'retraction-watch'
                          ? t('Retraction Watch via Crossref')
                          : t('Crossref')}
                      {notice.date ? (
                        <>
                          {' '}
                          · <time dateTime={notice.date}>{notice.date}</time>
                        </>
                      ) : null}
                    </p>
                    <ExternalTextLink
                      className="break-all text-xs"
                      href={`https://doi.org/${encodeURIComponent(notice.doi)}`}
                    >
                      {notice.doi}
                    </ExternalTextLink>
                  </li>
                ))}
              </ul>
            )
          ) : loaded && !issue && !loading && !checking ? (
            <div className="flex min-h-9 items-center gap-3 text-muted-foreground">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <FileText className="size-4" aria-hidden="true" />
              </span>
              <p className="text-sm">{t('Not checked')}</p>
            </div>
          ) : null}
        </div>
        <Button
          className="max-w-full whitespace-normal"
          disabled={!doi || unavailable || loading || checking}
          aria-describedby={helpId}
          onClick={() => void run(issue ? retryMode : 'check')}
        >
          {checking ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
          {checking
            ? t('Checking Crossref…')
            : issue
              ? t('Retry')
              : snapshot
                ? t('Check again')
                : t('Check now')}
        </Button>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <span>{t('Crossref')}</span>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={t('About this check')}>
                  <Info className="size-3.5" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{helpMessage}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        {snapshot ? (
          <p>
            {t('Last checked: {{time}}', {
              time: new Date(snapshot.checkedAt).toLocaleString(i18n.language, {
                dateStyle: 'medium',
                timeStyle: 'short'
              })
            })}
          </p>
        ) : null}
      </div>
    </section>
  )
}
