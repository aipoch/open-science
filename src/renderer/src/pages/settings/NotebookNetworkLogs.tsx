import { useCallback, useEffect, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  SplitButton,
  SplitButtonGroup,
  SplitButtonPrimary,
  SplitButtonTrigger
} from '@/components/ui/split-button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ErrorNotice } from '@/components/error-notice'
import { readWithDeadline } from '@/lib/read-with-deadline'
import type {
  NotebookNetworkAuditPage,
  NotebookNetworkAuditQuery,
  NotebookNetworkAuditRecord
} from '../../../../shared/notebook-network-audit'

const fieldClass = 'w-44 max-w-full'
const retentionPresets = [7, 15, 30, 90, 180, 365]

function localMinute(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function lastSevenDays(): { from: string; to: string } {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 6)
  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 0, 0)
  return { from: localMinute(start), to: localMinute(end) }
}

function queryRange({ from, to }: { from: string; to: string }): NotebookNetworkAuditQuery {
  return {
    ...(from && { from: new Date(from).getTime() }),
    ...(to && { to: new Date(to).getTime() + 59_999 })
  }
}

function NetworkLogContent(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [page, setPage] = useState<NotebookNetworkAuditPage>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>()
  const [filters, setFilters] = useState<NotebookNetworkAuditQuery>({})
  const [range, setRange] = useState(lastSevenDays)
  const [advanced, setAdvanced] = useState(false)
  const [days, setDays] = useState('90'),
    [saving, setSaving] = useState(false)
  const mounted = useRef(true),
    sequence = useRef(0),
    applied = useRef<NotebookNetworkAuditQuery>(queryRange(range)),
    form = useRef<HTMLFormElement>(null)
  const load = useCallback(
    async (query: NotebookNetworkAuditQuery, append = false) => {
      const id = ++sequence.current
      setBusy(true)
      setError(undefined)
      try {
        const result = await readWithDeadline(
          () => window.api.network.queryNotebookLogs(query),
          30_000
        )
        if (!mounted.current || sequence.current !== id) return
        setPage((previous) => ({
          ...result,
          records: append ? [...(previous?.records ?? []), ...result.records] : result.records
        }))
        if (!append) {
          applied.current = query
          setDays(String(result.retentionDays))
        }
      } catch {
        if (mounted.current && sequence.current === id) setError(t('Could not load network logs.'))
      } finally {
        if (mounted.current && sequence.current === id) setBusy(false)
      }
    },
    [t]
  )
  useEffect(() => {
    mounted.current = true
    void load(applied.current)
    return () => {
      mounted.current = false
    }
  }, [load])
  const updateRetention = async (value: string): Promise<void> => {
    if (!page || saving) return
    const next = Number(value)
    const previous = page.retentionDays
    setDays(value)
    if (!Number.isInteger(next) || next < 1 || next > 3650 || next === previous) return
    setSaving(true)
    setError(undefined)
    try {
      const retained = await window.api.network.setNotebookLogRetention(next)
      if (mounted.current) {
        setPage((current) => (current ? { ...current, retentionDays: retained } : current))
        setDays(String(retained))
      }
    } catch {
      if (mounted.current) {
        setDays(String(previous))
        setError(t('Could not save network log retention.'))
      }
    } finally {
      if (mounted.current) setSaving(false)
    }
  }
  const labels = {
    allowed: t('Allowed'),
    blocked: t('Blocked'),
    connected: t('Connected'),
    completed: t('Completed'),
    failed: t('Failed'),
    cancelled: t('Cancelled'),
    timeout: t('Timed out')
  }
  const resultText = (record: NotebookNetworkAuditRecord): string => {
    const value = record.data.outcome ?? record.data.decision
    return value ? labels[value] : t('Unknown')
  }
  const field = (
    key: 'address' | 'projectId' | 'sessionId' | 'notebookRunId',
    label: string
  ): React.JSX.Element => (
    <Input
      className={fieldClass}
      aria-label={label}
      placeholder={label}
      value={filters[key] ?? ''}
      onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
    />
  )
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <form
          ref={form}
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void load({ ...filters, ...queryRange(range) })
          }}
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Select
              value={filters.mode ?? 'all'}
              onValueChange={(value) =>
                setFilters({
                  ...filters,
                  mode: value === 'all' ? undefined : (value as NotebookNetworkAuditQuery['mode'])
                })
              }
            >
              <SelectTrigger className="h-8 w-full" aria-label={t('Network mode')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All modes')}</SelectItem>
                <SelectItem value="relaxed">{t('Relaxed')}</SelectItem>
                <SelectItem value="strict">{t('Strict')}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.decision ?? 'all'}
              onValueChange={(value) =>
                setFilters({
                  ...filters,
                  decision:
                    value === 'all' ? undefined : (value as NotebookNetworkAuditQuery['decision'])
                })
              }
            >
              <SelectTrigger className="h-8 w-full" aria-label={t('Decision')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All decisions')}</SelectItem>
                <SelectItem value="allowed">{t('Allowed')}</SelectItem>
                <SelectItem value="blocked">{t('Blocked')}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.outcome ?? 'all'}
              onValueChange={(value) =>
                setFilters({
                  ...filters,
                  outcome:
                    value === 'all' ? undefined : (value as NotebookNetworkAuditQuery['outcome'])
                })
              }
            >
              <SelectTrigger className="h-8 w-full" aria-label={t('Result')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('All results')}</SelectItem>
                {Object.entries(labels)
                  .filter(([key]) => key !== 'allowed' && key !== 'blocked')
                  .map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {advanced ? (
            <div id="network-log-advanced" className="space-y-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {field('address', t('Address'))}
                {field('sessionId', t('Session ID'))}
                {field('projectId', t('Project ID'))}
                {field('notebookRunId', t('Notebook run ID'))}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="min-w-0 space-y-1">
                  <label htmlFor="network-log-from" className="text-xs">
                    {t('From')}
                  </label>
                  <Input
                    id="network-log-from"
                    className="h-8 w-full"
                    type="datetime-local"
                    value={range.from}
                    onChange={(e) => setRange({ ...range, from: e.target.value })}
                  />
                </div>
                <div className="min-w-0 space-y-1">
                  <label htmlFor="network-log-to" className="text-xs">
                    {t('To')}
                  </label>
                  <Input
                    id="network-log-to"
                    className="h-8 w-full"
                    type="datetime-local"
                    min={range.from || undefined}
                    value={range.to}
                    onChange={(e) => setRange({ ...range, to: e.target.value })}
                  />
                </div>
              </div>
            </div>
          ) : null}
          {/* Keep search and advanced controls connected on one right-aligned action row. */}
          <div className="flex justify-end">
            <SplitButton
              kind="popover"
              open={advanced}
              onOpenChange={(next) => {
                if (!next && form.current && !form.current.reportValidity()) return
                setAdvanced(next)
              }}
              busy={busy}
            >
              <SplitButtonGroup>
                <SplitButtonPrimary type="submit" size="sm" className="h-8 w-24">
                  {busy ? t('Loading…') : t('Search')}
                </SplitButtonPrimary>
                <SplitButtonTrigger
                  size="icon-sm"
                  variant="default"
                  className={advanced ? 'h-8 w-9 brightness-90 hover:brightness-80' : 'h-8 w-9'}
                  aria-label={t('Advanced options')}
                  aria-controls="network-log-advanced"
                  aria-pressed={advanced}
                  title={t('Advanced options')}
                >
                  <SlidersHorizontal
                    aria-hidden="true"
                    style={{ transform: 'none', transition: 'none' }}
                  />
                </SplitButtonTrigger>
              </SplitButtonGroup>
            </SplitButton>
          </div>
        </form>
        {error ? <ErrorNotice inline title={error} /> : null}
        {page?.warnings.length ? (
          <ErrorNotice
            inline
            title={t('Network logs may be incomplete.')}
            description={t(
              'Some records could not be written or read, or expired files could not be cleaned up.'
            )}
          />
        ) : null}
        <div aria-busy={busy} className="min-h-24 flex-1 overflow-auto rounded-lg">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                {[
                  t('Time'),
                  t('Network mode'),
                  t('Address'),
                  t('Project'),
                  t('Session'),
                  t('Notebook run ID'),
                  t('Result')
                ].map((label) => (
                  <th key={label} className="p-2 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page?.records.map((record) => (
                <tr
                  key={record.data.eventId}
                  className="align-top odd:bg-muted/35 even:bg-muted/65"
                >
                  <td className="whitespace-nowrap p-2">
                    {new Date(record.t).toLocaleString(i18n.language)}
                  </td>
                  <td className="p-2">
                    {record.data.mode === 'strict' ? t('Strict') : t('Relaxed')}
                  </td>
                  <td className="max-w-64 break-all p-2">
                    <details>
                      <summary className="cursor-pointer">{`${record.data.protocol}://${record.data.host}:${record.data.port}`}</summary>
                      <dl className="mt-2 space-y-1 text-muted-foreground">
                        {record.data.address ? (
                          <>
                            <dt>{t('IP address')}</dt>
                            <dd>{record.data.address}</dd>
                          </>
                        ) : null}
                        {record.data.reason ? (
                          <>
                            <dt>{t('Reason')}</dt>
                            <dd>{record.data.reason}</dd>
                          </>
                        ) : null}
                        <dt>{t('Request ID')}</dt>
                        <dd>{record.data.requestId}</dd>
                        {record.data.executionId ? (
                          <>
                            <dt>{t('Execution ID')}</dt>
                            <dd>{record.data.executionId}</dd>
                          </>
                        ) : null}
                        {record.data.statusCode ? (
                          <>
                            <dt>{t('HTTP status')}</dt>
                            <dd>{record.data.statusCode}</dd>
                          </>
                        ) : null}
                        {record.data.durationMs !== undefined ? (
                          <>
                            <dt>{t('Duration (ms)')}</dt>
                            <dd>{record.data.durationMs}</dd>
                          </>
                        ) : null}
                      </dl>
                    </details>
                  </td>
                  <td className="max-w-32 break-all p-2">
                    {record.data.projectName ?? record.data.projectId}
                  </td>
                  <td className="max-w-32 break-all p-2">
                    {record.data.sessionNumber ?? record.data.sessionId}
                  </td>
                  <td className="max-w-32 break-all p-2">{record.data.notebookRunId ?? '—'}</td>
                  <td className="p-2">{resultText(record)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!busy && page && !page.cursor && !page.records.length ? (
            <p className="p-4 text-sm text-muted-foreground">{t('No matching network records.')}</p>
          ) : null}
        </div>
        <div className="sticky bottom-0 z-20 flex shrink-0 items-end justify-between gap-3">
          <div className="space-y-1">
            <label htmlFor="network-log-days" className="text-xs text-muted-foreground">
              {t('Retention days')}
            </label>
            <Select
              value={days}
              onValueChange={(value) => void updateRetention(value)}
              disabled={!page || saving}
            >
              <SelectTrigger
                id="network-log-days"
                className={fieldClass}
                aria-label={t('Retention days')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from(new Set([...retentionPresets, page?.retentionDays ?? 90]))
                  .sort((a, b) => a - b)
                  .map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {page?.cursor ? (
            <Button
              className="ms-auto"
              variant="outline"
              disabled={busy}
              onClick={() => void load({ ...applied.current, cursor: page.cursor }, true)}
            >
              {t('Load more')}
            </Button>
          ) : null}
        </div>
      </div>
    </>
  )
}

export function NotebookNetworkLogs(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col gap-4 p-5">
      <div>
        <h1 className="text-lg font-medium">{t('Notebook network logs')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('Allowed and blocked Notebook connections, grouped by their original network mode.')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('Retention changes apply immediately. Cleanup runs every 3 days and does not reset.')}
        </p>
      </div>
      <NetworkLogContent />
    </div>
  )
}
