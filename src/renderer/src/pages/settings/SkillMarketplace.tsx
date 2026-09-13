import { useEffect, useRef, useState } from 'react'
import type {
  SkillMarketplaceCatalog,
  SkillMarketplaceDetail,
  SkillMarketplaceInstallation,
  SkillMarketplaceInstallResult,
  SkillMarketplaceResult
} from '../../../../shared/skill-marketplace'
import { ErrorNotice } from '@/components/error-notice'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { ExternalTextLink } from '@/components/ExternalTextLink'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsSearchInput } from './SettingsSearchInput'
import {
  filterSkillMarketplace,
  skillMarketplaceCategories,
  skillMarketplaceRepository,
  SKILL_MARKETPLACE_PAGE_SIZE,
  type SkillMarketplaceEntry
} from './skill-marketplace-model'
import './skill-marketplace.css'

export type SkillMarketplaceView =
  | { kind: 'marketplace' }
  | { kind: 'marketplace-detail'; id: string; displayName: string; snapshotId: string }

function TruncatedText({
  text,
  lines,
  onClick
}: {
  text: string
  lines: 1 | 2
  onClick?: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const content = (
    <span ref={ref} className={lines === 1 ? 'block truncate' : 'line-clamp-2 break-words'}>
      {text}
    </span>
  )
  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const el = ref.current
        setOpen(
          Boolean(
            next && el && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1)
          )
        )
      }}
    >
      <TooltipTrigger asChild>
        {onClick ? (
          <button
            type="button"
            onClick={onClick}
            className="block w-full min-w-0 rounded text-left font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {content}
          </button>
        ) : (
          <span
            tabIndex={0}
            className="block min-w-0 rounded text-sm leading-5 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {content}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        className="skill-marketplace-tooltip max-h-[var(--radix-tooltip-content-available-height)] max-w-[280px] overflow-auto px-3 py-2 leading-5"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

function MetadataLink({
  href,
  children
}: {
  href: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <ExternalTextLink href={href} className="max-w-full break-all">
      {children}
    </ExternalTextLink>
  )
}

function MarketplaceInstallControls({
  entry,
  snapshotId,
  installation,
  onChanged
}: {
  entry: SkillMarketplaceEntry
  snapshotId: string
  installation: SkillMarketplaceInstallation
  onChanged: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<Extract<SkillMarketplaceInstallResult, { ok: false }>>()
  const active = useRef(true)
  const inFlight = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const installed = installation.kind === 'installed' ? installation : undefined
  const conflict = installation.kind === 'conflict' || failure?.error === 'conflict'
  const install = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setFailure(undefined)
    let result: SkillMarketplaceInstallResult
    try {
      result = await window.api.settings.installSkillMarketplace({
        id: entry.id,
        snapshotId,
        expectedVersion: installed?.version ?? null
      })
    } catch {
      result = { ok: false, error: 'installation-failed' }
    }
    inFlight.current = false
    if (!active.current) return
    setPending(false)
    setConfirm(false)
    if (result.ok) onChanged()
    else setFailure(result)
  }
  return (
    <div className="space-y-3">
      {installed ? (
        <p className="text-sm text-muted-foreground">
          {t('Installed version: {{version}}', { version: installed.version })}
        </p>
      ) : null}
      {conflict || failure ? (
        <ErrorNotice
          tone={conflict ? 'amber' : 'red'}
          title={t('Skill installation failed')}
          description={
            conflict
              ? t(
                  'Local changes or an existing Skill prevent installation. No files were replaced.'
                )
              : undefined
          }
          errorCode={failure?.error ?? 'conflict'}
          primaryButton={{ label: t('Refresh'), onClick: onChanged }}
        />
      ) : null}
      <Button
        ref={trigger}
        disabled={pending || conflict || Boolean(installed && !installed.canUpdate)}
        onClick={() => setConfirm(true)}
      >
        {pending
          ? t('Installing…')
          : installed
            ? installed.canUpdate
              ? t('Update')
              : t('Installed')
            : t('Install')}
      </Button>
      <ConfirmActionDialog
        open={confirm}
        title={installed ? t('Update') : t('Install')}
        description={
          (installed
            ? t('Update Skill from {{from}} to {{to}}?', {
                from: installed.version,
                to: entry.version
              }) + ' '
            : '') +
          t(
            'Installing downloads and verifies the package. Bundled scripts are not run during installation.'
          )
        }
        cancelLabel={t('Cancel', { ns: 'common' })}
        confirmLabel={installed ? t('Update') : t('Install')}
        loading={pending}
        loadingLabel={t('Installing…')}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          void install()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          trigger.current?.focus()
        }}
      />
    </div>
  )
}

export function SkillMarketplace({
  view,
  onNavigate
}: {
  view: SkillMarketplaceView
  onNavigate: (view: SkillMarketplaceView) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState('name')
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [detailRefresh, setDetailRefresh] = useState(0)
  const [catalogResponse, setCatalog] = useState<{
    key: number
    result: SkillMarketplaceResult<SkillMarketplaceCatalog>
  }>()
  const catalog = catalogResponse?.key === refresh ? catalogResponse.result : undefined
  const [detail, setDetail] = useState<{
    key: string
    result: SkillMarketplaceResult<SkillMarketplaceDetail>
  }>()
  const detailId = view.kind === 'marketplace-detail' ? view.id : undefined
  const snapshotId = view.kind === 'marketplace-detail' ? view.snapshotId : undefined
  const detailKey = `${snapshotId}/${detailId}/${detailRefresh}`
  useEffect(() => {
    let active = true
    void window.api.settings.listSkillMarketplace().then(
      (result) => {
        if (active) {
          setCatalog({ key: refresh, result })
          setPage(1)
        }
      },
      () => {
        if (active) setCatalog({ key: refresh, result: { ok: false, error: 'network' } })
      }
    )
    return () => {
      active = false
    }
  }, [refresh])
  useEffect(() => {
    if (!detailId || !snapshotId) return
    let active = true
    void window.api.settings.getSkillMarketplaceDetail({ id: detailId, snapshotId }).then(
      (result) => {
        if (active) setDetail({ key: detailKey, result })
      },
      () => {
        if (active) setDetail({ key: detailKey, result: { ok: false, error: 'network' } })
      }
    )
    return () => {
      active = false
    }
  }, [detailId, snapshotId, detailKey])
  const detailResult = detail?.key === detailKey ? detail.result : undefined
  const result = view.kind === 'marketplace' ? catalog : detailResult
  const items = catalog?.ok ? catalog.value.entries : []
  const selected = detailResult?.ok ? detailResult.value.entry : undefined
  const labels: Record<string, string> = {
    'Academic Writing': t('Academic writing'),
    'Data Analysis': t('Data analysis'),
    'Evidence Insight': t('Evidence insight'),
    'Protocol Design': t('Protocol design'),
    Other: t('Other')
  }
  const matches = filterSkillMarketplace(items, query, category, sort, i18n.language)
  const pages = Math.max(1, Math.ceil(matches.length / SKILL_MARKETPLACE_PAGE_SIZE))
  const resetFilter = (set: (value: string) => void, value: string): void => {
    set(value)
    setPage(1)
  }
  const openDetail = (item: SkillMarketplaceEntry): void => {
    if (catalog?.ok)
      onNavigate({
        kind: 'marketplace-detail',
        id: item.id,
        displayName: item.displayName,
        snapshotId: catalog.value.snapshotId
      })
  }
  const assessment = (item: SkillMarketplaceEntry): string | undefined =>
    item.evaluation && t('Upstream self-assessment {{score}}/{{maxScore}}', item.evaluation)

  return (
    <div className="space-y-4 p-5" data-slot="skill-marketplace">
      <p
        role="note"
        className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground"
      >
        {t('Browse and install verified Marketplace releases. Updates require confirmation.')}
      </p>
      {!result ? (
        <p role="status">{t('Loading…')}</p>
      ) : !result.ok ? (
        <ErrorNotice
          role="alert"
          tone={result.error === 'integrity' ? 'red' : 'amber'}
          title={
            result.error === 'integrity'
              ? t('Marketplace verification failed')
              : result.error === 'snapshot-unavailable'
                ? t('Marketplace snapshot is no longer available')
                : t('Unable to load Marketplace')
          }
          description={
            result.error === 'integrity'
              ? t('The catalog could not be verified. Unverified content is not displayed.')
              : undefined
          }
          primaryButton={{
            label: result.error === 'snapshot-unavailable' ? t('Back to Marketplace') : t('Retry'),
            onClick: () => {
              if (result.error === 'snapshot-unavailable') {
                onNavigate({ kind: 'marketplace' })
                setRefresh((value) => value + 1)
              } else if (view.kind === 'marketplace') setRefresh((value) => value + 1)
              else setDetailRefresh((value) => value + 1)
            }
          }}
        />
      ) : view.kind === 'marketplace-detail' ? (
        selected ? (
          <div className="space-y-5" data-slot="skill-marketplace-detail">
            <h3 className="break-words text-lg font-semibold">{selected.displayName}</h3>
            <p className="text-sm text-muted-foreground">{selected.summary}</p>
            {detailResult?.ok && detailResult.value.installation && snapshotId ? (
              <MarketplaceInstallControls
                key={detailKey}
                entry={selected}
                snapshotId={snapshotId}
                installation={detailResult.value.installation}
                onChanged={() => setDetailRefresh((value) => value + 1)}
              />
            ) : null}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm">
              <dt>{t('Category')}</dt>
              <dd>{labels[selected.category]}</dd>
              <dt>{t('Version')}</dt>
              <dd>{selected.version}</dd>
              {selected.authors?.length ? (
                <>
                  <dt>{t('Author')}</dt>
                  <dd className="space-x-2">
                    {selected.authors.map((a, index) =>
                      a.url ? (
                        <MetadataLink key={index} href={a.url}>
                          {a.name}
                        </MetadataLink>
                      ) : (
                        <span key={index}>{a.name}</span>
                      )
                    )}
                  </dd>
                </>
              ) : null}
              <dt>{t('Package publisher')}</dt>
              <dd>
                <MetadataLink href={selected.publisher.url}>{selected.publisher.name}</MetadataLink>
              </dd>
              <dt>{t('Upstream source')}</dt>
              <dd>
                <MetadataLink
                  href={`${selected.source.repository}/tree/${selected.source.commit}/${selected.source.path.split('/').map(encodeURIComponent).join('/')}`}
                >
                  {selected.source.repository}/{selected.source.path}
                </MetadataLink>
                <p className="break-all text-xs text-muted-foreground">{selected.source.commit}</p>
              </dd>
              <dt>{t('Marketplace')}</dt>
              <dd>
                <MetadataLink href={skillMarketplaceRepository}>
                  {skillMarketplaceRepository}
                </MetadataLink>
              </dd>
              <dt>{t('License')}</dt>
              <dd>{selected.license}</dd>
              <dt>{t('License evidence')}</dt>
              <dd className="space-y-2">
                {detailResult?.ok &&
                  detailResult.value.licenseEvidence.map((evidence) => (
                    <div key={evidence.url}>
                      <MetadataLink href={evidence.url}>{evidence.url}</MetadataLink>
                    </div>
                  ))}
              </dd>
            </dl>
            {selected.evaluation ? (
              <section
                className="space-y-2 rounded-lg border border-border p-4 text-sm"
                data-slot="skill-marketplace-assessment"
              >
                <h4 className="font-medium tabular-nums">{assessment(selected)}</h4>
                <p className="text-xs text-muted-foreground">
                  {t(
                    'Upstream self-assessment is not an independent quality or safety endorsement.'
                  )}
                </p>
                {selected.evaluation.staticScore ? (
                  <p>
                    {t('Static score: {{score}}/{{maxScore}}', selected.evaluation.staticScore)}
                  </p>
                ) : null}
                {selected.evaluation.dynamicScore ? (
                  <p>
                    {t('Dynamic score: {{score}}/{{maxScore}}', selected.evaluation.dynamicScore)}
                  </p>
                ) : null}
                {selected.evaluation.evaluatedOn ? (
                  <p>{t('Evaluated on: {{date}}', { date: selected.evaluation.evaluatedOn })}</p>
                ) : null}
                {selected.evaluation.evaluatorVersion ? (
                  <p>
                    {t('Evaluator: {{version}}', { version: selected.evaluation.evaluatorVersion })}
                  </p>
                ) : null}
                {selected.evaluation.skillVersion ? (
                  <p>
                    {t('Assessed Skill version: {{version}}', {
                      version: selected.evaluation.skillVersion
                    })}
                  </p>
                ) : null}
                <MetadataLink href={selected.evaluation.reportUrl}>
                  {t('Assessment report')}
                </MetadataLink>
              </section>
            ) : null}
          </div>
        ) : (
          <p role="status">{t('No skills match your search.')}</p>
        )
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">{t('Browse Marketplace')}</h3>
            <Button variant="outline" onClick={() => setRefresh((value) => value + 1)}>
              {t('Refresh')}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <SettingsSearchInput
              aria-label={t('Search skills')}
              placeholder={t('Search skills…')}
              value={query}
              onChange={(event) => resetFilter(setQuery, event.target.value)}
              containerClassName="min-w-48"
            />
            <Select value={sort} onValueChange={(value) => resetFilter(setSort, value)}>
              <SelectTrigger aria-label={t('Sort by')} className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">{t('Name A–Z')}</SelectItem>
                <SelectItem value="manifest">{t('Catalog order')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap gap-2" aria-label={t('Category')}>
            {['all', ...skillMarketplaceCategories].map((value) => (
              <Button
                key={value}
                variant={category === value ? 'secondary' : 'outline'}
                aria-pressed={category === value}
                onClick={() => resetFilter(setCategory, value)}
              >
                {value === 'all' ? t('All') : labels[value]}
                <span className="tabular-nums text-muted-foreground">
                  {value === 'all'
                    ? items.length
                    : items.filter((item) => item.category === value).length}
                </span>
              </Button>
            ))}
          </div>
          <p role="status" className="text-xs tabular-nums text-muted-foreground">
            {t('Results: {{results}} / {{total}}', {
              results: matches.length,
              total: items.length
            })}
          </p>
          <TooltipProvider delayDuration={250} skipDelayDuration={300}>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
              {matches
                .slice((page - 1) * SKILL_MARKETPLACE_PAGE_SIZE, page * SKILL_MARKETPLACE_PAGE_SIZE)
                .map((item) => (
                  <article
                    key={item.id}
                    data-slot="skill-marketplace-card"
                    className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm"
                  >
                    <TruncatedText
                      text={item.displayName}
                      lines={1}
                      onClick={() => openDetail(item)}
                    />
                    <TruncatedText text={item.summary} lines={2} />
                    <div className="truncate text-xs leading-6">
                      <span className="rounded bg-muted px-2 py-1">{labels[item.category]}</span>
                    </div>
                    {item.evaluation ? (
                      <p className="truncate text-xs tabular-nums text-muted-foreground">
                        {assessment(item)}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-between gap-2 border-t border-border pt-3 text-xs">
                      <span className="min-w-0 truncate text-muted-foreground">
                        {item.authors?.length
                          ? t('Author: {{name}}', {
                              name: item.authors.map((a) => a.name).join(', ')
                            })
                          : null}
                      </span>
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto shrink-0 p-0"
                        onClick={() => openDetail(item)}
                      >
                        {t('Details')}
                      </Button>
                    </div>
                  </article>
                ))}
            </div>
          </TooltipProvider>
          {matches.length === 0 ? <p>{t('No skills match your search.')}</p> : null}
          <div className="flex items-center justify-end gap-3">
            <Button variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>
              {t('Previous page')}
            </Button>
            <span className="text-xs tabular-nums">
              {t('Page {{page}} of {{pages}}', { page, pages })}
            </span>
            <Button variant="outline" disabled={page === pages} onClick={() => setPage(page + 1)}>
              {t('Next page')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
