import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  Loader2,
  PackageOpen,
  Plus,
  ShieldCheck,
  Trash2
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import type {
  MarketplaceDownloadProgress,
  MarketplaceInstallPreview,
  MarketplaceSnapshot,
  MarketplaceSourceCandidate,
  MarketplaceSpecialistRelease
} from '../../../../shared/specialist-marketplace'
import { SettingsSearchInput } from './SettingsSearchInput'
import { SettingsIconAction } from './SettingsLayout'
import { SpecialistSkillConflictChoices } from './SpecialistSkillConflictChoices'
import {
  skillConflictResolutionList,
  specialistSkillConflicts,
  type SkillConflictResolutionMap
} from './specialist-skill-conflicts'

export type SpecialistMarketplaceView =
  | { kind: 'marketplace' }
  | { kind: 'marketplace-sources' }
  | { kind: 'marketplace-release'; sourceId: string; id: string; version: string }

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
  const [snapshot, setSnapshot] = useState<MarketplaceSnapshot>()
  const [loading, setLoading] = useState(
    view.kind === 'marketplace' || view.kind === 'marketplace-sources'
  )
  const [loadError, setLoadError] = useState<string>()
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
  const [reviewing, setReviewing] = useState(false)
  const [installBusy, setInstallBusy] = useState(false)
  const [installPreview, setInstallPreview] = useState<MarketplaceInstallPreview>()
  const [installError, setInstallError] = useState<string>()
  const [installRecoveryPending, setInstallRecoveryPending] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<MarketplaceDownloadProgress>()
  const [skillConflictResolutions, setSkillConflictResolutions] =
    useState<SkillConflictResolutionMap>({})
  const sourceCandidateTokenRef = useRef<string | undefined>(undefined)
  const installCandidateTokenRef = useRef<string | undefined>(undefined)
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

  const loadMarketplace = useCallback(async (): Promise<void> => {
    if (typeof window.api?.specialist?.listMarketplace !== 'function') {
      setLoadError(t('Marketplace unavailable'))
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(undefined)
    try {
      setSnapshot(await window.api.specialist.listMarketplace())
    } catch {
      setLoadError(t('Marketplace unavailable'))
    } finally {
      setLoading(false)
    }
  }, [t])

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

  useEffect(() => {
    if (view.kind !== 'marketplace' && view.kind !== 'marketplace-sources') return
    void Promise.resolve().then(loadMarketplace)
  }, [loadMarketplace, view.kind])

  useEffect(() => {
    if (view.kind !== 'marketplace-release') return
    let active = true
    void Promise.resolve().then(async () => {
      if (!active) return
      setRelease(undefined)
      setReleaseError(undefined)
      setReleaseLoading(true)
      setReviewing(false)
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
      await loadMarketplace()
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
      await loadMarketplace()
    } catch {
      setSourceError(t('Could not remove this Marketplace source.'))
    }
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
      if (preparedNow) return
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
      onNavigate({ kind: 'edit', id: result.specialist.id })
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
          <div>
            <div className="flex items-start gap-3 border-b border-border pb-4">
              <PackageOpen className="mt-1 size-5 shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-foreground">{release.displayName}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{release.summary}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {release.publisher.name} · v{release.version} · {release.license} ·{' '}
                  {formatBytes(release.compressedBytes)}
                </p>
              </div>
            </div>

            {!reviewing ? (
              <>
                <div className="mt-5 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{t('Skills')}</h3>
                    <p className="text-xs text-muted-foreground">
                      {t('Selected Skills are available only to this Specialist.')}
                    </p>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t('{{selected}} of {{total}} selected', {
                      selected: selectedSkillIds.size,
                      total: release.skills.length
                    })}
                  </span>
                </div>
                <ul className="mt-2 max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border px-3">
                  {release.skills.map((skill) => (
                    <li key={skill.id} className="flex items-start gap-3 py-3">
                      <input
                        type="checkbox"
                        checked={selectedSkillIds.has(skill.id)}
                        aria-label={t('Select {{name}}', { name: skill.displayName })}
                        className="mt-1 size-4 accent-primary"
                        onChange={(event) => {
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
                        <p className="mt-0.5 text-xs text-muted-foreground">{skill.description}</p>
                      </div>
                    </li>
                  ))}
                </ul>
                {release.connectors.length ? (
                  <div className="mt-5">
                    <h3 className="text-sm font-semibold text-foreground">{t('Connectors')}</h3>
                    <ul className="mt-2 divide-y divide-border rounded-lg border border-border px-3">
                      {release.connectors.map((connector) => (
                        <li key={connector.id} className="flex items-center gap-3 py-3">
                          <input
                            type="checkbox"
                            checked={selectedConnectorIds.has(connector.id)}
                            disabled={connector.required}
                            aria-label={t('Select {{name}}', { name: connector.id })}
                            className="size-4 accent-primary"
                            onChange={(event) => {
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
                            <span className="text-xs text-muted-foreground">{t('Required')}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <div className="mt-5 flex justify-end">
                  <Button type="button" onClick={() => setReviewing(true)}>
                    {t('Review installation')}
                  </Button>
                </div>
              </>
            ) : (
              <div className="mt-5">
                <h3 className="text-sm font-semibold text-foreground">
                  {t('Review installation')}
                </h3>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 rounded-lg border border-border p-4 text-sm">
                  <dt className="text-muted-foreground">{t('Skills')}</dt>
                  <dd className="text-foreground">{selectedSkillIds.size}</dd>
                  <dt className="text-muted-foreground">{t('Connectors')}</dt>
                  <dd className="text-foreground">{selectedConnectorIds.size}</dd>
                  <dt className="text-muted-foreground">{t('Download')}</dt>
                  <dd className="text-foreground">{formatBytes(release.compressedBytes)}</dd>
                  <dt className="text-muted-foreground">{t('Main Agent')}</dt>
                  <dd className="font-medium text-foreground">{t('No changes')}</dd>
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  {t(
                    'The archive will be downloaded, verified, and installed locally. Newly installed resources remain unavailable to Main Agent.'
                  )}
                </p>
                {installBusy && !installPreview ? (
                  <div className="mt-4 space-y-1.5" role="status" aria-live="polite">
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span>{t('Downloading package…')}</span>
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
                        style={
                          downloadProgress ? { width: `${downloadProgress.percent}%` } : undefined
                        }
                      />
                    </div>
                  </div>
                ) : null}
                {installPreview && !marketplacePreviewBlocked && marketplaceConflictsResolved ? (
                  <div
                    role="status"
                    className="mt-3 flex gap-2 rounded-md border border-status-success-accent/30 bg-status-success-surface p-3 text-xs text-status-success-foreground dark:bg-status-success-dark-surface/40 dark:text-status-success-dark-foreground"
                  >
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    <div>
                      <strong className="block">{t('Package verified')}</strong>
                      <span className="opacity-80">
                        {t(
                          'The download, checksum, and package structure passed verification. You can continue with installation.'
                        )}
                      </span>
                    </div>
                  </div>
                ) : null}
                {installPreview?.package.overwrite ? (
                  <div className="mt-3 rounded-lg border border-warning-100/50 bg-warning-100/10 p-3 text-xs text-foreground">
                    <p className="font-medium">
                      {t('Update from v{{current}} to v{{incoming}}', {
                        current: installPreview.package.overwrite.currentVersion,
                        incoming: installPreview.package.overwrite.incomingVersion
                      })}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      {t(
                        'Updating replaces this Specialist’s instructions and selected capabilities. Existing resources are kept unless removed separately.'
                      )}
                    </p>
                    {installPreview.package.overwrite.modifiedSinceImport ? (
                      <p className="mt-2 text-warning-900">
                        {t(
                          'Local changes to this Specialist will be replaced by the Marketplace version.'
                        )}
                      </p>
                    ) : null}
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
                {installPreview && marketplacePreviewBlocked ? (
                  <ul className="mt-3 rounded-lg border border-danger-000/30 bg-danger-000/10 p-3 text-xs text-danger-000">
                    {installPreview.package.diagnostics
                      .filter((item) => item.severity === 'error')
                      .map((item) => (
                        <li key={`${item.code}-${item.path ?? ''}`}>
                          <span className="font-medium">{item.code}</span>
                          <span className="block text-muted-foreground">{item.message}</span>
                        </li>
                      ))}
                  </ul>
                ) : null}
                {installError ? (
                  <div className="mt-3">
                    <MarketplaceError message={installError} />
                  </div>
                ) : null}
                <div className="mt-5 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={installBusy}
                    onClick={() => {
                      if (installRecoveryPending) {
                        onNavigate({ kind: 'marketplace' })
                        return
                      }
                      cancelCandidate(installCandidateTokenRef.current)
                      installCandidateTokenRef.current = undefined
                      setReviewing(false)
                      setInstallPreview(undefined)
                      setDownloadProgress(undefined)
                      setSkillConflictResolutions({})
                    }}
                  >
                    {installRecoveryPending ? t('Back to Marketplace') : t('Back')}
                  </Button>
                  {!installRecoveryPending ? (
                    <Button
                      type="button"
                      disabled={
                        installBusy ||
                        marketplacePreviewBlocked ||
                        (marketplaceSkillConflicts.length > 0 && !marketplaceConflictsResolved)
                      }
                      onClick={() => void install()}
                    >
                      {installBusy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                      {installBusy
                        ? t('Downloading and verifying…')
                        : installPreview
                          ? installPreview.package.overwrite
                            ? t('Update Specialist')
                            : t('Install Specialist')
                          : t('Download and review')}
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="p-5">
      <div className="mb-4 flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => onNavigate({ kind: 'list' })}>
          {t('Installed')}
        </Button>
        <SettingsSearchInput
          aria-label={t('Search Marketplace')}
          placeholder={t('Search Marketplace…')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => onNavigate({ kind: 'marketplace-sources' })}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {t('Manage sources')}
        </Button>
      </div>
      {loading ? <MarketplaceLoading label={t('Loading Marketplace…')} /> : null}
      {!loading && loadError ? (
        <MarketplaceError message={loadError} retry={() => void loadMarketplace()} />
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
          retry={() => void loadMarketplace()}
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
        <ul className="divide-y divide-border">
          {visibleListings.map((item) => {
            const installedCurrentVersion = item.installedVersion === item.version
            return (
              <li
                key={`${item.sourceId}:${item.id}`}
                className="flex min-h-16 items-center gap-3 py-3"
              >
                <PackageOpen className="size-5 shrink-0 text-primary" aria-hidden="true" />
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    onNavigate({
                      kind: 'marketplace-release',
                      sourceId: item.sourceId,
                      id: item.id,
                      version: item.version
                    })
                  }
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {item.displayName}
                    </span>
                    {item.installedVersion ? (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        {installedCurrentVersion ? t('Installed') : t('Update available')}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.summary}
                  </span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {item.sourceTrust === 'official' ? t('Official') : t('User-added source')} ·{' '}
                    {item.sourceName} · {item.publisher.name} · v{item.version}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    installedCurrentVersion
                      ? onNavigate({ kind: 'edit', id: item.id })
                      : onNavigate({
                          kind: 'marketplace-release',
                          sourceId: item.sourceId,
                          id: item.id,
                          version: item.version
                        })
                  }
                >
                  {installedCurrentVersion ? t('Open') : t('View')}
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
