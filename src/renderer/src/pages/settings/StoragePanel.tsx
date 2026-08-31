import { AlertDialog } from 'radix-ui'
import {
  CheckCircle2,
  ChevronRight,
  FolderInput,
  FolderOpen,
  RefreshCw,
  TriangleAlert,
  X
} from 'lucide-react'
import { useRef, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
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
import { Input } from '@/components/ui/input'
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat'
import { cn } from '@/lib/utils'
import { DataRootWarning } from '@/components/DataRootWarning'
import { useSettingsStore } from '@/stores/settings-store'
import { useStorageInfoStore } from '@/stores/storage-info-store'
import type {
  DataRootKind,
  DataRootInspection,
  DataRootRecoveryStatus,
  UsageCategoryKey
} from '../../../../shared/storage'
import { SettingsSection } from './SettingsLayout'
import { isAgentRepairCheck } from './settings-navigation'
import { StorageMigrationModal } from './StorageMigrationModal'

// Formats a byte count as a human-readable size (1000-based, one decimal place).
const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1000 && unitIndex < units.length - 1) {
    value /= 1000
    unitIndex += 1
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

// Catalog keys, not resolved strings: a module-level constant is evaluated once at import time, so
// storing translated text here would freeze the language of the first render and never update when
// the user switches. Resolution happens inside the component, on every render.
// `as const` rather than a `: Record<..., string>` annotation so the values stay literal types and
// t() can still key-check them against the catalog.
const CATEGORY_LABEL_KEYS = {
  artifacts: 'Artifacts',
  compute: 'Compute cache',
  delegation: 'Subagent workspaces',
  uploads: 'Uploads',
  runtime: 'Runtime',
  notebooks: 'Notebooks',
  'execution-file-evidence': 'Execution evidence',
  workspaces: 'Session workspaces'
} as const satisfies Record<UsageCategoryKey, string>

// Fixed swatch palette keyed by category so the stacked bar and legend always agree on color,
// even though the bar only renders non-zero segments while the legend lists every category.
const CATEGORY_COLORS: Record<UsageCategoryKey, string> = {
  artifacts: 'bg-storage-artifacts',
  compute: 'bg-storage-compute',
  delegation: 'bg-storage-delegation',
  runtime: 'bg-storage-runtime',
  uploads: 'bg-storage-uploads',
  notebooks: 'bg-storage-notebooks',
  'execution-file-evidence': 'bg-storage-execution-evidence',
  workspaces: 'bg-storage-workspaces'
}

// Shared path-pill style, matching GeneralPanel's log-file display so every settings path reads the same.
const PATH_PILL =
  'overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs text-foreground'

// Storage settings: shows where app data lives, a "New location" picker, and a disk-usage
// breakdown. A picked/typed path is classified via inspectDataRoot: an empty folder offers
// "Change location" (opens StorageMigrationModal, which detects running sessions, confirms the
// interrupt+restart when needed, and drives the actual move); a folder that already contains our
// data offers "Use this folder" instead, which only switches the dataRoot pointer and relaunches -
// no files are moved. A marker-bearing target offers explicit recovery; an invalid target shows an
// inline error and disables both actions.
type StoragePanelProps = {
  onContinueToAgent?: () => void
}

const StoragePanel = ({ onContinueToAgent }: StoragePanelProps): React.JSX.Element => {
  const { t } = useTranslation()
  const { t: tCommon } = useTranslation()
  const formatDate = useDateTimeFormat()
  const environmentCheck = useSettingsStore((state) => state.environmentCheck)
  const environmentCheckError = useSettingsStore((state) => state.environmentCheckError)
  const checkEnvironment = useSettingsStore((state) => state.checkEnvironment)
  const status = useStorageInfoStore((state) => state.status)
  const info = useStorageInfoStore((state) => state.info)
  const scannedAt = useStorageInfoStore((state) => state.scannedAt)
  const isRefreshingUsage = useStorageInfoStore((state) => state.isRefreshing)
  const storageLoadError = useStorageInfoStore((state) => state.loadError)
  const loadStorageStatus = useStorageInfoStore((state) => state.loadStatus)
  const loadStorageInfo = useStorageInfoStore((state) => state.load)
  const refreshStorageInfo = useStorageInfoStore((state) => state.refresh)
  const retryStorageInfo = (): void => {
    void refreshStorageInfo().catch(() => undefined)
  }
  const initialStorageFailure = environmentCheck?.checks.some(
    (check) => check.id === 'storage' && check.status === 'failed'
  )
  const [hasRecheckedStorage, setHasRecheckedStorage] = useState(false)
  const [isCheckingStorage, setIsCheckingStorage] = useState(false)
  const [revealError, setRevealError] = useState<string | undefined>()
  const [newPath, setNewPath] = useState('')
  // The classification of `newPath` (a PARENT the user typed/picked), keyed by the exact path it
  // was computed for so a stale response for an already-superseded path never drives the action
  // buttons. `dataRoot` is the derived `<newPath>/OpenScience` the app will actually use.
  const [inspection, setInspection] = useState<(DataRootInspection & { path: string }) | null>(null)
  const [migrationTarget, setMigrationTarget] = useState<{
    path: string
    recoveryStatus?: DataRootRecoveryStatus
  } | null>(null)
  const [adoptConfirmOpen, setAdoptConfirmOpen] = useState(false)
  const [isAdopting, setIsAdopting] = useState(false)
  const [adoptError, setAdoptError] = useState<string | undefined>(undefined)
  // Error surfaced by "Use default location" when the default parent unexpectedly fails to classify
  // (near-impossible — it's the home directory — but never left as a silent no-op).
  const [defaultError, setDefaultError] = useState<string | undefined>(undefined)
  // The move editor is collapsed behind a "Change location" button; opening it goes through a
  // warning-confirm step (warnOpen) so the user acknowledges before editing (isEditing).
  const [isEditing, setIsEditing] = useState(false)
  const [warnOpen, setWarnOpen] = useState(false)
  const [expandedCategory, setExpandedCategory] = useState<UsageCategoryKey | null>(null)
  // Guards against a stale inspectDataRoot response (from a superseded path) overwriting a newer one.
  const inspectRequestRef = useRef(0)

  useEffect(() => {
    void loadStorageStatus().catch(() => undefined)
    void loadStorageInfo().catch(() => undefined)
  }, [loadStorageInfo, loadStorageStatus])

  const storageCheck = environmentCheck?.checks.find((check) => check.id === 'storage')
  const storagePassed = storageCheck?.status === 'passed'
  const storageRepairActive = Boolean(initialStorageFailure || hasRecheckedStorage)
  const agentRepairRequired =
    storagePassed &&
    Boolean(
      environmentCheck?.checks.some(
        (check) => check.status === 'failed' && isAgentRepairCheck(check.id)
      )
    )

  const handleRevealAppStorage = async (): Promise<void> => {
    setRevealError(undefined)
    try {
      const result = await window.api.storage.revealAppStorage()
      // Backend-supplied failure text passes through verbatim; the catalog copy is the fallback.
      if (!result.revealed)
        setRevealError(result.error ?? t('Could not reveal application storage.'))
    } catch (error) {
      setRevealError(
        error instanceof Error ? error.message : t('Could not reveal application storage.')
      )
    }
  }

  const handleCheckStorage = async (): Promise<void> => {
    setIsCheckingStorage(true)
    setRevealError(undefined)
    try {
      // A user-requested retry must observe changes made after any background launch check began.
      await checkEnvironment({ force: true })
    } finally {
      setHasRecheckedStorage(true)
      setIsCheckingStorage(false)
    }
  }

  // Classifies a candidate path (move / adopt / invalid) so the action button and helper text can
  // route correctly; an empty path clears the classification instead of calling the IPC.
  const inspectPath = async (path: string): Promise<void> => {
    const requestId = ++inspectRequestRef.current
    if (!path) {
      setInspection(null)
      return
    }
    const result = await window.api.storage.inspectDataRoot(path)
    if (inspectRequestRef.current !== requestId) return
    setInspection({ path, ...result })
  }

  const handleBrowse = async (): Promise<void> => {
    const picked = await window.api.storage.pickDirectory()
    if (!picked) return
    setNewPath(picked)
    setAdoptError(undefined)
    await inspectPath(picked)
  }

  const handleNewPathChange = (value: string): void => {
    setNewPath(value)
    setAdoptError(undefined)
    void inspectPath(value.trim())
  }

  const handleCancelNewPath = (): void => {
    setNewPath('')
    setInspection(null)
    setAdoptError(undefined)
    setIsEditing(false)
  }

  const handleMigrationClose = (): void => {
    const resolvedTarget = migrationTarget
    setMigrationTarget(null)
    // Discarding a recovered copy changes its on-disk classification. Refresh the editor instead of
    // leaving a stale `recover` action that would reopen a modal for a marker that no longer exists.
    if (resolvedTarget && inspection?.path === resolvedTarget.path) {
      void inspectPath(resolvedTarget.path)
    }
  }

  const handleAdopt = async (): Promise<void> => {
    setAdoptConfirmOpen(false)
    setIsAdopting(true)
    setAdoptError(undefined)

    const result = await window.api.storage.setDataRootAndRelaunch(trimmedNewPath, false)
    if (!result.ok) {
      setIsAdopting(false)
      setAdoptError(result.error ?? t('Could not switch to this folder.'))
    }
    // On success the app relaunches; nothing left to update here.
  }

  // "Use default location": relocate back to the default `<home>/OpenScience` (the reverse of any
  // other move). The default is reproduced by feeding its parent through the same inspect/migrate
  // flow a browsed folder uses, so the common case (default folder empty or gone → 'move') just
  // opens the migration modal, which moves the data back and restarts. Rare fallbacks: the default
  // folder still holds data ('adopt' → repoint as-is), or it is somehow unusable ('invalid' → error).
  const handleUseDefault = async (): Promise<void> => {
    if (!info) return
    setDefaultError(undefined)
    const result = await window.api.storage.inspectDataRoot(info.defaultParent)
    if (result.kind === 'move') {
      setMigrationTarget({ path: info.defaultParent })
      return
    }
    if (result.kind === 'adopt') {
      setNewPath(info.defaultParent)
      setInspection({ path: info.defaultParent, ...result })
      setIsEditing(true)
      setAdoptConfirmOpen(true)
      return
    }
    if (result.kind === 'recover' && result.recoveryStatus) {
      setMigrationTarget({
        path: info.defaultParent,
        recoveryStatus: result.recoveryStatus
      })
      return
    }
    setDefaultError(result.error ?? t('The default location is not usable.'))
  }

  const trimmedNewPath = newPath.trim()
  // Only trust the classification when it was computed for the exact path currently shown.
  const kind: DataRootKind | null =
    inspection && inspection.path === trimmedNewPath ? inspection.kind : null
  const canChangeLocation = kind === 'move'

  const toggleCategory = (key: UsageCategoryKey): void => {
    setExpandedCategory((current) => (current === key ? null : key))
  }

  const categories = info?.usage.categories ?? []
  const totalBytes = info?.usage.totalBytes ?? 0
  const storageStatus = info ?? status
  // What migration actually moves: everything except runtime/ (rebuilt on demand at the new root).
  const migratableBytes = categories
    .filter((category) => category.key !== 'runtime')
    .reduce((sum, category) => sum + category.bytes, 0)
  const scanTime = scannedAt === null ? undefined : formatDate(scannedAt, 'dateTime')

  return (
    <div className="space-y-5 p-5">
      {storageRepairActive && storageCheck ? (
        <SettingsSection
          title={t('Application storage')}
          description={t('Open Science needs write access to its private configuration directory.')}
          aria-label={t('Application storage')}
        >
          {/* Keep the failure visibly actionable, then remove the warning treatment as soon as a
              user-requested recheck confirms storage is writable again. */}
          <div
            className={cn(
              'space-y-3 rounded-lg border p-3',
              storagePassed ? 'border-border bg-muted/40' : 'border-amber-500/30 bg-amber-500/5'
            )}
          >
            <div className="flex items-start gap-2">
              {storagePassed ? (
                <CheckCircle2
                  className="mt-0.5 size-4 shrink-0 text-emerald-600"
                  aria-hidden="true"
                />
              ) : (
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0 text-amber-600"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{storageCheck.summary}</p>
                {storageCheck.detail ? (
                  <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                    {storageCheck.detail}
                  </pre>
                ) : null}
              </div>
            </div>
            {revealError ? (
              <p className="text-xs text-destructive" role="alert">
                {revealError}
              </p>
            ) : null}
            {environmentCheckError ? (
              <p className="text-xs text-destructive" role="alert">
                {environmentCheckError}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void handleRevealAppStorage()}>
                <FolderOpen className="size-4" aria-hidden="true" />
                {window.api.platform === 'darwin' ? t('Reveal in Finder') : t('Reveal in folder')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={isCheckingStorage}
                onClick={() => void handleCheckStorage()}
              >
                <RefreshCw
                  className={cn('size-4', isCheckingStorage && 'animate-spin')}
                  aria-hidden="true"
                />
                {isCheckingStorage ? t('Checking…') : t('Check again')}
              </Button>
              {agentRepairRequired ? (
                <Button type="button" onClick={onContinueToAgent}>
                  {t('Continue to repair Agent')}
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={t('Data location')}
        description={t(
          'Where Open Science stores your projects, artifacts, and other app data on this device.'
        )}
        aria-label={t('Data location')}
        separated={storageRepairActive}
        action={
          info !== null && !isEditing ? (
            <Button type="button" variant="outline" onClick={() => setWarnOpen(true)}>
              {t('Change location')}
            </Button>
          ) : undefined
        }
      >
        {storageStatus === null ? (
          storageLoadError ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive" role="alert">
                {t('Could not scan storage usage. Try again.')}
              </p>
              <Button type="button" variant="outline" onClick={retryStorageInfo}>
                <RefreshCw className="size-4" aria-hidden="true" />
                {t('Retry')}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('Loading…')}</p>
          )
        ) : (
          <>
            <span className="text-xs font-medium text-muted-foreground">{t('Location')}</span>
            <pre className={cn('mt-1', PATH_PILL)} aria-label={t('Data root path')}>
              {storageStatus.dataRoot}
            </pre>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {info
                ? info.isDefault
                  ? t('{{size}} on disk · default location', {
                      size: formatBytes(info.usage.totalBytes)
                    })
                  : t('{{size}} on disk', { size: formatBytes(info.usage.totalBytes) })
                : t('Scanning…')}
            </p>

            {isEditing && info ? (
              <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
                <label
                  htmlFor="data-dir-path-input"
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  {t('New location')}
                </label>
                <div className="flex gap-2">
                  <Input
                    id="data-dir-path-input"
                    type="text"
                    placeholder={t('/path/to/new/location')}
                    value={newPath}
                    onChange={(event) => handleNewPathChange(event.target.value)}
                    className="flex-1 bg-background font-mono"
                  />
                  <Button type="button" variant="outline" onClick={() => void handleBrowse()}>
                    <FolderOpen className="size-4" aria-hidden="true" />
                    {t('Browse…')}
                  </Button>
                </div>

                {/* Return-to-default lives inside the editor (only after Change location), next to
                    Browse: picking the default folder is just another destination. It runs the same
                    relocation — normally a reversible copy back into the default; if that folder
                    already holds data it adopts it as-is instead. Hidden when already on default. */}
                {!info.isDefault ? (
                  <button
                    type="button"
                    onClick={() => void handleUseDefault()}
                    className="mt-2 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                  >
                    <Trans
                      i18nKey="Or move it back to the default location <path>({{path}})</path>"
                      values={{ path: info.defaultDataRoot }}
                      components={{ path: <span className="font-mono no-underline" /> }}
                    />
                  </button>
                ) : null}

                {defaultError ? (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {defaultError}
                  </p>
                ) : null}

                {(kind === 'move' || kind === 'adopt' || kind === 'recover') && inspection ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    <Trans
                      i18nKey="Data will be stored in <path>{{path}}</path>"
                      values={{ path: inspection.dataRoot }}
                      components={{ path: <span className="font-mono" /> }}
                    />
                  </p>
                ) : null}

                {kind === 'adopt' ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    <Trans
                      i18nKey="This folder already contains Open Science data. It will be <em>used as-is (not merged)</em> — <em>your current data folder is kept, so you can switch back</em>. The app will restart."
                      components={{ em: <strong className="font-semibold text-foreground" /> }}
                    />
                  </p>
                ) : kind === 'recover' ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {inspection?.recoveryStatus === 'verified'
                      ? t(
                          'A verified copy from an interrupted move was found here. You can finish the move without copying everything again, or discard it.'
                        )
                      : t(
                          'An incomplete copy from an interrupted move was found here. Discard it before using this location again.'
                        )}
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-xs text-muted-foreground">
                      <Trans
                        i18nKey="<em>Your existing data (~{{size}}) will be moved</em> to the new location — your files come with it, and nothing is left behind in the current folder."
                        values={{ size: formatBytes(migratableBytes) }}
                        components={{ em: <strong className="font-semibold text-foreground" /> }}
                      />
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(
                        'Python/R environments are rebuilt at the new location on first use (not moved).'
                      )}
                    </p>
                  </>
                )}

                {kind === 'invalid' && inspection?.error ? (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {inspection.error}
                  </p>
                ) : null}

                {adoptError ? (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {adoptError}
                  </p>
                ) : null}

                <div className="mt-3 flex gap-2">
                  {kind === 'adopt' ? (
                    <Button
                      type="button"
                      disabled={isAdopting}
                      onClick={() => setAdoptConfirmOpen(true)}
                    >
                      <FolderInput className="size-4" aria-hidden="true" />
                      {isAdopting ? t('Switching…') : t('Use this folder')}
                    </Button>
                  ) : kind === 'recover' && inspection?.recoveryStatus ? (
                    <Button
                      type="button"
                      onClick={() =>
                        setMigrationTarget({
                          path: trimmedNewPath,
                          recoveryStatus: inspection.recoveryStatus
                        })
                      }
                    >
                      <FolderInput className="size-4" aria-hidden="true" />
                      {t('Resolve unfinished move')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      disabled={!canChangeLocation}
                      onClick={() => setMigrationTarget({ path: trimmedNewPath })}
                    >
                      <FolderInput className="size-4" aria-hidden="true" />
                      {t('Change location')}
                    </Button>
                  )}
                  <Button type="button" variant="outline" onClick={handleCancelNewPath}>
                    {tCommon('Cancel')}
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>

      {storageStatus !== null ? (
        <SettingsSection
          title={t('Disk usage')}
          description={scanTime ? t('Last scanned {{time}}', { time: scanTime }) : undefined}
          aria-label={t('Disk usage')}
          separated
          action={
            info ? (
              <Button
                type="button"
                variant="outline"
                disabled={isRefreshingUsage}
                onClick={retryStorageInfo}
              >
                <RefreshCw
                  className={cn('size-4', isRefreshingUsage && 'animate-spin')}
                  aria-hidden="true"
                />
                {storageLoadError ? t('Retry') : t('Refresh')}
              </Button>
            ) : undefined
          }
        >
          {info === null ? (
            storageLoadError ? (
              <div className="space-y-2">
                <p className="text-sm text-destructive" role="alert">
                  {t('Could not scan storage usage. Try again.')}
                </p>
                <Button type="button" variant="outline" onClick={retryStorageInfo}>
                  <RefreshCw className="size-4" aria-hidden="true" />
                  {t('Retry')}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t('Scanning…')}</p>
            )
          ) : (
            <>
              {storageLoadError ? (
                <p className="mb-3 text-sm text-destructive" role="alert">
                  {t('Could not scan storage usage. Try again.')}
                </p>
              ) : null}
              {totalBytes > 0 ? (
                <div className="flex h-2 gap-0.5 overflow-hidden rounded bg-muted">
                  {categories
                    .filter((category) => category.bytes > 0)
                    .map((category) => (
                      <div
                        key={category.key}
                        className={cn('rounded', CATEGORY_COLORS[category.key])}
                        style={{ width: `${(category.bytes / totalBytes) * 100}%` }}
                        title={t('{{label}}: {{size}}', {
                          label: t(CATEGORY_LABEL_KEYS[category.key]),
                          size: formatBytes(category.bytes)
                        })}
                      />
                    ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t('No data yet.')}</p>
              )}

              <div className="mt-2 space-y-1.5">
                {categories.map((category) => {
                  const hasChildren = (category.children?.length ?? 0) > 0
                  const isExpanded = expandedCategory === category.key

                  return (
                    <div key={category.key}>
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn('size-2 rounded-sm', CATEGORY_COLORS[category.key])}
                            aria-hidden="true"
                          />
                          {hasChildren ? (
                            <button
                              type="button"
                              aria-expanded={isExpanded}
                              onClick={() => toggleCategory(category.key)}
                              className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                            >
                              {t(CATEGORY_LABEL_KEYS[category.key])}
                              <ChevronRight
                                className={cn(
                                  'size-3 transition-transform',
                                  isExpanded && 'rotate-90'
                                )}
                                aria-hidden="true"
                              />
                            </button>
                          ) : (
                            <span className="text-muted-foreground">
                              {t(CATEGORY_LABEL_KEYS[category.key])}
                            </span>
                          )}
                        </div>
                        <span className="tabular-nums text-muted-foreground">
                          {formatBytes(category.bytes)}
                        </span>
                      </div>

                      {hasChildren && isExpanded ? (
                        <div className="mt-1 mb-1.5 space-y-1 pl-[14px]">
                          {category.children?.map((child) => (
                            <div
                              key={child.name}
                              className="flex items-center justify-between gap-2 text-xs"
                            >
                              <span className="truncate text-muted-foreground" title={child.name}>
                                {child.name}
                              </span>
                              <span className="shrink-0 tabular-nums text-muted-foreground">
                                {formatBytes(child.bytes)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )
                })}

                <div className="flex items-center justify-between border-t border-border pt-1.5 text-xs">
                  <span className="font-medium text-foreground">{t('Total')}</span>
                  <span className="font-medium tabular-nums text-foreground">
                    {formatBytes(totalBytes)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t('Available on disk')}</span>
                  <span className="tabular-nums">{formatBytes(info.availableBytes)}</span>
                </div>
              </div>
            </>
          )}
        </SettingsSection>
      ) : null}

      <AlertDialog.Root open={warnOpen} onOpenChange={setWarnOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(440px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Change data location?')}
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>

            <div className={dialogBodyClassName}>
              <AlertDialog.Description className={dialogDescriptionClassName}>
                {t("You can move Open Science's data to another folder on this device.")}
              </AlertDialog.Description>
              <div className="mt-3">
                <DataRootWarning />
              </div>
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                  {tCommon('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button
                  type="button"
                  onClick={() => {
                    setWarnOpen(false)
                    setIsEditing(true)
                  }}
                >
                  {tCommon('Continue')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root open={adoptConfirmOpen} onOpenChange={setAdoptConfirmOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={dialogOverlayClassName} />
          <AlertDialog.Content
            className={dialogPanelClassName('w-[min(420px,calc(100vw-2rem))] p-0')}
          >
            <div className={dialogHeaderClassName}>
              <div className="min-w-0">
                <AlertDialog.Title className={dialogTitleClassName}>
                  {t('Use this folder?')}
                </AlertDialog.Title>
              </div>
              <AlertDialog.Cancel asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('Close')}
                  className={dialogCloseButtonClassName}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </AlertDialog.Cancel>
            </div>

            <div className={dialogBodyClassName}>
              <pre className={PATH_PILL}>{inspection?.dataRoot ?? trimmedNewPath}</pre>
              <AlertDialog.Description className={cn(dialogDescriptionClassName, 'mt-3')}>
                <Trans
                  i18nKey="Open Science will restart and use this folder as-is — <em>its contents are not merged with your current data</em>, and anything it's missing will show as unavailable. <em>Your current data folder is left untouched, so you can switch back.</em>"
                  components={{ em: <strong className="font-semibold text-text-000" /> }}
                />
              </AlertDialog.Description>
            </div>

            <div className={dialogFooterClassName}>
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="ghost" className={dialogCancelButtonClassName}>
                  {tCommon('Cancel')}
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button type="button" onClick={() => void handleAdopt()}>
                  {t('Use this folder')}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {migrationTarget !== null ? (
        <StorageMigrationModal
          targetPath={migrationTarget.path}
          recoveryStatus={migrationTarget.recoveryStatus}
          onClose={handleMigrationClose}
        />
      ) : null}
    </div>
  )
}

export { StoragePanel }
