import { AlertDialog } from 'radix-ui'
import { ChevronRight, FolderInput, FolderOpen } from 'lucide-react'
import { useRef, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { DataRootWarning } from '@/components/DataRootWarning'
import type { DataRootKind, StorageInfo, UsageCategoryKey } from '../../../../shared/storage'
import { SettingsSection } from './SettingsLayout'
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

const CATEGORY_LABELS: Record<UsageCategoryKey, string> = {
  artifacts: 'Artifacts',
  uploads: 'Uploads',
  runtime: 'Runtime',
  notebooks: 'Notebooks'
}

// Fixed swatch palette keyed by category so the stacked bar and legend always agree on color,
// even though the bar only renders non-zero segments while the legend lists every category.
const CATEGORY_COLORS: Record<UsageCategoryKey, string> = {
  artifacts: 'bg-sky-500',
  runtime: 'bg-violet-500',
  uploads: 'bg-amber-500',
  notebooks: 'bg-emerald-500'
}

// Shared path-pill style, matching GeneralPanel's log-file display so every settings path reads the same.
const PATH_PILL =
  'overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted/60 px-3 py-2.5 font-mono text-xs text-foreground'

// Storage settings: shows where app data lives, a "New location" picker, and a disk-usage
// breakdown. A picked/typed path is classified via inspectDataRoot: an empty folder offers
// "Change location" (opens StorageMigrationModal, which detects running sessions, confirms the
// interrupt+restart when needed, and drives the actual move); a folder that already contains our
// data offers "Use this folder" instead, which only switches the dataRoot pointer and relaunches -
// no files are moved. An invalid target shows an inline error and disables both actions.
const StoragePanel = (): React.JSX.Element => {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [newPath, setNewPath] = useState('')
  // The classification of `newPath` (a PARENT the user typed/picked), keyed by the exact path it
  // was computed for so a stale response for an already-superseded path never drives the action
  // buttons. `dataRoot` is the derived `<newPath>/OpenScience` the app will actually use.
  const [inspection, setInspection] = useState<{
    path: string
    kind: DataRootKind
    dataRoot: string
    error?: string
    warning?: string
  } | null>(null)
  const [migrationTarget, setMigrationTarget] = useState<string | null>(null)
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
    void window.api.storage.getInfo().then(setInfo)
  }, [])

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

  const handleAdopt = async (): Promise<void> => {
    setAdoptConfirmOpen(false)
    setIsAdopting(true)
    setAdoptError(undefined)

    const result = await window.api.storage.setDataRootAndRelaunch(trimmedNewPath, false)
    if (!result.ok) {
      setIsAdopting(false)
      setAdoptError(result.error ?? 'Could not switch to this folder.')
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
      setMigrationTarget(info.defaultParent)
      return
    }
    if (result.kind === 'adopt') {
      setNewPath(info.defaultParent)
      setInspection({ path: info.defaultParent, ...result })
      setIsEditing(true)
      setAdoptConfirmOpen(true)
      return
    }
    setDefaultError(result.error ?? 'The default location is not usable.')
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
  // What migration actually moves: everything except runtime/ (rebuilt on demand at the new root).
  const migratableBytes = categories
    .filter((category) => category.key !== 'runtime')
    .reduce((sum, category) => sum + category.bytes, 0)

  return (
    <div className="space-y-5 p-5">
      <SettingsSection
        title="Data location"
        description="Where Open Science stores your projects, artifacts, and other app data on this device."
        aria-label="Data location"
        action={
          info !== null && !isEditing ? (
            <Button type="button" variant="outline" onClick={() => setWarnOpen(true)}>
              Change location
            </Button>
          ) : undefined
        }
      >
        {info === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <span className="text-xs font-medium text-muted-foreground">Location</span>
            <pre className={cn('mt-1', PATH_PILL)} aria-label="Data root path">
              {info.dataRoot}
            </pre>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {info.isDefault
                ? `${formatBytes(info.usage.totalBytes)} on disk · default location`
                : `${formatBytes(info.usage.totalBytes)} on disk`}
            </p>

            {isEditing ? (
              <div className="mt-3 rounded-lg border border-border bg-muted/40 p-3">
                <label
                  htmlFor="data-dir-path-input"
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  New location
                </label>
                <div className="flex gap-2">
                  <Input
                    id="data-dir-path-input"
                    type="text"
                    placeholder="/path/to/new/location"
                    value={newPath}
                    onChange={(event) => handleNewPathChange(event.target.value)}
                    className="flex-1 bg-background font-mono"
                  />
                  <Button type="button" variant="outline" onClick={() => void handleBrowse()}>
                    <FolderOpen className="size-4" aria-hidden="true" />
                    Browse…
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
                    Or move it back to the default location
                  </button>
                ) : null}

                {defaultError ? (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {defaultError}
                  </p>
                ) : null}

                {(kind === 'move' || kind === 'adopt') && inspection ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Data will be stored in <span className="font-mono">{inspection.dataRoot}</span>
                  </p>
                ) : null}

                {kind === 'adopt' ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    This folder already contains Open Science data. It will be{' '}
                    <strong className="font-semibold text-foreground">
                      used as-is (not merged)
                    </strong>
                    —{' '}
                    <strong className="font-semibold text-foreground">
                      your current data folder is kept, so you can switch back
                    </strong>
                    . The app will restart.
                  </p>
                ) : (
                  <>
                    <p className="mt-2 text-xs text-muted-foreground">
                      <strong className="font-semibold text-foreground">
                        Your existing data (~{formatBytes(migratableBytes)}) will be moved
                      </strong>{' '}
                      to the new location — your files come with it, and nothing is left behind in
                      the current folder.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Python/R environments are rebuilt at the new location on first use (not
                      moved).
                    </p>
                  </>
                )}

                {/* Non-blocking caution (e.g. spaced path on macOS/Linux): the action stays enabled,
                    but the user is told before committing. */}
                {kind && inspection?.warning ? (
                  <p
                    className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400"
                    role="alert"
                  >
                    {inspection.warning}
                  </p>
                ) : null}

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
                      {isAdopting ? 'Switching…' : 'Use this folder'}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      disabled={!canChangeLocation}
                      onClick={() => setMigrationTarget(trimmedNewPath)}
                    >
                      <FolderInput className="size-4" aria-hidden="true" />
                      Change location
                    </Button>
                  )}
                  <Button type="button" variant="outline" onClick={handleCancelNewPath}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </SettingsSection>

      {info !== null ? (
        <SettingsSection title="Disk usage" aria-label="Disk usage" separated>
          {totalBytes > 0 ? (
            <div className="flex h-2 gap-0.5 overflow-hidden rounded bg-muted">
              {categories
                .filter((category) => category.bytes > 0)
                .map((category) => (
                  <div
                    key={category.key}
                    className={cn('rounded', CATEGORY_COLORS[category.key])}
                    style={{ width: `${(category.bytes / totalBytes) * 100}%` }}
                    title={`${CATEGORY_LABELS[category.key]}: ${formatBytes(category.bytes)}`}
                  />
                ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No data yet.</p>
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
                          {CATEGORY_LABELS[category.key]}
                          <ChevronRight
                            className={cn('size-3 transition-transform', isExpanded && 'rotate-90')}
                            aria-hidden="true"
                          />
                        </button>
                      ) : (
                        <span className="text-muted-foreground">
                          {CATEGORY_LABELS[category.key]}
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
              <span className="font-medium text-foreground">Total</span>
              <span className="font-medium tabular-nums text-foreground">
                {formatBytes(totalBytes)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Available on disk</span>
              <span className="tabular-nums">{formatBytes(info.availableBytes)}</span>
            </div>
          </div>
        </SettingsSection>
      ) : null}

      <AlertDialog.Root open={warnOpen} onOpenChange={setWarnOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
            <AlertDialog.Title className="text-base font-semibold text-text-000">
              Change data location?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-text-100">
              You can move Open Science&apos;s data to another folder on this device.
            </AlertDialog.Description>
            <div className="mt-3">
              <DataRootWarning />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  Cancel
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
                  Continue
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root open={adoptConfirmOpen} onOpenChange={setAdoptConfirmOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/25 backdrop-blur-[2px]" />
          <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-000 p-6 text-text-000 shadow-dialog">
            <AlertDialog.Title className="text-base font-semibold text-text-000">
              Use this folder?
            </AlertDialog.Title>
            <pre className={cn('mt-3', PATH_PILL)}>{inspection?.dataRoot ?? trimmedNewPath}</pre>
            <AlertDialog.Description className="mt-3 text-sm leading-relaxed text-text-100">
              Open Science will restart and use this folder as-is —{' '}
              <strong className="font-semibold text-text-000">
                its contents are not merged with your current data
              </strong>
              , and anything it&apos;s missing will show as unavailable.{' '}
              <strong className="font-semibold text-text-000">
                Your current data folder is left untouched, so you can switch back.
              </strong>
            </AlertDialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button type="button" onClick={() => void handleAdopt()}>
                  Use this folder
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {migrationTarget !== null ? (
        <StorageMigrationModal
          targetPath={migrationTarget}
          onClose={() => setMigrationTarget(null)}
        />
      ) : null}
    </div>
  )
}

export { StoragePanel }
