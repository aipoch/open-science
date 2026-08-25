import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  GitBranch,
  Loader2,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldCheck,
  Trash2
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDateTimeFormat, useRelativeTimeFormat } from '@/hooks/useDateTimeFormat'
import { useMarketplaceStore } from '@/stores/marketplace-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type {
  MarketplaceDownloadProgress,
  MarketplaceInstallPreview,
  MarketplaceSourceCandidate,
  MarketplaceSpecialistRelease
} from '../../../../shared/specialist-marketplace'
import { SettingsSearchInput } from './SettingsSearchInput'
import { SettingsIconAction } from './SettingsLayout'
import { ConnectorsNavIcon } from './connector-icons'
import { SpecialistSkillConflictChoices } from './SpecialistSkillConflictChoices'
import {
  skillConflictResolutionList,
  specialistSkillConflicts,
  type SkillConflictResolutionMap
} from './specialist-skill-conflicts'

export type SpecialistMarketplaceView =
  | { kind: 'marketplace' }
  | { kind: 'marketplace-sources' }
  | {
      kind: 'marketplace-release'
      sourceId: string
      sourceName?: string
      sourceTrust?: 'official' | 'user-approved'
      id: string
      version: string
      installedVersion?: string
      updateAvailable?: boolean
    }

type Props = {
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

const identityTones = [
  'bg-chart-1/15 text-chart-1 ring-chart-1/20',
  'bg-chart-2/15 text-chart-2 ring-chart-2/20',
  'bg-chart-3/15 text-chart-3 ring-chart-3/20',
  'bg-chart-4/15 text-chart-4 ring-chart-4/20'
] as const

const specialistInitials = (displayName: string): string => {
  const words = displayName.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'SP'
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')
}

const SpecialistIdentity = ({
  id,
  displayName,
  size = 'md'
}: {
  id: string
  displayName: string
  size?: 'md' | 'lg'
}): React.JSX.Element => {
  const tone =
    identityTones[
      [...id].reduce((total, character) => total + character.charCodeAt(0), 0) %
        identityTones.length
    ]
  return (
    <div
      role="img"
      aria-label={displayName}
      className={`grid shrink-0 place-items-center font-semibold tracking-tight ring-1 ${tone} ${
        size === 'lg' ? 'size-14 rounded-xl text-base' : 'size-10 rounded-lg text-xs'
      }`}
    >
      {specialistInitials(displayName)}
    </div>
  )
}

const MarketplaceError = ({
  message,
  retry
}: {
  message: string
  retry?: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger-000/30 bg-danger-000/10 p-3 text-sm text-danger-000"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{message}</span>
      </div>
      {retry ? (
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={retry}>
          {t('Retry')}
        </Button>
      ) : null}
    </div>
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

const SpecialistMarketplace = ({ view, onNavigate }: Props): React.JSX.Element => {
  const { t } = useTranslation()
  const formatDate = useDateTimeFormat()
  const formatRelative = useRelativeTimeFormat()
  // The snapshot lives in the store so it survives leaving this view: re-entering the Marketplace
  // renders the last data immediately and refreshes in the background (the status line below makes
  // that refresh visible), instead of returning to a full-screen loader for data already in hand.
  const snapshot = useMarketplaceStore((state) => state.snapshot)
  const isRefreshing = useMarketplaceStore((state) => state.isRefreshing)
  const lastRefreshFailed = useMarketplaceStore((state) => state.lastRefreshFailed)
  const refreshMarketplace = useMarketplaceStore((state) => state.refresh)
  // No snapshot and no failure verdict yet is a genuine first load, true from the very first render
  // before any effect has fired. Once a snapshot exists the content renders immediately whatever
  // the refresh state, and a failed first load flips this to false so the error renders instead.
  const loading = snapshot === undefined && !lastRefreshFailed
  const [query, setQuery] = useState('')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [sourceCandidate, setSourceCandidate] = useState<MarketplaceSourceCandidate>()
  const [sourceBusy, setSourceBusy] = useState(false)
  const [sourceError, setSourceError] = useState<string>()
  const [release, setRelease] = useState<MarketplaceSpecialistRelease>()
  const [releaseLoading, setReleaseLoading] = useState(view.kind === 'marketplace-release')
  const [releaseError, setReleaseError] = useState<string>()
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<Set<string>>(new Set())
  const [skillsExpanded, setSkillsExpanded] = useState(false)
  const [connectorsExpanded, setConnectorsExpanded] = useState(false)
  const [installBusy, setInstallBusy] = useState(false)
  const [installPreview, setInstallPreview] = useState<MarketplaceInstallPreview>()
  const [installError, setInstallError] = useState<string>()
  const [installRecoveryPending, setInstallRecoveryPending] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<MarketplaceDownloadProgress>()
  const [skillConflictResolutions, setSkillConflictResolutions] =
    useState<SkillConflictResolutionMap>({})
  const sourceCandidateTokenRef = useRef<string | undefined>(undefined)
  const installCandidateTokenRef = useRef<string | undefined>(undefined)
  const installedSpecialists = useSpecialistStore((state) => state.items)
  const viewKey =
    view.kind === 'marketplace-release'
      ? `${view.kind}:${view.sourceId}:${view.id}:${view.version}`
      : view.kind
  const viewKeyRef = useRef<string | undefined>(viewKey)

  useEffect(() => {
    viewKeyRef.current = viewKey
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
        setSelectedSkillIds(new Set(value.defaultSkillIds))
        setSelectedConnectorIds(
          new Set([
            ...value.defaultConnectorIds,
            ...value.connectors
              .filter((connector) => connector.required)
              .map((connector) => connector.id)
          ])
        )
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

  const visibleListings = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return snapshot?.specialists ?? []
    return (snapshot?.specialists ?? []).filter((item) =>
      [item.displayName, item.summary, item.publisher.name, item.sourceName]
        .join(' ')
        .toLowerCase()
        .includes(term)
    )
  }, [query, snapshot])

  // The newest per-source refresh timestamp answers "how old is the data on screen", covering both
  // the TTL-hit case (a few minutes ago) and a just-completed network refresh (now).
  const lastDataAt = useMemo(() => {
    const stamps = (snapshot?.sources ?? [])
      .map((source) => source.lastRefreshedAt)
      .filter((value): value is string => Boolean(value))
    return stamps.sort().at(-1)
  }, [snapshot])

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
      // Source configuration changed: force past the TTL so every source reports live state.
      void refreshMarketplace({ forceRefresh: true })
    } catch {
      setSourceError(t('Could not add this Marketplace source.'))
    } finally {
      setSourceBusy(false)
    }
  }

  const removeSource = async (sourceId: string): Promise<void> => {
    setSourceError(undefined)
    try {
      await window.api.specialist.removeMarketplaceSource({ sourceId })
      void refreshMarketplace({ forceRefresh: true })
    } catch {
      setSourceError(t('Could not remove this Marketplace source.'))
    }
  }

  const invalidateInstallPreview = (): void => {
    cancelCandidate(installCandidateTokenRef.current)
    installCandidateTokenRef.current = undefined
    setInstallPreview(undefined)
    setDownloadProgress(undefined)
    setSkillConflictResolutions({})
    setInstallError(undefined)
  }

  const install = async (): Promise<void> => {
    if (!release || view.kind !== 'marketplace-release') return
    const startedViewKey = viewKey
    setInstallBusy(true)
    setInstallError(undefined)
    if (!installPreview) setDownloadProgress(undefined)
    try {
      const preview =
        installPreview ??
        (await window.api.specialist.prepareMarketplaceInstall({
          sourceId: view.sourceId,
          specialistId: view.id,
          version: view.version,
          selectedSkillIds: [...selectedSkillIds],
          selectedConnectorIds: [...selectedConnectorIds]
        }))
      const preparedNow = !installPreview
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
        setInstallError(t('Installation failed. Try again.'))
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
        return
      }
      onNavigate({ kind: 'list' })
    } catch {
      setDownloadProgress(undefined)
      setInstallError(t('Could not install this Specialist.'))
    } finally {
      setInstallBusy(false)
    }
  }

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

  if (view.kind === 'marketplace-sources') {
    return (
      <div className="p-5">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('Marketplace sources')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Add a public GitHub repository that follows the Specialist Marketplace protocol.')}
          </p>
        </div>

        <div className="mt-5 rounded-lg border border-border p-4">
          <label htmlFor="marketplace-repository" className="text-sm font-medium text-foreground">
            {t('GitHub repository')}
          </label>
          <div className="mt-2 flex items-center gap-2">
            <Input
              id="marketplace-repository"
              value={repositoryUrl}
              onChange={(event) => setRepositoryUrl(event.target.value)}
              placeholder={t('https://github.com/owner/repository')}
              disabled={sourceBusy}
            />
            <Button
              type="button"
              onClick={() => void inspectSource()}
              disabled={sourceBusy || !repositoryUrl.trim()}
            >
              {sourceBusy ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <GitBranch aria-hidden="true" />
              )}
              {t('Inspect source')}
            </Button>
          </div>

          {sourceCandidate ? (
            <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{sourceCandidate.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {sourceCandidate.repositoryUrl} · {sourceCandidate.ref}
                  </p>
                  <p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">
                    {t('Signing key fingerprint: {{fingerprint}}', {
                      fingerprint: sourceCandidate.keyFingerprint
                    })}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('{{count}} Specialists. Installed Skills can change Agent behavior.', {
                      count: sourceCandidate.specialistCount
                    })}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button type="button" onClick={() => void addSource()} disabled={sourceBusy}>
                  {t('Trust and add source')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {sourceError ? (
          <div className="mt-4">
            <MarketplaceError message={sourceError} />
          </div>
        ) : null}

        <div className="mt-6">
          <h3 className="text-sm font-semibold text-foreground">{t('Configured sources')}</h3>
          {loading ? (
            <MarketplaceLoading label={t('Loading…')} />
          ) : !snapshot && lastRefreshFailed ? (
            // Without this arm a failed load reads as "no sources configured".
            <div className="mt-2">
              <MarketplaceError
                message={t('Marketplace unavailable')}
                retry={() => void refreshMarketplace()}
              />
            </div>
          ) : snapshot?.sources.length ? (
            <ul className="mt-2 divide-y divide-border">
              {snapshot.sources.map((source) => (
                <li key={source.id} className="flex min-h-14 items-center gap-3 py-2.5">
                  <GitBranch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{source.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {source.trust === 'official' ? t('Official') : t('User-added source')} ·{' '}
                      {source.repositoryUrl} · {source.ref}
                    </p>
                  </div>
                  {source.removable ? (
                    <SettingsIconAction
                      label={t('Remove {{name}}', { name: source.name })}
                      icon={Trash2}
                      danger
                      onClick={() => void removeSource(source.id)}
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
        </div>
      </div>
    )
  }

  if (view.kind === 'marketplace-release') {
    return (
      <div className="p-5">
        {releaseLoading ? <MarketplaceLoading label={t('Loading…')} /> : null}
        {releaseError ? (
          <div>
            <MarketplaceError message={releaseError} />
          </div>
        ) : null}
        {release ? (
          <div className="mx-auto max-w-4xl">
            <div className="flex flex-wrap items-start gap-4 border-b border-border pb-5">
              <SpecialistIdentity
                id={release.specialistId}
                displayName={release.displayName}
                size="lg"
              />
              <div className="min-w-64 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-semibold tracking-tight text-foreground">
                    {release.displayName}
                  </h2>
                  {releaseStatus === 'installed' ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {t('Installed')}
                    </span>
                  ) : null}
                  {releaseStatus === 'update-available' ? (
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                      {t('Update available')}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1.5 max-w-3xl text-sm leading-6 text-muted-foreground">
                  {release.summary}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                  {view.sourceTrust === 'official' ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 font-medium text-primary">
                      <BadgeCheck className="size-3.5" aria-hidden="true" />
                      {t('Official')}
                    </span>
                  ) : null}
                  <span className="rounded-full border border-border px-2 py-1 text-muted-foreground">
                    {t('Publisher: {{publisher}}', { publisher: release.publisher.name })}
                  </span>
                  {release.author ? (
                    <span className="rounded-full border border-border px-2 py-1 text-muted-foreground">
                      {t('Author: {{author}}', { author: release.author })}
                    </span>
                  ) : null}
                  <span className="rounded-full border border-border px-2 py-1 text-muted-foreground">
                    v{release.version}
                  </span>
                  <span className="rounded-full border border-border px-2 py-1 text-muted-foreground">
                    {release.license}
                  </span>
                  <span className="rounded-full border border-border px-2 py-1 text-muted-foreground">
                    {formatBytes(release.compressedBytes)}
                  </span>
                  {view.sourceName ? (
                    <span className="rounded-full border border-border px-2 py-1 text-muted-foreground">
                      {view.sourceName}
                    </span>
                  ) : null}
                </div>
              </div>
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
                  (marketplaceSkillConflicts.length > 0 && !marketplaceConflictsResolved)
                }
                onClick={() => {
                  if (releaseStatus === 'installed' || releaseStatus === 'setup-incomplete') {
                    onNavigate({ kind: 'edit', id: release.specialistId })
                    return
                  }
                  void install()
                }}
              >
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
              </Button>
            </div>

            {installBusy && !installPreview ? (
              <div className="mt-4 space-y-1.5" role="status" aria-live="polite">
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>{t('Downloading and verifying…')}</span>
                  {downloadProgress ? (
                    <span className="tabular-nums">
                      {formatBytes(downloadProgress.transferred)} /{' '}
                      {formatBytes(downloadProgress.total)} · {downloadProgress.percent}%
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
                    style={downloadProgress ? { width: `${downloadProgress.percent}%` } : undefined}
                  />
                </div>
              </div>
            ) : null}

            <div className="mt-5 space-y-3">
              <section className="overflow-hidden rounded-xl border border-border bg-background">
                <button
                  type="button"
                  aria-expanded={skillsExpanded}
                  onClick={() => setSkillsExpanded((expanded) => !expanded)}
                  className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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

              <section className="overflow-hidden rounded-xl border border-border bg-background">
                <button
                  type="button"
                  aria-expanded={connectorsExpanded}
                  onClick={() => setConnectorsExpanded((expanded) => !expanded)}
                  className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
              <div className="mt-4 rounded-xl border border-warning-100/50 bg-warning-100/10 p-4">
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
                    <p className="mt-1 text-warning-900">
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
                  <ul className="mt-3 rounded-lg border border-danger-000/30 bg-danger-000/10 p-3 text-xs text-danger-000">
                    {installPreview?.package.diagnostics
                      .filter((item) => item.severity === 'error')
                      .map((item) => (
                        <li key={`${item.code}-${item.path ?? ''}`}>
                          <span className="font-medium">{item.code}</span>
                          <span className="block text-muted-foreground">{item.message}</span>
                        </li>
                      ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {installError ? (
              <div className="mt-4">
                <MarketplaceError message={installError} />
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
    )
  }

  return (
    <div className="p-5">
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{t('Marketplace')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Browse and install Specialists from configured sources.')}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <SettingsIconAction
            label={t('Refresh Marketplace')}
            icon={RefreshCw}
            disabled={isRefreshing}
            className={
              isRefreshing ? '[&_svg]:animate-spin motion-reduce:[&_svg]:animate-none' : ''
            }
            onClick={() => void refreshMarketplace({ forceRefresh: true })}
          />
          <SettingsIconAction
            label={t('Manage Marketplace sources')}
            icon={Settings2}
            onClick={() => onNavigate({ kind: 'marketplace-sources' })}
          />
        </div>
      </div>
      <div className="mb-4 flex items-center gap-2">
        <SettingsSearchInput
          aria-label={t('Search Marketplace')}
          placeholder={t('Search Marketplace…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {loading ? <MarketplaceLoading label={t('Loading Marketplace…')} /> : null}
      {!loading && !snapshot && lastRefreshFailed ? (
        <MarketplaceError
          message={t('Marketplace unavailable')}
          retry={() => void refreshMarketplace()}
        />
      ) : null}
      {/* Stale-while-revalidate status: neutral while content is on screen, and distinct from the
          warning banners below, which mean degraded data rather than merely old data. */}
      {!loading && snapshot && snapshot.sources.length > 0 && !lastRefreshFailed ? (
        <p
          role="status"
          aria-live="polite"
          className="mb-3.5 flex min-h-4 items-center gap-1.5 text-xs text-muted-foreground"
        >
          {isRefreshing ? (
            <>
              <Loader2
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              <span className="font-medium text-foreground">{t('Refreshing Marketplace…')}</span>
              {lastDataAt ? (
                <span>
                  · {t('Showing data from {{time}}', { time: formatRelative(lastDataAt) })}
                </span>
              ) : null}
            </>
          ) : lastDataAt ? (
            <span>{t('Updated {{time}}', { time: formatRelative(lastDataAt) })}</span>
          ) : null}
        </p>
      ) : null}
      {!loading && snapshot && lastRefreshFailed ? (
        <div
          role="status"
          className="mb-3 rounded-lg border border-warning-100/40 bg-warning-100/10 p-3 text-sm text-foreground"
        >
          {t('Could not refresh Marketplace. Showing the last available data.')}
        </div>
      ) : null}
      {!loading
        ? snapshot?.sources
            .filter((source) => source.usingCachedMetadata && source.lastRefreshedAt)
            .map((source) => (
              <div
                key={`cached-${source.id}`}
                role="status"
                className="mb-3 rounded-lg border border-warning-100/40 bg-warning-100/10 p-3 text-sm text-foreground"
              >
                {t(
                  'Showing verified cached data from {{time}} for {{source}}. Installation still requires a verified download.',
                  {
                    time: formatDate(source.lastRefreshedAt!, 'dateTime'),
                    source: source.name
                  }
                )}
              </div>
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
              : t('No Marketplace Specialists available.')}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => (query ? setQuery('') : onNavigate({ kind: 'marketplace-sources' }))}
          >
            {query ? t('Clear search') : t('Manage sources')}
          </Button>
        </div>
      ) : null}
      {!loading && visibleListings.length ? (
        <ul className="space-y-2">
          {visibleListings.map((item) => {
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
            const opensDetails = status === 'available' || status === 'update-available'
            const navigate = (): void => {
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
                updateAvailable: item.updateAvailable
              })
            }
            return (
              <li
                key={`${item.sourceId}:${item.id}`}
                className="group flex cursor-pointer items-center gap-3 rounded-xl border border-border bg-background p-3 transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-sm motion-reduce:transition-none"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={navigate}
                >
                  <SpecialistIdentity id={item.id} displayName={item.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {item.displayName}
                      </span>
                      {status !== 'available' ? (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            status === 'update-available'
                              ? 'bg-primary/10 text-primary'
                              : 'bg-muted text-muted-foreground'
                          }`}
                        >
                          {status === 'update-available'
                            ? t('Update available')
                            : status === 'setup-incomplete'
                              ? t('Setup incomplete')
                              : t('Installed')}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-muted-foreground">
                      {item.summary}
                    </span>
                    <span className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
                      {item.sourceTrust === 'official' ? (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">
                          <BadgeCheck className="size-3.5" aria-hidden="true" />
                          {t('Official')}
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                          {t('Community')}
                        </span>
                      )}
                      <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                        {t('Publisher: {{publisher}}', { publisher: item.publisher.name })}
                      </span>
                      {item.author ? (
                        <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                          {t('Author: {{author}}', { author: item.author })}
                        </span>
                      ) : null}
                      <span className="rounded-full border border-border px-2 py-1 text-muted-foreground">
                        v{item.version}
                      </span>
                      <span className="min-w-0 truncate text-muted-foreground">
                        {item.sourceName}
                      </span>
                    </span>
                  </span>
                </button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  onClick={navigate}
                >
                  {opensDetails ? t('View details') : t('Manage')}
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

export { SpecialistMarketplace }
