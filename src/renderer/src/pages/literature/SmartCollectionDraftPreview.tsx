import { Button } from '@/components/ui/button'
import { CollectionOptionHelp } from './CollectionOptionHelp'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import type {
  SmartCollectionPreview,
  SmartScope,
  SmartEvidenceMode
} from '../../../../shared/literature-smart-collections'
import { SmartCollectionAssessment } from './SmartCollectionDecision'

/** Draft results never enter the collection's persisted assessments or counts. */
export function SmartCollectionDraftPreview({
  description,
  evidenceMode,
  scope,
  disabled
}: {
  description: string
  evidenceMode: SmartEvidenceMode
  scope: SmartScope
  disabled: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{
    key: string
    preview?: SmartCollectionPreview
    loading?: boolean
    failed?: boolean
  }>()
  const scopeKey = JSON.stringify(scope)
  const key = JSON.stringify([description, scopeKey, evidenceMode, enabled, disabled, attempt])
  const currentResult = result?.key === key ? result : undefined
  const preview = currentResult?.preview
  const loading = currentResult?.loading
  const failed = currentResult?.failed
  useEffect(() => {
    if (!enabled || disabled || !description.trim()) return
    let current = true
    let started = false
    const requestId = crypto.randomUUID()
    const timer = setTimeout(() => {
      started = true
      setResult({ key, loading: true })
      void window.api.literature
        .transact({
          kind: 'preview-smart-collection',
          requestId,
          evidenceMode,
          description: description.trim(),
          scope: JSON.parse(scopeKey)
        })
        .then((receipt) => {
          if (current) setResult({ key, preview: receipt.smartPreview })
        })
        .catch(() => {
          if (current) setResult({ key, failed: true })
        })
    }, 600)
    return () => {
      current = false
      clearTimeout(timer)
      if (started)
        void window.api.literature
          .transact({ kind: 'cancel-smart-preview', requestId })
          .catch(() => undefined)
    }
  }, [enabled, disabled, description, scopeKey, evidenceMode, key])
  return (
    <section className="space-y-2 border-t border-border pt-3" aria-label={t('Live rule preview')}>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <label htmlFor="collection-rule-preview" className="text-sm font-medium">
              {t('Live rule preview')}
            </label>
            <CollectionOptionHelp label={t('Live rule preview')}>
              {t(
                'Preview up to 4 references as you edit. Requests may incur costs; results are not saved.'
              )}
            </CollectionOptionHelp>
          </div>
          <Switch
            id="collection-rule-preview"
            checked={enabled}
            onCheckedChange={(value) => {
              setResult(undefined)
              setEnabled(value)
            }}
            disabled={disabled && !enabled}
          />
        </div>
        <p className="text-xs leading-5 text-muted-foreground">
          {t('May incur costs. Preview results are not saved.')}
        </p>
      </div>
      {enabled && (
        <div role="status" className="text-xs text-muted-foreground">
          {loading ? (
            <span className="flex items-center gap-2">
              <LoaderCircle
                className="size-3 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t('Updating…')}
            </span>
          ) : failed ? (
            <span className="flex items-center justify-between gap-3">
              {t('Preview unavailable. Try again.')}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => setAttempt((value) => value + 1)}
              >
                {t('Retry')}
              </Button>
            </span>
          ) : preview && !preview.configured ? (
            t(
              'Configure a classification model to evaluate this collection. Saved results remain available.'
            )
          ) : preview?.rows.length === 0 ? (
            t('No references found')
          ) : null}
        </div>
      )}
      {enabled && preview && preview.rows.length > 0 && (
        <ul className="max-h-64 overflow-y-auto divide-y divide-border rounded-lg border border-border">
          {preview.rows.map((row) => (
            <li key={row.id} className="space-y-1 p-2">
              <p className="truncate px-2 text-sm" title={row.title}>
                {row.title}
              </p>
              <SmartCollectionAssessment row={row} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
