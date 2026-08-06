// Local ("This computer") file browser. Rendered as one of the two containers the Files tab can show:
// the source dropdown swaps between the artifacts list and this browser, so it owns no tab or modal
// chrome of its own. Forked from the remote FileBrowserModal chrome (editable address bar, Go-to
// dropdown with a fixed Home + pin/unpin bookmarks) but:
//   - transport is window.api.localFs (node:fs in main), not SSH
//   - the toolbar has a single arrow, which goes to the parent directory; there is no history stack
//   - opening a file does NOT show an inline detail panel; it opens a standalone preview-workbench
//     tab (source:'local') that renders through the shared preview pipeline with a dedicated header
//   - bookmarks persist under the reserved LOCAL_BOOKMARKS_KEY in the compute bookmark store
import { ArrowLeft, ChevronDown, Folder, File, Home, Pin, PinOff, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { LocalDirEntry, LocalListingProblem, LocalRoots } from '../../../../shared/local-fs'
import {
  describeLocalListingError,
  isLocalPathRoot,
  isSensitiveLocalPath,
  LOCAL_BOOKMARKS_KEY,
  parentLocalPath,
  resolveLocalPath,
  sameLocalDirectory,
  validateLocalPath
} from '../../../../shared/local-fs'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'

import { createPreviewFileItemFromLocal, LOCAL_PREVIEW_SESSION_ID } from './preview-file-item'

// Formats a byte count as a short human-readable string.
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(1)} GB`
}

// Human-readable relative time from a mtime; empty when unknown (mtimeMs 0).
const relativeTime = (mtimeMs: number): string => {
  if (!mtimeMs) return ''
  const sec = Math.round((Date.now() - mtimeMs) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${Math.round(sec / 3600)}h`
  return `${Math.round(sec / 86400)}d`
}

// Shared look for the three icon-only toolbar buttons. They sit above a dense listing, so they read
// as secondary chrome: text-300 rather than the body color, darkening only on hover, and a hairline
// stroke that matches the weight of the 12px mono address text next to them.
const TOOLBAR_ICON_STROKE = 1.25
const TOOLBAR_ICON_BUTTON = 'text-text-300 hover:text-text-100'

type BrowserState =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: LocalDirEntry[]; resolvedPath: string; truncated: boolean }
  | { kind: 'error'; problem: LocalListingProblem }

// Hover hint for the toolbar controls. Every one of them is icon-only (or icon + a two-word label),
// so the label alone doesn't say what the control does; the delay keeps hints from flashing while the
// pointer just crosses the toolbar. One shared TooltipProvider lives on the toolbar row.
const Hint = ({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="bottom">{label}</TooltipContent>
  </Tooltip>
)

// Body of one Go-to row: the label plus the absolute path it resolves to. Without the path, "Home"
// says nothing about where it lands and two folders pinned from different trees look identical when
// they share a basename (…/2024/data vs …/2025/data).
const GoToRow = ({
  icon,
  label,
  path
}: {
  icon: React.ReactNode
  label: string
  path: string
}): React.JSX.Element => (
  <>
    <span className="mt-0.5 shrink-0">{icon}</span>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{label}</span>
      {/* title carries the untruncated path: CSS clips the tail, which is the part that identifies
          a deeply nested folder. */}
      <span
        title={path}
        className="truncate font-mono text-[10px] leading-tight text-muted-foreground"
      >
        {path}
      </span>
    </span>
  </>
)

// Go-to dropdown: Home is fixed at the top (never removable); pinned folders follow with Unpin.
// Built on the shared shadcn DropdownMenu, so click-outside, Escape, focus trapping and the
// trigger's aria-expanded all come from Radix instead of hand-rolled open state.
const GoToMenu = ({
  home,
  bookmarks,
  currentPath,
  isBookmarked,
  onNavigate,
  onPinCurrent,
  onRemoveBookmark
}: {
  home: string | undefined
  bookmarks: string[]
  currentPath: string
  isBookmarked: boolean
  onNavigate: (path: string) => void
  onPinCurrent: () => void
  onRemoveBookmark: (path: string) => void
}): React.JSX.Element => (
  <DropdownMenu>
    <Hint label="Jump to Home or a pinned folder">
      {/* Label at the default 13px: at text-xs it was the smallest type in the row despite being
          the only worded control there. */}
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1 text-sm font-normal text-text-000"
        >
          Go to
          <ChevronDown className="size-3.5 text-text-300" strokeWidth={TOOLBAR_ICON_STROKE} />
        </Button>
      </DropdownMenuTrigger>
    </Hint>
    <DropdownMenuContent align="start" className="w-[300px] max-w-[70vw]">
      {home ? (
        <DropdownMenuItem className="items-start gap-2 text-xs" onSelect={() => onNavigate(home)}>
          <GoToRow
            icon={<Home className="size-3.5 text-muted-foreground" strokeWidth={1.5} />}
            label="Home"
            path={home}
          />
        </DropdownMenuItem>
      ) : null}
      {!isBookmarked && currentPath ? (
        <DropdownMenuItem className="items-start gap-2 text-xs" onSelect={onPinCurrent}>
          <GoToRow
            icon={<Pin className="size-3.5 text-muted-foreground" strokeWidth={1.5} />}
            label="Pin current folder"
            path={currentPath}
          />
        </DropdownMenuItem>
      ) : null}
      {bookmarks.length > 0 ? (
        <>
          <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wide">
            Pinned
          </DropdownMenuLabel>
          {bookmarks.map((path) => (
            <DropdownMenuItem
              key={path}
              className="items-start gap-2 pr-1 text-xs"
              onSelect={() => onNavigate(path)}
            >
              <GoToRow
                icon={<Pin className="size-3.5 text-muted-foreground" strokeWidth={1.5} />}
                label={path.split('/').pop() || path}
                path={path}
              />
              {/* The crossed-out pushpin can read as "delete this folder", so the hint says it
                  unpins. Its hover fill is surface-control-hover, a step darker than the muted fill
                  the highlighted row already shows, so the square reads as its own control.
                  stopPropagation keeps the click from selecting the row (which would navigate and
                  close the menu) — unpinning leaves the list open so several can go at once. */}
              <Hint label="Remove from Go to (the folder is not deleted)">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveBookmark(path)
                  }}
                  aria-label={`Unpin ${path}`}
                  className="flex size-6 shrink-0 items-center justify-center self-center rounded-md text-muted-foreground transition-colors hover:bg-surface-control-hover hover:text-text-000"
                >
                  <PinOff className="size-3.5" strokeWidth={1.5} />
                </button>
              </Hint>
            </DropdownMenuItem>
          ))}
        </>
      ) : null}
    </DropdownMenuContent>
  </DropdownMenu>
)

// Directory listing table: dirs first, single-click opens (navigate for dirs, preview tab for files).
const LocalListing = ({
  state,
  onOpenEntry
}: {
  state: BrowserState
  onOpenEntry: (entry: LocalDirEntry) => void
}): React.JSX.Element => {
  if (state.kind === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        Loading…
      </div>
    )
  }
  if (state.kind === 'error') {
    // A missing or unreadable path is an ordinary typo, not a fault: state it quietly in the body
    // text color and echo the path in mono underneath, rather than shouting the raw errno in red.
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
        <p className="text-xs text-text-100">{state.problem.summary}</p>
        {state.problem.path ? (
          <p className="max-w-full break-all font-mono text-[11px] text-text-300">
            {state.problem.path}
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {state.truncated ? (
        <div className="bg-amber-50 px-4 py-1.5 text-[11px] text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
          Showing the first entries only — this directory is very large.
        </div>
      ) : null}
      {state.entries.length === 0 ? (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Empty folder
        </div>
      ) : (
        <ul role="listbox" aria-label="Directory contents">
          {state.entries.map((entry) => (
            <li key={entry.name} className="border-b border-border-300/40 last:border-b-0">
              <button
                type="button"
                onClick={() => onOpenEntry(entry)}
                className="grid w-full grid-cols-[1fr_80px_64px] items-center gap-2 px-4 py-2 text-left text-[13px] hover:bg-bg-200"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {/* One neutral color for both: the glyph already says folder vs file, so tinting
                      the folder only added noise to a long list. */}
                  {entry.isDirectory ? (
                    <Folder className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  ) : (
                    <File className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                  )}
                  <span className="truncate">{entry.name}</span>
                </span>
                <span className="text-right text-xs text-muted-foreground">
                  {entry.isDirectory ? '—' : formatSize(entry.size)}
                </span>
                <span className="text-right text-xs text-muted-foreground">
                  {relativeTime(entry.mtimeMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export const LocalFileBrowser = ({
  onEntryCountChange
}: {
  // Reports the visible entry count so the Files tab header can show it next to the source picker.
  onEntryCountChange?: (count: number | undefined) => void
}): React.JSX.Element => {
  const [roots, setRoots] = useState<LocalRoots | null>(null)
  const [cwd, setCwd] = useState('')
  const [state, setState] = useState<BrowserState>({ kind: 'loading' })
  const [addressInput, setAddressInput] = useState('')
  const [bookmarks, setBookmarks] = useState<string[]>([])
  const upsertAndActivateItem = usePreviewWorkbenchStore((s) => s.upsertAndActivateItem)
  // Latest count reporter, read through a ref so navigate() stays identity-stable even when the
  // parent passes a fresh closure.
  const onEntryCountChangeRef = useRef(onEntryCountChange)
  useEffect(() => {
    onEntryCountChangeRef.current = onEntryCountChange
  }, [onEntryCountChange])

  // Clear the reported count when this container goes away, so the header stops showing a stale one.
  useEffect(
    () => () => {
      onEntryCountChangeRef.current?.(undefined)
    },
    []
  )

  // Loads one directory into the listing. Navigation is a single axis (parent arrow, address bar,
  // Go-to, entry double-click), so there is no history stack to maintain.
  const navigate = useCallback(async (target: string): Promise<void> => {
    setState({ kind: 'loading' })
    try {
      const listing = await window.api.localFs.listDir(target)
      setState({
        kind: 'ok',
        entries: listing.entries,
        resolvedPath: listing.resolvedPath,
        truncated: listing.truncated
      })
      setCwd(listing.resolvedPath)
      setAddressInput(listing.resolvedPath)
      onEntryCountChangeRef.current?.(listing.entries.length)
    } catch (err) {
      setState({
        kind: 'error',
        problem: describeLocalListingError((err as Error).message ?? '', target)
      })
      onEntryCountChangeRef.current?.(undefined)
    }
  }, [])

  // On mount: fetch roots + bookmarks, then land in Home.
  useEffect(() => {
    void (async () => {
      const [fetchedRoots, fetchedBookmarks] = await Promise.all([
        window.api.localFs.getRoots(),
        window.api.compute.bookmarksGet(LOCAL_BOOKMARKS_KEY)
      ])
      setRoots(fetchedRoots)
      setBookmarks(fetchedBookmarks)
      await navigate(fetchedRoots.home)
    })()
  }, [navigate])

  const listing = state.kind === 'ok' ? state : null
  const currentPath = listing?.resolvedPath ?? cwd
  const isAtRoot = isLocalPathRoot(currentPath, window.api.platform)

  // Submit/blur only re-reads the directory when the typed path actually resolves somewhere new, so
  // tabbing out of an untouched address bar costs no listing call. A no-op edit (trailing slash,
  // relative form of the same dir) snaps the field back to the canonical path instead.
  const handleAddressSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    const resolved = resolveLocalPath(currentPath, addressInput.trim(), window.api.platform)
    const invalid = validateLocalPath(resolved, window.api.platform)
    if (invalid) {
      setState({
        kind: 'error',
        problem: {
          summary:
            invalid === 'not_absolute'
              ? 'Enter an absolute path, starting at /.'
              : 'That path contains invalid characters.'
        }
      })
      return
    }
    if (sameLocalDirectory(resolved, currentPath, window.api.platform)) {
      setAddressInput(currentPath)
      return
    }
    void navigate(resolved)
  }

  // Directory → navigate in; file → open a preview-workbench tab. Sensitive paths (credential dirs
  // like .ssh, private keys, dotenv files) warn first, whether entering or opening.
  const handleOpenEntry = (entry: LocalDirEntry): void => {
    const path = resolveLocalPath(currentPath, entry.name, window.api.platform)
    if (isSensitiveLocalPath(path, window.api.platform)) {
      const prompt = entry.isDirectory
        ? `"${entry.name}" may contain credentials or secrets. Open this folder anyway?`
        : `"${entry.name}" may contain credentials or secrets. Open it anyway?`
      if (!window.confirm(prompt)) return
    }
    if (entry.isDirectory) {
      void navigate(path)
      return
    }
    upsertAndActivateItem(
      createPreviewFileItemFromLocal({
        sessionId: LOCAL_PREVIEW_SESSION_ID,
        path,
        name: entry.name,
        size: entry.size,
        mtimeMs: entry.mtimeMs
      })
    )
  }

  const isBookmarked = bookmarks.includes(currentPath)

  const handleToggleBookmark = async (): Promise<void> => {
    const next = isBookmarked
      ? bookmarks.filter((b) => b !== currentPath)
      : [...bookmarks, currentPath]
    setBookmarks(next)
    await window.api.compute.bookmarksSet(LOCAL_BOOKMARKS_KEY, next)
  }

  const handleRemoveBookmark = async (path: string): Promise<void> => {
    const next = bookmarks.filter((b) => b !== path)
    setBookmarks(next)
    await window.api.compute.bookmarksSet(LOCAL_BOOKMARKS_KEY, next)
  }

  return (
    <div
      className="mx-4 mb-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-300/50 bg-bg-000"
      aria-label="Local file browser"
    >
      {/* Toolbar */}
      <TooltipProvider delayDuration={200}>
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border-300/40 px-3 py-1.5">
          {/* One arrow only: it goes to the parent directory. A separate up-arrow beside it read as a
              duplicate of the same action, so this is the single way to move a level out. */}
          <Hint label="Go to the parent folder">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={TOOLBAR_ICON_BUTTON}
              disabled={isAtRoot}
              onClick={() => void navigate(parentLocalPath(currentPath, window.api.platform))}
              aria-label="Go to parent directory"
            >
              <ArrowLeft className="size-4" strokeWidth={TOOLBAR_ICON_STROKE} />
            </Button>
          </Hint>

          {/* Go-to dropdown: fixed Home + pinned bookmarks. Selecting an item closes the menu
              itself, so nothing here tracks open state. */}
          <GoToMenu
            home={roots?.home}
            bookmarks={bookmarks}
            currentPath={currentPath}
            isBookmarked={isBookmarked}
            onNavigate={(path) => void navigate(path)}
            onPinCurrent={() => void handleToggleBookmark()}
            onRemoveBookmark={(path) => void handleRemoveBookmark(path)}
          />

          {/* Always-editable address bar */}
          <form onSubmit={handleAddressSubmit} className="flex-1">
            <input
              value={addressInput}
              onChange={(e) => setAddressInput(e.target.value)}
              onBlur={handleAddressSubmit}
              spellCheck={false}
              className="w-full rounded-md border border-border bg-bg-000 px-2 py-1 font-mono text-xs text-text-100 outline-none focus:text-text-000 focus:ring-2 focus:ring-ring/50"
              aria-label="Directory path"
            />
          </form>

          <Hint label="Re-read this folder from disk">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={TOOLBAR_ICON_BUTTON}
              onClick={() => void navigate(currentPath)}
              aria-label="Refresh directory"
            >
              <RefreshCw className="size-4" strokeWidth={TOOLBAR_ICON_STROKE} />
            </Button>
          </Hint>
          <Hint
            label={
              isBookmarked ? 'Unpin this folder from Go to' : 'Pin this folder to the Go to menu'
            }
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={TOOLBAR_ICON_BUTTON}
              onClick={() => void handleToggleBookmark()}
              aria-label={isBookmarked ? 'Remove bookmark' : 'Pin this folder'}
            >
              {/* Pushpin for the action in both directions: PinOff (crossed-out pin) is what a click
                  will do next, so a pinned folder reads as "click to unpin". */}
              {isBookmarked ? (
                <PinOff className="size-4" strokeWidth={TOOLBAR_ICON_STROKE} />
              ) : (
                <Pin className="size-4" strokeWidth={TOOLBAR_ICON_STROKE} />
              )}
            </Button>
          </Hint>
        </div>
      </TooltipProvider>

      {/* Listing */}
      <LocalListing state={state} onOpenEntry={handleOpenEntry} />
    </div>
  )
}
