import { ResourceDetailActions, ResourceDetailHeader } from '../marketplace/ResourceDetailLayout'
import { ScrollText } from 'lucide-react'
import type { SkillMarketplaceView } from '../../lib/settings-navigation'
import { SkillMarketplaceUpdateDialog } from './SkillMarketplaceUpdateDialog'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CircleCheck, ChevronDown, Download, LoaderCircle, Trash2 } from 'lucide-react'
import { useSettingsStore } from '@/stores/settings-store'
import { skillMarketplaceStableVersionPattern } from '../../../../shared/skill-marketplace'
import type {
  SkillMarketplaceCatalog,
  SkillMarketplaceCatalogRequest,
  SkillMarketplaceInstallation,
  SkillMarketplaceInstallResult,
  SkillMarketplaceResult
} from '../../../../shared/skill-marketplace'
import type {
  SkillMarketplaceUpdatePreview,
  SkillMarketplaceDetail
} from '../../../../shared/skill-marketplace'
import { ErrorNotice } from '@/components/error-notice'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
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
import { SkillMarketplaceBatchControls, type MarketplaceBatchMode } from './SkillMarketplaceBatch'
import {
  ResourceCatalogHeader,
  ResourceCatalogFilter,
  ResourceCatalogToolbar,
  ResourceCenterModeTabs
} from '../marketplace/ResourceCenterModeTabs'
import {
  ResourceMarketplaceCardContent,
  ResourceMarketplaceIdentity
} from '../marketplace/ResourceMarketplaceIdentity'
import {
  filterSkillMarketplace,
  skillMarketplaceAttribution,
  skillMarketplaceSourceOwner,
  skillMarketplaceCategories,
  skillMarketplaceRepository,
  SKILL_MARKETPLACE_PAGE_SIZE,
  type SkillMarketplaceEntry
} from './skill-marketplace-model'
import './skill-marketplace.css'

export type { SkillMarketplaceView } from '../../lib/settings-navigation'

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
  onChanged,
  compact = false,
  disabled = false,
  onOpenDetail,
  onManageLocal
}: {
  entry: SkillMarketplaceEntry
  snapshotId: string
  installation: SkillMarketplaceInstallation
  onChanged: (installation?: SkillMarketplaceInstallation) => void
  compact?: boolean
  disabled?: boolean
  onOpenDetail?: () => void
  onManageLocal?: (id?: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [confirm, setConfirm] = useState(false)
  const [pending, setPending] = useState<'install' | 'uninstall' | 'toggle' | 'preview'>()
  const packagePending = pending === 'install' || pending === 'uninstall' || pending === 'preview'
  const [updatePreview, setUpdatePreview] = useState<SkillMarketplaceUpdatePreview>()
  const [updateError, setUpdateError] = useState<string>()
  const [failure, setFailure] = useState<Extract<SkillMarketplaceInstallResult, { ok: false }>>()
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [uninstallConfirm, setUninstallConfirm] = useState(false)
  const [uninstallPreview, setUninstallArmed] = useState(false)
  const [managementFailure, setManagementFailure] = useState<string>()
  const installed = installation.kind === 'installed' ? installation : undefined
  const localSkillId = installed?.localSkillId
  const conflictSkillId = installation.kind === 'conflict' ? installation.localSkillId : undefined
  const localSkill = useSettingsStore((state) =>
    state.skills.find((skill) => skill.id === localSkillId)
  )
  const deleteSkill = useSettingsStore((state) => state.deleteSkill)
  const setSkillEnabled = useSettingsStore((state) => state.setSkillEnabled)
  const active = useRef(true)
  const inFlight = useRef(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const uninstallTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  if (!skillMarketplaceStableVersionPattern.test(entry.version)) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title={t('Only stable releases can be installed.')}
      >
        {compact ? t('Unavailable') : t('Only stable releases can be installed.')}
      </span>
    )
  }
  const conflict = installation.kind === 'conflict' || failure?.error === 'conflict'
  const canUninstallInline = Boolean(
    installed &&
    !installed.protected &&
    !installed.canUpdate &&
    localSkillId &&
    !conflict &&
    !disabled &&
    !pending
  )
  const uninstallArmed = canUninstallInline && uninstallPreview
  const conflictReason =
    failure?.reason ?? (installation.kind === 'conflict' ? installation.reason : undefined)
  const conflictDescription =
    conflictReason === 'name-taken'
      ? t(
          'A Skill with this name is already installed. Review its differences before updating it in place.'
        )
      : conflictReason === 'local-content-changed'
        ? t('This Skill has local changes. Updating will replace them.')
        : conflictReason === 'version-changed'
          ? t(
              'The Skill or its affected Specialists changed after preview. Refresh and review the update again.'
            )
          : conflictReason === 'release-mismatch'
            ? t(
                'This release would downgrade the Skill or change an existing release. Installation remains blocked.'
              )
            : conflictReason === 'invalid-name' || conflictReason === 'installation-unverifiable'
              ? t('The existing installation cannot be safely verified. No files were replaced.')
              : t(
                  'Local changes or an existing Skill prevent installation. No files were replaced.'
                )
  const reviewUpdate = async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setPending('preview')
    setFailure(undefined)
    setUpdateError(undefined)
    try {
      const result = await window.api.settings.getSkillMarketplaceDetail({
        id: entry.id,
        snapshotId,
        previewUpdate: true
      })
      if (!active.current) return
      if (result.ok && result.value.updatePreview) setUpdatePreview(result.value.updatePreview)
      else
        setFailure(
          result.ok
            ? {
                ok: false,
                error: 'conflict',
                reason:
                  result.value.installation?.kind === 'conflict'
                    ? result.value.installation.reason
                    : 'installation-unverifiable'
              }
            : result
        )
    } catch {
      if (active.current) setFailure({ ok: false, error: 'installation-failed' })
    } finally {
      inFlight.current = false
      if (active.current) setPending(undefined)
    }
  }
  const manage = async (remove: boolean): Promise<void> => {
    if (!localSkillId || inFlight.current) return
    inFlight.current = true
    setPending(remove ? 'uninstall' : 'toggle')
    setManagementFailure(undefined)
    try {
      if (remove) await deleteSkill(localSkillId)
      else if (localSkill) await setSkillEnabled(localSkillId, !localSkill.enabled)
      if (active.current) {
        setUninstallConfirm(false)
        setUninstallArmed(false)
        if (remove) {
          setRefreshFailed(false)
          onChanged({ kind: 'not-installed' })
        }
      }
    } catch (error) {
      if (active.current) {
        setUninstallConfirm(false)
        setUninstallArmed(false)
        setManagementFailure(
          error instanceof Error ? error.message : t('Could not change this Skill.')
        )
      }
    } finally {
      inFlight.current = false
      if (active.current) setPending(undefined)
    }
  }
  const install = async (updateToken?: string): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setPending('install')
    setFailure(undefined)
    let result: SkillMarketplaceInstallResult
    try {
      result = await window.api.settings.installSkillMarketplace({
        id: entry.id,
        snapshotId,
        expectedVersion: installed?.version ?? null,
        ...(updateToken ? { updateToken } : {})
      })
    } catch {
      result = { ok: false, error: 'installation-failed' }
    }
    inFlight.current = false
    if (!active.current) return
    setPending(undefined)
    setConfirm(false)
    if (result.ok) {
      setUpdatePreview(undefined)
      setUpdateError(undefined)
      setRefreshFailed(result.value.refreshFailed === true)
      onChanged({
        kind: 'installed',
        version: result.value.version,
        canUpdate: false,
        localSkillId: result.value.id,
        ...(updateToken
          ? {
              requiresPreview: true,
              protected: updatePreview ? updatePreview.specialists.length > 0 : installed?.protected
            }
          : {})
      })
    } else if (updateToken)
      setUpdateError(
        t(
          'The update could not be completed. Close this preview and review the current installation again.'
        )
      )
    else setFailure(result)
  }
  return (
    <div
      className={compact ? 'flex min-w-0 flex-col gap-2' : 'space-y-4'}
      aria-busy={Boolean(pending)}
    >
      {refreshFailed && installed ? (
        <ErrorNotice
          tone="amber"
          role="status"
          title={t(
            'Skills were installed, but runtime refresh failed. Restart the app to reload them.'
          )}
          primaryButton={{
            label: t('Retry'),
            onClick: () => void (installed.requiresPreview ? reviewUpdate() : install()),
            disabled: disabled || Boolean(pending)
          }}
        />
      ) : null}
      {installed && !compact ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck className="size-4 text-success-000" aria-hidden="true" />
          {t('Installed version: {{version}}', { version: installed.version })}
        </p>
      ) : null}
      {(conflict && !compact) || failure ? (
        <ErrorNotice
          tone={conflict ? 'amber' : 'red'}
          role={failure ? 'alert' : 'status'}
          title={failure ? t('Skill installation failed') : t('Skill installation blocked')}
          description={conflict ? conflictDescription : undefined}
          errorCode={[failure?.error ?? 'conflict', conflictReason, conflictSkillId]
            .filter(Boolean)
            .join(' / ')}
          diagnosticsLabel={t('Details')}
          primaryButton={
            conflict && onManageLocal
              ? {
                  label: conflictSkillId ? t('View installed Skill') : t('Manage local skills'),
                  onClick: () => onManageLocal(conflictSkillId),
                  disabled: disabled || Boolean(pending)
                }
              : {
                  label:
                    failure?.error === 'network' || failure?.error === 'installation-failed'
                      ? t('Retry')
                      : t('Refresh'),
                  disabled: disabled || Boolean(pending),
                  onClick: () => {
                    if (failure?.error === 'network' || failure?.error === 'installation-failed') {
                      if (installed) setConfirm(true)
                      else void install()
                    } else {
                      setFailure(undefined)
                      onChanged()
                    }
                  }
                }
          }
          secondaryButton={
            conflict && onManageLocal
              ? {
                  label: t('Refresh'),
                  disabled: disabled || Boolean(pending),
                  onClick: () => {
                    setFailure(undefined)
                    onChanged()
                  }
                }
              : undefined
          }
        />
      ) : null}
      {conflict &&
      !compact &&
      conflictSkillId &&
      (conflictReason === 'name-taken' || conflictReason === 'local-content-changed') ? (
        <ResourceDetailActions>
          <Button disabled={disabled || Boolean(pending)} onClick={() => void reviewUpdate()}>
            {pending === 'preview' ? t('Loading…') : t('Review Skill update')}
          </Button>
        </ResourceDetailActions>
      ) : null}
      <SkillMarketplaceUpdateDialog
        preview={updatePreview}
        version={entry.version}
        pending={Boolean(pending)}
        error={updateError}
        onCancel={() => {
          setUpdatePreview(undefined)
          setUpdateError(undefined)
        }}
        onConfirm={() => void install(updatePreview?.token)}
      />
      {managementFailure ? (
        <ErrorNotice
          role="alert"
          tone="amber"
          title={t('Could not change this Skill.')}
          description={managementFailure}
          primaryButton={{ label: t('Retry'), onClick: onChanged }}
        />
      ) : null}
      {compact && conflict ? (
        <span className="text-xs text-status-warning-foreground dark:text-status-warning-dark-foreground">
          {t('Local conflict')}
        </span>
      ) : null}
      {compact || !conflict ? (
        <ResourceDetailActions
          inline={compact}
          leading={
            !compact && localSkill ? (
              <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                {t('Enable')}
                <Switch
                  aria-label={t('Enable')}
                  aria-busy={pending === 'toggle' || undefined}
                  checked={localSkill.enabled}
                  disabled={disabled || Boolean(pending)}
                  onCheckedChange={() => void manage(false)}
                />
              </label>
            ) : null
          }
        >
          {!compact && localSkillId && installed?.canUpdate && !installed.protected ? (
            <Button
              ref={uninstallTrigger}
              variant="outline"
              className="text-destructive"
              aria-disabled={pending === 'toggle' || undefined}
              disabled={disabled || packagePending}
              onClick={() => {
                if (!inFlight.current) setUninstallConfirm(true)
              }}
            >
              {t('Uninstall')}
            </Button>
          ) : null}
          <Button
            ref={trigger}
            size={compact ? 'sm' : 'default'}
            variant={uninstallArmed ? 'destructive' : compact ? 'outline' : 'default'}
            data-installed={Boolean(
              installed && !installed.canUpdate && !conflict && !packagePending && !uninstallArmed
            )}
            className="skill-marketplace-install-action"
            aria-live="polite"
            aria-disabled={pending === 'toggle' || undefined}
            disabled={
              disabled ||
              packagePending ||
              Boolean(installed && !installed.canUpdate && !localSkillId) ||
              (!compact && conflict)
            }
            onBlur={() => setUninstallArmed(false)}
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse' && canUninstallInline) setUninstallArmed(true)
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') setUninstallArmed(false)
            }}
            onFocus={(event) => {
              if (canUninstallInline && event.currentTarget.matches(':focus-visible'))
                setUninstallArmed(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && uninstallArmed) {
                event.preventDefault()
                event.stopPropagation()
                setUninstallArmed(false)
              }
            }}
            onClick={() => {
              if (inFlight.current) return
              if (compact && conflict) onOpenDetail?.()
              else if (installed && !installed.canUpdate) {
                if (installed.protected) {
                  onManageLocal?.(localSkillId)
                  return
                }
                if (uninstallArmed) setUninstallConfirm(true)
                else setUninstallArmed(true)
              } else if (installed?.requiresPreview) void reviewUpdate()
              else if (installed) setConfirm(true)
              else void install()
            }}
          >
            {packagePending ? (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : uninstallArmed ? (
              <Trash2 data-icon="inline-start" className="size-4" aria-hidden="true" />
            ) : installed && !installed.canUpdate && !conflict ? (
              <CircleCheck data-icon="inline-start" className="size-4" aria-hidden="true" />
            ) : !compact ? (
              <Download className="size-4" aria-hidden="true" />
            ) : null}
            {packagePending
              ? pending === 'install'
                ? t('Installing…')
                : pending === 'preview'
                  ? t('Loading…')
                  : t('Uninstalling…')
              : uninstallArmed
                ? t('Uninstall')
                : compact && conflict
                  ? t('View details')
                  : installed
                    ? installed.canUpdate
                      ? t('Update')
                      : t('Installed')
                    : t('Install')}
          </Button>
        </ResourceDetailActions>
      ) : null}
      <ConfirmActionDialog
        open={uninstallConfirm}
        title={t('Uninstall')}
        description={t(
          'Uninstall {{name}}? This removes its installed files. You can install it again from the Marketplace.',
          { name: entry.displayName }
        )}
        cancelLabel={t('Cancel', { ns: 'common' })}
        confirmLabel={t('Uninstall')}
        loading={Boolean(pending)}
        destructive
        onCancel={() => setUninstallConfirm(false)}
        onConfirm={() => void manage(true)}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (uninstallTrigger.current?.isConnected) uninstallTrigger.current.focus()
          else trigger.current?.focus()
        }}
      />
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
        loading={Boolean(pending)}
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
  onNavigate,
  onImportFromGitHub,
  localRevisionKey = 0,
  onInstallationChanged,
  addAction,
  onManageLocal
}: {
  view: SkillMarketplaceView
  onNavigate: (view: SkillMarketplaceView) => void
  onManageLocal?: (id?: string) => void
  localRevisionKey?: number
  onInstallationChanged?: () => void
  addAction?: React.ReactNode
  onImportFromGitHub?: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const installedCount = useSettingsStore(
    (state) => state.skills.filter((skill) => skill.available !== false).length
  )
  // Retained catalogs also reconcile imports, edits and deletions made in other resource views.
  const skillCatalogRevision = useSettingsStore((state) =>
    JSON.stringify(state.skills.map(({ id, updatedAt, available }) => [id, updatedAt, available]))
  )
  const heading = useRef<HTMLHeadingElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const listScrollTop = useRef(0)
  const appendedFrom = useRef<number | undefined>(undefined)
  const restoreFocus = useRef(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [sort, setSort] = useState('name')
  const [statusFilter, setStatusFilter] = useState('all')
  const isBatch = view.kind === 'marketplace-batch'
  const [batchMode, setBatchMode] = useState<MarketplaceBatchMode>('install')
  const [batchBusy, setBatchBusy] = useState(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [visibleCount, setVisibleCount] = useState(SKILL_MARKETPLACE_PAGE_SIZE)
  const [browseSnapshot, setBrowseSnapshot] = useState<
    | {
        query: string
        category: string
        sort: string
        statusFilter: string
        visibleCount: number
      }
    | undefined
  >(undefined)
  // Adjust on route transitions before committing DOM so scroll restoration sees the saved cards.
  if (isBatch && !browseSnapshot) {
    setBrowseSnapshot({ query, category, sort, statusFilter, visibleCount })
  } else if (view.kind === 'marketplace' && browseSnapshot) {
    // Inspecting a detail is not an exit: keep the batch selection and mode for Back.
    setQuery(browseSnapshot.query)
    setCategory(browseSnapshot.category)
    setSort(browseSnapshot.sort)
    setStatusFilter(browseSnapshot.statusFilter)
    setVisibleCount(browseSnapshot.visibleCount)
    setBrowseSnapshot(undefined)
    setSelectedIds(new Set())
    setBatchMode('install')
  }
  const [refresh, setRefresh] = useState(0)
  const [localRefresh, setLocalRefresh] = useState(0)
  const [localSyncError, setLocalSyncError] = useState(false)
  const [localSyncPending, setLocalSyncPending] = useState(false)
  const localReconciled = useRef(0)
  const externalReconciled = useRef(localRevisionKey)
  const skillsReconciled = useRef(skillCatalogRevision)
  const localRevision = useRef(0)
  const readCatalog = useCallback(async (request?: SkillMarketplaceCatalogRequest) => {
    let revision = localRevision.current
    let result = await window.api.settings.listSkillMarketplace(request)
    // Re-project against the returned snapshot: its offered version may have changed too.
    while (result.ok && revision !== localRevision.current) {
      revision = localRevision.current
      const local = await window.api.settings.listSkillMarketplace({
        snapshotId: result.value.snapshotId
      })
      if (!local.ok) return local
      result = {
        ok: true,
        value: { ...result.value, installations: local.value.installations }
      }
    }
    return result
  }, [])
  const [detailRefresh, setDetailRefresh] = useState(0)
  const [catalogResponse, setCatalog] = useState<{
    key: number
    result: SkillMarketplaceResult<SkillMarketplaceCatalog>
  }>()
  const refreshing = catalogResponse?.key !== refresh
  // Network failures may return a stale verified catalog; integrity errors replace it.
  const catalog = !refreshing || catalogResponse?.result.ok ? catalogResponse?.result : undefined
  const [detail, setDetail] = useState<{
    key: string
    result: SkillMarketplaceResult<SkillMarketplaceDetail>
  }>()
  const detailId = view.kind === 'marketplace-detail' ? view.id : undefined
  const snapshotId = view.kind === 'marketplace-detail' ? view.snapshotId : undefined
  const detailKey = `${snapshotId}/${detailId}/${detailRefresh}`
  useEffect(() => {
    let active = true
    const load = async (): Promise<void> => {
      try {
        let result = await readCatalog(refresh ? { forceRefresh: true } : undefined)
        if (!active) return
        const revalidate = refresh === 0 && result.ok && result.value.revalidate
        setCatalog({ key: revalidate ? refresh - 1 : refresh, result })
        if (revalidate) {
          result = await readCatalog({ forceRefresh: true })
          if (active) setCatalog({ key: refresh, result })
        }
      } catch {
        if (active) setCatalog({ key: refresh, result: { ok: false, error: 'network' } })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [refresh, readCatalog])
  const catalogSnapshotId = catalog?.ok ? catalog.value.snapshotId : undefined
  useEffect(() => {
    if (
      !catalogSnapshotId ||
      (localRefresh === localReconciled.current &&
        localRevisionKey === externalReconciled.current &&
        skillCatalogRevision === skillsReconciled.current)
    )
      return
    let active = true
    setLocalSyncPending(true)
    setLocalSyncError(false)
    void readCatalog({ snapshotId: catalogSnapshotId })
      .then(
        (result) => {
          if (!active) return
          if (result.ok) {
            // A slower remote read must not undo the authoritative local reconciliation.
            ++localRevision.current
            localReconciled.current = localRefresh
            externalReconciled.current = localRevisionKey
            skillsReconciled.current = skillCatalogRevision
            setCatalog((current) =>
              current?.result.ok && current.result.value.snapshotId === catalogSnapshotId
                ? {
                    ...current,
                    result: {
                      ok: true,
                      value: { ...current.result.value, installations: result.value.installations }
                    }
                  }
                : current
            )
            setDetail((current) =>
              current?.result.ok && current.key.startsWith(`${catalogSnapshotId}/`)
                ? {
                    ...current,
                    result: {
                      ok: true,
                      value: {
                        ...current.result.value,
                        installation: result.value.installations?.[
                          current.result.value.entry.id
                        ] ?? { kind: 'not-installed' }
                      }
                    }
                  }
                : current
            )
          } else setLocalSyncError(true)
        },
        () => {
          if (active) setLocalSyncError(true)
        }
      )
      .finally(() => {
        if (active) setLocalSyncPending(false)
      })
    return () => {
      active = false
    }
  }, [catalogSnapshotId, localRefresh, localRevisionKey, skillCatalogRevision, readCatalog])
  useEffect(() => {
    if (!detailId || !snapshotId) return
    let active = true
    const load = async (): Promise<void> => {
      try {
        let revision = localRevision.current
        let result = await window.api.settings.getSkillMarketplaceDetail({
          id: detailId,
          snapshotId
        })
        while (active && result.ok && revision !== localRevision.current) {
          revision = localRevision.current
          const local = await readCatalog({ snapshotId })
          result = local.ok
            ? {
                ok: true,
                value: {
                  ...result.value,
                  installation: local.value.installations?.[detailId] ?? { kind: 'not-installed' }
                }
              }
            : local
        }
        if (active) setDetail({ key: detailKey, result })
      } catch {
        if (active) setDetail({ key: detailKey, result: { ok: false, error: 'network' } })
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [detailId, snapshotId, detailKey, readCatalog])
  const detailResult = detail?.key === detailKey ? detail.result : undefined
  const result = view.kind === 'marketplace-detail' ? detailResult : catalog
  const items = useMemo(() => (catalog?.ok ? catalog.value.entries : []), [catalog])
  const selected = detailResult?.ok ? detailResult.value.entry : undefined
  const labels: Record<string, string> = {
    'Academic Writing': t('Academic writing'),
    'Data Analysis': t('Data analysis'),
    'Evidence Insight': t('Evidence insight'),
    'Protocol Design': t('Protocol design'),
    Other: t('Other')
  }
  const installations = catalog?.ok ? catalog.value.installations : undefined
  const modeCounts = useMemo(() => {
    let install = 0
    let update = 0
    if (installations)
      for (const item of items) {
        if (!skillMarketplaceStableVersionPattern.test(item.version)) continue
        const state = installations[item.id]
        if (!state || state.kind === 'not-installed') install++
        else if (state.kind === 'installed' && state.canUpdate && !state.requiresPreview) update++
      }
    return { install, update }
  }, [items, installations])
  const canSelect = useCallback(
    (item: SkillMarketplaceEntry): boolean => {
      if (!installations || !skillMarketplaceStableVersionPattern.test(item.version)) return false
      const state = installations[item.id]
      return batchMode === 'update'
        ? state?.kind === 'installed' && state.canUpdate && !state.requiresPreview
        : !state || state.kind === 'not-installed'
    },
    [installations, batchMode]
  )
  const modeItems = useMemo(
    () => (isBatch ? items.filter(canSelect) : items),
    [items, isBatch, canSelect]
  )
  const filteredItems = useMemo(
    () => filterSkillMarketplace(modeItems, query, category, sort, i18n.language),
    [modeItems, query, category, sort, i18n.language]
  )
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of modeItems) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
    return counts
  }, [modeItems])
  const matches = useMemo(
    () =>
      filteredItems.filter((item) => {
        const state = installations?.[item.id]
        return (
          isBatch ||
          statusFilter === 'all' ||
          (state?.kind === 'installed' && (statusFilter === 'installed' || state.canUpdate))
        )
      }),
    [filteredItems, installations, statusFilter, isBatch]
  )
  const selectedItems = items.filter((item) => selectedIds.has(item.id) && canSelect(item))
  const selectMode = (mode: MarketplaceBatchMode): void => {
    setBatchMode(mode)
    setSelectedIds(new Set())
    setVisibleCount(SKILL_MARKETPLACE_PAGE_SIZE)
  }
  useLayoutEffect(() => {
    const scroll = surface.current?.closest<HTMLElement>('[data-slot="settings-content-scroll"]')
    if (!scroll) return
    scroll.scrollTop = view.kind === 'marketplace' ? listScrollTop.current : 0
    if (view.kind !== 'marketplace') return
    const rememberScroll = (): void => {
      listScrollTop.current = scroll.scrollTop
    }
    scroll.addEventListener('scroll', rememberScroll, { passive: true })
    return () => scroll.removeEventListener('scroll', rememberScroll)
  }, [view.kind])
  useLayoutEffect(() => {
    if (appendedFrom.current === undefined) return
    surface.current
      ?.querySelectorAll<HTMLElement>('[data-slot="skill-marketplace-card"]')
      [appendedFrom.current]?.querySelector<HTMLElement>(
        isBatch ? 'input[type="checkbox"]' : 'button'
      )
      ?.focus({ preventScroll: true })
    appendedFrom.current = undefined
  }, [visibleCount, isBatch])
  const changed = (installedUpdate?: {
    id: string
    installation: SkillMarketplaceInstallation
  }): void => {
    // The installer has verified and committed these files; show success without a page flash.
    if (installedUpdate) {
      onInstallationChanged?.()
      ++localRevision.current
      const focusedCard = document.activeElement?.closest<HTMLElement>(
        '[data-slot="skill-marketplace-card"]'
      )
      const state = installedUpdate.installation
      const leavesFilter =
        statusFilter !== 'all' &&
        (state.kind !== 'installed' || (statusFilter === 'updates' && !state.canUpdate))
      restoreFocus.current = Boolean(
        leavesFilter &&
        surface.current?.contains(focusedCard ?? null) &&
        focusedCard?.dataset.skillId === installedUpdate.id
      )
      setCatalog((current) =>
        current?.result.ok
          ? {
              ...current,
              result: {
                ok: true,
                value: {
                  ...current.result.value,
                  installations: {
                    ...current.result.value.installations,
                    [installedUpdate.id]: installedUpdate.installation
                  }
                }
              }
            }
          : current
      )
      setDetail((current) =>
        current?.result.ok && current.result.value.entry.id === installedUpdate.id
          ? {
              ...current,
              result: {
                ok: true,
                value: { ...current.result.value, installation: installedUpdate.installation }
              }
            }
          : current
      )
      return
    }
    restoreFocus.current = true
    setRefresh((value) => value + 1)
    setDetailRefresh((value) => value + 1)
  }
  useEffect(() => {
    if (result?.ok && restoreFocus.current && heading.current) {
      restoreFocus.current = false
      heading.current.focus()
    }
  }, [result])
  const resetFilter = (
    set: (value: string) => void,
    value: string,
    clearSelection = true
  ): void => {
    set(value)
    if (isBatch && clearSelection) setSelectedIds(new Set())
    setVisibleCount(SKILL_MARKETPLACE_PAGE_SIZE)
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
  const renderCatalogToolbar = (toolbarActions: React.ReactNode): React.JSX.Element => (
    <ResourceCatalogToolbar
      onResetFilters={() => {
        resetFilter(setCategory, 'all')
        resetFilter(setStatusFilter, 'all')
        resetFilter(setSort, 'name', false)
      }}
      activeFilterCount={
        Number(category !== 'all') + Number(statusFilter !== 'all') + Number(sort !== 'name')
      }
      resetFiltersDisabled={isBatch && batchBusy}
      data-batch={isBatch || undefined}
      trailing={
        <>
          <p role="status" className="ml-auto text-xs tabular-nums text-muted-foreground">
            {refreshing ? (
              <LoaderCircle
                className="mr-2 inline size-3 animate-spin motion-reduce:animate-none"
                aria-label={t('Loading…')}
              />
            ) : null}
            {t('Results: {{results}} / {{total}}', {
              results: matches.length,
              total: modeItems.length
            })}
          </p>
          {toolbarActions}
        </>
      }
      search={
        <SettingsSearchInput
          aria-label={t('Search skills')}
          placeholder={t('Search skills…')}
          value={query}
          disabled={isBatch && batchBusy}
          onChange={(event) => resetFilter(setQuery, event.target.value)}
        />
      }
    >
      <ResourceCatalogFilter label={t('Category')}>
        <Select
          value={category}
          disabled={isBatch && batchBusy}
          onValueChange={(value) => resetFilter(setCategory, value)}
        >
          <SelectTrigger aria-label={t('Category')} className="w-44">
            <span className="truncate">{category === 'all' ? t('All') : labels[category]}</span>
          </SelectTrigger>
          <SelectContent>
            {['all', ...skillMarketplaceCategories].map((value) => (
              <SelectItem key={value} value={value}>
                {value === 'all' ? t('All') : labels[value]}
                <span className="ml-2 tabular-nums text-muted-foreground">
                  {value === 'all' ? modeItems.length : (categoryCounts.get(value) ?? 0)}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ResourceCatalogFilter>
      {installations && !isBatch ? (
        <ResourceCatalogFilter label={t('Installation status')}>
          <Select
            value={statusFilter}
            onValueChange={(value) => resetFilter(setStatusFilter, value)}
          >
            <SelectTrigger aria-label={t('Installation status')} className="w-40">
              <span className="truncate">
                {statusFilter === 'all'
                  ? t('All')
                  : statusFilter === 'installed'
                    ? t('Installed')
                    : t('Update available')}
              </span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('All')}</SelectItem>
              <SelectItem value="installed">{t('Installed')}</SelectItem>
              <SelectItem value="updates">{t('Update available')}</SelectItem>
            </SelectContent>
          </Select>
        </ResourceCatalogFilter>
      ) : null}
      <ResourceCatalogFilter label={t('Sort by')}>
        <Select
          value={sort}
          disabled={isBatch && batchBusy}
          onValueChange={(value) => resetFilter(setSort, value, false)}
        >
          <SelectTrigger aria-label={t('Sort by')} className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">{t('Name A–Z')}</SelectItem>
            <SelectItem value="manifest">{t('Catalog order')}</SelectItem>
          </SelectContent>
        </Select>
      </ResourceCatalogFilter>
    </ResourceCatalogToolbar>
  )
  return (
    <div
      ref={surface}
      className="space-y-4 p-5"
      data-slot="skill-marketplace"
      data-batch={isBatch || undefined}
    >
      <SkillMarketplaceBatchControls
        refreshing={refreshing}
        expanded={isBatch}
        onOpen={() => onNavigate({ kind: 'marketplace-batch' })}
        onExit={() => onNavigate({ kind: 'marketplace' })}
        onRefresh={
          view.kind !== 'marketplace-detail' ? () => setRefresh((value) => value + 1) : undefined
        }
        request={
          catalog?.ok
            ? {
                snapshotId: catalog.value.snapshotId,
                items: selectedItems.map(({ id, version }) => {
                  const state = installations?.[id]
                  return {
                    id,
                    version,
                    expectedVersion:
                      batchMode === 'update' && state?.kind === 'installed' ? state.version : null
                  }
                })
              }
            : undefined
        }
        mode={batchMode}
        modeCounts={modeCounts}
        filteredCount={matches.length}
        filteredSelectedCount={matches.filter(({ id }) => selectedIds.has(id)).length}
        showSelection={isBatch && Boolean(catalog?.ok && installations)}
        disabled={localSyncPending || localSyncError}
        onModeChange={selectMode}
        onSelectFiltered={() =>
          setSelectedIds(new Set(matches.filter(canSelect).map(({ id }) => id)))
        }
        onClearSelection={() => setSelectedIds(new Set())}
        onBusyChange={setBatchBusy}
        onChanged={() => setLocalRefresh((value) => value + 1)}
      >
        {(selectionControls, toolbarActions) => (
          <>
            {view.kind !== 'marketplace-detail' ? (
              <ResourceCatalogHeader
                icon={ScrollText}
                title={t('Skills')}
                actions={
                  addAction ??
                  (onImportFromGitHub ? (
                    <Button variant="outline" size="sm" onClick={onImportFromGitHub}>
                      {t('Import from GitHub')}
                    </Button>
                  ) : undefined)
                }
                selectionBar={selectionControls}
                toolbar={renderCatalogToolbar(toolbarActions)}
              >
                <ResourceCenterModeTabs
                  count={installedCount}
                  value="marketplace"
                  onChange={(value) => {
                    if (value === 'installed') onManageLocal?.()
                  }}
                />
              </ResourceCatalogHeader>
            ) : null}
            {view.kind !== 'marketplace-detail' ? (
              <h2 ref={heading} tabIndex={-1} className="sr-only">
                {t('Marketplace')}
              </h2>
            ) : null}
            {view.kind !== 'marketplace-detail' &&
            !refreshing &&
            catalog?.ok &&
            catalog.value.revalidate ? (
              <ErrorNotice
                role="status"
                tone="amber"
                title={t('Could not refresh Marketplace. Showing the last available data.')}
              />
            ) : null}
            {localSyncError ? (
              <ErrorNotice
                role="alert"
                tone="amber"
                title={t('Unable to load Marketplace')}
                primaryButton={{
                  label: t('Retry'),
                  onClick: () => setLocalRefresh((value) => value + 1)
                }}
              />
            ) : null}
            {!result ? (
              <div
                role="status"
                aria-busy="true"
                data-slot="skill-marketplace-loading"
                className="space-y-4"
              >
                <span className="sr-only">{t('Loading…')}</span>
                <div
                  aria-hidden="true"
                  className="h-9 rounded-lg bg-muted animate-pulse motion-reduce:animate-none"
                />
                <div aria-hidden="true" className="skill-marketplace-grid grid gap-3">
                  {Array.from({ length: 6 }, (_, index) => (
                    <div
                      key={index}
                      className="space-y-4 rounded-lg border border-border p-4 animate-pulse motion-reduce:animate-none"
                    >
                      <div className="h-5 w-3/5 rounded bg-muted" />
                      <div className="space-y-2">
                        <div className="h-4 rounded bg-muted" />
                        <div className="h-4 w-4/5 rounded bg-muted" />
                      </div>
                      <div className="h-6 w-2/5 rounded bg-muted" />
                    </div>
                  ))}
                </div>
              </div>
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
                  label:
                    result.error === 'snapshot-unavailable' ? t('Back to Marketplace') : t('Retry'),
                  onClick: () => {
                    if (result.error === 'snapshot-unavailable') {
                      onNavigate({ kind: 'marketplace' })
                      setRefresh((value) => value + 1)
                    } else if (view.kind !== 'marketplace-detail') setRefresh((value) => value + 1)
                    else setDetailRefresh((value) => value + 1)
                  }
                }}
              />
            ) : view.kind === 'marketplace-detail' ? (
              selected ? (
                <div className="space-y-6" data-slot="skill-marketplace-detail">
                  <ResourceDetailHeader
                    headingRef={heading}
                    identity={
                      <ResourceMarketplaceIdentity
                        id={selected.id}
                        displayName={selected.displayName}
                      />
                    }
                    name={selected.displayName}
                    description={selected.summary}
                  >
                    <span data-slot="skill-marketplace-detail-category">
                      {labels[selected.category]}
                    </span>
                    <span>
                      {t('Publisher: {{publisher}}', { publisher: selected.publisher.name })}
                    </span>
                    {selected.authors?.length ? (
                      <span>
                        {t('Author: {{name}}', {
                          name: selected.authors.map((a) => a.name).join(', ')
                        })}
                      </span>
                    ) : (
                      <span>
                        {t('Upstream source')}: {skillMarketplaceSourceOwner(selected)}
                      </span>
                    )}
                    <span>
                      {t('Version')}: {selected.version}
                    </span>
                    <span>
                      {t('License')}: {selected.license}
                    </span>
                    {selected.evaluation ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              tabIndex={0}
                              data-slot="skill-marketplace-score"
                              aria-label={t(
                                'Upstream self-assessment {{score}}/{{maxScore}}',
                                selected.evaluation
                              )}
                              className="rounded font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {selected.evaluation.score}
                              <span className="font-normal text-muted-foreground">
                                /{selected.evaluation.maxScore}
                              </span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="skill-marketplace-tooltip max-w-64">
                            {t(
                              'Upstream self-assessment is not an independent quality or safety endorsement.'
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : null}
                  </ResourceDetailHeader>
                  {detailResult?.ok && detailResult.value.installation && snapshotId ? (
                    <MarketplaceInstallControls
                      key={detailKey}
                      entry={selected}
                      snapshotId={snapshotId}
                      installation={detailResult.value.installation}
                      disabled={batchBusy || localSyncPending || localSyncError}
                      onChanged={(installation) =>
                        changed(installation ? { id: selected.id, installation } : undefined)
                      }
                      onManageLocal={onManageLocal}
                    />
                  ) : null}
                  <p role="note" className="text-xs leading-5 text-muted-foreground">
                    {t(
                      'Browse and install verified Marketplace releases. Updates require confirmation.'
                    )}
                  </p>
                  <details
                    className="skill-marketplace-disclosure border-t border-border pt-4"
                    data-slot="skill-marketplace-sources"
                  >
                    <summary>
                      <span>{t('Sources and verification')}</span>
                      <ChevronDown className="size-4" aria-hidden="true" />
                    </summary>
                    <dl className="skill-marketplace-metadata mt-4 grid gap-x-5 gap-y-3 text-sm">
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
                        <MetadataLink href={selected.publisher.url}>
                          {selected.publisher.name}
                        </MetadataLink>
                      </dd>
                      <dt>{t('Upstream source')}</dt>
                      <dd>
                        <MetadataLink
                          href={`${selected.source.repository}/tree/${selected.source.commit}/${selected.source.path.split('/').map(encodeURIComponent).join('/')}`}
                        >
                          {selected.source.repository.replace('https://github.com/', '')}
                        </MetadataLink>
                        <p className="break-all text-xs text-muted-foreground">
                          {selected.source.path}
                        </p>
                        <p className="break-all text-xs text-muted-foreground">
                          {selected.source.commit}
                        </p>
                      </dd>
                      <dt>{t('Marketplace')}</dt>
                      <dd>
                        <MetadataLink href={skillMarketplaceRepository}>
                          {t('Marketplace')}
                        </MetadataLink>
                      </dd>
                      <dt>{t('License evidence')}</dt>
                      <dd className="space-y-2">
                        {detailResult?.ok &&
                          detailResult.value.licenseEvidence.map((evidence) => (
                            <div key={evidence.url}>
                              <MetadataLink href={evidence.url}>
                                {evidence.url.split('/').at(-1)}
                              </MetadataLink>
                            </div>
                          ))}
                      </dd>
                    </dl>
                  </details>
                  {selected.evaluation ? (
                    <details
                      className="skill-marketplace-disclosure space-y-2 border-t border-border pt-4 text-sm"
                      data-slot="skill-marketplace-assessment"
                    >
                      <summary>
                        <span>{t('Assessment report')}</span>
                        <ChevronDown className="size-4" aria-hidden="true" />
                      </summary>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'Upstream self-assessment is not an independent quality or safety endorsement.'
                        )}
                      </p>
                      <dl className="skill-marketplace-metadata mt-4 grid gap-x-5 gap-y-3 text-sm">
                        {selected.evaluation.staticScore ? (
                          <>
                            <dt>{t('Static score')}</dt>
                            <dd className="tabular-nums">
                              {selected.evaluation.staticScore.score}/
                              {selected.evaluation.staticScore.maxScore}
                            </dd>
                          </>
                        ) : null}
                        {selected.evaluation.dynamicScore ? (
                          <>
                            <dt>{t('Dynamic score')}</dt>
                            <dd className="tabular-nums">
                              {selected.evaluation.dynamicScore.score}/
                              {selected.evaluation.dynamicScore.maxScore}
                            </dd>
                          </>
                        ) : null}
                        {selected.evaluation.evaluatedOn ? (
                          <>
                            <dt>{t('Evaluated on')}</dt>
                            <dd>{selected.evaluation.evaluatedOn}</dd>
                          </>
                        ) : null}
                        {selected.evaluation.evaluatorVersion ? (
                          <>
                            <dt>{t('Evaluator')}</dt>
                            <dd>{selected.evaluation.evaluatorVersion}</dd>
                          </>
                        ) : null}
                        {selected.evaluation.skillVersion ? (
                          <>
                            <dt>{t('Assessed Skill version')}</dt>
                            <dd>{selected.evaluation.skillVersion}</dd>
                          </>
                        ) : null}
                        <dt>{t('Assessment report')}</dt>
                        <dd>
                          <MetadataLink href={selected.evaluation.reportUrl}>
                            {t('Assessment report')}
                          </MetadataLink>
                        </dd>
                      </dl>
                    </details>
                  ) : null}
                </div>
              ) : (
                <p role="status">{t('No skills match your search.')}</p>
              )
            ) : (
              <>
                <TooltipProvider skipDelayDuration={300}>
                  <div className="resource-marketplace-grid grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
                    {matches.slice(0, visibleCount).map((item) => {
                      const installation = installations?.[item.id]
                      return (
                        <article
                          key={item.id}
                          data-slot="skill-marketplace-card"
                          data-skill-id={item.id}
                          data-selected={(isBatch && selectedIds.has(item.id)) || undefined}
                          className="resource-marketplace-card relative flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-sm motion-reduce:transition-none"
                        >
                          <ResourceMarketplaceCardContent
                            id={item.id}
                            name={item.displayName}
                            publisher={skillMarketplaceAttribution(item)}
                            summary={item.summary}
                            onOpen={() => openDetail(item)}
                            primaryAction={
                              !isBatch &&
                              catalog?.ok &&
                              installations &&
                              skillMarketplaceStableVersionPattern.test(item.version) &&
                              installation?.kind !== 'conflict' ? (
                                <MarketplaceInstallControls
                                  compact
                                  entry={item}
                                  snapshotId={catalog.value.snapshotId}
                                  installation={installation ?? { kind: 'not-installed' }}
                                  disabled={batchBusy || localSyncPending || localSyncError}
                                  onChanged={(next) =>
                                    changed(next ? { id: item.id, installation: next } : undefined)
                                  }
                                  onOpenDetail={() => openDetail(item)}
                                  onManageLocal={onManageLocal}
                                />
                              ) : null
                            }
                            status={
                              !skillMarketplaceStableVersionPattern.test(item.version)
                                ? t('Unavailable')
                                : installation?.kind === 'conflict'
                                  ? t('Local conflict')
                                  : installation?.kind === 'installed' &&
                                      (isBatch || installation.canUpdate)
                                    ? installation.canUpdate
                                      ? t('Update available')
                                      : t('Installed')
                                    : undefined
                            }
                            selection={
                              isBatch ? (
                                <input
                                  type="checkbox"
                                  className="absolute right-4 top-4 size-4 accent-primary"
                                  aria-label={t('Select {{name}}', { name: item.displayName })}
                                  checked={selectedIds.has(item.id) && canSelect(item)}
                                  disabled={batchBusy || !canSelect(item)}
                                  onChange={(event) =>
                                    setSelectedIds((current) => {
                                      const next = new Set(current)
                                      if (event.target.checked) next.add(item.id)
                                      else next.delete(item.id)
                                      return next
                                    })
                                  }
                                />
                              ) : null
                            }
                          />
                        </article>
                      )
                    })}
                  </div>
                </TooltipProvider>
                {matches.length === 0 ? (
                  <div className="space-y-3 py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      {t('No skills match your search.')}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setQuery('')
                        setCategory('all')
                        setStatusFilter('all')
                        setSelectedIds(new Set())
                        setVisibleCount(SKILL_MARKETPLACE_PAGE_SIZE)
                      }}
                    >
                      {t('Clear filters')}
                    </Button>
                  </div>
                ) : null}
                {visibleCount < matches.length ? (
                  <div
                    data-slot="skill-marketplace-load-more"
                    className="flex items-center gap-4 py-2"
                  >
                    <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
                    <Button
                      variant="secondary"
                      className="h-11 gap-2 rounded-full px-5 transition-none"
                      onClick={() => {
                        appendedFrom.current = visibleCount
                        setVisibleCount((count) => count + SKILL_MARKETPLACE_PAGE_SIZE)
                      }}
                    >
                      {t('Load more')}
                      <ChevronDown aria-hidden="true" className="size-4" />
                    </Button>
                    <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-border" />
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
      </SkillMarketplaceBatchControls>
    </div>
  )
}
