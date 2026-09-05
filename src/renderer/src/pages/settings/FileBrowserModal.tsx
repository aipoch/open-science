// Remote file browser modal (compute-file-preview, issue 02 + issue 03).
// Opened from the ComputePanel host card folder-icon button (and later from the Files panel Remote
// dropdown, issue 05). Presents a directory listing with navigation, a detail panel for
// selected files, and a Go-to dropdown with Scratch / Home / Pin / bookmarks.
//
// Design decisions (from design.md):
//   - No inline content preview: detail panel shows SIZE / MODIFIED / TYPE + "No preview · <size>"
//   - Selecting a file does NOT trigger any remote content request
//   - Transport = find -printf via exec SshRunner (no sftp, no ssh2)
//   - Bookmarks persist in settings JSON (keyed by provider_id)
//   - Download → OS Downloads via scp (issue 03); Add to project → artifact (issue 03)
//   - Neither Download nor Add to project triggers an approval card (human actions, no gate)

import {
  ArrowLeft,
  ArrowUp,
  Bookmark,
  ChevronDown,
  ClipboardCopy,
  Download,
  FolderOpen,
  Folder,
  File,
  MapPin,
  RefreshCw,
  X
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { formatDisplayDateTime } from '@/lib/locale-format'

import type { DirListing, RemoteDirEntry } from '../../../../shared/remote-fs'
import type { ComputeAuthenticationErrorCode } from '../../../../shared/compute'
import { resolveRemotePath, validateRemotePath } from '../../../../shared/remote-fs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { computeRuntimeRecoveryAction } from './compute-runtime-recovery'
import { fileBrowserRemoteError } from './file-browser-remote-error'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns a human-readable relative time string from a mtime timestamp.
const relativeTime = (mtimeMs: number, t: TFunction): string => {
  const ageMs = Date.now() - mtimeMs
  const sec = Math.round(ageMs / 1000)
  if (sec < 60) return t('{{count}}s', { count: sec })
  const min = Math.round(sec / 60)
  if (min < 60) return t('{{count}}m', { count: min })
  const hr = Math.round(min / 60)
  if (hr < 24) return t('{{count}}h', { count: hr })
  const days = Math.round(hr / 24)
  return t('{{count}}d', { count: days })
}

// Formats a byte count as a short human-readable string.
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

// Infers a file type label from the extension. Purely presentational.
const inferType = (name: string): string => {
  const dot = name.lastIndexOf('.')
  if (dot === -1 || dot === name.length - 1) return 'file'
  const ext = name.slice(dot + 1).toLowerCase()
  const map: Record<string, string> = {
    py: 'Python',
    ipynb: 'Notebook',
    sh: 'Shell',
    txt: 'Text',
    csv: 'CSV',
    tsv: 'TSV',
    json: 'JSON',
    yaml: 'YAML',
    yml: 'YAML',
    md: 'Markdown',
    pdf: 'PDF',
    png: 'Image',
    jpg: 'Image',
    jpeg: 'Image',
    gif: 'Image',
    svg: 'SVG',
    zip: 'Archive',
    tar: 'Archive',
    gz: 'Archive',
    bz2: 'Archive',
    h5: 'HDF5',
    hdf5: 'HDF5',
    nc: 'NetCDF',
    r: 'R',
    rds: 'R Data',
    exe: 'Binary',
    so: 'Library',
    dylib: 'Library',
    log: 'Log'
  }
  return map[ext] ?? ext.toUpperCase()
}

// Returns the parent path (removes the last path component). Returns '/' at the root.
const parentPath = (p: string): string => {
  if (p === '/') return '/'
  const idx = p.lastIndexOf('/')
  if (idx <= 0) return '/'
  return p.slice(0, idx)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BrowserState =
  | { kind: 'loading' }
  | { kind: 'ok'; listing: DirListing; providerId: string }
  | {
      kind: 'error'
      detail: string
      kind_hint?: string
      authenticationCode?: ComputeAuthenticationErrorCode
    }

type SelectedRemoteFile = {
  entry: RemoteDirEntry
  providerId: string
  resolvedDir: string
}

type BookmarksState =
  | { kind: 'loading'; items: string[] }
  | { kind: 'ready'; items: string[] }
  | { kind: 'error'; items: string[]; summary: string; detail: string }

type GoToItem = { label: string; path: string; icon: React.ReactNode }

// ---------------------------------------------------------------------------
// DetailPanel — right-side file detail panel (no remote content requests)
// ---------------------------------------------------------------------------

type DetailPanelProps = {
  entry: RemoteDirEntry
  // The resolved absolute path of the containing directory.
  resolvedDir: string
  // The provider id for the host, used for download IPC calls.
  providerId: string
  // The project name to import into (undefined when no project is active).
  activeProjectId?: string
  onClose: () => void
  onManageCredentials: (providerId: string, errorCode: ComputeAuthenticationErrorCode) => void
}

// Short-lived action status shown in the detail panel after Download / Add to project.
type ActionStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; action: 'download' | 'import' }
  | {
      kind: 'success'
      action: 'download' | 'import'
      name: string
      filePath?: string
    }
  | {
      kind: 'error'
      message: string
      authenticationCode?: ComputeAuthenticationErrorCode
    }

function DetailPanel({
  entry,
  resolvedDir,
  providerId,
  activeProjectId,
  onClose,
  onManageCredentials
}: DetailPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [actionStatus, setActionStatus] = useState<ActionStatus>({ kind: 'idle' })
  const remoteAbsPath = `${resolvedDir.replace(/\/$/, '')}/${entry.name}`

  const copyPath = async (): Promise<void> => {
    await navigator.clipboard.writeText(remoteAbsPath)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Download → OS Downloads folder (no approval gate).
  const handleDownload = async (): Promise<void> => {
    setActionStatus({ kind: 'loading', action: 'download' })
    try {
      const result = await window.api.compute.download(providerId, remoteAbsPath, {
        kind: 'os-downloads'
      })
      setActionStatus({
        kind: 'success',
        action: 'download',
        name: result.name,
        filePath: result.path
      })
    } catch (err) {
      const decoded = fileBrowserRemoteError(err, t, t('Download failed'))
      setActionStatus({
        kind: 'error',
        message: decoded.detail,
        authenticationCode: decoded.authenticationCode
      })
    }
  }

  // Reveal in Finder/Explorer after a successful download.
  const handleReveal = (filePath: string): void => {
    void window.api.compute.revealInFolder(filePath)
  }

  // "Add to project" (artifact import) is intentionally not wired yet — see the disabled button
  // below and issue 06 (compute-file-preview). The ComputeService.download(dest='artifact') path
  // exists but no caller persists the temp file into the project artifact store.

  const isLoading = actionStatus.kind === 'loading'

  return (
    <div className="flex w-52 shrink-0 flex-col border-l border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          {t('Details')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('Close detail panel')}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3">
        <div>
          <File className="mb-1 size-8 text-muted-foreground" aria-hidden="true" />
          <p className="break-all text-xs font-medium text-foreground">{entry.name}</p>
        </div>

        <div className="space-y-1.5">
          <MetaRow label={t('SIZE')} value={formatSize(entry.size)} />
          <MetaRow label={t('MODIFIED')} value={formatDisplayDateTime(entry.mtimeMs)} />
          <MetaRow label={t('TYPE')} value={t(inferType(entry.name))} />
        </div>

        {/* No preview placeholder */}
        <div className="rounded border border-dashed border-border bg-muted/30 px-3 py-4 text-center">
          <p className="text-xs text-muted-foreground">
            {t('No preview ·')} {formatSize(entry.size)}
          </p>
        </div>

        {/* Action status banner */}
        {actionStatus.kind === 'success' && (
          <div className="rounded bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 px-2 py-1.5 text-xs text-emerald-700 dark:text-emerald-300 space-y-1">
            <p>
              {actionStatus.action === 'download'
                ? t('Saved to Downloads: {{name}}', { name: actionStatus.name })
                : t('Added to project: {{name}}', { name: actionStatus.name })}
            </p>
            {actionStatus.action === 'download' && actionStatus.filePath && (
              <button
                type="button"
                className="underline text-xs"
                onClick={() => handleReveal(actionStatus.filePath!)}
              >
                {t('Show in Finder')}
              </button>
            )}
          </div>
        )}
        {actionStatus.kind === 'error' && (
          <div
            role="alert"
            className="rounded bg-destructive/10 border border-destructive/30 px-2 py-1.5 text-xs text-destructive"
          >
            <p>{actionStatus.message}</p>
            {actionStatus.authenticationCode ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1.5 text-xs"
                onClick={() => onManageCredentials(providerId, actionStatus.authenticationCode!)}
              >
                {computeRuntimeRecoveryAction(actionStatus.authenticationCode, t)}
              </Button>
            ) : null}
          </div>
        )}

        {/* Download → OS Downloads (no approval) */}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full gap-1.5 text-xs"
          disabled={isLoading}
          onClick={() => void handleDownload()}
          aria-label={t('Download file to OS Downloads folder')}
        >
          <Download className="size-3.5" />
          {actionStatus.kind === 'loading' && actionStatus.action === 'download'
            ? t('Downloading…')
            : t('Download')}
        </Button>

        {/* Add to project → artifact. Disabled until artifact persistence is wired: the download
            currently scp's to a temp dir but nothing writes it to the project artifact store, so
            enabling it would show a misleading "success" with no artifact. Tracked in issue 06
            (compute-file-preview). */}
        {activeProjectId && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full gap-1.5 text-xs"
            disabled
            title={t('Coming soon — remote import to project artifacts is not yet available')}
            aria-label={t('Add file to current project as artifact (coming soon)')}
          >
            <FolderOpen className="size-3.5" />
            {t('Add to project')}
          </Button>
        )}

        {/* Copy path — pure front-end, no remote request */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full gap-1.5 text-xs"
          onClick={() => void copyPath()}
          aria-label={t('Copy remote absolute path to clipboard')}
        >
          <ClipboardCopy className="size-3.5" />
          {copied ? t('Copied!') : t('Copy path')}
        </Button>
      </div>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-foreground">{value}</span>
    </div>
  )
}

type FileBrowserModalProps = {
  open: boolean
  onClose: () => void
  initialProviderId?: string
  // Directory to open at (e.g. a job's remote_workdir). When omitted, the host's scratchRoot is
  // used. Applied on the open edge and once the requested provider is active; a later manual host
  // switch navigates to that host's scratchRoot instead.
  initialPath?: string
}

export function FileBrowserModal({
  open,
  onClose,
  initialProviderId,
  initialPath
}: FileBrowserModalProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const hosts = useComputeStore((s) => s.hosts)
  const probeHost = useComputeStore((s) => s.probeHost)
  const openSettingsToComputeAuthentication = useSettingsStore(
    (state) => state.openSettingsToComputeAuthentication
  )
  // Active project for "Add to project" — derived from navigation state.
  const activeProjectId = useNavigationStore((s) => s.activeProjectId)
  const projects = useProjectStore((s) => s.projects)
  const activeProject = projects.find((p) => p.id === activeProjectId)

  // Active host — defaults to initialProviderId or the first configured host.
  const [activeProviderId, setActiveProviderId] = useState<string | undefined>(
    initialProviderId ?? hosts[0]?.providerId
  )
  const host = hosts.find((h) => h.providerId === activeProviderId) ?? hosts[0]

  // Navigation state
  const [cwd, setCwd] = useState<string>('~')
  const [history, setHistory] = useState<string[]>([])
  const [browserState, setBrowserState] = useState<BrowserState>({ kind: 'loading' })
  const [selected, setSelected] = useState<SelectedRemoteFile | null>(null)
  const navigationGeneration = useRef(0)

  // Address bar
  const [addressInput, setAddressInput] = useState('')
  const [addressEditing, setAddressEditing] = useState(false)

  // Bookmarks
  const [bookmarksState, setBookmarksState] = useState<BookmarksState>({
    kind: 'loading',
    items: []
  })
  const bookmarksGeneration = useRef(0)
  const bookmarks = bookmarksState.items

  // Go-to dropdown open state
  const [gotoOpen, setGotoOpen] = useState(false)

  // Open-edge detection + one-shot target directory for the current open session (e.g. a job's
  // remote_workdir). Tracked as state (not refs) so it works with the "adjust state during render"
  // pattern below without touching refs mid-render. `pending` is null when nothing is queued, or
  // `{ path }` on the closed→open edge (path may be undefined → fall back to scratchRoot). It is
  // consumed by the navigation effect so a later manual host switch goes to that host's scratchRoot.
  const [prevOpen, setPrevOpen] = useState(open)
  const [pending, setPending] = useState<{ path?: string } | null>(
    open ? { path: initialPath } : null
  )

  const navigate = useCallback(
    async (path: string, pushHistory = true) => {
      if (!host) return
      const providerId = host.providerId
      // Renderer IPC cannot be cancelled. Only the latest navigation may commit its result.
      const generation = ++navigationGeneration.current
      const isCurrent = (): boolean => navigationGeneration.current === generation
      if (pushHistory && cwd !== path) {
        setHistory((h) => [...h, cwd])
      }
      setCwd(path)
      setSelected(null)
      setBrowserState({ kind: 'loading' })
      try {
        const listing = await window.api.compute.listDir(providerId, path)
        if (!isCurrent()) return
        setBrowserState({ kind: 'ok', listing, providerId })
        // Update cwd to resolvedPath so the address bar reflects the real path.
        setCwd(listing.resolvedPath)
        setAddressInput(listing.resolvedPath)
      } catch (err) {
        if (!isCurrent()) return
        const decoded = fileBrowserRemoteError(err, t, t('Unknown error'))
        setBrowserState({
          kind: 'error',
          detail: decoded.detail,
          kind_hint: decoded.remoteKind,
          authenticationCode: decoded.authenticationCode
        })
        // Connection failure means the probe result is stale — re-probe in the background so
        // the host chip reflects the current unreachable state (green → grey).
        if (decoded.remoteKind === 'connection') {
          void probeHost(providerId).catch(() => undefined)
        }
      }
    },
    [host, cwd, probeHost, t]
  )

  const invalidatePendingRequests = useCallback((): void => {
    navigationGeneration.current += 1
    bookmarksGeneration.current += 1
  }, [])

  // Adjust state during render on the open edge (React's "adjust state when a prop changes" pattern
  // — https://react.dev/learn/you-might-not-need-an-effect). The modal stays mounted across opens in
  // JobDetailModal, so without this re-sync activeProviderId would stay stale for a different job's
  // provider. Setting state during render (not in an effect) lets React re-render immediately with
  // the correct provider before committing, avoiding a stale-host flash.
  if (open !== prevOpen) {
    setPrevOpen(open)
    setPending(open ? { path: initialPath } : null)
    if (open && initialProviderId && initialProviderId !== activeProviderId) {
      setActiveProviderId(initialProviderId)
    }
  }

  // Initial navigation when modal opens or host changes. Consuming `pending` (setPending(null))
  // happens inside the async IIFE — the same place the other nav-state resets already run — so this
  // effect never sets state synchronously in its body. `pending` is intentionally NOT in the deps:
  // it is read once per open/host change; consuming it must not itself re-fire the effect.
  useEffect(() => {
    if (!open || !host) return
    // While the open-edge sync switches to the requested provider, `host` may lag by one render.
    // Skip navigating the stale host so we don't flash its scratchRoot; the effect re-fires once
    // activeProviderId (and thus host) catches up.
    if (initialProviderId && host.providerId !== initialProviderId && pending) return
    // Consume the one-shot target: use it on the open edge, else fall back to scratchRoot.
    const startPath = pending?.path ?? host.scratchRoot ?? '~'
    void (async () => {
      if (pending) setPending(null)
      setCwd(startPath)
      setHistory([])
      setSelected(null)
      setAddressInput(startPath)
      await navigate(startPath, false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host?.providerId])

  const bookmarkProviderId = host?.providerId

  // Load bookmarks when host changes.
  useEffect(() => {
    if (!open || !bookmarkProviderId) return
    const providerId = bookmarkProviderId
    // Host switches and bookmark writes invalidate older reads through the shared generation.
    const generation = ++bookmarksGeneration.current
    const isCurrent = (): boolean => bookmarksGeneration.current === generation
    void (async () => {
      await Promise.resolve()
      if (!isCurrent()) return
      setBookmarksState({ kind: 'loading', items: [] })
      try {
        const items = await window.api.compute.bookmarksGet(providerId)
        if (!isCurrent()) return
        setBookmarksState({ kind: 'ready', items })
      } catch (error) {
        if (!isCurrent()) return
        const detail =
          error instanceof Error && error.message ? error.message : t('Failed to load bookmarks.')
        setBookmarksState({
          kind: 'error',
          items: [],
          summary: t("Couldn't load bookmarks."),
          detail
        })
      }
    })()
  }, [bookmarkProviderId, open, t])

  useEffect(() => {
    if (!open) invalidatePendingRequests()
  }, [invalidatePendingRequests, open])

  const handleBack = (): void => {
    const prev = history[history.length - 1]
    if (!prev) return
    setHistory((h) => h.slice(0, -1))
    void navigate(prev, false)
  }

  const handleUp = (): void => {
    const listing = browserState.kind === 'ok' ? browserState.listing : null
    const parent = parentPath(listing?.resolvedPath ?? cwd)
    void navigate(parent)
  }

  const handleRefresh = (): void => {
    void navigate(cwd, false)
  }

  const handleAddressSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    const resolved = resolveRemotePath(cwd, addressInput.trim())
    if (validateRemotePath(resolved) === 'outside_roots') {
      setBrowserState({
        kind: 'error',
        detail: t('Path must be absolute and contain no control characters.'),
        kind_hint: 'outside_roots'
      })
      return
    }
    setAddressEditing(false)
    void navigate(resolved)
  }

  const handleOpenDirectory = (entry: RemoteDirEntry): void => {
    if (!entry.isDirectory) return
    const listing = browserState.kind === 'ok' ? browserState.listing : null
    const next = `${(listing?.resolvedPath ?? cwd).replace(/\/$/, '')}/${entry.name}`
    void navigate(next)
  }

  const saveBookmarks = async (
    providerId: string,
    next: string[],
    previous: string[]
  ): Promise<void> => {
    const generation = ++bookmarksGeneration.current
    const isCurrent = (): boolean => bookmarksGeneration.current === generation
    setBookmarksState({ kind: 'ready', items: next })
    try {
      await window.api.compute.bookmarksSet(providerId, next)
    } catch (error) {
      if (!isCurrent()) return
      const detail =
        error instanceof Error && error.message ? error.message : t('Failed to update bookmarks.')
      setBookmarksState({
        kind: 'error',
        items: previous,
        summary: t("Couldn't update bookmarks."),
        detail
      })
    }
  }

  const handlePinCurrent = async (): Promise<void> => {
    if (!host || bookmarksState.kind === 'loading') return
    const path = browserState.kind === 'ok' ? browserState.listing.resolvedPath : cwd
    if (bookmarks.includes(path)) return
    const providerId = browserState.kind === 'ok' ? browserState.providerId : host.providerId
    const next = [...bookmarks, path]
    setGotoOpen(false)
    await saveBookmarks(providerId, next, bookmarks)
  }

  const handleRemoveBookmark = async (path: string): Promise<void> => {
    if (!host || bookmarksState.kind === 'loading') return
    const next = bookmarks.filter((b) => b !== path)
    await saveBookmarks(host.providerId, next, bookmarks)
  }

  const handleHostSelect = (providerId: string): void => {
    if (providerId === activeProviderId) return
    invalidatePendingRequests()
    setActiveProviderId(providerId)
    setSelected(null)
    setBrowserState({ kind: 'loading' })
    setBookmarksState({ kind: 'loading', items: [] })
    setGotoOpen(false)
  }

  const isAtRoot = (): boolean => {
    const p = browserState.kind === 'ok' ? browserState.listing.resolvedPath : cwd
    return p === '/'
  }

  const listing = browserState.kind === 'ok' ? browserState.listing : null
  const roots = listing?.roots ?? null

  const goToItems: GoToItem[] = [
    ...(roots?.scratch
      ? [{ label: t('Scratch'), path: roots.scratch, icon: <Folder className="size-3.5" /> }]
      : []),
    ...(roots?.home
      ? [{ label: t('Home'), path: roots.home, icon: <Folder className="size-3.5" /> }]
      : [])
  ]

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          invalidatePendingRequests()
          onClose()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[70]')} />
        <Dialog.Content
          className={dialogPanelClassName(
            'z-[70] flex w-[min(860px,calc(100vw-2rem))] h-[min(600px,calc(100vh-4rem))] flex-col overflow-hidden p-0'
          )}
          aria-label={t('Remote file browser')}
        >
          {/* Header: host chips + close */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mr-1">
              {t('Host')}
            </span>
            {hosts.map((h) => (
              <button
                key={h.providerId}
                type="button"
                onClick={() => handleHostSelect(h.providerId)}
                aria-pressed={h.providerId === host?.providerId}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
                  h.providerId === host?.providerId
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                )}
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    h.probeResult?.ok ? 'bg-emerald-400' : 'bg-muted-foreground/40'
                  )}
                  aria-hidden="true"
                />
                {h.displayName}
                <span className="sr-only">
                  {h.probeResult
                    ? h.probeResult.ok
                      ? t('Probe succeeded')
                      : t('Probe failed')
                    : t('Not probed yet')}
                </span>
              </button>
            ))}
            <div className="flex-1" />
            <Dialog.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('Close file browser')}
              >
                <X className="size-4" />
              </Button>
            </Dialog.Close>
          </div>

          {/* Toolbar */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5">
            {/* Back */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={history.length === 0}
              onClick={handleBack}
              aria-label={t('Go back')}
            >
              <ArrowLeft className="size-4" />
            </Button>
            {/* Up */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={isAtRoot()}
              onClick={handleUp}
              aria-label={t('Go up one level')}
            >
              <ArrowUp className="size-4" />
            </Button>

            {/* Go-to dropdown */}
            <DropdownMenu open={gotoOpen} onOpenChange={setGotoOpen} modal={false}>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="gap-1 text-xs">
                  <MapPin className="size-3.5" aria-hidden="true" />
                  {t('Go to')}
                  <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="z-[80] min-w-[200px]"
                aria-label={t('Go-to locations')}
              >
                {goToItems.map((item) => (
                  <DropdownMenuItem
                    key={item.path}
                    className="gap-2 text-xs"
                    onSelect={() => void navigate(item.path)}
                  >
                    {item.icon}
                    <span className="flex-1">{item.label}</span>
                    <span className="truncate max-w-[100px] text-muted-foreground font-mono">
                      {item.path}
                    </span>
                  </DropdownMenuItem>
                ))}
                {goToItems.length > 0 && <DropdownMenuSeparator />}
                {bookmarksState.kind === 'loading' && (
                  <DropdownMenuLabel>{t('Loading bookmarks...')}</DropdownMenuLabel>
                )}
                <DropdownMenuItem
                  disabled={bookmarksState.kind === 'loading'}
                  className="gap-2 text-xs"
                  onSelect={() => void handlePinCurrent()}
                >
                  <MapPin className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  {t('Pin current folder')}
                </DropdownMenuItem>
                {bookmarks.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>{t('Bookmarks')}</DropdownMenuLabel>
                    {bookmarks.map((bm) => (
                      <div key={bm} className="flex items-center gap-1">
                        <DropdownMenuItem
                          className="min-w-0 flex-1 gap-2 text-xs"
                          onSelect={() => void navigate(bm)}
                        >
                          <Bookmark className="size-3.5 text-muted-foreground" aria-hidden="true" />
                          <span className="truncate max-w-[140px] font-mono">{bm}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          aria-label={t('Remove bookmark {{path}}', { path: bm })}
                          className="shrink-0 text-muted-foreground"
                          onSelect={() => void handleRemoveBookmark(bm)}
                        >
                          <X className="size-3" aria-hidden="true" />
                        </DropdownMenuItem>
                      </div>
                    ))}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Address bar */}
            <form onSubmit={handleAddressSubmit} className="flex flex-1 items-center">
              <input
                type="text"
                value={addressEditing ? addressInput : (listing?.resolvedPath ?? cwd)}
                onChange={(e) => setAddressInput(e.target.value)}
                onFocus={() => {
                  setAddressEditing(true)
                  setAddressInput(listing?.resolvedPath ?? cwd)
                }}
                onBlur={() => setAddressEditing(false)}
                className="h-7 w-full rounded border border-border bg-muted/40 px-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                aria-label={t('Current directory path')}
                spellCheck={false}
              />
            </form>

            {/* Refresh */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={handleRefresh}
              aria-label={t('Refresh directory listing')}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>

          {/* Body: listing + detail panel */}
          <div className="flex min-h-0 flex-1">
            {/* File listing */}
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              {bookmarksState.kind === 'error' && (
                <div
                  role={'alert'}
                  className={
                    'm-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive'
                  }
                >
                  <div className={'flex-1'}>
                    <p className={'font-semibold'}>{bookmarksState.summary}</p>
                    <p className={'mt-0.5 text-muted-foreground'}>{bookmarksState.detail}</p>
                  </div>
                </div>
              )}
              {/* Error banner */}
              {browserState.kind === 'error' && (
                <div
                  role="alert"
                  className="m-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
                >
                  <div className="flex-1">
                    <p className="font-semibold">{t("Couldn't open this path.")}</p>
                    <p className="mt-0.5 text-muted-foreground">{browserState.detail}</p>
                  </div>
                  <div className="flex gap-1.5">
                    {host &&
                    (browserState.authenticationCode || browserState.kind_hint === 'connection') ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => {
                          const errorCode = browserState.authenticationCode ?? 'host_unreachable'
                          onClose()
                          openSettingsToComputeAuthentication(host.providerId, errorCode)
                        }}
                      >
                        {computeRuntimeRecoveryAction(
                          browserState.authenticationCode ?? 'host_unreachable',
                          t
                        )}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={handleRefresh}
                    >
                      {t('Retry')}
                    </Button>
                    {roots?.home && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-xs"
                        onClick={() => void navigate(roots.scratch ?? roots.home ?? '~')}
                      >
                        {t('Go to home')}
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* Loading skeleton */}
              {browserState.kind === 'loading' && (
                <div className="flex flex-1 items-center justify-center">
                  <RefreshCw
                    className="size-5 animate-spin text-muted-foreground"
                    aria-label={t('Loading')}
                  />
                </div>
              )}

              {/* Entry list */}
              {browserState.kind === 'ok' && (
                <div>
                  {/* Header row */}
                  <div className="grid grid-cols-[1fr_80px_80px] border-b border-border bg-muted/30 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span>{t('Name')}</span>
                    <span className="text-right">{t('Size')}</span>
                    <span className="text-right">{t('Modified')}</span>
                  </div>
                  {listing?.entries.length === 0 && (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      {t('Empty directory')}
                    </p>
                  )}
                  <ul aria-label={t('Directory contents')}>
                    {listing?.entries.map((entry) => (
                      <li key={entry.name}>
                        <button
                          type="button"
                          aria-pressed={
                            entry.isDirectory ? undefined : selected?.entry.name === entry.name
                          }
                          className={cn(
                            'grid w-full grid-cols-[1fr_80px_80px] items-center px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent',
                            selected?.entry.name === entry.name ? 'bg-accent/80' : ''
                          )}
                          onClick={() => {
                            if (browserState.kind !== 'ok') return
                            if (entry.isDirectory) {
                              handleOpenDirectory(entry)
                              return
                            }
                            setSelected({
                              entry,
                              providerId: browserState.providerId,
                              resolvedDir: browserState.listing.resolvedPath
                            })
                          }}
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            {entry.isDirectory ? (
                              <Folder
                                className="size-3.5 shrink-0 text-sky-500"
                                aria-hidden="true"
                              />
                            ) : (
                              <File
                                className="size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                            )}
                            <span className="truncate">{entry.name}</span>
                          </span>
                          <span className="text-right text-muted-foreground">
                            {entry.isDirectory ? '—' : formatSize(entry.size)}
                          </span>
                          <span className="text-right text-muted-foreground">
                            {relativeTime(entry.mtimeMs, t)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {listing?.truncated && (
                    <p className="border-t border-border px-3 py-2 text-center text-xs text-muted-foreground">
                      {t('Showing first 5,000 entries. Navigate into a subdirectory to see more.')}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Detail panel (appears when a file is selected) */}
            {selected && !selected.entry.isDirectory && (
              <DetailPanel
                entry={selected.entry}
                resolvedDir={selected.resolvedDir}
                providerId={selected.providerId}
                activeProjectId={activeProject?.id}
                onClose={() => setSelected(null)}
                onManageCredentials={(targetProviderId, errorCode) => {
                  onClose()
                  openSettingsToComputeAuthentication(targetProviderId, errorCode)
                }}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
