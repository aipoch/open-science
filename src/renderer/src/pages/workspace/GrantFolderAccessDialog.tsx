// "Grant folder access" dialog. Opened from the Files tab filter menu ("Add folder…"). The user
// browses subfolders of home (or of already-granted roots) via a breadcrumb + folder-only listing,
// picks an access level, and grants the current folder. The main process is authoritative on what
// may be granted; the dialog mirrors its scope check only to avoid listing out-of-scope folders.
import { CircleAlert, Folder, Home, Info } from 'lucide-react'
import { Dialog } from 'radix-ui'
import { useEffect, useState } from 'react'

import type {
  GrantedLocalRoot,
  GrantedLocalRootAccess,
  LocalDirEntry
} from '../../../../shared/local-fs'
import {
  canBrowseGrantedPath,
  describeLocalListingError,
  isLocalPathRoot,
  parentLocalPath,
  resolveLocalPath,
  sameLocalDirectory
} from '../../../../shared/local-fs'
import { Button } from '@/components/ui/button'
import { dialogOverlayClassName, dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { cn } from '@/lib/utils'
import { useGrantedFoldersStore } from '@/stores/granted-folders-store'

type ListingState =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: LocalDirEntry[] }
  | { kind: 'out-of-scope' }
  | { kind: 'error'; summary: string }

// One custom-dot radio option for the access-level choice in the footer.
const AccessRadio = ({
  label,
  selected,
  onSelect
}: {
  label: string
  selected: boolean
  onSelect: () => void
}): React.JSX.Element => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    onClick={onSelect}
    className="flex items-center gap-1.5 text-[13px] text-text-000"
  >
    <span
      className={cn(
        'flex size-3.5 items-center justify-center rounded-full border-[1.5px]',
        selected ? 'border-primary' : 'border-text-300'
      )}
      aria-hidden="true"
    >
      {selected ? <span className="size-[7px] rounded-full bg-primary" /> : null}
    </span>
    {label}
  </button>
)

// The dialog body. Rendered only while the dialog is open, so every open starts fresh at home
// with the default access level and no leftover grant error.
const GrantFolderAccessDialogContent = ({
  onOpenChange,
  onGranted
}: {
  onOpenChange: (open: boolean) => void
  onGranted?: (root: GrantedLocalRoot) => void
}): React.JSX.Element => {
  const roots = useGrantedFoldersStore((state) => state.roots)
  const refresh = useGrantedFoldersStore((state) => state.refresh)
  const grant = useGrantedFoldersStore((state) => state.grant)
  // Host platform drives path segmentation/joining ('win32' paths use '\' and drive roots).
  const platform = window.api?.platform ?? 'darwin'
  const [home, setHome] = useState<string | undefined>(undefined)
  const [cwd, setCwd] = useState('')
  // Latest completed listing, keyed by the path it belongs to; anything else renders as loading.
  const [result, setResult] = useState<
    | { kind: 'ok'; path: string; entries: LocalDirEntry[] }
    | { kind: 'error'; path: string; summary: string }
    | null
  >(null)
  const [access, setAccess] = useState<GrantedLocalRootAccess>('ro')
  const [grantFailed, setGrantFailed] = useState(false)

  const outOfScope = home !== undefined && cwd !== '' && !canBrowseGrantedPath(cwd, home, roots)

  // On mount: resolve home (the initial location) and refresh the granted roots that, together
  // with home, define the browsable scope.
  useEffect(() => {
    if (!window.api?.localFs) return
    let cancelled = false
    void (async () => {
      const fetchedRoots = await window.api.localFs.getRoots()
      if (cancelled) return
      setHome(fetchedRoots.home)
      setCwd(fetchedRoots.home)
      await refresh().catch(() => undefined)
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // List the current folder's subfolders. Out-of-scope locations are never listed: the breadcrumb
  // can point outside home/granted roots, but reading them is not allowed.
  useEffect(() => {
    if (!home || !cwd || outOfScope || !window.api?.localFs) return
    let cancelled = false
    window.api.localFs
      .listDir(cwd)
      .then((listing) => {
        if (cancelled) return
        setResult({
          kind: 'ok',
          path: listing.resolvedPath,
          entries: listing.entries.filter((entry) => entry.isDirectory)
        })
        // Snap the breadcrumb to the canonical path main resolved (symlinks, '..').
        if (!sameLocalDirectory(listing.resolvedPath, cwd, platform)) setCwd(listing.resolvedPath)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setResult({
          kind: 'error',
          path: cwd,
          summary: describeLocalListingError((error as Error).message ?? '', cwd).summary
        })
      })
    return () => {
      cancelled = true
    }
  }, [home, cwd, outOfScope, platform])

  const listing: ListingState = outOfScope
    ? { kind: 'out-of-scope' }
    : result && sameLocalDirectory(result.path, cwd, platform)
      ? result.kind === 'ok'
        ? { kind: 'ok', entries: result.entries }
        : { kind: 'error', summary: result.summary }
      : { kind: 'loading' }

  const navigateTo = (path: string): void => {
    setGrantFailed(false)
    setCwd(path)
  }

  const isHome = home !== undefined && sameLocalDirectory(cwd, home, platform)

  const handleGrant = async (): Promise<void> => {
    try {
      const nextRoots = await grant(cwd, access)
      const granted =
        nextRoots.find((root) => sameLocalDirectory(root.path, cwd, platform)) ??
        nextRoots.find((root) => !roots.some((existing) => existing.id === root.id))
      onOpenChange(false)
      if (granted) onGranted?.(granted)
    } catch {
      // Main rejected the candidate (out of scope, unreadable, home itself): state it quietly
      // next to the buttons; navigation clears the message.
      setGrantFailed(true)
    }
  }

  // Absolute-path breadcrumb: home icon jumps home; every segment of cwd stays clickable.
  // Segmentation is platform-aware — a Windows drive path leads with its drive root ("C:\").
  const crumbs: { label: string; path: string }[] = []
  if (cwd !== '') {
    let cursor = cwd
    for (;;) {
      if (isLocalPathRoot(cursor, platform)) {
        // The POSIX root is already implied by the leading separator; a Windows drive root
        // ("C:\") gets its own crumb.
        if (cursor !== '/') crumbs.push({ label: cursor, path: cursor })
        break
      }
      crumbs.push({ label: cursor.split(/[\\/]/).pop() ?? cursor, path: cursor })
      cursor = parentLocalPath(cursor, platform)
    }
    crumbs.reverse()
  }

  return (
    <>
      <Dialog.Overlay className={cn(dialogOverlayClassName, 'z-[60]')} />
      <Dialog.Content
        data-testid="grant-folder-access-dialog"
        className={dialogPanelClassName(
          'z-[60] flex w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0'
        )}
      >
        <Dialog.Title className="px-5 pb-3 pt-4 text-[15px] font-semibold text-text-000">
          Grant folder access
        </Dialog.Title>
        <Dialog.Description className="sr-only">
          Browse to a folder and grant the app read-only or read &amp; write access to it.
        </Dialog.Description>

        {/* Breadcrumb bar */}
        <div className="flex flex-wrap items-center gap-0.5 border-y border-border-200 px-5 py-2.5 text-[13px] text-text-100">
          <button
            type="button"
            aria-label="Go to home folder"
            data-testid="grant-access-crumb-home"
            onClick={() => home && navigateTo(home)}
            className="flex items-center rounded p-1 hover:bg-bg-200 hover:text-text-000"
          >
            <Home className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
          </button>
          <span className="text-text-300" aria-hidden="true">
            /
          </span>
          {crumbs.map((crumb, index) => {
            const isCurrent = index === crumbs.length - 1
            return (
              <span key={crumb.path} className="flex items-center gap-0.5">
                {index > 0 ? (
                  <span className="text-text-300" aria-hidden="true">
                    ›
                  </span>
                ) : null}
                {isCurrent ? (
                  <span className="rounded bg-bg-200 px-1 py-0.5 font-medium text-text-000">
                    {crumb.label}
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid={`grant-access-crumb-${crumb.label}`}
                    onClick={() => navigateTo(crumb.path)}
                    className="rounded px-1 py-0.5 hover:bg-bg-200 hover:text-text-000"
                  >
                    {crumb.label}
                  </button>
                )}
              </span>
            )
          })}
        </div>

        {/* Subfolder listing */}
        <div className="flex max-h-[320px] min-h-[220px] flex-col overflow-y-auto px-5 pb-3 pt-2">
          {listing.kind === 'loading' ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-text-300">
              Loading…
            </div>
          ) : listing.kind === 'out-of-scope' ? (
            <div
              data-testid="grant-access-out-of-scope"
              className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-danger-000"
            >
              Directory is not under $HOME or a granted root.
            </div>
          ) : listing.kind === 'error' ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-text-300">
              {listing.summary}
            </div>
          ) : listing.entries.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-text-300">
              No subfolders.
            </div>
          ) : (
            <ul data-testid="grant-access-folder-list">
              {listing.entries.map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    data-testid={`grant-access-folder-${entry.name}`}
                    onClick={() => navigateTo(resolveLocalPath(cwd, entry.name, platform))}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-text-000 hover:bg-bg-200"
                  >
                    <Folder
                      className="size-4 shrink-0 text-text-100"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer: full-width alert strips (hint/error variants) sit inside the action bar,
            above the row of radios + buttons. */}
        <div className="flex flex-col gap-2.5 border-t border-border-200 px-5 pb-4 pt-3">
          {isHome ? (
            <div className="flex items-start gap-2 rounded-lg bg-bg-200 px-3 py-2 text-xs leading-[18px] text-text-100">
              <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
              <span>Your home folder itself can&apos;t be granted — pick a subfolder.</span>
            </div>
          ) : null}
          {grantFailed ? (
            <div
              role="alert"
              data-testid="grant-access-error"
              className="flex items-start gap-2 rounded-lg bg-danger-900 px-3 py-2 text-xs leading-[18px] text-danger-000 ring-1 ring-inset ring-danger-000/25"
            >
              <CircleAlert
                className="mt-px size-3.5 shrink-0"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span>Directory could not be accessed.</span>
            </div>
          ) : null}
          <div className="flex items-center gap-2.5">
            <AccessRadio
              label="Read-only"
              selected={access === 'ro'}
              onSelect={() => setAccess('ro')}
            />
            <AccessRadio
              label="Read & write"
              selected={access === 'rw'}
              onSelect={() => setAccess('rw')}
            />
            <span className="flex-1" />
            <Button
              type="button"
              variant="outline"
              data-testid="grant-access-cancel"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="grant-access-grant"
              disabled={isHome}
              onClick={() => void handleGrant()}
              className="bg-text-000 text-bg-000 hover:bg-text-000/85"
            >
              Grant this folder
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </>
  )
}

export const GrantFolderAccessDialog = ({
  open,
  onOpenChange,
  onGranted
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Called with the granted root after a successful grant (the dialog has already closed).
  onGranted?: (root: GrantedLocalRoot) => void
}): React.JSX.Element => (
  <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      {open ? (
        <GrantFolderAccessDialogContent onOpenChange={onOpenChange} onGranted={onGranted} />
      ) : null}
    </Dialog.Portal>
  </Dialog.Root>
)
