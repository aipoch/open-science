import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Dialog from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice } from '@/components/error-notice'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { EditableNumberCombobox } from '@/components/ui/editable-number-combobox'
import {
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { readWithDeadline } from '@/lib/read-with-deadline'
import type {
  NotebookNetworkAuditPage,
  NotebookNetworkAuditQuery,
  NotebookNetworkAuditRecord
} from '../../../../shared/notebook-network-audit'

const selectClass = 'h-8 rounded-md border border-input bg-background px-2 text-xs'

function NetworkLogContent(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [page, setPage] = useState<NotebookNetworkAuditPage>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string>()
  const [filters, setFilters] = useState<NotebookNetworkAuditQuery>({})
  const [from, setFrom] = useState(''),
    [to, setTo] = useState('')
  const [days, setDays] = useState('90'),
    [saving, setSaving] = useState(false),
    [confirm, setConfirm] = useState(false)
  const mounted = useRef(true),
    sequence = useRef(0),
    applied = useRef<NotebookNetworkAuditQuery>({})
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
    let cancelled = false
    const id = ++sequence.current
    void readWithDeadline(() => window.api.network.queryNotebookLogs({}), 30_000)
      .then((result) => {
        if (cancelled || sequence.current !== id) return
        setPage(result)
        applied.current = {}
        setDays(String(result.retentionDays))
      })
      .catch(() => {
        if (!cancelled && sequence.current === id) setError(t('Could not load network logs.'))
      })
      .finally(() => {
        if (!cancelled && sequence.current === id) setBusy(false)
      })
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [t])
  const search = (): void => {
    const query = {
      ...filters,
      ...(from ? { from: new Date(from).getTime() } : {}),
      ...(to ? { to: new Date(to).getTime() } : {})
    }
    void load(query)
  }
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
      <div className="space-y-4 overflow-y-auto p-5">
        <div className="flex flex-wrap items-end gap-2">
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
          <p className="text-xs text-muted-foreground">
            {t(
              'Retain at least the selected number of days. Expired files are checked every 3 days.'
            )}
          </p>
        </div>
        <form
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault()
            search()
          }}
        >
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
          {field('address', t('Address'))}
          {field('projectId', t('Project ID'))}
          {field('sessionId', t('Session ID'))}
          {field('notebookRunId', t('Notebook run ID'))}
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
          <div className="col-span-full grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <div className="space-y-1">
              <label htmlFor="network-log-from" className="text-xs">
                {t('From')}
              </label>
              <Input
                id="network-log-from"
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="network-log-to" className="text-xs">
                {t('To')}
              </label>
              <Input
                id="network-log-to"
                type="datetime-local"
                min={from || undefined}
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              {busy ? t('Loading…') : t('Search')}
            </Button>
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
        <div aria-busy={busy} className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-xs">
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
                <tr key={record.data.eventId} className="border-t align-top">
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
        {page?.cursor ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void load({ ...applied.current, cursor: page.cursor }, true)}
          >
            {t('Load more')}
          </Button>
        ) : null}
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
  const { t } = useTranslation(),
    [open, setOpen] = useState(false)
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="outline" size="sm">
          {t('Notebook network logs')}
        </Button>
      </Dialog.Trigger>
      {open ? (
        <Dialog.Portal>
          <Dialog.Overlay className={dialogOverlayClassName} />
          <Dialog.Content
            className={dialogPanelClassName(
              'flex max-h-[85vh] w-[min(1100px,calc(100vw-2rem))] flex-col overflow-hidden p-0'
            )}
          >
            <div className="flex items-center justify-between border-b px-5 py-3">
              <Dialog.Title className={dialogTitleClassName}>
                {t('Notebook network logs')}
              </Dialog.Title>
              <Dialog.Close asChild>
                <Button variant="ghost" size="sm">
                  {t('Close')}
                </Button>
              </Dialog.Close>
            </div>
            <Dialog.Description className="px-5 pt-3 text-xs text-muted-foreground">
              {t(
                'Allowed and blocked Notebook connections, grouped by their original network mode.'
              )}
            </Dialog.Description>
            <NetworkLogContent />
          </Dialog.Content>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  )
}
