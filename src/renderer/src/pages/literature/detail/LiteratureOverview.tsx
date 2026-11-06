import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import {
  literatureOverviewSource,
  type LiteratureOverview as LiteratureOverviewData,
  type LiteratureOverviewIssue
} from '../../../../../shared/literature-overview'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useLiteratureHost } from '../renderer-host'

type OverviewFailure = LiteratureOverviewIssue | 'generation-failed'

type OverviewProps = {
  item: LiteratureItemView
  overviewRevision?: number
  batchGenerating?: boolean
}

export function LiteratureOverview({
  item,
  overviewRevision,
  batchGenerating
}: OverviewProps): React.JSX.Element {
  const { i18n } = useTranslation()
  // A source/language owns its own state. Late responses cannot update another keyed instance.
  return (
    <OverviewContent
      key={JSON.stringify([
        literatureOverviewSource(item).key,
        i18n.resolvedLanguage ?? i18n.language
      ])}
      item={item}
      overviewRevision={overviewRevision}
      batchGenerating={batchGenerating}
    />
  )
}

function OverviewContent({
  item,
  overviewRevision,
  batchGenerating
}: OverviewProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { api } = useLiteratureHost()
  const [result, setResult] = useState<LiteratureOverviewData>()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<OverviewFailure>()
  const [readRevision, setReadRevision] = useState(0)
  const busy = useRef(false)
  const deferredRead = useRef(false)
  const readInFlight = useRef(false)
  const sourceInvalidated = useRef(false)
  const generation = useRef(0)
  const source = literatureOverviewSource(item)
  const available = source.active && Boolean(item.item.abstract?.trim() || source.document)
  useEffect(() => {
    // A cached result cannot establish that a source rejected by generation is usable again.
    if (sourceInvalidated.current) return
    // A manual generation owns the result; recover the batch save if that generation fails.
    if (busy.current) {
      deferredRead.current = true
      return
    }
    let current = true
    readInFlight.current = true
    const initialGeneration = generation.current
    const initialLanguage = i18n.resolvedLanguage ?? i18n.language
    void api.literature
      .studySnapshot({
        mode: 'read',
        itemId: item.id,
        expectedSourceKey: source.key,
        language: initialLanguage
      })
      .then((saved) => {
        if (
          current &&
          generation.current === initialGeneration &&
          saved.sourceKey === source.key &&
          !('issue' in saved)
        ) {
          setResult(saved)
        }
      })
      .catch(() => {
        /* Generation remains available when loading a saved result fails. */
      })
      .finally(() => {
        if (current) readInFlight.current = false
      })
    return () => {
      current = false
      readInFlight.current = false
    }
  }, [
    api,
    item.id,
    source.key,
    i18n.resolvedLanguage,
    i18n.language,
    overviewRevision,
    readRevision
  ])
  const generate = async (): Promise<void> => {
    if (busy.current || batchGenerating) return
    if (readInFlight.current) deferredRead.current = true
    busy.current = true
    generation.current++
    setPending(true)
    setFailure(undefined)
    let generated = false
    try {
      const overview = await api.literature.studySnapshot({
        itemId: item.id,
        expectedSourceKey: source.key,
        language: i18n.resolvedLanguage ?? i18n.language
      })
      if (overview.sourceKey !== source.key) throw new Error('Stale study overview response.')
      if ('issue' in overview) {
        setFailure(overview.issue)
        if (overview.issue === 'source-changed' || overview.issue === 'source-unavailable') {
          sourceInvalidated.current = true
          deferredRead.current = false
          setResult(undefined)
        }
        return
      }
      sourceInvalidated.current = false
      setResult(overview)
      generated = true
    } catch {
      setFailure('generation-failed')
    } finally {
      busy.current = false
      setPending(false)
      if (deferredRead.current) {
        deferredRead.current = false
        if (!generated) setReadRevision((revision) => revision + 1)
      }
    }
  }
  const failureDescriptions: Record<OverviewFailure, string> = {
    'not-generated': t('Generate overview'),
    busy: t('Too many overviews are being generated. Try again shortly.'),
    'source-changed': t('This reference has changed. Reopen its details and try again.'),
    'source-unavailable': t('Add an abstract or readable full-text PDF to generate an overview.'),
    'input-too-large': t('The available source exceeds the overview input limit.'),
    'generation-failed': result
      ? t(
          'Could not regenerate the overview. The previous result is still shown. Please try again.'
        )
      : t('Could not generate the overview. Please try again.')
  }
  const generating = pending || Boolean(batchGenerating)
  return (
    <section className="py-4" aria-label={t('Paper overview')} aria-busy={generating}>
      <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 font-medium">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            {t('Paper overview')}
          </h3>
          {result ? (
            <span className="rounded bg-background px-1.5 py-0.5 text-xs text-muted-foreground">
              {result.coverage === 'abstract'
                ? t('Based on abstract')
                : result.coverage === 'full-text'
                  ? t('Based on full text')
                  : t('Based on selected passages')}
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={generating || !available}
            onClick={() => void generate()}
          >
            {generating ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : result ? (
              <RefreshCw className="size-3.5" aria-hidden="true" />
            ) : null}
            {generating
              ? t('Generating overview…')
              : failure
                ? t('Retry')
                : result
                  ? t('Regenerate')
                  : t('Generate overview')}
          </Button>
        </div>
        {!result && !generating && !available ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {!source.active
              ? t('This reference is no longer available.')
              : t('Add an abstract or readable full-text PDF to generate an overview.')}
          </p>
        ) : null}
        {generating ? (
          <p role="status" className="mt-2 text-xs text-muted-foreground">
            {t('Reading the available source and generating an overview…')}
          </p>
        ) : null}
        {failure ? (
          <ErrorNotice
            inline
            role="alert"
            tone="amber"
            description={failureDescriptions[failure]}
          />
        ) : null}
        {result ? <LiteratureOverviewDetails overview={result} /> : null}
      </div>
    </section>
  )
}

export function LiteratureOverviewDetails({
  overview
}: {
  overview: LiteratureOverviewData
}): React.JSX.Element {
  const { t } = useTranslation()
  const rows = [
    [t('Research question'), overview.sections.question],
    [t('Study population'), overview.sections.population],
    [t('Research methods'), overview.sections.methods],
    [t('Main findings'), overview.sections.results],
    [t('Study limitations'), overview.sections.limitations]
  ]
  return (
    <>
      <dl className="mt-3 divide-y divide-primary/10 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3">
            <dt className="font-medium">{label}</dt>
            <dd className="whitespace-pre-wrap break-words text-muted-foreground">
              {value ?? t('Not reported in the available source')}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('Model')}: {overview.model}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('AI-generated. Verify against the original paper.')}
      </p>
    </>
  )
}
