import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Copy, LoaderCircle, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { LiteratureErrorNotice } from './LiteratureErrorNotice'
import { LiteratureDuplicateBatch } from './LiteratureDuplicateBatch'
import type { LiteratureDuplicateGroup, LiteratureItemView } from '../../../../shared/literature'

export type LiteratureDuplicateCountHandle = { setCount: (count: number | undefined) => void }

// Keep asynchronous count updates out of the full library/preview render tree.
export const LiteratureDuplicateCount = forwardRef<
  LiteratureDuplicateCountHandle,
  { hidden: boolean }
>(function LiteratureDuplicateCount({ hidden }, ref) {
  const { t } = useTranslation()
  const [count, setCount] = useState<number>()
  useImperativeHandle(ref, () => ({ setCount }), [])
  return count === undefined || hidden ? null : (
    <span
      className="ml-auto text-xs tabular-nums text-muted-foreground"
      aria-label={t('{{count}} duplicate groups', {
        count,
        defaultValue_one: '{{count}} duplicate group'
      })}
    >
      {count}
    </span>
  )
})

type Props = {
  active: boolean
  revision: number
  onCount: (count: number | undefined) => void
  onReview: (items: LiteratureItemView[]) => void
  onMerged: () => void
}

export const LiteratureDuplicatesView = ({
  active,
  revision,
  onCount,
  onReview,
  onMerged
}: Props): React.JSX.Element | null => {
  const { t } = useTranslation()
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [groups, setGroups] = useState<LiteratureDuplicateGroup[]>([])
  const [nextOffset, setNextOffset] = useState<number>()
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadedKey, setLoadedKey] = useState('')
  const requestKey = `${active}:${offset}:${refresh}:${revision}`
  const pending = loading || loadedKey !== requestKey
  const [error, setError] = useState(false)
  const [reviewing, setReviewing] = useState<string>()
  const reviewRequest = useRef(0)
  const [selected, setSelected] = useState<string[]>([])
  const [batchBusy, setBatchBusy] = useState(false)
  const refreshed = useRef(0)

  useEffect(() => {
    let cancelled = false
    const delay = active ? 0 : 200
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(false)
      if (!active) setReviewing(undefined)
      const force = refreshed.current !== refresh
      refreshed.current = refresh
      void window.api.literature
        .search({
          scope: 'duplicates',
          offset: active ? offset : 0,
          limit: active ? 20 : 1,
          ...(force ? { refreshDuplicates: true } : {})
        })
        .then(
          (page) => {
            if (cancelled) return
            const count = page.totalCount ?? 0
            onCount(count)
            setTotal(count)
            if (active && offset > 0 && page.entries.length === 0) {
              setOffset(Math.max(0, offset - 20))
              return
            }
            setGroups(
              page.entries.filter((entry): entry is LiteratureDuplicateGroup => 'itemIds' in entry)
            )
            setNextOffset(page.nextOffset)
            setLoading(false)
            setLoadedKey(requestKey)
          },
          () => {
            if (cancelled) return
            onCount(undefined)
            setError(true)
            setLoading(false)
            setLoadedKey(requestKey)
          }
        )
    }, delay)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, offset, refresh, revision, onCount, requestKey])

  useEffect(() => {
    reviewRequest.current += 1
    const timer = window.setTimeout(() => setReviewing(undefined), 0)
    return () => {
      reviewRequest.current += 1
      window.clearTimeout(timer)
    }
  }, [active])

  const review = async (group: LiteratureDuplicateGroup): Promise<void> => {
    const request = ++reviewRequest.current
    setReviewing(group.id)
    setError(false)
    try {
      const items = await Promise.all(
        group.itemIds.slice(0, 20).map((id) => window.api.literature.get(id))
      )
      if (request !== reviewRequest.current) return
      if (
        items.some((item, index) => !item || item.deletedAt || item.id !== group.itemIds[index])
      ) {
        setRefresh((value) => value + 1)
        return
      }
      onReview(items.filter((item): item is LiteratureItemView => Boolean(item)))
    } catch {
      if (request === reviewRequest.current) setError(true)
    } finally {
      if (request === reviewRequest.current) setReviewing(undefined)
    }
  }

  if (!active) return null
  return (
    <div className="flex h-full min-h-0 w-full flex-col px-4 py-6 lg:px-6 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-semibold tracking-tight">{t('Duplicates')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Review possible duplicates before merging. Nothing is removed automatically.')}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={pending || Boolean(reviewing) || batchBusy}
          onClick={() => {
            setSelected([])
            setRefresh((value) => value + 1)
          }}
        >
          <RotateCcw className="size-4" aria-hidden="true" />
          {t('Refresh')}
        </Button>
      </div>
      <div className="mt-6 flex min-h-0 flex-1 flex-col gap-2">
        {error && !pending ? (
          <LiteratureErrorNotice
            tone="amber"
            title={t('Literature could not be loaded.')}
            primaryButton={{ label: t('Retry'), onClick: () => setRefresh((value) => value + 1) }}
          />
        ) : null}
        {!pending && !error && groups.length > 0 ? (
          <label className="flex min-h-10 shrink-0 cursor-pointer items-center gap-2 px-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 shrink-0 accent-primary"
              aria-label={t('Select groups on this page')}
              ref={(node) => {
                if (node)
                  node.indeterminate =
                    groups.some((group) => selected.includes(group.id)) &&
                    !groups.every((group) => selected.includes(group.id))
              }}
              checked={groups.every((group) => selected.includes(group.id))}
              disabled={batchBusy}
              onChange={(event) =>
                setSelected(event.target.checked ? groups.map((group) => group.id) : [])
              }
            />
            {t('Select groups on this page')}
          </label>
        ) : null}
        {selected.length > 0 ? (
          <LiteratureDuplicateBatch
            key={selected.join(':')}
            groups={groups.filter((group) => selected.includes(group.id))}
            onBusy={setBatchBusy}
            onMerged={onMerged}
          />
        ) : null}
        {pending ? (
          <div role="status" className="flex justify-center py-20">
            <LoaderCircle
              className="size-5 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span className="sr-only">{t('Loading…')}</span>
          </div>
        ) : groups.length === 0 && !error ? (
          <div className="rounded-xl border border-border-300/80 border-dashed py-16 text-center">
            <Copy className="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
            <h3 className="mt-3 font-medium">{t('No duplicates found')}</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('Checks active references across your entire library.')}
            </p>
          </div>
        ) : !error ? (
          <div className="min-h-0 overflow-y-auto px-2 pt-1 pb-3">
            <div className="rounded-xl border border-border-300/80 divide-y divide-border-300/80">
              {groups.map((group) => (
                <div key={group.id} className="flex flex-wrap items-center gap-4 p-4">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    aria-label={t('Select duplicate group: {{title}}', { title: group.title })}
                    checked={selected.includes(group.id)}
                    disabled={batchBusy || Boolean(reviewing)}
                    onChange={(event) =>
                      setSelected((ids) =>
                        event.target.checked
                          ? [...ids, group.id]
                          : ids.filter((id) => id !== group.id)
                      )
                    }
                  />
                  <div className="min-w-0 flex-1 basis-64">
                    <h3 className="font-medium break-words">{group.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('{{count}} references', {
                        count: group.itemIds.length,
                        defaultValue_one: '{{count}} reference'
                      })}{' '}
                      ·{' '}
                      {group.match === 'identifier'
                        ? t('Matching identifiers')
                        : t('Matching title, author and year')}
                    </p>
                    {group.itemIds.length > 20 ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t('Review up to 20 references at a time.')}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="outline"
                    disabled={Boolean(reviewing) || batchBusy}
                    onClick={() => void review(group)}
                  >
                    {reviewing === group.id ? (
                      <LoaderCircle
                        className="size-4 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : null}
                    {t('Review duplicates')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {!pending && !error && total > 0 ? (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-2 text-sm">
            <span className="text-muted-foreground">
              {t('{{count}} duplicate groups', {
                count: total,
                defaultValue_one: '{{count}} duplicate group'
              })}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={offset === 0 || Boolean(reviewing) || batchBusy}
                onClick={() => {
                  setSelected([])
                  setOffset(Math.max(0, offset - 20))
                }}
              >
                {t('Previous page')}
              </Button>
              <Button
                variant="outline"
                disabled={nextOffset === undefined || Boolean(reviewing) || batchBusy}
                onClick={() => {
                  setSelected([])
                  setOffset(nextOffset ?? offset)
                }}
              >
                {t('Next page')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
