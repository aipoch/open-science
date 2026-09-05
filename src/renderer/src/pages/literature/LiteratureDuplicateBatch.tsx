import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ErrorNotice } from '@/components/error-notice'
import type {
  LiteratureCatalogReceipt,
  LiteratureDuplicateGroup
} from '../../../../shared/literature'

export function LiteratureDuplicateBatch({
  groups,
  onBusy,
  onMerged
}: {
  groups: LiteratureDuplicateGroup[]
  onBusy: (busy: boolean) => void
  onMerged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [batch, setBatch] = useState<LiteratureCatalogReceipt['batch']>()
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const previewGroups = useRef<string[][]>([])
  const run = async (mode: 'preview' | 'commit'): Promise<void> => {
    setBusy(true)
    onBusy(true)
    setError(false)
    try {
      // The 21st ID marks an oversized group for review; it must never be partially merged.
      if (mode === 'preview')
        previewGroups.current = groups.map((group) => group.itemIds.slice(0, 21))
      const receipt = await window.api.literature.transact({
        kind: 'merge-duplicates',
        mode,
        groups: previewGroups.current
      })
      if (!receipt.batch) throw new Error('Missing duplicate batch result')
      setBatch(receipt.batch)
      setDone(mode === 'commit')
    } catch {
      setError(true)
    } finally {
      setBusy(false)
      onBusy(false)
      // A lost response can follow committed groups; always invalidate the library after a commit.
      if (mode === 'commit') onMerged()
    }
  }
  return (
    <div className="space-y-3 rounded-lg border border-border-300/80 bg-bg-100 p-4">
      <p className="text-sm text-muted-foreground">
        {t(
          'Only groups with matching identifiers and no conflicting fields are merged. The oldest reference is kept; attachments, tags and destinations are preserved. Groups with more than 20 references need individual review.'
        )}
      </p>
      {error ? (
        <ErrorNotice
          tone="amber"
          title={t('Duplicate processing failed. Refresh the list before trying again.')}
        />
      ) : null}
      {batch ? (
        <div role="status" className="text-sm space-y-1">
          {done ? (
            <p>
              {t('Succeeded: {{succeeded}} · Skipped: {{skipped}} · Failed: {{failed}}', batch)}
            </p>
          ) : (
            <p>
              {t(
                'Selected groups: {{selected}} · Ready to merge: {{eligible}} · References removed from the list: {{reduced}} · Needs review: {{review}}',
                { ...batch, selected: groups.length }
              )}
            </p>
          )}
          {!done && batch.failed > 0 ? (
            <p>
              {t('Failed')}: {batch.failed}
            </p>
          ) : null}
        </div>
      ) : null}
      {!done ? (
        <Button
          variant={batch ? 'default' : 'outline'}
          disabled={busy || groups.length === 0 || Boolean(batch && batch.eligible === 0) || error}
          onClick={() => void run(batch ? 'commit' : 'preview')}
        >
          {busy
            ? t('Loading…')
            : batch
              ? t('Merge conflict-free groups')
              : t('Preview batch merge')}
        </Button>
      ) : null}
    </div>
  )
}
