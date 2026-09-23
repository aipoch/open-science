import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LiteratureCatalogReceipt } from '../../../../shared/literature'
import { Button } from '@/components/ui/button'
import { SmartRuleSummary } from './SmartRuleSummary'

type History = NonNullable<LiteratureCatalogReceipt['smartHistory']>
export function SmartEvaluationHistory({
  collectionId,
  itemId
}: {
  collectionId: string
  itemId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const pending = useRef(false)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<History>()
  const [failed, setFailed] = useState(false)
  const load = async (): Promise<void> => {
    if (pending.current) return
    pending.current = true
    setLoading(true)
    setFailed(false)
    try {
      const receipt = await window.api.literature.transact({
        kind: 'read-smart-history',
        collectionId,
        itemId,
        offset: history?.nextOffset ?? 0
      })
      if (!receipt.smartHistory) throw new Error('Missing history')
      const next = receipt.smartHistory
      setHistory((previous) => ({
        currentRevision: next.currentRevision,
        entries: [...(previous?.entries ?? []), ...next.entries],
        nextOffset: next.nextOffset
      }))
    } catch {
      setFailed(true)
    } finally {
      pending.current = false
      setLoading(false)
    }
  }
  return (
    <details
      className="border-t border-border pt-3"
      onToggle={(event) => {
        if (event.currentTarget.open && !history && !failed) void load()
      }}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {t('Evaluation history')}
      </summary>
      <div className="mt-3 space-y-3">
        {history?.entries.map((entry) => (
          <details key={entry.runId} className="border-b border-border pb-2 text-xs">
            <summary className="cursor-pointer">
              {t('Evaluated with rule {{evaluated}}; current rule {{current}}', {
                evaluated: `#${entry.revision}`,
                current: `#${history.currentRevision}`
              })}{' '}
              · {new Date(entry.evaluatedAt).toLocaleString()}
            </summary>
            <div className="mt-2 space-y-2">
              <p>
                {entry.model === 'insufficient-evidence'
                  ? t('Not evaluated')
                  : entry.verdict === 'match'
                    ? t('Match')
                    : entry.verdict === 'no-match'
                      ? t('No match')
                      : t('Uncertain')}{' '}
                {entry.model !== 'insufficient-evidence' && `· ${entry.model}`}
              </p>
              {entry.probabilities?.match !== undefined && (
                <p>
                  {t('Match')}: {Math.round(entry.probabilities.match * 100)}%
                </p>
              )}
              <SmartRuleSummary rule={entry.rule} compact />
            </div>
          </details>
        ))}
        {failed && <p role="alert">{t('Could not load evaluation history.')}</p>}
        {history?.entries.length === 0 && <p>{t('No evaluation history yet.')}</p>}
        {(loading || failed || history?.nextOffset !== undefined) && (
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
            {loading ? t('Loading…') : failed ? t('Retry') : t('Load more')}
          </Button>
        )}
      </div>
    </details>
  )
}
