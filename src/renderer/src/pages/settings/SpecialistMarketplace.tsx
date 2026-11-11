import { ResourceDetailActions, ResourceDetailHeader } from '../marketplace/ResourceDetailLayout'
import { Users } from 'lucide-react'
import type { SpecialistMarketplaceView } from '../../lib/settings-navigation'
import { useRetainedDialogValue } from '@/components/ui/use-retained-dialog-value'
import { inlineNoticeClassName } from '@/components/ui/notice-chrome'
import { InlineNotice } from '@/components/ui/inline-notice'
import { ErrorNotice } from '@/components/error-notice'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as AlertDialog from '@/components/ui/alert-dialog'
import * as Dialog from '@/components/ui/dialog'
import {
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  GitBranch,
  Loader2,
  Plus,
  ScrollText,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { useDateTimeFormat, useRelativeTimeFormat } from '@/hooks/useDateTimeFormat'
import {
  specialistDiagnosticCopy,
  specialistInstallFailureCopy,
  type SpecialistInstallFailureCode
} from '@/lib/specialist-diagnostics'
import { useMarketplaceStore } from '@/stores/marketplace-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type {
  MarketplaceDownloadProgress,
  MarketplaceInstallPreview,
  MarketplaceSourceCandidate,
  MarketplaceSourceView,
  MarketplaceSpecialistListing,
  MarketplaceSpecialistRelease
} from '../../../../shared/specialist-marketplace'
import {
  dialogBodyClassName,
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogDescriptionClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import { SettingsSearchInput } from './SettingsSearchInput'
import { SettingsIconAction } from './SettingsLayout'
import {
  ResourceCatalogHeader,
  ResourceCatalogFilter,
  ResourceCatalogToolbar,
  ResourceCatalogActions,
  ResourceCenterModeTabs
} from '../marketplace/ResourceCenterModeTabs'
import {
  ResourceMarketplaceIdentity,
  ResourceMarketplaceCardContent
} from '../marketplace/ResourceMarketplaceIdentity'
import { ConnectorsNavIcon } from './connector-icons'
import { SpecialistSkillConflictChoices } from './SpecialistSkillConflictChoices'
import {
  skillConflictResolutionList,
  specialistSkillConflicts,
  type SkillConflictResolutionMap
} from './specialist-skill-conflicts'

export type { SpecialistMarketplaceView } from '../../lib/settings-navigation'

const SpecialistIdentity = ResourceMarketplaceIdentity

type Props = {
  onUninstall?: (id: string) => void
  uninstallBusy?: boolean
  uninstallError?: string
  addAction?: React.ReactNode
  view: SpecialistMarketplaceView
  onNavigate: (
    view: SpecialistMarketplaceView | { kind: 'list' } | { kind: 'edit'; id: string }
  ) => void
}

const formatBytes = (value: number): string => {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

type MarketplacePresentationStatus =
  'available' | 'installed' | 'update-available' | 'setup-incomplete'

// Browse-view filter chips. Deliberately limited to fields the signed registry schema already
// carries: trust and derived install state. A category chip row would need a new signed field,
// which .strict() protocol schemas make a one-way breaking change for older app versions.
type MarketplaceFilter = 'all' | 'official' | 'community' | 'updates'

const marketplaceListingKey = (item: MarketplaceSpecialistListing): string =>
  `${item.sourceId}:${item.id}`

const MarketplaceError = ({
  message,
  retry,
  action
}: {
  message: string
  retry?: () => void
  action?: { label: string; onClick: () => void }
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <ErrorNotice
      role="alert"
      description={message}
      primaryButton={retry ? { label: t('Retry'), onClick: retry } : undefined}
      secondaryButton={action}
    />
  )
}

const MarketplaceLoading = ({ label }: { label: string }): React.JSX.Element => (
  <div
    role="status"
    aria-live="polite"
    className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"
  >
    <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
    <span>{label}</span>
  </div>
)

const SpecialistMarketplace = ({
  view,
  onNavigate,
  addAction,
  onUninstall,
  uninstallBusy,
  uninstallError
}: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const formatRelative = useRelativeTimeFormat()
  // The snapshot lives in the store so it survives leaving this view: re-entering the Marketplace
  // renders the last data immediately and refreshes in the background (the status line below makes
  // that refresh visible), instead of returning to a full-screen loader for data already in hand.
  const snapshot = useMarketplaceStore((state) => state.snapshot)
  const isRefreshing = useMarketplaceStore((state) => state.isRefreshing)
  const lastRefreshFailed = useMarketplaceStore((state) => state.lastRefreshFailed)
  const integrityFailed = useMarketplaceStore((state) => state.integrityFailed)
  const refreshMarketplace = useMarketplaceStore((state) => state.refresh)
  // No snapshot and no failure verdict yet is a genuine first load, true from the very first render
  // before any effect has fired. Once a snapshot exists the content renders immediately whatever
  // the refresh state, and a failed first load flips this to false so the error renders instead.
  const loading = snapshot === undefined && !lastRefreshFailed
  // Remote Web exposes Marketplace browsing (list + release detail) but not the write actions yet;
  // keep those controls disabled instead of failing at call time (#3328).
  const canManageSources =
    typeof window.api.specialist?.inspectGitHubMarketplaceSource === 'function'
  const canInstallSpecialist =
    typeof window.api.specialist?.prepareMarketplaceInstall === 'function'
  const [uninstallArmedKey, setUninstallArmedKey] = useState<string>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<MarketplaceFilter>('all')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [sourceFormOpen, setSourceFormOpen] = useState(false)
  const sourceInput = useRef<HTMLInputElement>(null)
  const sourceMenuTrigger = useRef<HTMLButtonElement>(null)
  const addSourceTrigger = useRef<HTMLButtonElement>(null)
  const restoreAddSourceFocus = useRef(false)
  const [sourceCandidate, setSourceCandidate] = useState<MarketplaceSourceCandidate>()
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourceError, setSourceError] = useState<string>()
  const [sourcePendingRemoval, setSourcePendingRemoval] = useState<MarketplaceSourceView>()
  const [sourceRemovalBusy, setSourceRemovalBusy] = useState(false)
  const [release, setRelease] = useState<MarketplaceSpecialistRelease>()
  const [releaseLoading, setReleaseLoading] = useState(view.kind === 'marketplace-release')
  const [releaseError, setReleaseError] = useState<string>()
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<Set<string>>(new Set())
  const [skillsExpanded, setSkillsExpanded] = useState(false)
  const [connectorsExpanded, setConnectorsExpanded] = useState(false)
  const [installBusy, setInstallBusy] = useState(false)
  const installInFlight = useRef(false)
  const startedCardInstall = useRef<string | undefined>(undefined)
  const [installPreview, setInstallPreview] = useState<MarketplaceInstallPreview>()
  const [installError, setInstallError] = useState<string>()
  const [installErrorCode, setInstallErrorCode] = useState<SpecialistInstallFailureCode>()
  const [installRecoveryPending, setInstallRecoveryPending] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<MarketplaceDownloadProgress>()
  const [skillConflictResolutions, setSkillConflictResolutions] =
    useState<SkillConflictResolutionMap>({})
  const sourceCandidateTokenRef = useRef<string | undefined>(undefined)
  const installCandidateTokenRef = useRef<string | undefined>(undefined)
  const installedSpecialists = useSpecialistStore((state) => state.items)
  const dialogRemovalSource = useRetainedDialogValue(sourcePendingRemoval)
  const sourceRemovalAffectedSpecialists = dialogRemovalSource
    ? installedSpecialists.flatMap((item) =>
        item.kind === 'custom' &&
        item.origin === 'marketplace' &&
        item.marketplaceProvenance?.sourceId === dialogRemovalSource.id
          ? [item]
          : []
      )
    : []
  const viewKey =
    view.kind === 'marketplace-release'
      ? `${view.kind}:${view.sourceId}:${view.id}:${view.version}`
      : view.kind
  const viewKeyRef = useRef<string | undefined>(viewKey)

  useEffect(() => {
    viewKeyRef.current = viewKey
    startedCardInstall.current = undefined
    return () => {
      viewKeyRef.current = undefined
    }
  }, [viewKey])

  const cancelCandidate = useCallback((candidateToken: string | undefined): void => {
    if (!candidateToken) return
    void window.api.specialist.cancelMarketplaceCandidate({ candidateToken }).catch(() => undefined)
  }, [])

  useEffect(
    () => () => {
      cancelCandidate(sourceCandidateTokenRef.current)
      cancelCandidate(installCandidateTokenRef.current)
      sourceCandidateTokenRef.current = undefined
      installCandidateTokenRef.current = undefined
    },
    [cancelCandidate, viewKey]
  )

  useEffect(() => {
    if (typeof window.api?.specialist?.onMarketplaceDownloadProgress !== 'function') return
    return window.api.specialist.onMarketplaceDownloadProgress((progress) => {
      if (
        view.kind === 'marketplace-release' &&
        progress.sourceId === view.sourceId &&
        progress.specialistId === view.id &&
        progress.version === view.version
      ) {
        setDownloadProgress(progress)
      }
    })
  }, [view])

  // Entering the Marketplace view refreshes without forcing: the cached-root TTL in Main answers
  // from a fresh-enough cache with no network round trip. The toolbar Refresh button is the
  // user-initiated path and forces past that TTL.
  useEffect(() => {
    if (view.kind !== 'marketplace' && view.kind !== 'marketplace-sources') return
    void Promise.resolve().then(() => refreshMarketplace())
  }, [refreshMarketplace, view.kind])

  // Card status is shared by the grid and the "Updates available" filter chip, so it is derived
  // once per snapshot instead of per card render.
  const statusByKey = useMemo(() => {
    const statuses = new Map<string, MarketplacePresentationStatus>()
    for (const item of snapshot?.specialists ?? []) {
      const installedSpecialist = installedSpecialists.find(
        (specialist) => specialist.id === item.id
      )
      const status: MarketplacePresentationStatus = !item.installedVersion
        ? 'available'
        : installedSpecialist?.kind !== 'reviewer' && installedSpecialist?.setupPending
          ? 'setup-incomplete'
          : item.updateAvailable
            ? 'update-available'
            : 'installed'
      statuses.set(marketplaceListingKey(item), status)
    }
    return statuses
  }, [installedSpecialists, snapshot])

  const filterCounts = useMemo(() => {
    const counts = { all: 0, official: 0, community: 0, updates: 0 }
    for (const item of snapshot?.specialists ?? []) {
      counts.all += 1
      if (item.sourceTrust === 'official') counts.official += 1
      else counts.community += 1
      if (statusByKey.get(marketplaceListingKey(item)) === 'update-available') counts.updates += 1
    }
    return counts
  }, [snapshot, statusByKey])

  const visibleListings = useMemo(() => {
    const term = query.trim().toLowerCase()
    return (snapshot?.specialists ?? []).filter((item) => {
      if (filter === 'official' && item.sourceTrust !== 'official') return false
      if (filter === 'community' && item.sourceTrust !== 'user-approved') return false
      if (
        filter === 'updates' &&
        statusByKey.get(marketplaceListingKey(item)) !== 'update-available'
      )
        return false
      if (!term) return true
      return [item.displayName, item.summary, item.publisher.name, item.sourceName]
        .join(' ')
        .toLowerCase()
        .includes(term)
    })
  }, [filter, query, snapshot, statusByKey])

  // The newest per-source refresh timestamp answers "how old is the data on screen", covering both
  // the TTL-hit case (a few minutes ago) and a just-completed network refresh (now).
  const lastDataAt = useMemo(() => {
    const stamps = (snapshot?.sources ?? [])
      .map((source) => source.lastRefreshedAt)
      .filter((value): value is string => Boolean(value))
    return stamps.sort().at(-1)
  }, [snapshot])

  useEffect(() => {
    if (sourceFormOpen) sourceInput.current?.focus()
    else if (restoreAddSourceFocus.current) {
      restoreAddSourceFocus.current = false
      addSourceTrigger.current?.focus({ preventScroll: true })
    }
  }, [sourceFormOpen])
  const invalidateSourceCandidate = (): void => {
    cancelCandidate(sourceCandidateTokenRef.current)
    sourceCandidateTokenRef.current = undefined
    setSourceCandidate(undefined)
    setSourceError(undefined)
  }
  const cancelSourceForm = (): void => {
    invalidateSourceCandidate()
    setRepositoryUrl('')
    restoreAddSourceFocus.current = true
    setSourceFormOpen(false)
  }

  const inspectSource = async (): Promise<void> => {
    const startedViewKey = viewKey
    cancelCandidate(sourceCandidateTokenRef.current)
    sourceCandidateTokenRef.current = undefined
    setSourceBusy(true)
    setSourceError(undefined)
    setSourceCandidate(undefined)
    try {
      const candidate = await window.api.specialist.inspectGitHubMarketplaceSource({
        repositoryUrl
      })
      sourceCandidateTokenRef.current = candidate.candidateToken
      if (viewKeyRef.current !== startedViewKey) {
        cancelCandidate(candidate.candidateToken)
        sourceCandidateTokenRef.current = undefined
        return
      }
      setSourceCandidate(candidate)
    } catch {
      setSourceError(t('Could not inspect this GitHub source.'))
    } finally {
      setSourceBusy(false)
    }
  }

  const addSource = async (): Promise<void> => {
    if (!sourceCandidate) return
    setSourceBusy(true)
    setSourceError(undefined)
    try {
      await window.api.specialist.addMarketplaceSource({
        candidateToken: sourceCandidate.candidateToken
      })
      sourceCandidateTokenRef.current = undefined
      setRepositoryUrl('')
      setSourceCandidate(undefined)
      restoreAddSourceFocus.current = true
      setSourceFormOpen(false)
      // Source configuration changed: force past the TTL so every source reports live state.
      void refreshMarketplace({ forceRefresh: true })
    } catch {
      setSourceError(t('Could not add this Marketplace source.'))
    } finally {
      setSourceBusy(false)
    }
  }

  const removeSource = async (sourceId: string): Promise<void> => {
    setSourceRemovalBusy(true)
    setSourceError(undefined)
    try {
      await window.api.specialist.removeMarketplaceSource({ sourceId })
      setSourcePendingRemoval(undefined)
      void refreshMarketplace({ forceRefresh: true })
    } catch {
      setSourceError(t('Could not remove this Marketplace source.'))
    } finally {
      setSourceRemovalBusy(false)
    }
  }

  const invalidateInstallPreview = (): void => {
    cancelCandidate(installCandidateTokenRef.current)
    installCandidateTokenRef.current = undefined
    setInstallPreview(undefined)
    setDownloadProgress(undefined)
    setSkillConflictResolutions({})
    setInstallError(undefined)
    setInstallErrorCode(undefined)
  }

  const install = async (selection?: {
    skillIds: string[]
    connectorIds: string[]
  }): Promise<void> => {
    if (
      (!release && !selection) ||
      view.kind !== 'marketplace-release' ||
      !canInstallSpecialist ||
      installInFlight.current
    )
      return
    installInFlight.current = true
    const startedViewKey = viewKey
    setInstallBusy(true)
    setInstallError(undefined)
    setInstallErrorCode(undefined)
    const currentPreview = selection ? undefined : installPreview
    if (!currentPreview) setDownloadProgress(undefined)
    try {
      const preview =
        currentPreview ??
        (await window.api.specialist.prepareMarketplaceInstall({
          sourceId: view.sourceId,
          specialistId: view.id,
          version: view.version,
          selectedSkillIds: selection?.skillIds ?? [...selectedSkillIds],
          selectedConnectorIds: selection?.connectorIds ?? [...selectedConnectorIds]
        }))
      const preparedNow = !currentPreview
      if (preparedNow) {
        installCandidateTokenRef.current = preview.package.candidateToken
        if (viewKeyRef.current !== startedViewKey) {
          cancelCandidate(preview.package.candidateToken)
          installCandidateTokenRef.current = undefined
          return
        }
        setInstallPreview(preview)
        setDownloadProgress(undefined)
        setSkillConflictResolutions({})
      }
      const conflicts = specialistSkillConflicts(preview.package.summary?.skills)
      if (!preview.package.installable && conflicts.length === 0) {
        setInstallError(t('The downloaded package has blocking validation errors.'))
        return
      }
      if (
        preparedNow &&
        (conflicts.length > 0 || preview.package.overwrite?.modifiedSinceImport === true)
      ) {
        return
      }
      if (conflicts.some((skill) => skillConflictResolutions[skill.id] === undefined)) return
      const result = await window.api.specialist.installMarketplace({
        candidateToken: preview.package.candidateToken,
        ...(preview.package.overwrite ? { confirmOverwrite: true } : {}),
        skillConflictResolutions: skillConflictResolutionList(conflicts, skillConflictResolutions)
      })
      if (result.status !== 'installed') {
        cancelCandidate(preview.package.candidateToken)
        installCandidateTokenRef.current = undefined
        setInstallPreview(undefined)
        setDownloadProgress(undefined)
        setSkillConflictResolutions({})
        setInstallErrorCode(result.code)
        setInstallError(t(specialistInstallFailureCopy(result.code).body))
        return
      }
      installCandidateTokenRef.current = undefined
      await Promise.allSettled([
        useSpecialistStore.getState().load(),
        useSettingsStore.getState().loadSkills()
      ])
      if (result.provenanceLinked === false) {
        setInstallPreview(undefined)
        setInstallRecoveryPending(true)
        setDownloadProgress(undefined)
        setSkillConflictResolutions({})
        setInstallError(
          t(
            'This Specialist was installed, but Marketplace status is still being recovered. Return to Marketplace or restart the app to finish recovery.'
          )
        )
        setInstallErrorCode(undefined)
        return
      }
      await refreshMarketplace()
      onNavigate({ kind: 'list' })
    } catch {
      setDownloadProgress(undefined)
      setInstallErrorCode(undefined)
      setInstallError(t('Could not install this Specialist.'))
    } finally {
      installInFlight.current = false
      setInstallBusy(false)
    }
  }

  const beginCardInstall = useEffectEvent(
    (selection: { skillIds: string[]; connectorIds: string[] }) => {
      if (!canInstallSpecialist || startedCardInstall.current === viewKey) return
      startedCardInstall.current = viewKey
      void install(selection)
    }
  )

  useEffect(() => {
    if (view.kind !== 'marketplace-release') return
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setRelease(undefined)
      setReleaseError(undefined)
      setReleaseLoading(true)
      setSkillsExpanded(false)
      setConnectorsExpanded(false)
      setInstallPreview(undefined)
      setInstallError(undefined)
      setInstallErrorCode(undefined)
      setInstallRecoveryPending(false)
      setDownloadProgress(undefined)
      setSkillConflictResolutions({})
      try {
        const value = await window.api.specialist.getMarketplaceRelease({
          sourceId: view.sourceId,
          specialistId: view.id,
          version: view.version
        })
        if (!active) return
        setRelease(value)
        const skillIds = [...value.defaultSkillIds]
        const connectorIds = [
          ...new Set([
            ...value.defaultConnectorIds,
            ...value.connectors
              .filter((connector) => connector.required)
              .map((connector) => connector.id)
          ])
        ]
        setSelectedSkillIds(new Set(skillIds))
        setSelectedConnectorIds(new Set(connectorIds))
        if (view.installRequested && (!view.installedVersion || view.updateAvailable)) {
          beginCardInstall({ skillIds, connectorIds })
        }
      } catch {
        if (active) setReleaseError(t('Could not load this Specialist release.'))
      } finally {
        if (active) setReleaseLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [t, view])

  const marketplaceSkillConflicts = specialistSkillConflicts(
    installPreview?.package.summary?.skills
  )
  const marketplaceConflictsResolved = marketplaceSkillConflicts.every(
    (skill) => skillConflictResolutions[skill.id] !== undefined
  )
  const marketplacePreviewBlocked =
    installPreview?.package.diagnostics.some((item) => item.severity === 'error') ?? false
  const installedRelease =
    view.kind === 'marketplace-release'
      ? installedSpecialists.find((specialist) => specialist.id === view.id)
      : undefined
  const releaseStatus: MarketplacePresentationStatus =
    view.kind !== 'marketplace-release' || !view.installedVersion
      ? 'available'
      : installedRelease?.kind !== 'reviewer' && installedRelease?.setupPending
        ? 'setup-incomplete'
        : view.updateAvailable
          ? 'update-available'
          : 'installed'
  const installNeedsAttention =
    installPreview !== undefined &&
    (marketplacePreviewBlocked ||
      marketplaceSkillConflicts.length > 0 ||
      installPreview.package.overwrite?.modifiedSinceImport === true)
  const allSourcesUnavailable =
    !loading &&
    snapshot !== undefined &&
    snapshot.sources.length > 0 &&
    snapshot.specialists.length === 0 &&
    snapshot.failures.length === snapshot.sources.length &&
    snapshot.failures.every(
      (failure) => failure.code === 'network' || failure.code === 'unavailable'
    )

  const sourceDrawer = (
    <Dialog.Root
      open={view.kind === 'marketplace-sources'}
      onOpenChange={(open) => {
        if (!open && !sourceBusy && !sourceRemovalBusy) {
          invalidateSourceCandidate()
          setSourceFormOpen(false)
          setRepositoryUrl('')
          setSourcePendingRemoval(undefined)
          onNavigate({ kind: 'marketplace' })
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={dialogOverlayClassName} />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 flex w-full flex-col border-l border-border bg-card text-foreground shadow-dialog outline-none sm:w-[min(38rem,calc(100vw-4rem))] data-[state=closed]:pointer-events-none data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right motion-reduce:animate-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            sourceMenuTrigger.current?.focus({ preventScroll: true })
          }}
        >
          <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-5">
            <Dialog.Title className="min-w-0 flex-1 text-sm font-semibold">
              {t('Marketplace sources')}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close')}
                disabled={sourceBusy || sourceRemovalBusy}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{t('Configured sources')}</h3>
              <Button
                ref={addSourceTrigger}
                variant="outline"
                size="sm"
                disabled={sourceFormOpen || !canManageSources}
                onClick={() => setSourceFormOpen(true)}
              >
                <Plus className="size-4" aria-hidden="true" />
                {t('Add source')}
              </Button>
            </div>
            {loading ? (
              <MarketplaceLoading label={t('Loading…')} />
            ) : !snapshot && lastRefreshFailed ? (
              // Without this arm a failed load reads as "no sources configured".
              <div className="mt-2">
                <MarketplaceError
                  message={
                    integrityFailed
                      ? t(
                          'Marketplace data needs repair. The original {{fileName}} file has been preserved.',
                          { fileName: 'specialist-marketplace.json' }
                        )
                      : t('Marketplace unavailable')
                  }
                  retry={() => void refreshMarketplace()}
                />
              </div>
            ) : snapshot?.sources.length ? (
              <ul className="mt-2 divide-y divide-border">
                {snapshot.sources.map((source) => (
                  <li key={source.id} className="flex min-h-14 items-start gap-3 py-2.5">
                    <GitBranch
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium text-foreground">
                        {source.name}
                      </p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {source.repositoryUrl.replace('https://github.com/', '')}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span
                          className={
                            source.trust === 'official'
                              ? 'inline-flex items-center gap-1 text-primary'
                              : undefined
                          }
                        >
                          {source.trust === 'official' ? (
                            <BadgeCheck className="size-3.5" aria-hidden="true" />
                          ) : null}
                          {source.trust === 'official' ? t('Official') : t('User-added source')}
                        </span>
                        <span className="min-w-0 break-all">
                          {t('Branch or tag')}: {source.ref}
                        </span>
                      </div>
                    </div>
                    {source.removable ? (
                      <SettingsIconAction
                        label={t('Remove {{name}}', { name: source.name })}
                        icon={Trash2}
                        danger
                        disabled={!canManageSources}
                        onClick={() => {
                          setSourceError(undefined)
                          setSourcePendingRemoval(source)
                        }}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                {t('No Marketplace sources configured.')}
              </p>
            )}
            {sourceFormOpen ? (
              <form
                id="marketplace-source-form"
                aria-label={t('Add source')}
                className="mt-5 border-t border-border pt-5"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (sourceBusy || !canManageSources || !repositoryUrl.trim()) return
                  if (sourceCandidate) void addSource()
                  else void inspectSource()
                }}
              >
                <label htmlFor="marketplace-repository" className="text-sm font-medium">
                  {t('Source URL')}
                </label>
                <Input
                  ref={sourceInput}
                  id="marketplace-repository"
                  type="url"
                  required
                  className="mt-2"
                  aria-describedby="marketplace-source-help"
                  value={repositoryUrl}
                  onChange={(event) => {
                    invalidateSourceCandidate()
                    setRepositoryUrl(event.target.value)
                  }}
                  placeholder={t('https://github.com/owner/repository')}
                  disabled={sourceBusy}
                />
                <p id="marketplace-source-help" className="mt-2 text-xs text-muted-foreground">
                  {t(
                    'Use a public GitHub repository or branch URL that publishes a Specialist Marketplace catalog.'
                  )}
                </p>
                {sourceCandidate ? (
                  <section
                    className="mt-4 space-y-3 rounded-lg border border-border p-4"
                    aria-label={sourceCandidate.name}
                  >
                    <div className="flex items-start gap-2">
                      <ShieldCheck
                        className="mt-0.5 size-4 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                      <h4 className="min-w-0 break-words text-sm font-medium">
                        {sourceCandidate.name}
                      </h4>
                    </div>
                    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
                      <dt className="text-muted-foreground">{t('Branch or tag')}</dt>
                      <dd className="break-all">{sourceCandidate.ref}</dd>
                      <dt className="text-muted-foreground">{t('Specialists')}</dt>
                      <dd>{sourceCandidate.specialistCount}</dd>
                    </dl>
                    <p className="break-all font-mono text-[11px] text-muted-foreground">
                      {t('Signing key fingerprint: {{fingerprint}}', {
                        fingerprint: sourceCandidate.keyFingerprint
                      })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        'Installed Skills can change Agent behavior. Only trust sources you recognize.'
                      )}
                    </p>
                  </section>
                ) : null}
              </form>
            ) : null}
            {sourceError && !sourcePendingRemoval ? (
              <div className="mt-4">
                <MarketplaceError message={sourceError} />
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
            {sourceFormOpen ? (
              <>
                <Button variant="ghost" disabled={sourceBusy} onClick={cancelSourceForm}>
                  {t('Cancel', { ns: 'common' })}
                </Button>
                <Button
                  type="submit"
                  form="marketplace-source-form"
                  disabled={sourceBusy || !repositoryUrl.trim() || !canManageSources}
                  aria-busy={sourceBusy}
                >
                  {sourceBusy ? (
                    <Loader2
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : null}
                  {sourceCandidate ? t('Trust and add source') : t('Inspect source')}
                </Button>
              </>
            ) : (
              <Dialog.Close asChild>
                <Button variant="outline" className="ml-auto" disabled={sourceRemovalBusy}>
                  {t('Close')}
                </Button>
              </Dialog.Close>
            )}
          </div>
          <AlertDialog.Root
            open={sourcePendingRemoval !== undefined}
            onOpenChange={(open) => {
              if (!open && !sourceRemovalBusy) setSourcePendingRemoval(undefined)
            }}
          >
            <AlertDialog.Portal>
              <AlertDialog.Overlay className={dialogOverlayClassName} />
              <AlertDialog.Content
                className={dialogPanelClassName('w-[min(520px,calc(100vw-2rem))] p-0')}
              >
                <div className={dialogHeaderClassName}>
                  <AlertDialog.Title className={dialogTitleClassName}>
                    {t('Remove “{{name}}”?', { name: dialogRemovalSource?.name ?? '' })}
                  </AlertDialog.Title>
                  <AlertDialog.Cancel asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('Close')}
                      className={dialogCloseButtonClassName}
                      disabled={sourceRemovalBusy}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  </AlertDialog.Cancel>
                </div>
                <div className={dialogBodyClassName}>
                  <AlertDialog.Description className={dialogDescriptionClassName}>
                    {t(
                      'The source and its cached listings will be removed. Installed Specialists will remain installed.'
                    )}
                  </AlertDialog.Description>
                  {sourceRemovalAffectedSpecialists.length > 0 ? (
                    <div className="mt-4 rounded-lg border border-border p-3">
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'The following installed Specialists will lose Marketplace listings and updates until this source is added again:'
                        )}
                      </p>
                      <ul className="mt-2 list-inside list-disc text-sm text-foreground">
                        {sourceRemovalAffectedSpecialists.map((item) => (
                          <li key={item.id}>{item.displayName ?? item.name}</li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="mt-4 text-xs text-muted-foreground">
                      {t('No installed Specialists currently use this source.')}
                    </p>
                  )}
                  {sourceError ? (
                    <ErrorNotice
                      inline
                      role="alert"
                      tone="amber"
                      className="mt-4"
                      description={sourceError}
                    />
                  ) : null}
                </div>
                <div className={dialogFooterClassName}>
                  <AlertDialog.Cancel asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className={dialogCancelButtonClassName}
                      disabled={sourceRemovalBusy}
                    >
                      {t('Cancel')}
                    </Button>
                  </AlertDialog.Cancel>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={sourceRemovalBusy || !sourcePendingRemoval}
                    onClick={() => {
                      if (sourcePendingRemoval) void removeSource(sourcePendingRemoval.id)
                    }}
                    aria-busy={Boolean(sourceRemovalBusy)}
                  >
                    <span key={String(sourceRemovalBusy)} className="button-feedback">
                      {sourceRemovalBusy ? (
                        <Loader2 className="animate-spin" aria-hidden="true" />
                      ) : null}
                      {t(sourceRemovalBusy ? 'Removing…' : 'Remove source')}
                    </span>
                  </Button>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )

  if (view.kind === 'marketplace-release') {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="p-5">
          {releaseLoading ? <MarketplaceLoading label={t('Loading…')} /> : null}
          {releaseError ? (
            <div>
              <MarketplaceError message={releaseError} />
            </div>
          ) : null}
          {release ? (
            <div className="mx-auto max-w-4xl">
              <ResourceDetailHeader
                identity={
                  <SpecialistIdentity id={release.specialistId} displayName={release.displayName} />
                }
                name={release.displayName}
                description={release.summary}
              >
                {releaseStatus === 'installed' ? <span>{t('Installed')}</span> : null}
                {releaseStatus === 'update-available' ? (
                  <span className="text-primary">{t('Update available')}</span>
                ) : null}
                <span>{t('Publisher: {{publisher}}', { publisher: release.publisher.name })}</span>
                {release.author ? (
                  <span>{t('Author: {{author}}', { author: release.author })}</span>
                ) : null}
                <span>
                  {t('Version')}: {release.version}
                </span>
                <span>
                  {t('License')}: {release.license}
                </span>
                <span>{formatBytes(release.compressedBytes)}</span>
                {view.sourceName ? <span>{view.sourceName}</span> : null}
                {view.sourceTrust === 'official' ? (
                  <span className="inline-flex items-center gap-1 text-primary">
                    <BadgeCheck className="size-3.5" aria-hidden="true" />
                    {t('Official')}
                  </span>
                ) : null}
              </ResourceDetailHeader>
              <ResourceDetailActions>
                <Button
                  type="button"
                  className="shrink-0"
                  variant={
                    releaseStatus === 'installed' || releaseStatus === 'setup-incomplete'
                      ? 'outline'
                      : 'default'
                  }
                  disabled={
                    installBusy ||
                    marketplacePreviewBlocked ||
                    !canInstallSpecialist ||
                    (marketplaceSkillConflicts.length > 0 && !marketplaceConflictsResolved)
                  }
                  onClick={() => {
                    if (releaseStatus === 'installed' || releaseStatus === 'setup-incomplete') {
                      onNavigate({ kind: 'edit', id: release.specialistId })
                      return
                    }
                    void install()
                  }}
                  aria-busy={Boolean(installBusy)}
                >
                  <span key={String(installBusy)} className="button-feedback">
                    {installBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                    {installBusy
                      ? t('Installing…')
                      : releaseStatus === 'installed'
                        ? t('Manage')
                        : releaseStatus === 'setup-incomplete'
                          ? t('Finish setup')
                          : installNeedsAttention
                            ? installPreview?.package.overwrite?.modifiedSinceImport
                              ? t('Replace local changes')
                              : t('Continue installation')
                            : releaseStatus === 'update-available'
                              ? t('Update Specialist')
                              : t('Install Specialist')}
                  </span>
                </Button>
              </ResourceDetailActions>

              {installBusy && !installPreview ? (
                <div className="mt-4 space-y-1.5" role="status" aria-live="polite">
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>{t('Downloading and verifying…')}</span>
                    {downloadProgress ? (
                      <span className="tabular-nums">
                        {formatBytes(downloadProgress.transferred)} /{' '}
                        {formatBytes(downloadProgress.total)} / {downloadProgress.percent}%
                      </span>
                    ) : null}
                  </div>
                  <div
                    role="progressbar"
                    aria-label={t('Marketplace download progress')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={downloadProgress?.percent}
                    data-indeterminate={downloadProgress ? undefined : 'true'}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  >
                    <div
                      className={
                        downloadProgress
                          ? 'h-full rounded-full bg-primary transition-[width] duration-300 motion-reduce:transition-none'
                          : 'install-progress-indeterminate h-full w-1/3 rounded-full bg-primary motion-reduce:animate-none'
                      }
                      style={
                        downloadProgress ? { width: `${downloadProgress.percent}%` } : undefined
                      }
                    />
                  </div>
                </div>
              ) : null}

              <div className="mt-6 space-y-6">
                <section className="border-t border-border pt-4">
                  <button
                    type="button"
                    aria-expanded={skillsExpanded}
                    onClick={() => setSkillsExpanded((expanded) => !expanded)}
                    className="flex min-h-11 w-full items-center gap-3 rounded py-1 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <ScrollText
                      className="size-5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-foreground">{t('Skills')}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('{{selected}} of {{total}} included', {
                          selected: selectedSkillIds.size,
                          total: release.skills.length
                        })}
                      </p>
                    </div>
                    <ChevronDown
                      className={`size-4 text-muted-foreground transition-transform motion-reduce:transition-none ${skillsExpanded ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                  {skillsExpanded ? (
                    <ul className="max-h-80 divide-y divide-border overflow-y-auto border-t border-border px-4">
                      {release.skills.map((skill) => (
                        <li key={skill.id} className="flex items-start gap-3 py-3">
                          <input
                            type="checkbox"
                            checked={selectedSkillIds.has(skill.id)}
                            disabled={installBusy}
                            aria-label={t('Select {{name}}', { name: skill.displayName })}
                            className="mt-1 size-4 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                            onChange={(event) => {
                              invalidateInstallPreview()
                              setSelectedSkillIds((current) => {
                                const next = new Set(current)
                                if (event.target.checked) next.add(skill.id)
                                else next.delete(skill.id)
                                return next
                              })
                            }}
                          />
                          <div className="min-w-0">
                            <p className="text-sm text-foreground">{skill.displayName}</p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {skill.description}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>

                <section className="border-t border-border pt-4">
                  <button
                    type="button"
                    aria-expanded={connectorsExpanded}
                    onClick={() => setConnectorsExpanded((expanded) => !expanded)}
                    className="flex min-h-11 w-full items-center gap-3 rounded py-1 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <ConnectorsNavIcon className="size-5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-foreground">{t('Connectors')}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('{{selected}} of {{total}} included', {
                          selected: selectedConnectorIds.size,
                          total: release.connectors.length
                        })}
                      </p>
                    </div>
                    <ChevronDown
                      className={`size-4 text-muted-foreground transition-transform motion-reduce:transition-none ${connectorsExpanded ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                  {connectorsExpanded ? (
                    release.connectors.length ? (
                      <ul className="divide-y divide-border border-t border-border px-4">
                        {release.connectors.map((connector) => (
                          <li key={connector.id} className="flex items-center gap-3 py-3">
                            <input
                              type="checkbox"
                              checked={selectedConnectorIds.has(connector.id)}
                              disabled={connector.required || installBusy}
                              aria-label={t('Select {{name}}', { name: connector.id })}
                              className="size-4 accent-primary disabled:cursor-not-allowed disabled:opacity-50"
                              onChange={(event) => {
                                invalidateInstallPreview()
                                setSelectedConnectorIds((current) => {
                                  const next = new Set(current)
                                  if (event.target.checked) next.add(connector.id)
                                  else next.delete(connector.id)
                                  return next
                                })
                              }}
                            />
                            <span className="text-sm text-foreground">{connector.id}</span>
                            {connector.required ? (
                              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                {t('Required')}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="border-t border-border p-4 text-xs text-muted-foreground">
                        {t('No Connectors included.')}
                      </p>
                    )
                  ) : null}
                </section>
              </div>

              {installNeedsAttention ? (
                <div className={`${inlineNoticeClassName} mt-4 block`}>
                  {!marketplacePreviewBlocked ? (
                    <div className="flex gap-2 text-xs text-foreground">
                      <CheckCircle2
                        className="mt-0.5 size-3.5 shrink-0 text-primary"
                        aria-hidden="true"
                      />
                      <div>
                        <strong className="block">{t('Package verified')}</strong>
                        <span className="text-muted-foreground">
                          {t('Resolve the items below to continue installation.')}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  {installPreview?.package.overwrite?.modifiedSinceImport ? (
                    <div className="mt-3 text-xs">
                      <p className="font-medium text-foreground">
                        {t('Update from v{{current}} to v{{incoming}}', {
                          current: installPreview.package.overwrite.currentVersion,
                          incoming: installPreview.package.overwrite.incomingVersion
                        })}
                      </p>
                      <p className="mt-1 text-status-warning-foreground dark:text-status-warning-dark-foreground">
                        {t(
                          'Local changes to this Specialist will be replaced by the Marketplace version.'
                        )}
                      </p>
                    </div>
                  ) : null}
                  <div className="mt-3">
                    <SpecialistSkillConflictChoices
                      conflicts={marketplaceSkillConflicts}
                      resolutions={skillConflictResolutions}
                      onChange={(skillId, resolution) =>
                        setSkillConflictResolutions((current) => ({
                          ...current,
                          [skillId]: resolution
                        }))
                      }
                    />
                  </div>
                  {marketplacePreviewBlocked ? (
                    <InlineNotice level="error" role="alert" className="mt-3">
                      <ul className="space-y-2">
                        {installPreview?.package.diagnostics
                          .filter((item) => item.severity === 'error')
                          .map((item) => {
                            const copy = specialistDiagnosticCopy(item)
                            return (
                              <li key={`${item.code}-${item.path ?? ''}`}>
                                <span className="font-medium">{t(copy.title)}</span>
                                <span className="block text-muted-foreground">{t(copy.body)}</span>
                                {item.path ? (
                                  <span className="block font-mono text-[10px] text-muted-foreground">
                                    {item.path}
                                  </span>
                                ) : null}
                              </li>
                            )
                          })}
                      </ul>
                    </InlineNotice>
                  ) : null}
                </div>
              ) : null}

              {installError ? (
                <div className="mt-4">
                  <MarketplaceError
                    message={installError}
                    action={
                      installErrorCode &&
                      specialistInstallFailureCopy(installErrorCode).previewAgain
                        ? { label: t('Preview again'), onClick: () => void install() }
                        : installErrorCode &&
                            specialistInstallFailureCopy(installErrorCode).revealStorage
                          ? {
                              label: t('Open data folder'),
                              onClick: () => void window.api.storage.revealAppStorage()
                            }
                          : undefined
                    }
                  />
                  {installRecoveryPending ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      onClick={() => onNavigate({ kind: 'marketplace' })}
                    >
                      {t('Back to Marketplace')}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="p-5">
        <ResourceCatalogHeader
          icon={Users}
          title={t('Specialists')}
          actions={addAction}
          toolbar={
            <ResourceCatalogToolbar
              onResetFilters={() => {
                setFilter('all')
              }}
              activeFilterCount={Number(filter !== 'all')}
              search={
                <SettingsSearchInput
                  aria-label={t('Search Marketplace')}
                  placeholder={t('Search Marketplace…')}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              }
              trailing={
                <>
                  {snapshot && snapshot.sources.length > 0 && !lastRefreshFailed ? (
                    <p
                      role="status"
                      aria-live="polite"
                      className="ml-auto flex min-h-4 items-center gap-1.5 text-xs text-muted-foreground"
                    >
                      {isRefreshing ? (
                        <>
                          <Loader2
                            className="size-3.5 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                          <span className="font-medium text-foreground">
                            {t('Refreshing Marketplace…')}
                          </span>
                          {lastDataAt ? (
                            <span>
                              /{' '}
                              {t('Showing data from {{time}}', {
                                time: formatRelative(lastDataAt)
                              })}
                            </span>
                          ) : null}
                        </>
                      ) : lastDataAt ? (
                        <span>{t('Updated {{time}}', { time: formatRelative(lastDataAt) })}</span>
                      ) : null}
                    </p>
                  ) : null}

                  <ResourceCatalogActions
                    menuTriggerRef={sourceMenuTrigger}
                    onRefresh={() => void refreshMarketplace({ forceRefresh: true })}
                    refreshing={isRefreshing}
                    items={[
                      {
                        label: t('Manage Marketplace sources'),
                        onSelect: () => onNavigate({ kind: 'marketplace-sources' })
                      }
                    ]}
                  />
                </>
              }
            >
              {snapshot && snapshot.specialists.length > 0 ? (
                <ResourceCatalogFilter label={t('Category')}>
                  <Select
                    value={filter}
                    onValueChange={(value) => setFilter(value as MarketplaceFilter)}
                  >
                    <SelectTrigger
                      aria-label={t('Filter Marketplace Specialists')}
                      className="w-44"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(
                        [
                          ['all', t('All'), filterCounts.all],
                          ['official', t('Official'), filterCounts.official],
                          ['community', t('Community'), filterCounts.community],
                          ...(filterCounts.updates > 0 || filter === 'updates'
                            ? [['updates', t('Updates available'), filterCounts.updates] as const]
                            : [])
                        ] as const
                      ).map(([key, label, count]) => (
                        <SelectItem key={key} value={key}>
                          {label}
                          <span className="ml-2 tabular-nums text-muted-foreground">{count}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </ResourceCatalogFilter>
              ) : null}
            </ResourceCatalogToolbar>
          }
        >
          <ResourceCenterModeTabs
            count={installedSpecialists.length}
            installedLabel={t('Installed', { context: 'specialists' })}
            value="marketplace"
            onChange={(value) => {
              if (value === 'installed') onNavigate({ kind: 'list' })
            }}
          />
        </ResourceCatalogHeader>

        {uninstallError ? <MarketplaceError message={uninstallError} /> : null}
        {loading ? <MarketplaceLoading label={t('Loading Marketplace…')} /> : null}
        {!loading && !snapshot && lastRefreshFailed ? (
          <MarketplaceError
            message={
              integrityFailed
                ? t(
                    'Marketplace data needs repair. The original {{fileName}} file has been preserved.',
                    { fileName: 'specialist-marketplace.json' }
                  )
                : t('Marketplace unavailable')
            }
            retry={() => void refreshMarketplace()}
          />
        ) : null}
        {!loading && snapshot && lastRefreshFailed ? (
          <InlineNotice role="status" className="mb-3">
            {integrityFailed
              ? t(
                  'Marketplace data needs repair. The original {{fileName}} file has been preserved.',
                  { fileName: 'specialist-marketplace.json' }
                )
              : t('Could not refresh Marketplace. Showing the last available data.')}
          </InlineNotice>
        ) : null}
        {!loading
          ? snapshot?.sources
              .filter((source) => source.usingCachedMetadata && source.lastRefreshedAt)
              .map((source) => (
                <InlineNotice key={`cached-${source.id}`} role="status" className="mb-3">
                  {t(
                    'Showing verified cached data from {{time}} for {{source}}. Installation still requires a verified download.',
                    {
                      time: formatDate(source.lastRefreshedAt!, 'dateTime'),
                      source: source.name
                    }
                  )}
                </InlineNotice>
              ))
          : null}
        {allSourcesUnavailable ? (
          <MarketplaceError
            message={t(
              'Marketplace could not be reached from any configured source. Check your network and try again.'
            )}
            retry={() => void refreshMarketplace()}
          />
        ) : null}
        {!loading && !allSourcesUnavailable
          ? snapshot?.failures.map((failure) => (
              <div key={failure.sourceId} className="mb-3">
                <MarketplaceError
                  message={t('Could not refresh {{source}}', { source: failure.sourceName })}
                />
              </div>
            ))
          : null}
        {!loading && snapshot && !allSourcesUnavailable && visibleListings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <p className="text-sm text-foreground">
              {query
                ? t('No Specialists match “{{query}}”.', { query })
                : filter !== 'all'
                  ? t('No Specialists match this filter.')
                  : t('No Marketplace Specialists available.')}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                if (query) setQuery('')
                else if (filter !== 'all') setFilter('all')
                else onNavigate({ kind: 'marketplace-sources' })
              }}
            >
              {query ? t('Clear search') : filter !== 'all' ? t('Show all') : t('Manage sources')}
            </Button>
          </div>
        ) : null}
        {!loading && visibleListings.length ? (
          <ul className="resource-marketplace-grid grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
            {visibleListings.map((item) => {
              const status = statusByKey.get(marketplaceListingKey(item)) ?? ('available' as const)
              const opensDetails = status === 'available' || status === 'update-available'
              const installed = installedSpecialists.find((specialist) => specialist.id === item.id)
              const canUninstall = Boolean(
                status === 'installed' &&
                installed?.kind === 'custom' &&
                installed.origin === 'marketplace' &&
                onUninstall &&
                !uninstallBusy
              )
              const key = marketplaceListingKey(item)
              const uninstallArmed = canUninstall && uninstallArmedKey === key
              const navigate = (installRequested = false): void => {
                if (!opensDetails) {
                  onNavigate({ kind: 'edit', id: item.id })
                  return
                }
                onNavigate({
                  kind: 'marketplace-release',
                  sourceId: item.sourceId,
                  sourceName: item.sourceName,
                  sourceTrust: item.sourceTrust,
                  id: item.id,
                  version: item.version,
                  installedVersion: item.installedVersion,
                  updateAvailable: item.updateAvailable,
                  ...(installRequested ? { installRequested: true } : {})
                })
              }
              return (
                <li
                  key={marketplaceListingKey(item)}
                  className="resource-marketplace-card flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 text-card-foreground transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-sm motion-reduce:transition-none"
                >
                  <ResourceMarketplaceCardContent
                    id={item.id}
                    name={item.displayName}
                    publisher={item.publisher.name}
                    summary={item.summary}
                    onOpen={() => navigate()}
                    primaryAction={
                      <Button
                        type="button"
                        variant={uninstallArmed ? 'destructive' : 'outline'}
                        size="sm"
                        className="skill-marketplace-install-action shrink-0"
                        data-installed={status === 'installed' && !uninstallArmed}
                        aria-live="polite"
                        disabled={
                          uninstallBusy ||
                          (status === 'installed' && !canUninstall) ||
                          (opensDetails && !canInstallSpecialist)
                        }
                        onPointerEnter={(event) => {
                          if (event.pointerType === 'mouse' && canUninstall)
                            setUninstallArmedKey(key)
                        }}
                        onPointerLeave={(event) => {
                          if (event.pointerType === 'mouse') setUninstallArmedKey(undefined)
                        }}
                        onFocus={(event) => {
                          if (canUninstall && event.currentTarget.matches(':focus-visible'))
                            setUninstallArmedKey(key)
                        }}
                        onBlur={() => setUninstallArmedKey(undefined)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape' && uninstallArmed) {
                            event.preventDefault()
                            event.stopPropagation()
                            setUninstallArmedKey(undefined)
                          }
                        }}
                        onClick={() => {
                          if (canUninstall) {
                            if (uninstallArmed) onUninstall?.(item.id)
                            else setUninstallArmedKey(key)
                          } else navigate(true)
                        }}
                      >
                        {status === 'installed' ? (
                          uninstallArmed ? (
                            <Trash2 className="size-4" aria-hidden="true" />
                          ) : (
                            <CheckCircle2 className="size-4" aria-hidden="true" />
                          )
                        ) : null}
                        {status === 'installed'
                          ? t(uninstallArmed ? 'Uninstall' : 'Installed')
                          : status === 'setup-incomplete'
                            ? t('Finish setup')
                            : status === 'update-available'
                              ? t('Update')
                              : t('Install')}
                      </Button>
                    }
                    status={
                      status === 'update-available'
                        ? t('Update available')
                        : status === 'setup-incomplete'
                          ? t('Setup incomplete')
                          : undefined
                    }
                  />
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
      {sourceDrawer}
    </TooltipProvider>
  )
}

export { SpecialistMarketplace }
