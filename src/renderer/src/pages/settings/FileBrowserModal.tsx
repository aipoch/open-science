// Remote file browser modal (compute-file-preview, issue 02).
// Opened from the ComputePanel host card folder-icon button (and later from the Files panel REMOTE
// dropdown, issue 05). Presents a listbox-style directory listing with navigation, a detail panel for
// selected files, and a Go-to dropdown with Scratch / Home / Pin / bookmarks.
//
// Design decisions (from design.md):
//   - No inline content preview: detail panel shows SIZE / MODIFIED / TYPE + "No preview · <size>"
//   - Selecting a file does NOT trigger any remote content request
//   - Transport = find -printf via exec SshRunner (no sftp, no ssh2)
//   - Bookmarks persist in settings JSON (keyed by provider_id)

import {
  ArrowLeft,
  ArrowUp,
  Bookmark,
  ChevronDown,
  ClipboardCopy,
  Folder,
  File,
  MapPin,
  RefreshCw,
  X
} from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { DirListing, RemoteDirEntry } from '../../../../shared/remote-fs'
import { resolveRemotePath, validateRemotePath } from '../../../../shared/remote-fs'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useComputeStore } from '@/stores/compute-store'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Returns a human-readable relative time string from a mtime timestamp.
const relativeTime = (mtimeMs: number): string => {
  const ageMs = Date.now() - mtimeMs
  const sec = Math.round(ageMs / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const days = Math.round(hr / 24)
  return `${days}d`
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
  | { kind: 'ok'; listing: DirListing }
  | { kind: 'error'; detail: string; kind_hint?: string }

type GoToItem = { label: string; path: string; icon: React.ReactNode }

// ---------------------------------------------------------------------------
// DetailPanel — right-side file detail panel (no remote content requests)
// ---------------------------------------------------------------------------

type DetailPanelProps = {
  entry: RemoteDirEntry
  // The resolved absolute path of the containing directory.
  resolvedDir: string
  onClose: () => void
}

function DetailPanel({ entry, resolvedDir, onClose }: DetailPanelProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const remoteAbsPath = `${resolvedDir.replace(/\/$/, '')}/${entry.name}`

  const copyPath = async (): Promise<void> => {
    await navigator.clipboard.writeText(remoteAbsPath)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex w-52 shrink-0 flex-col border-l border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Details
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail panel"
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
          <MetaRow label="SIZE" value={formatSize(entry.size)} />
          <MetaRow label="MODIFIED" value={new Date(entry.mtimeMs).toLocaleString()} />
          <MetaRow label="TYPE" value={inferType(entry.name)} />
        </div>

        {/* No preview placeholder */}
        <div className="rounded border border-dashed border-border bg-muted/30 px-3 py-4 text-center">
          <p className="text-xs text-muted-foreground">No preview · {formatSize(entry.size)}</p>
        </div>

        {/* Copy path — pure front-end, no remote request */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full gap-1.5 text-xs"
          onClick={() => void copyPath()}
          aria-label="Copy remote absolute path to clipboard"
        >
          <ClipboardCopy className="size-3.5" />
          {copied ? 'Copied!' : 'Copy path'}
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
}

export function FileBrowserModal({
  open,
  onClose,
  initialProviderId
}: FileBrowserModalProps): React.JSX.Element | null {
  const hosts = useComputeStore((s) => s.hosts)

  // Active host — defaults to initialProviderId or first reachable host.
  const [activeProviderId, setActiveProviderId] = useState<string | undefined>(
    initialProviderId ?? hosts[0]?.providerId
  )
  const host = hosts.find((h) => h.providerId === activeProviderId) ?? hosts[0]

  // Navigation state
  const [cwd, setCwd] = useState<string>('~')
  const [history, setHistory] = useState<string[]>([])
  const [browserState, setBrowserState] = useState<BrowserState>({ kind: 'loading' })
  const [selected, setSelected] = useState<RemoteDirEntry | null>(null)

  // Address bar
  const [addressInput, setAddressInput] = useState('')
  const [addressEditing, setAddressEditing] = useState(false)

  // Bookmarks
  const [bookmarks, setBookmarks] = useState<string[]>([])
  const bookmarksLoaded = useRef(false)

  // Go-to dropdown open state
  const [gotoOpen, setGotoOpen] = useState(false)

  const navigate = useCallback(
    async (path: string, pushHistory = true) => {
      if (!host) return
      if (pushHistory && cwd !== path) {
        setHistory((h) => [...h, cwd])
      }
      setCwd(path)
      setSelected(null)
      setBrowserState({ kind: 'loading' })
      try {
        const listing = await window.api.compute.listDir(host.providerId, path)
        setBrowserState({ kind: 'ok', listing })
        // Update cwd to resolvedPath so the address bar reflects the real path.
        setCwd(listing.resolvedPath)
        setAddressInput(listing.resolvedPath)
      } catch (err) {
        const e = err as Error & { remoteFsError?: { detail: string; remoteKind: string } }
        const detail = e.remoteFsError?.detail ?? e.message ?? 'Unknown error'
        setBrowserState({ kind: 'error', detail, kind_hint: e.remoteFsError?.remoteKind })
      }
    },
    [host, cwd]
  )

  // Initial navigation when modal opens or host changes.
  // All state resets happen inside the async navigate() call via a dedicated "reset" flag.
  useEffect(() => {
    if (!open || !host) return
    const startPath = host.scratchRoot ?? '~'
    // Synchronously reset navigation state before the async navigate starts.
    // React batches these updates together in the same render cycle.
    void (async () => {
      setCwd(startPath)
      setHistory([])
      setSelected(null)
      setAddressInput(startPath)
      await navigate(startPath, false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host?.providerId])

  // Load bookmarks when host changes.
  useEffect(() => {
    if (!open || !host) return
    bookmarksLoaded.current = false
    void window.api.compute.bookmarksGet(host.providerId).then((bms) => {
      setBookmarks(bms)
      bookmarksLoaded.current = true
    })
  }, [open, host?.providerId])

  // Escape key closes the modal.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

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
        detail: 'Path must be absolute and contain no control characters.',
        kind_hint: 'outside_roots'
      })
      return
    }
    setAddressEditing(false)
    void navigate(resolved)
  }

  const handleEntryDoubleClick = (entry: RemoteDirEntry): void => {
    if (!entry.isDirectory) return
    const listing = browserState.kind === 'ok' ? browserState.listing : null
    const next = `${(listing?.resolvedPath ?? cwd).replace(/\/$/, '')}/${entry.name}`
    void navigate(next)
  }

  const handlePinCurrent = async (): Promise<void> => {
    if (!host) return
    const path = browserState.kind === 'ok' ? browserState.listing.resolvedPath : cwd
    if (bookmarks.includes(path)) return
    const next = [...bookmarks, path]
    setBookmarks(next)
    setGotoOpen(false)
    await window.api.compute.bookmarksSet(host.providerId, next)
  }

  const handleRemoveBookmark = async (path: string): Promise<void> => {
    if (!host) return
    const next = bookmarks.filter((b) => b !== path)
    setBookmarks(next)
    await window.api.compute.bookmarksSet(host.providerId, next)
  }

  const isAtRoot = (): boolean => {
    const p = browserState.kind === 'ok' ? browserState.listing.resolvedPath : cwd
    return p === '/'
  }

  const listing = browserState.kind === 'ok' ? browserState.listing : null
  const roots = listing?.roots ?? null

  const goToItems: GoToItem[] = [
    ...(roots?.scratch
      ? [{ label: 'Scratch', path: roots.scratch, icon: <Folder className="size-3.5" /> }]
      : []),
    ...(roots?.home
      ? [{ label: 'Home', path: roots.home, icon: <Folder className="size-3.5" /> }]
      : [])
  ]

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[70] flex w-[min(860px,calc(100vw-2rem))] h-[min(600px,calc(100vh-4rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card text-foreground shadow-dialog overflow-hidden"
          aria-label="Remote file browser"
        >
          {/* Header: host chips + close */}
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mr-1">
              Host
            </span>
            {hosts.map((h) => (
              <button
                key={h.providerId}
                type="button"
                onClick={() => setActiveProviderId(h.providerId)}
                disabled={!h.probeResult?.ok}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
                  h.providerId === activeProviderId
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80 disabled:opacity-40 disabled:cursor-not-allowed'
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
              </button>
            ))}
            <div className="flex-1" />
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label="Close file browser">
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
              aria-label="Go back"
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
              aria-label="Go up one level"
            >
              <ArrowUp className="size-4" />
            </Button>

            {/* Go-to dropdown */}
            <div className="relative">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1 text-xs"
                onClick={() => setGotoOpen(!gotoOpen)}
                aria-haspopup="listbox"
                aria-expanded={gotoOpen}
              >
                <MapPin className="size-3.5" />
                Go to
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
              {gotoOpen && (
                <div
                  className="absolute left-0 top-full z-10 mt-1 min-w-[200px] rounded-lg border border-border bg-popover p-1 shadow-md"
                  role="listbox"
                  aria-label="Go-to locations"
                >
                  {goToItems.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      role="option"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                      onClick={() => {
                        setGotoOpen(false)
                        void navigate(item.path)
                      }}
                    >
                      {item.icon}
                      <span className="flex-1">{item.label}</span>
                      <span className="truncate max-w-[100px] text-muted-foreground font-mono">
                        {item.path}
                      </span>
                    </button>
                  ))}
                  {goToItems.length > 0 && <div className="my-1 border-t border-border" />}
                  {/* Pin current folder */}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                    onClick={() => void handlePinCurrent()}
                  >
                    <MapPin className="size-3.5 text-muted-foreground" />
                    <span>Pin current folder</span>
                  </button>
                  {/* Bookmarks */}
                  {bookmarks.length > 0 && (
                    <>
                      <div className="my-1 border-t border-border" />
                      <p className="px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Bookmarks
                      </p>
                      {bookmarks.map((bm) => (
                        <div key={bm} className="flex items-center gap-1">
                          <button
                            type="button"
                            className="flex flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
                            onClick={() => {
                              setGotoOpen(false)
                              void navigate(bm)
                            }}
                          >
                            <Bookmark className="size-3.5 text-muted-foreground" />
                            <span className="truncate max-w-[140px] font-mono">{bm}</span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove bookmark ${bm}`}
                            className="mr-1 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                            onClick={() => void handleRemoveBookmark(bm)}
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

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
                aria-label="Current directory path"
                spellCheck={false}
              />
            </form>

            {/* Refresh */}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={handleRefresh}
              aria-label="Refresh directory listing"
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>

          {/* Body: listing + detail panel */}
          <div className="flex min-h-0 flex-1">
            {/* File listing */}
            <div className="flex min-h-0 flex-1 flex-col overflow-auto">
              {/* Error banner */}
              {browserState.kind === 'error' && (
                <div
                  role="alert"
                  className="m-2 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
                >
                  <div className="flex-1">
                    <p className="font-semibold">Couldn&apos;t open this path.</p>
                    <p className="mt-0.5 text-muted-foreground">{browserState.detail}</p>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-xs"
                      onClick={handleRefresh}
                    >
                      Retry
                    </Button>
                    {roots?.home && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-xs"
                        onClick={() => void navigate(roots.scratch ?? roots.home ?? '~')}
                      >
                        Go to home
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
                    aria-label="Loading"
                  />
                </div>
              )}

              {/* Entry list */}
              {browserState.kind === 'ok' && (
                <div role="listbox" aria-label="Directory contents">
                  {/* Header row */}
                  <div className="grid grid-cols-[1fr_80px_80px] border-b border-border bg-muted/30 px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span>Name</span>
                    <span className="text-right">Size</span>
                    <span className="text-right">Modified</span>
                  </div>
                  {listing?.entries.length === 0 && (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      Empty directory
                    </p>
                  )}
                  {listing?.entries.map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      role="option"
                      aria-selected={selected?.name === entry.name}
                      className={cn(
                        'grid w-full grid-cols-[1fr_80px_80px] items-center px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent',
                        selected?.name === entry.name ? 'bg-accent/80' : ''
                      )}
                      onClick={() => setSelected(entry)}
                      onDoubleClick={() => handleEntryDoubleClick(entry)}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        {entry.isDirectory ? (
                          <Folder className="size-3.5 shrink-0 text-sky-500" aria-hidden="true" />
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
                        {relativeTime(entry.mtimeMs)}
                      </span>
                    </button>
                  ))}
                  {listing?.truncated && (
                    <p className="border-t border-border px-3 py-2 text-center text-xs text-muted-foreground">
                      Showing first 5,000 entries. Navigate into a subdirectory to see more.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Detail panel (appears when a file is selected) */}
            {selected && !selected.isDirectory && (
              <DetailPanel
                entry={selected}
                resolvedDir={listing?.resolvedPath ?? cwd}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
