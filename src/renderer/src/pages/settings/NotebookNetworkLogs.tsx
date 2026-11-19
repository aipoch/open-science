import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { EditableNumberCombobox } from '@/components/ui/editable-number-combobox'
import { readWithDeadline } from '@/lib/read-with-deadline'
import type {
  NotebookNetworkAuditPage,
  NotebookNetworkAuditQuery,
  NotebookNetworkAuditRecord
} from '../../../../shared/notebook-network-audit'

const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-xs'

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
    [saving, setSaving] = useState(false),
    [confirm, setConfirm] = useState(false)
  const mounted = useRef(true),
    sequence = useRef(0),
    applied = useRef<NotebookNetworkAuditQuery>(queryRange(range))
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
  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(undefined)
    try {
      const retained = await window.api.network.setNotebookLogRetention(Number(days))
      if (mounted.current) {
        setPage((previous) => (previous ? { ...previous, retentionDays: retained } : previous))
        setConfirm(false)
      }
    } catch {
      if (mounted.current) setError(t('Could not save network log retention.'))
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
      aria-label={label}
      placeholder={label}
      value={filters[key] ?? ''}
      onChange={(e) => setFilters({ ...filters, [key]: e.target.value })}
    />
  )
  return (
    <>
      <div className="space-y-4">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void load({ ...filters, ...queryRange(range) })
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={selectClass}
              aria-label={t('Network mode')}
              value={filters.mode ?? ''}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  mode: (e.target.value as NotebookNetworkAuditQuery['mode']) || undefined
                })
              }
            >
              <option value="">{t('All modes')}</option>
              <option value="relaxed">{t('Relaxed')}</option>
              <option value="strict">{t('Strict')}</option>
            </select>
            <select
              className={selectClass}
              aria-label={t('Decision')}
              value={filters.decision ?? ''}
              onChange={(e) =>
                setFilters({
                  ...filters,
                  decision: (e.target.value as NotebookNetworkAuditQuery['decision']) || undefined
                })
              }
            >
              <option value="">{t('All decisions')}</option>
              <option value="allowed">{t('Allowed')}</option>
              <option value="blocked">{t('Blocked')}</option>
            </select>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-expanded={advanced}
              aria-controls="network-log-advanced"
              onClick={(event) => {
                if (!advanced || event.currentTarget.form?.reportValidity()) setAdvanced(!advanced)
              }}
            >
              {t('Advanced search')}
              <ChevronDown
                aria-hidden="true"
                className={advanced ? 'size-4 rotate-180' : 'size-4'}
              />
            </Button>
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              {busy ? t('Loading…') : t('Search')}
            </Button>
          </div>
          <div id="network-log-advanced" hidden={!advanced}>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {field('address', t('Address'))}
              {field('projectId', t('Project ID'))}
              {field('sessionId', t('Session ID'))}
              {field('notebookRunId', t('Notebook run ID'))}
              <select
                className={selectClass}
                aria-label={t('Result')}
                value={filters.outcome ?? ''}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    outcome: (e.target.value as NotebookNetworkAuditQuery['outcome']) || undefined
                  })
                }
              >
                <option value="">{t('All results')}</option>
                {Object.entries(labels)
                  .filter(([key]) => key !== 'allowed' && key !== 'blocked')
                  .map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
              </select>
              <div className="col-span-full grid grid-cols-1 items-end gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <label htmlFor="network-log-from" className="text-xs">
                    {t('From')}
                  </label>
                  <Input
                    id="network-log-from"
                    type="datetime-local"
                    value={range.from}
                    onChange={(e) => setRange({ ...range, from: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <label htmlFor="network-log-to" className="text-xs">
                    {t('To')}
                  </label>
                  <Input
                    id="network-log-to"
                    type="datetime-local"
                    min={range.from || undefined}
                    value={range.to}
                    onChange={(e) => setRange({ ...range, to: e.target.value })}
                  />
                </div>
              </div>
            </div>
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
        <div aria-busy={busy} className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-x-0 border-spacing-y-1 text-left text-xs [&_tr>:first-child]:rounded-l-md [&_tr>:last-child]:rounded-r-md">
            <thead className="bg-muted">
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
        <div className="flex flex-wrap items-end justify-between gap-3">
          {page?.cursor ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void load({ ...applied.current, cursor: page.cursor }, true)}
            >
              {t('Load more')}
            </Button>
          ) : (
            <span aria-hidden="true" />
          )}
          <div className="flex flex-wrap items-end justify-end gap-2">
            <div className="w-40 space-y-1">
              <label htmlFor="network-log-days" className="text-xs text-muted-foreground">
                {t('Retention days')}
              </label>
              <EditableNumberCombobox
                id="network-log-days"
                ariaLabel={t('Retention days')}
                value={days}
                presets={[30, 90, 180, 365]}
                onValueChange={setDays}
                disabled={!page || saving}
                locale={i18n.language}
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={
                !page ||
                saving ||
                !Number.isInteger(Number(days)) ||
                Number(days) < 1 ||
                Number(days) > 3650 ||
                Number(days) === page.retentionDays
              }
              onClick={() => {
                if (page && Number(days) < page.retentionDays) setConfirm(true)
                else void save()
              }}
            >
              {saving ? t('Saving…') : t('Save')}
            </Button>
          </div>
        </div>
      </div>
      <ConfirmActionDialog
        open={confirm}
        title={t('Shorten network log retention?')}
        description={t(
          'Older records will become eligible for deletion at the next cleanup. Deleted records cannot be recovered.'
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Confirm')}
        loading={saving}
        destructive
        onCancel={() => setConfirm(false)}
        onConfirm={() => void save()}
      />
    </>
  )
}

export function NotebookNetworkLogs(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="space-y-4 p-5">
      <div>
        <h1 className="text-lg font-medium">{t('Notebook network logs')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('Allowed and blocked Notebook connections, grouped by their original network mode.')}
        </p>
      </div>
      <NetworkLogContent />
    </div>
  )
}
