import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type {
  LiteratureCatalogReceipt,
  LiteratureDuplicateGroup,
  LiteratureMergeStrategy
} from '../../../../shared/literature'

export function LiteratureDuplicateBatch({
  groups,
  onBusy,
  onMerged,
  onRefresh = onMerged,
  onCompleted,
  result
}: {
  groups: LiteratureDuplicateGroup[]
  onBusy: (busy: boolean) => void
  onMerged: () => void
  onRefresh?: () => void
  onCompleted?: (batch: NonNullable<LiteratureCatalogReceipt['batch']>) => void
  result?: LiteratureCatalogReceipt['batch']
}): React.JSX.Element {
  const { t } = useTranslation()
  const [batch, setBatch] = useState<LiteratureCatalogReceipt['batch']>(result)
  const [done, setDone] = useState(Boolean(result))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [strategy, setStrategy] = useState<LiteratureMergeStrategy>('conflict-free')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onBusy(false)
    }
  }, [onBusy])
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
        strategy,
        ...(mode === 'commit'
          ? { expectedItems: batch?.groups?.flatMap((group) => group.items) }
          : {}),
        groups: previewGroups.current
      })
      if (mode === 'commit' && receipt.batch) onCompleted?.(receipt.batch)
      if (!mounted.current) return
      if (!receipt.batch) throw new Error('Missing duplicate batch result')
      setBatch(receipt.batch)
      setDone(mode === 'commit')
    } catch {
      if (mounted.current) setError(true)
    } finally {
      if (mounted.current) {
        setBusy(false)
        onBusy(false)
      }
      // A lost response can follow committed groups; always invalidate the library after a commit.
      if (mode === 'commit') onMerged()
    }
  }
  const reasonLabels = {
    'too-large': t('More than 20 references. Review this group individually.'),
    overlapping: t('References occur in more than one selected group.'),
    unavailable: t('Some references are no longer available.'),
    changed: t('References changed after preview. Review this group again.'),
    identity: t('Identifiers or reference types need individual review.'),
    conflicts: t('Conflicting metadata needs individual review.'),
    failed: t('Processing failed. Refresh and try again.')
  }
  const statusLabels = {
    ready: t('Ready to merge'),
    merged: t('Merged'),
    skipped: t('Skipped'),
    failed: t('Failed')
  }
  return (
    <div className="space-y-3 rounded-lg border border-border-300/80 bg-bg-100 p-4">
      {!done ? (
        <>
          <Select
            value={strategy}
            disabled={busy || done}
            onValueChange={(value) => {
              setStrategy(value as LiteratureMergeStrategy)
              setBatch(undefined)
              setError(false)
            }}
          >
            <SelectTrigger aria-label={t('Merge strategy')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="conflict-free">{t('Merge conflict-free groups')}</SelectItem>
              <SelectItem value="most-complete">{t('Keep the most complete reference')}</SelectItem>
              <SelectItem value="oldest">{t('Keep the earliest added reference')}</SelectItem>
              <SelectItem value="newest">
                {t('Keep the most recently updated reference')}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {strategy === 'conflict-free'
              ? t(
                  'Only groups with matching identifiers and no conflicting fields are merged. The oldest reference is kept; attachments, tags and destinations are preserved. Groups with more than 20 references need individual review.'
                )
              : t(
                  'Keep the chosen reference’s values when fields conflict and fill its empty fields. Attachments, tags and links are preserved. Ambiguous identifiers and groups over 20 references require individual review.'
                )}
          </p>
        </>
      ) : null}
      {error ? (
        <LiteratureErrorNotice
          tone="amber"
          title={t('Duplicate processing failed. Refresh the list before trying again.')}
          primaryButton={{ label: t('Refresh'), onClick: onRefresh }}
        />
      ) : null}
      {batch?.groups && !done ? (
        <ul className="max-h-56 divide-y overflow-y-auto text-sm">
          {batch.groups.map((group) => (
            <li key={group.survivorId} className="py-2">
              <p className="font-medium">
                {t('Keep reference')}: {group.survivorTitle}
              </p>
              <p className="text-xs text-muted-foreground">
                {group.conflicts
                  ? t('Conflicting values will follow the chosen reference.')
                  : t('Fill empty fields')}
              </p>
            </li>
          ))}
        </ul>
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
      {batch?.details?.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-primary">{t('View processing details')}</summary>
          <ol className="mt-2 max-h-64 divide-y divide-border overflow-y-auto">
            {batch.details.map((detail) => (
              <li key={detail.groupIndex} className="py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
                    {detail.title ??
                      groups[detail.groupIndex]?.title ??
                      t('Group {{number}}', { number: detail.groupIndex + 1 })}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {statusLabels[detail.status]}
                  </span>
                </div>
                {detail.reason ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {reasonLabels[detail.reason]}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {!done ? (
        <Button
          variant={batch ? 'default' : 'outline'}
          disabled={busy || groups.length === 0 || Boolean(batch && batch.eligible === 0) || error}
          onClick={() => void run(batch ? 'commit' : 'preview')}
        >
          {busy ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : null}
          {busy
            ? batch
              ? t('Merging references…')
              : t('Checking duplicate groups…')
            : batch
              ? strategy === 'conflict-free'
                ? t('Merge conflict-free groups')
                : t('Merge references')
              : t('Preview batch merge')}
        </Button>
      ) : null}
    </div>
  )
}
