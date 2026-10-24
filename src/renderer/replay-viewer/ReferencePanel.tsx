import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../src/components/ui/button'

type ReferencePanelProps = {
  reference: string
  kind?: 'step' | 'file' | 'moment' | 'observation'
  observedAt?: number
  referencePositionMs?: number
  watchingPositionMs?: number
  presentation?: 'desktop' | 'browser'
  compact?: boolean
}

const ReferencePanelContent = ({
  reference,
  kind = 'step',
  observedAt,
  referencePositionMs,
  watchingPositionMs,
  presentation,
  compact = false
}: ReferencePanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const text = useRef<HTMLTextAreaElement>(null)
  const referenceLabel =
    kind === 'observation'
      ? t('Recorded state reference')
      : kind === 'moment'
        ? t('Recorded moment reference')
        : kind === 'file'
          ? t('Recorded file version')
          : t('Recorded step reference')
  const copyLabel =
    copyState === 'copied'
      ? t('Copied')
      : kind === 'observation'
        ? t('Copy state reference')
        : kind === 'moment'
          ? t('Copy moment reference')
          : kind === 'file'
            ? t('Copy file reference')
            : t('Copy step reference')
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(reference)
      setCopyState('copied')
    } catch {
      setCopyState('manual')
      setDetailsOpen(true)
    }
  }
  useEffect(() => {
    if (compact && detailsOpen && copyState === 'manual') {
      text.current?.focus()
      text.current?.select()
    }
  }, [compact, detailsOpen, copyState])
  const instructions =
    presentation !== 'desktop' ? (
      <p className={compact ? 'text-xs text-muted-foreground' : 'text-xs'}>
        {t(
          'Paste this reference into your conversation. Your agent can read the saved selection through the Open Science SDK.'
        )}
      </p>
    ) : null
  const timestamp =
    observedAt !== undefined ? (
      <p role="status" className="mt-1 text-xs font-medium">
        {t('Saved reference for the record at {{time}}.', {
          time: new Date(observedAt).toISOString()
        })}
      </p>
    ) : null
  const position = (value: number): string => {
    const seconds = Math.max(0, value) / 1000
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
  }
  const positions =
    referencePositionMs !== undefined || watchingPositionMs !== undefined ? (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt>{t('Reference time')}</dt>
        <dd>
          {referencePositionMs === undefined
            ? t('Publication time not recorded')
            : position(referencePositionMs)}
        </dd>
        {watchingPositionMs !== undefined ? (
          <>
            <dt>{t('Watching position')}</dt>
            <dd>{position(watchingPositionMs)}</dd>
          </>
        ) : null}
      </dl>
    ) : null
  const referenceText = (
    <textarea
      ref={text}
      readOnly
      aria-label={referenceLabel}
      value={reference}
      rows={compact ? 4 : 3}
      className="mt-2 w-full resize-none rounded border border-border-200 bg-bg-100 p-2 font-mono text-xs"
    />
  )
  const manualCopy =
    copyState === 'manual' ? (
      <p role="status" className="text-xs text-muted-foreground">
        {t('Select and copy the reference below.')}
      </p>
    ) : null

  if (compact)
    return (
      <section className="min-w-0" aria-label={referenceLabel}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 truncate text-xs font-medium" title={referenceLabel}>
            {referenceLabel}
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="min-w-0 max-w-full"
            onClick={() => void copy()}
          >
            <span className="truncate">{copyLabel}</span>
          </Button>
        </div>
        <details
          className="mt-1 text-xs text-muted-foreground"
          open={detailsOpen}
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
        >
          <summary className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('Saved reference details')}
          </summary>
          {detailsOpen ? (
            <div className="mt-2 max-h-48 space-y-2 overflow-auto break-words">
              {instructions}
              {timestamp}
              {positions}
              {manualCopy}
              {referenceText}
            </div>
          ) : null}
        </details>
      </section>
    )

  return (
    <section className="shrink-0 border-b border-border-200 px-3 py-2" aria-label={referenceLabel}>
      <div className="flex items-center justify-between gap-2">
        {instructions}
        <Button size="sm" variant="secondary" onClick={() => void copy()}>
          {copyLabel}
        </Button>
      </div>
      {timestamp}
      {positions}
      {referenceText}
      {manualCopy}
    </section>
  )
}

// A newly selected immutable reference starts with its own copy/expansion state. A pending
// clipboard write for the old reference cannot label the new selection as already copied.
export const ReferencePanel = (props: ReferencePanelProps): React.JSX.Element => (
  <ReferencePanelContent key={props.reference} {...props} />
)
