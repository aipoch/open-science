import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import type { LiteratureDuplicateGroup, LiteratureItemView } from '../../../../shared/literature'

const PAGE_SIZE = 50

export function LiteratureDuplicateMembers({
  group,
  busy,
  onReview,
  onClose
}: {
  group: LiteratureDuplicateGroup
  busy: boolean
  onReview: (itemIds: string[]) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [page, setPage] = useState<{ key: string; items: LiteratureItemView[]; error: boolean }>()
  const requestKey = `${offset}:${retry}`
  const pending = page?.key !== requestKey
  useEffect(() => {
    let cancelled = false
    const ids = group.itemIds.slice(offset, offset + PAGE_SIZE)
    void Promise.all(ids.map((id) => window.api.literature.get(id))).then(
      (items) => {
        if (cancelled) return
        const available = items.filter((item, index): item is LiteratureItemView =>
          Boolean(item && !item.deletedAt && item.id === ids[index])
        )
        setPage({ key: requestKey, items: available, error: available.length !== ids.length })
      },
      () => {
        if (!cancelled) setPage({ key: requestKey, items: [], error: true })
      }
    )
    return () => {
      cancelled = true
    }
  }, [group.itemIds, offset, requestKey])

  return (
    <section
      className="w-full space-y-3 border-t border-border-300/80 pt-4"
      aria-label={t('Select 2–20 references to compare.')}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('Select 2–20 references to compare.')}</p>
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t('Close')}
        </Button>
      </div>
      {pending ? (
        <p role="status">{t('Loading…')}</p>
      ) : page?.error ? (
        <LiteratureErrorNotice
          tone="amber"
          title={t('Literature could not be loaded.')}
          primaryButton={{ label: t('Retry'), onClick: () => setRetry((value) => value + 1) }}
        />
      ) : (
        <ul className="max-h-80 divide-y divide-border-300/80 overflow-y-auto">
          {page?.items.map(({ id, item }) => (
            <li key={id}>
              <label className="flex cursor-pointer items-start gap-3 py-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-primary"
                  checked={selected.includes(id)}
                  disabled={busy || (selected.length >= 20 && !selected.includes(id))}
                  onChange={(event) =>
                    setSelected((ids) =>
                      event.target.checked ? [...ids, id] : ids.filter((value) => value !== id)
                    )
                  }
                />
                <span className="min-w-0 text-sm">
                  <span className="block font-medium break-words">{item.title}</span>
                  <span className="block break-words text-xs text-muted-foreground">
                    {[
                      item.issuedYear,
                      ...(item.identifiers ?? []).map(
                        ({ scheme, value }) => `${scheme.toUpperCase()}: ${value}`
                      )
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span>
          {t('Page {{current}} of {{total}}', {
            current: Math.floor(offset / PAGE_SIZE) + 1,
            total: Math.ceil(group.itemIds.length / PAGE_SIZE)
          })}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy || offset === 0}
            onClick={() => setOffset(offset - PAGE_SIZE)}
          >
            {t('Previous page')}
          </Button>
          <Button
            variant="outline"
            disabled={busy || offset + PAGE_SIZE >= group.itemIds.length}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            {t('Next page')}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm tabular-nums">
          {t('Selected: {{selected}} / 20', { selected: selected.length })}
        </span>
        <Button
          disabled={busy || pending || page?.error || selected.length < 2}
          onClick={() => onReview(selected)}
        >
          {t('Compare selected references')}
        </Button>
      </div>
    </section>
  )
}
