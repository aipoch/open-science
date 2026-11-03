import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import type { LiteratureItemView } from '@aipoch/literature-library/contracts'
import {
  literatureSnapshotSource,
  type LiteratureSnapshot,
  type LiteratureSnapshotIssue
} from '../../../../../shared/literature-snapshot'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import { useLiteratureHost } from '../renderer-host'

type SnapshotFailure = LiteratureSnapshotIssue | 'generation-failed'

export function LiteratureStudySnapshot({ item }: { item: LiteratureItemView }): React.JSX.Element {
  const { i18n } = useTranslation()
  // A source/language owns its own state. Late responses cannot update another keyed instance.
  return (
    <SnapshotContent
      key={JSON.stringify([
        literatureSnapshotSource(item).key,
        i18n.resolvedLanguage ?? i18n.language
      ])}
      item={item}
    />
  )
}

function SnapshotContent({ item }: { item: LiteratureItemView }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { api } = useLiteratureHost()
  const [result, setResult] = useState<LiteratureSnapshot>()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<SnapshotFailure>()
  const busy = useRef(false)
  const generation = useRef(0)
  const source = literatureSnapshotSource(item)
  const available = source.active && Boolean(item.item.abstract?.trim() || source.document)
  useEffect(() => {
    let current = true
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
        )
          setResult(saved)
      })
      .catch(() => {
        /* Generation remains available when loading a saved result fails. */
      })
    return () => {
      current = false
    }
  }, [api, item.id, source.key, i18n.resolvedLanguage, i18n.language])
  const generate = async (): Promise<void> => {
    if (busy.current) return
    busy.current = true
    generation.current++
    setPending(true)
    setFailure(undefined)
    try {
      const snapshot = await api.literature.studySnapshot({
        itemId: item.id,
        expectedSourceKey: source.key,
        language: i18n.resolvedLanguage ?? i18n.language
      })
      if (snapshot.sourceKey !== source.key) throw new Error('Stale study snapshot response.')
      if ('issue' in snapshot) {
        setFailure(snapshot.issue)
        if (snapshot.issue === 'source-changed' || snapshot.issue === 'source-unavailable')
          setResult(undefined)
        return
      }
      setResult(snapshot)
    } catch {
      setFailure('generation-failed')
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const failureDescriptions: Record<SnapshotFailure, string> = {
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
  const rows = result
    ? [
        [t('Research question'), result.sections.question],
        [t('Study population'), result.sections.population],
        [t('Research methods'), result.sections.methods],
        [t('Main findings'), result.sections.results],
        [t('Study limitations'), result.sections.limitations]
      ]
    : []
  return (
    <section className="py-4" aria-label={t('Study overview')} aria-busy={pending}>
      <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 font-medium">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            {t('Study overview')}
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
            disabled={pending || !available}
            onClick={() => void generate()}
          >
            {pending ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : result ? (
              <RefreshCw className="size-3.5" aria-hidden="true" />
            ) : null}
            {pending
              ? t('Generating overview…')
              : failure
                ? t('Retry')
                : result
                  ? t('Regenerate')
                  : t('Generate overview')}
          </Button>
        </div>
        {!result && !pending && !available ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {!source.active
              ? t('This reference is no longer available.')
              : t('Add an abstract or readable full-text PDF to generate an overview.')}
          </p>
        ) : null}
        {pending ? (
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
        {result ? (
          <>
            <dl className="mt-3 divide-y divide-primary/10 text-sm">
              {rows.map(([label, value]) => (
                <div
                  key={label}
                  className="grid gap-1 py-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3"
                >
                  <dt className="font-medium">{label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-muted-foreground">
                    {value ?? t('Not reported in the available source')}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('Model')}: {result.model}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('AI-generated. Verify against the original paper.')}
            </p>
          </>
        ) : null}
      </div>
    </section>
  )
}
