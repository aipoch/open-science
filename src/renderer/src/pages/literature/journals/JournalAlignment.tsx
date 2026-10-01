import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScanSearch, Search, Unlink, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { CollectionOptionHelp } from '../collections/CollectionOptionHelp'
import { LiteratureErrorNotice } from '../LiteratureErrorNotice'
import { LiteraturePagination } from '../list/LiteraturePagination'
import { LiteratureTextTooltip } from '../LiteratureTable'
import { refreshJournalAttributes } from './journal-attribute-store'
import type {
  JournalAlignment as Alignment,
  JournalIdentity,
  JournalMatchStatus,
  JournalRequest,
  JournalResult
} from '../../../../../shared/journal-attributes'

const externalIdText = (identity: JournalIdentity): string =>
  (identity.externalIds ?? []).map(({ namespace, value }) => `${namespace}:${value}`).join(', ')

export function JournalAlignment({
  onOpenItem,
  expanded = false
}: {
  onOpenItem: (id: string, initiator?: HTMLElement) => void | Promise<void>
  expanded?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(expanded)
  const [report, setReport] = useState<Alignment>()
  const [status, setStatus] = useState<JournalMatchStatus>('missing')
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState<25 | 50 | 100>(25)
  const [busy, setBusy] = useState(false)
  const [pageLoading, setPageLoading] = useState(false)
  const tableScroll = useRef<HTMLDivElement>(null)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Alignment['rows'][number]>()
  const [target, setTarget] = useState<NonNullable<JournalResult['candidates']>[number] | null>()
  const [saving, setSaving] = useState(false)
  const [candidates, setCandidates] = useState<JournalResult['candidates']>()
  const generation = useRef(0)
  const checkGeneration = useRef(0)
  const scanToken = useRef<string | undefined>(undefined)
  const [processed, setProcessed] = useState<number>()
  const candidateEditor = useRef<HTMLDivElement>(null)
  const confirmationPanel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (selected && candidateEditor.current) candidateEditor.current.scrollTop = 0
  }, [selected])
  useEffect(() => {
    if (target !== undefined) confirmationPanel.current?.scrollIntoView?.({ block: 'nearest' })
  }, [target])
  const api = window.api.literature.journals
  const cancelScan = useCallback((): void => {
    checkGeneration.current++
    generation.current++
    const token = scanToken.current
    scanToken.current = undefined
    if (token) void api({ action: 'audit-cancel', token }).catch(() => {})
    setProcessed(undefined)
    setPageLoading(false)
    setBusy(false)
    setStale(true)
  }, [api])
  const labels = { matched: t('Matched'), missing: t('Unmatched'), ambiguous: t('Ambiguous match') }
  const reasons = {
    manual: t('Manually confirmed journal'),
    'external-id': t('Matched by external journal ID'),
    issn: t('Matched by ISSN'),
    name: t('Matched by journal name or abbreviation'),
    'multiple-candidates': t('Multiple journals share this identity'),
    'identifier-conflict': t('Journal name matches, but ISSNs conflict'),
    'missing-identity': t('Missing journal identity'),
    'not-found': t('No matching journal')
  }
  useEffect(() => {
    if (!open) return
    const invalidate = (): void => {
      cancelScan()
      generation.current += 1
      setBusy(false)
      setStale(true)
      setCandidates(undefined)
      setSelected(undefined)
      setTarget(undefined)
    }
    const remove = window.api.literature.onChanged?.(invalidate)
    window.addEventListener('open-science:web-events-open', invalidate)
    return () => {
      cancelScan()
      generation.current += 1
      remove?.()
      window.removeEventListener('open-science:web-events-open', invalidate)
    }
  }, [open, cancelScan])

  const run = async (request: JournalRequest): Promise<JournalResult | undefined> => {
    const current = (generation.current += 1)
    setBusy(true)
    setPageLoading(request.action === 'audit' && Boolean(report))
    setError('')
    try {
      const result = await api(request)
      if (current !== generation.current && result.scan)
        void api({ action: 'audit-cancel', token: result.scan.token }).catch(() => {})
      return current === generation.current ? result : undefined
    } catch {
      if (current === generation.current) {
        setStale(true)
        setError(t('Could not check journal alignment. Check the library again.'))
      }
      return undefined
    } finally {
      if (current === generation.current) {
        setBusy(false)
        setPageLoading(false)
      }
    }
  }
  const check = async (
    nextStatus = status,
    nextOffset = 0,
    token?: string,
    nextPageSize = pageSize
  ): Promise<void> => {
    const checkId = ++checkGeneration.current
    if (!token) {
      setProcessed(0)
      while (true) {
        const step = await run({ action: 'audit-step', token: scanToken.current })
        if (checkId !== checkGeneration.current) return
        if (!step?.scan) {
          const expired = scanToken.current
          scanToken.current = undefined
          if (expired) void api({ action: 'audit-cancel', token: expired }).catch(() => {})
          setProcessed(undefined)
          return
        }
        scanToken.current = step.scan.token
        setProcessed(step.scan.processed)
        if (step.scan.done) {
          token = step.scan.token
          scanToken.current = undefined
          setProcessed(undefined)
          break
        }
      }
    }
    const result = await run({
      action: 'audit',
      token,
      status: nextStatus,
      offset: nextOffset,
      limit: nextPageSize
    })
    if (!result?.alignment) return
    setReport(result.alignment)
    if (tableScroll.current) tableScroll.current.scrollTop = 0
    setStatus(nextStatus)
    setOffset(nextOffset)
    setPageSize(nextPageSize)
    setStale(false)
    setCandidates(undefined)
    setSelected(undefined)
    setTarget(undefined)
  }
  const search = async (value: string): Promise<void> => {
    setCandidates(undefined)
    if (value.trim().length < 2) return
    const result = await run({ action: 'candidates', query: value.trim() })
    if (result) setCandidates(result.candidates ?? [])
  }
  const confirm = async (): Promise<void> => {
    if (!selected || target === undefined || !report || stale || busy || saving) return
    setSaving(true)
    try {
      const result = await run({
        action: 'bind',
        token: report.token,
        itemId: selected.itemId,
        journalId: target?.id ?? null,
        expectedMetadataRevision: selected.metadataRevision,
        expectedBindingRevision: selected.bindingRevision
      })
      if (result) {
        refreshJournalAttributes()
        setStale(true)
        setSelected(undefined)
        setTarget(undefined)
        setCandidates(undefined)
      }
    } finally {
      setSaving(false)
    }
  }
  const reset = (): void => {
    cancelScan()
    generation.current += 1
    setBusy(false)
    setReport(undefined)
    setCandidates(undefined)
    setSelected(undefined)
    setTarget(undefined)
  }
  const openReference = async (id: string, initiator: HTMLElement): Promise<void> => {
    try {
      await onOpenItem(id, initiator)
    } catch {
      setError(t('Literature could not be loaded.'))
    }
  }
  return (
    <TooltipProvider>
      <section
        className={`w-full overflow-hidden rounded-xl border border-border-300/80 bg-bg-000 ${expanded ? 'flex min-h-0 flex-1 flex-col' : ''}`}
        aria-label={t('Journal alignment')}
      >
        {!expanded ? (
          <div className="flex items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">{t('Journal alignment')}</h3>
              {!open ? (
                <p className="mt-1 max-w-2xl truncate text-xs text-muted-foreground">
                  {t(
                    'Check saved journal articles. Trash and merged references are excluded. This check does not change references.'
                  )}
                </p>
              ) : null}
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={open}
              aria-label={t('Journal alignment')}
              onClick={() => {
                reset()
                setOpen((value) => !value)
              }}
            >
              {open ? t('Show less') : t('Show more')}
            </Button>
          </div>
        ) : null}
        {open ? (
          <div
            className={`px-4 py-4 ${expanded ? 'flex min-h-0 flex-1 flex-col gap-3' : 'space-y-3 border-t border-border-300/80'}`}
          >
            <div
              className={
                report
                  ? 'flex shrink-0 flex-wrap items-center gap-3'
                  : 'flex min-h-56 flex-col items-center justify-center gap-4 py-6 text-center'
              }
            >
              {!report ? (
                <div className="flex max-w-md flex-col items-center gap-2">
                  <ScanSearch className="mb-1 size-7 text-muted-foreground" aria-hidden="true" />
                  <h3 className="text-sm font-medium">{t('Check journal matches')}</h3>
                  <p className="text-sm text-muted-foreground">
                    {t(
                      'Find unmatched or ambiguous references. This check does not change your library.'
                    )}
                  </p>
                </div>
              ) : null}
              {report ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {report ? (
                    <p role="status" className="text-sm">
                      {t(
                        'Matched: {{matched}} · Unmatched: {{missing}} · Conflicts: {{ambiguous}}',
                        report.counts
                      )}
                    </p>
                  ) : null}
                  <CollectionOptionHelp label={t('Journal alignment')}>
                    {t(
                      'Check saved journal articles. Trash and merged references are excluded. This check does not change references.'
                    )}
                  </CollectionOptionHelp>
                </div>
              ) : null}
              {report ? (
                <Select
                  value={status}
                  disabled={busy || saving || stale}
                  onValueChange={(value) =>
                    void check(value as JournalMatchStatus, 0, report.token)
                  }
                >
                  <SelectTrigger aria-label={t('Match status')} className="w-auto min-w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['missing', 'ambiguous', 'matched'] as const).map((value) => (
                      <SelectItem key={value} value={value}>
                        {labels[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Button className="shrink-0" disabled={busy || saving} onClick={() => void check()}>
                {report ? t('Recheck library') : t('Check library')}
              </Button>
            </div>
            {busy && !report ? <p role="status">{t('Checking…')}</p> : null}
            {processed !== undefined && !report ? (
              <div className="space-y-2">
                <p role="status">{t('References checked: {{total}}', { total: processed })}</p>
                <p className="text-xs text-muted-foreground">
                  {t('Large libraries may take a while. Cancelling does not change references.')}
                </p>
                <Button variant="outline" onClick={cancelScan}>
                  {t('Cancel')}
                </Button>
              </div>
            ) : null}
            {error ? <LiteratureErrorNotice tone="amber" title={error} /> : null}
            {stale && report ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t(
                  'References or journal data may have changed. Recheck the library before using these results.'
                )}
              </p>
            ) : null}
            {report ? (
              <>
                <div
                  className={`relative h-[min(24rem,45dvh)] min-h-0 ${expanded ? 'flex-1' : ''}`}
                  aria-busy={pageLoading || processed !== undefined}
                >
                  <div ref={tableScroll} className="h-full overflow-auto overscroll-contain">
                    <table className="w-full table-fixed text-left text-sm">
                      <thead className="sticky top-0 z-10 bg-bg-000">
                        <tr>
                          <th className="p-2">{t('Title')}</th>
                          <th className="p-2">{t('Journal name')}</th>
                          <th className="p-2">{t('Match details')}</th>
                          <th className="w-24 p-2">{t('Actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!report.rows.length ? (
                          <tr>
                            <td colSpan={4} className="p-4 text-center text-muted-foreground">
                              {t('No references in this group.')}
                            </td>
                          </tr>
                        ) : null}
                        {report.rows.map((row) => (
                          <tr key={row.itemId} className="border-t border-border align-top">
                            <td className="p-2">
                              <LiteratureTextTooltip text={row.title} overflowOnly>
                                <Button
                                  variant="link"
                                  className="h-auto w-full justify-start whitespace-normal p-0 text-left"
                                  onClick={(event) =>
                                    void openReference(row.itemId, event.currentTarget)
                                  }
                                >
                                  <span className="line-clamp-2">
                                    {row.title || t('Open reference')}
                                  </span>
                                </Button>
                              </LiteratureTextTooltip>
                            </td>
                            <td className="max-w-64 break-words p-2">
                              <LiteratureTextTooltip text={row.identity.name} overflowOnly>
                                <p className="truncate">{row.identity.name || '—'}</p>
                              </LiteratureTextTooltip>
                              <LiteratureTextTooltip
                                text={row.identity.issns.join(', ')}
                                overflowOnly
                              >
                                <p className="truncate text-xs text-muted-foreground">
                                  {row.identity.issns.join(', ') || '—'}
                                </p>
                              </LiteratureTextTooltip>
                              {externalIdText(row.identity) ? (
                                <LiteratureTextTooltip
                                  text={externalIdText(row.identity)}
                                  overflowOnly
                                >
                                  <p className="truncate text-xs text-muted-foreground">
                                    {externalIdText(row.identity)}
                                  </p>
                                </LiteratureTextTooltip>
                              ) : null}
                            </td>
                            <td className="max-w-80 break-words p-2">
                              <p>{reasons[row.reason]}</p>
                              {row.candidates.map((candidate) => (
                                <div key={candidate.id}>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {candidate.name} · {candidate.issns.join(', ') || '—'}
                                  </p>
                                  {externalIdText(candidate) ? (
                                    <p className="break-all text-xs text-muted-foreground">
                                      {externalIdText(candidate)}
                                    </p>
                                  ) : null}
                                </div>
                              ))}
                              {row.candidateTotal > 5 ? (
                                <p className="text-xs">
                                  {t('Only the first five candidates are shown.')}
                                </p>
                              ) : null}
                            </td>
                            <td className="p-2">
                              <div className="flex gap-2">
                                <LiteratureTextTooltip text={t('Find journal candidates')}>
                                  <Button
                                    variant="outline"
                                    size="icon"
                                    aria-label={t('Find journal candidates')}
                                    disabled={busy || saving || stale}
                                    onClick={() => {
                                      setSelected(row)
                                      setTarget(undefined)
                                      setQuery(row.identity.name)
                                      void search(row.identity.name)
                                    }}
                                  >
                                    <Search className="size-4" aria-hidden="true" />
                                  </Button>
                                </LiteratureTextTooltip>
                                {row.bindingRevision ? (
                                  <LiteratureTextTooltip text={t('Remove journal confirmation')}>
                                    <Button
                                      variant="outline"
                                      size="icon"
                                      aria-label={t('Remove journal confirmation')}
                                      disabled={busy || saving || stale}
                                      onClick={() => {
                                        setSelected(row)
                                        setTarget(null)
                                        setCandidates(undefined)
                                      }}
                                    >
                                      <Unlink className="size-4" aria-hidden="true" />
                                    </Button>
                                  </LiteratureTextTooltip>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {pageLoading || processed !== undefined ? (
                    <div
                      className="absolute inset-0 z-20 flex items-center justify-center bg-bg-000/80"
                      role="status"
                    >
                      {processed !== undefined ? (
                        <div className="space-y-2 p-4 text-center">
                          <p>{t('References checked: {{total}}', { total: processed })}</p>
                          <p className="text-xs text-muted-foreground">
                            {t(
                              'Large libraries may take a while. Cancelling does not change references.'
                            )}
                          </p>
                          <Button variant="outline" onClick={cancelScan}>
                            {t('Cancel')}
                          </Button>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">{t('Loading')}</span>
                      )}
                    </div>
                  ) : null}
                </div>
                <div className="shrink-0">
                  <LiteraturePagination
                    total={report.total}
                    offset={offset}
                    pageSize={pageSize}
                    displayedCount={report.rows.length}
                    countLabel={t('{{count}} references', {
                      count: report.total,
                      defaultValue_one: '{{count}} reference'
                    })}
                    pageSizeLabel={t('References per page')}
                    disabled={busy || saving || stale}
                    loading={pageLoading}
                    onOffsetChange={(next) => void check(status, next, report.token)}
                    onPageSizeChange={(size) =>
                      void check(status, 0, report.token, size as 25 | 50 | 100)
                    }
                  />
                </div>
                {selected ? (
                  <div
                    ref={candidateEditor}
                    className="max-h-[min(20rem,35dvh)] shrink-0 space-y-3 overflow-y-auto overscroll-contain rounded-lg border border-border bg-muted/20 p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{t('Find journal candidates')}</p>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('Close')}
                        disabled={busy || saving}
                        onClick={() => {
                          setSelected(undefined)
                          setTarget(undefined)
                          setCandidates(undefined)
                        }}
                      >
                        <X className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                    {selected ? (
                      <p className="line-clamp-2 text-sm">
                        {t('Selected reference: {{title}}', {
                          title: selected.title || t('Open reference')
                        })}
                      </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'Search by part of a journal name or abbreviation. Candidates are suggestions only and are not linked automatically.'
                      )}
                    </p>
                    <form
                      className="flex flex-wrap items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        if (!busy && !saving && !stale && query.trim().length >= 2)
                          void search(query)
                      }}
                    >
                      <Input
                        className="min-w-48 flex-1"
                        placeholder={t('Search journal candidates')}
                        aria-label={t('Search journal candidates')}
                        disabled={busy || saving || stale}
                        value={query}
                        maxLength={500}
                        onChange={(event) => {
                          setQuery(event.target.value)
                          setCandidates(undefined)
                          setTarget(undefined)
                        }}
                      />
                      <Button
                        variant="outline"
                        disabled={busy || saving || stale || query.trim().length < 2}
                        type="submit"
                      >
                        {t('Find journal candidates')}
                      </Button>
                    </form>
                    {candidates?.map((candidate) => (
                      <div
                        key={candidate.id}
                        className="flex items-center justify-between gap-2 text-sm"
                      >
                        <span>
                          {candidate.name} · {candidate.issns.join(', ') || '—'}
                        </span>
                        {selected ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || saving || stale}
                            onClick={() => setTarget(candidate)}
                          >
                            {t('Choose journal')}
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    {selected && target !== undefined ? (
                      <div
                        className="space-y-2 rounded-md border border-border p-3"
                        aria-label={t('Confirm journal association')}
                        ref={confirmationPanel}
                      >
                        <p className="text-sm">{selected.title || t('Open reference')}</p>
                        <p className="text-xs text-muted-foreground">
                          {selected.identity.name} · {selected.identity.issns.join(', ') || '—'}
                        </p>
                        {externalIdText(selected.identity) ? (
                          <p className="break-all text-xs text-muted-foreground">
                            {externalIdText(selected.identity)}
                          </p>
                        ) : null}
                        {target ? (
                          <>
                            <p className="text-sm">
                              {target.name} · {target.issns.join(', ') || '—'}
                            </p>
                            {externalIdText(target) ? (
                              <p className="break-all text-xs text-muted-foreground">
                                {externalIdText(target)}
                              </p>
                            ) : null}
                            <p className="text-xs text-muted-foreground">
                              {t(
                                'This confirmation applies only to this reference. Changing its journal name, abbreviation, or ISSN removes the confirmation.'
                              )}
                            </p>
                          </>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {t('Removing this confirmation restores automatic journal matching.')}
                          </p>
                        )}
                        <Button disabled={busy || saving || stale} onClick={() => void confirm()}>
                          {t('Confirm journal association')}
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={saving}
                          onClick={() => setTarget(undefined)}
                        >
                          {t('Cancel')}
                        </Button>
                      </div>
                    ) : null}
                    {candidates?.length === 0 ? (
                      <p className="text-sm">{t('No matching journal')}</p>
                    ) : null}
                    {candidates?.length === 20 ? (
                      <p className="text-xs text-muted-foreground">
                        {t('Showing up to 20 candidates. Refine the search to find more journals.')}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </section>
    </TooltipProvider>
  )
}
