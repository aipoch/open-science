// "Grant folder access" dialog. Opened from the Files tab filter menu ("Add folder…"). The user
// browses any folder on any mounted drive via a breadcrumb + folder-only listing, picks an access
// level, and grants the current folder. The breadcrumb bar doubles as a path field (click its
// empty area to type a path), and its leading drive crumb opens a drive/volume switcher.
import { ChevronDown, CircleAlert, Folder, Home, Info, X } from 'lucide-react'
import { Dialog, RadioGroup } from 'radix-ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type {
  GrantedLocalRoot,
  GrantedLocalRootAccess,
  LocalDirEntry,
  LocalDrive
} from '../../../../shared/local-fs'
import {
  describeInvalidLocalPath,
  describeLocalListingError,
  isLocalPathRoot,
  localDriveRootFor,
  parentLocalPath,
  resolveLocalPath,
  sameLocalDirectory,
  validateLocalPath
} from '../../../../shared/local-fs'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import {
  dialogCancelButtonClassName,
  dialogCloseButtonClassName,
  dialogFooterClassName,
  dialogHeaderClassName,
  dialogOverlayClassName,
  dialogPanelClassName,
  dialogTitleClassName
} from '@/components/ui/dialog-chrome'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useGrantedFoldersStore } from '@/stores/granted-folders-store'

type ListingState =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: LocalDirEntry[] }
  | { kind: 'error'; summary: string }

// One custom-dot radio option for the access-level choice in the footer.
const AccessRadio = ({
  label,
  value,
  selected
}: {
  label: string
  value: GrantedLocalRootAccess
  selected: boolean
}): React.JSX.Element => (
  <RadioGroup.Item value={value} className="flex items-center gap-1.5 text-[13px] text-text-000">
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
  </RadioGroup.Item>
)

// The path input that replaces the breadcrumb while editing. Enter or blur submits, Escape
// cancels; either way the parent swaps the breadcrumb back in. Enter/Escape unmount the input, and
// unmounting never fires blur, so neither path can double-settle.
const PathEditInput = ({
  initialPath,
  onSubmit,
  onCancel
}: {
  initialPath: string
  onSubmit: (input: string) => void
  onCancel: () => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialPath)
  const inputRef = useRef<HTMLInputElement>(null)
  // Focus on mount with the caret at the end of the prefilled cwd — no select-all, so clicking
  // into the bar never destroys the path being edited. This must run once, not in an inline ref
  // callback: the callback's identity changes every render, so React re-invokes it after every
  // keystroke and would reset the caret while typing.
  useEffect(() => {
    const element = inputRef.current
    element?.focus()
    element?.setSelectionRange(element.value.length, element.value.length)
  }, [])
  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onSubmit(value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => onSubmit(value)}
      spellCheck={false}
      aria-label={t('Folder path')}
      className="w-full rounded-md border border-border bg-bg-000 px-2 py-1 font-mono text-xs text-text-100 outline-none focus:text-text-000 focus:ring-2 focus:ring-ring/50"
    />
  )
}

// The highlighted chip for the current location: the tail crumb, or the drive label when cwd sits
// at a drive root (no segment crumbs). Clicking it opens the path editor, like the bar's empty space.
const CurrentCrumb = ({
  label,
  onEdit
}: {
  label: string
  onEdit: () => void
}): React.JSX.Element => (
  <button
    type="button"
    data-testid="grant-access-crumb-current"
    onClick={onEdit}
    className="rounded bg-bg-200 px-1 py-0.5 font-medium text-text-000"
  >
    {label}
  </button>
)

// The dialog body. Rendered only while the dialog is open, so every open starts fresh at home
// with the default access level and no leftover grant error.
const GrantFolderAccessDialogContent = ({
  onOpenChange,
  onGranted,
  onGrantingChange
}: {
  onOpenChange: (open: boolean) => void
  onGranted?: (root: GrantedLocalRoot) => void
  onGrantingChange: (granting: boolean) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const roots = useGrantedFoldersStore((state) => state.roots)
  const refresh = useGrantedFoldersStore((state) => state.refresh)
  const grant = useGrantedFoldersStore((state) => state.grant)
  // Host platform drives path segmentation/joining ('win32' paths use '\' and drive roots).
  const platform = window.api?.platform ?? 'darwin'
  const [home, setHome] = useState<string | undefined>(undefined)
  const [drives, setDrives] = useState<LocalDrive[]>([])
  const [cwd, setCwd] = useState('')
  // True while the breadcrumb bar is swapped for the path input.
  const [editingPath, setEditingPath] = useState(false)
  // Latest completed listing, keyed by the path it belongs to; anything else renders as loading.
  const [result, setResult] = useState<
    | { kind: 'ok'; path: string; entries: LocalDirEntry[] }
    | { kind: 'error'; path: string; summary: string }
    | null
  >(null)
  // Bumped to force a re-list of the unchanged cwd (a no-op path submit clearing an error).
  const [relistNonce, setRelistNonce] = useState(0)
  // True while the drive dropdown is open — and until the next pointerdown after it closes: the
  // menu's dismissal is dispatched before the dialog layer evaluates the same deferred outside
  // click, so plain open state would already read false when the guard below runs. The menu is
  // modal, so that click only dismisses the menu; the guard absorbs it for the dialog. The next
  // pointerdown anywhere belongs to a new interaction and re-arms normal dialog dismissal.
  const driveMenuOpenRef = useRef(false)
  const disarmDriveMenu = useCallback((): void => {
    driveMenuOpenRef.current = false
  }, [])
  useEffect(
    () => () => document.removeEventListener('pointerdown', disarmDriveMenu, { capture: true }),
    [disarmDriveMenu]
  )
  const handleDriveMenuOpenChange = (open: boolean): void => {
    if (open) {
      // Cancel a pending disarm first: an Escape/select close leaves the one-shot listener
      // unconsumed, and reopening must not let the next pointerdown flip the ref back to false
      // while the menu is open. Reopening can even skip pointerdown entirely (keyboard), so
      // the listener itself must be withdrawn, not just the state reset.
      document.removeEventListener('pointerdown', disarmDriveMenu, { capture: true })
      driveMenuOpenRef.current = true
    } else {
      document.addEventListener('pointerdown', disarmDriveMenu, { capture: true, once: true })
    }
  }
  const [access, setAccess] = useState<GrantedLocalRootAccess>('ro')
  const [grantFailed, setGrantFailed] = useState(false)
  const [grantConfirmationOpen, setGrantConfirmationOpen] = useState(false)
  const [isGranting, setIsGranting] = useState(false)
  const grantingRef = useRef(false)
  const grantAttemptRef = useRef(0)
  useEffect(
    () => () => {
      grantAttemptRef.current += 1
      grantingRef.current = false
      onGrantingChange(false)
    },
    [onGrantingChange]
  )

  // On mount: resolve home (the initial location), enumerate the mounted drives for the drive
  // dropdown, and refresh the granted roots so handleGrant's fallback can tell which root the
  // grant just added.
  useEffect(() => {
    if (!window.api?.localFs) return
    let cancelled = false
    void (async () => {
      const [fetchedRoots, fetchedDrives] = await Promise.all([
        window.api.localFs.getRoots(),
        // A drive-enumeration failure must not take the whole dialog down with it.
        window.api.localFs.listDrives().catch(() => [])
      ])
      if (cancelled) return
      setHome(fetchedRoots.home)
      setCwd(fetchedRoots.home)
      setDrives(fetchedDrives)
      await refresh().catch(() => undefined)
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // List the current folder's subfolders. Browsing is not scope-confined ("Home start, full-disk
  // navigable"): any location the breadcrumb or path field points at gets listed.
  useEffect(() => {
    if (!home || !cwd || !window.api?.localFs) return
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
  }, [home, cwd, platform, relistNonce])

  const listing: ListingState =
    result && sameLocalDirectory(result.path, cwd, platform)
      ? result.kind === 'ok'
        ? { kind: 'ok', entries: result.entries }
        : { kind: 'error', summary: result.summary }
      : { kind: 'loading' }

  const navigateTo = (path: string): void => {
    setGrantFailed(false)
    setCwd(path)
  }

  // Path-field submit (Enter/blur). Relative input resolves against cwd; invalid input surfaces
  // the same quiet inline error LocalFileBrowser shows for a bad address, and a well-formed path
  // that doesn't exist surfaces through the ordinary listDir error path.
  const handlePathSubmit = (input: string): void => {
    setEditingPath(false)
    const resolved = resolveLocalPath(cwd, input.trim(), platform)
    const invalid = validateLocalPath(resolved, platform)
    if (invalid) {
      setResult({
        kind: 'error',
        path: cwd,
        summary: describeInvalidLocalPath(invalid, platform)
      })
      return
    }
    if (sameLocalDirectory(resolved, cwd, platform)) {
      // A no-op submit while an error is showing re-lists cwd so the stale error clears.
      if (result?.kind === 'error') {
        setResult(null)
        setRelistNonce((nonce) => nonce + 1)
      }
      return
    }
    navigateTo(resolved)
  }

  const isHome = home !== undefined && sameLocalDirectory(cwd, home, platform)

  const handleGrant = async (): Promise<void> => {
    if (grantingRef.current) return
    grantingRef.current = true
    const attempt = ++grantAttemptRef.current
    setIsGranting(true)
    onGrantingChange(true)
    try {
      const nextRoots = await grant(cwd, access)
      if (attempt !== grantAttemptRef.current) return
      const granted =
        nextRoots.find((root) => sameLocalDirectory(root.path, cwd, platform)) ??
        nextRoots.find((root) => !roots.some((existing) => existing.id === root.id))
      onOpenChange(false)
      if (granted) onGranted?.(granted)
    } catch {
      if (attempt !== grantAttemptRef.current) return
      // Main rejected the candidate (unreadable, home itself): state it quietly next to the
      // buttons; navigation clears the message.
      setGrantFailed(true)
    } finally {
      if (attempt === grantAttemptRef.current) {
        grantingRef.current = false
        setIsGranting(false)
        setGrantConfirmationOpen(false)
        onGrantingChange(false)
      }
    }
  }

  // Absolute-path breadcrumb: the Home shortcut leads the bar, then the drive crumb (opening the
  // drive/volume dropdown) as the first path crumb, then every segment of cwd as a clickable
  // crumb. Segmentation is platform-aware. The root itself is not a segment crumb — the drive
  // dropdown trigger represents it. The drive root is the longest listDrives() entry containing
  // cwd, so Linux mount points under /media, /run/media and /mnt highlight their own entry
  // instead of /.
  const driveRoot = cwd === '' ? undefined : localDriveRootFor(cwd, drives, platform)
  const currentDrive = drives.find(
    (drive) => driveRoot !== undefined && sameLocalDirectory(drive.path, driveRoot, platform)
  )
  const isCurrentDrive = (drive: LocalDrive): boolean =>
    currentDrive !== undefined && sameLocalDirectory(drive.path, currentDrive.path, platform)
  // Drives the user could switch to; the dropdown shows a placeholder when there are none.
  const otherDrives = drives.filter((drive) => !isCurrentDrive(drive))
  const crumbs: { label: string; path: string }[] = []
  if (cwd !== '' && driveRoot !== undefined) {
    let cursor = cwd
    for (;;) {
      // Stop at the drive root: the drive dropdown trigger already represents it.
      if (isLocalPathRoot(cursor, platform) || sameLocalDirectory(cursor, driveRoot, platform))
        break
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
        onClickCapture={(event) => {
          if (!isGranting) return
          event.preventDefault()
          event.stopPropagation()
        }}
        onKeyDownCapture={(event) => {
          if (!isGranting) return
          event.preventDefault()
          event.stopPropagation()
        }}
        onEscapeKeyDown={(event) => {
          if (isGranting) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (isGranting) {
            event.preventDefault()
            return
          }
          // The drive dropdown portals its content to <body>, outside this dialog's DOM: while
          // it is open, an outside click (a menu item, or the overlay the click falls through to
          // while the modal menu disables pointer events elsewhere) reaches this layer as an
          // outside interaction and would dismiss the dialog together with the menu. Absorb it;
          // once the menu is gone the next outside click dismisses the dialog normally.
          const target = event.detail.originalEvent.target
          if (
            driveMenuOpenRef.current ||
            (target instanceof Element && target.closest('[data-slot="dropdown-menu-content"]'))
          )
            event.preventDefault()
        }}
        className={dialogPanelClassName(
          'z-[60] flex w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0'
        )}
      >
        <div className={dialogHeaderClassName}>
          <Dialog.Title className={dialogTitleClassName}>{t('Grant folder access')}</Dialog.Title>
          <Dialog.Close asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('Close')}
              data-testid="grant-access-close"
              className={dialogCloseButtonClassName}
              disabled={isGranting}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </Dialog.Close>
        </div>
        <Dialog.Description className="sr-only">
          {t('Browse to a folder and grant the app read-only or read & write access to it.')}
        </Dialog.Description>

        {/* Breadcrumb bar. Clicking the bar's own empty space (not a crumb) swaps it for the
            path input; submit/cancel brings this rendering back unchanged. */}
        {editingPath ? (
          <div className="border-b border-border-200 px-5 py-2">
            <PathEditInput
              initialPath={cwd}
              onSubmit={handlePathSubmit}
              onCancel={() => setEditingPath(false)}
            />
          </div>
        ) : (
          <div
            data-testid="grant-access-path-bar"
            onClick={(event) => {
              // target === currentTarget means the click landed on the bar itself (padding or
              // empty flex space), not on a crumb, separator, or the home shortcut.
              if (event.target === event.currentTarget && cwd !== '') setEditingPath(true)
            }}
            className="flex flex-wrap items-center gap-0.5 border-b border-border-200 px-5 py-2.5 text-[13px] text-text-100"
          >
            <button
              type="button"
              aria-label={t('Go to home folder')}
              data-testid="grant-access-crumb-home"
              onClick={() => home && navigateTo(home)}
              className="flex items-center rounded p-1 hover:bg-bg-200 hover:text-text-000"
            >
              <Home className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
            </button>
            {/* Vertical divider between the Home shortcut and the path crumbs (same hairline
                style as the settings toolbar divider). */}
            {driveRoot !== undefined ? (
              <span aria-hidden="true" className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
            ) : null}
            {driveRoot !== undefined ? (
              <DropdownMenu onOpenChange={handleDriveMenuOpenChange}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('Choose a drive or volume')}
                    data-testid="grant-access-drive-root"
                    className="flex items-center gap-0.5 rounded px-1 py-0.5 font-medium text-text-000 hover:bg-bg-200"
                  >
                    {currentDrive?.label ?? driveRoot}
                    <ChevronDown
                      className="size-3 text-text-300"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </button>
                </DropdownMenuTrigger>
                {/* z-[70]: the dialog overlay/panel sit at z-[60], and this content portals to
                    body — at the shared component's default z-50 it opens *behind* the dialog. */}
                <DropdownMenuContent align="start" className="z-[70] w-[280px] max-w-[70vw]">
                  {otherDrives.length === 0 ? (
                    // Nothing to switch to (no drives enumerated, or already on the only one).
                    <DropdownMenuItem
                      disabled
                      data-testid="grant-access-no-drives"
                      className="text-xs"
                    >
                      {t('No other drives')}
                    </DropdownMenuItem>
                  ) : (
                    drives.map((drive) => {
                      const isCurrent = isCurrentDrive(drive)
                      return (
                        <DropdownMenuItem
                          key={drive.path}
                          data-testid={`grant-access-drive-${drive.path}`}
                          aria-current={isCurrent ? 'true' : undefined}
                          className={cn('items-start gap-2 text-xs', isCurrent && 'bg-muted')}
                          onSelect={() => navigateTo(drive.path)}
                        >
                          <span className="flex min-w-0 flex-1 flex-col">
                            {/* Full volume name + full path, no truncation: the name is the
                                identifier ("Macintosh HD"), the path disambiguates mounts. */}
                            <span className="break-words">{drive.label}</span>
                            <span
                              title={drive.path}
                              className="break-all font-mono text-[10px] leading-tight text-muted-foreground"
                            >
                              {drive.path}
                            </span>
                          </span>
                        </DropdownMenuItem>
                      )
                    })
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <span className="text-text-300" aria-hidden="true">
              ›
            </span>
            {crumbs.length === 0 ? (
              // At a drive root there are no segment crumbs; the current-location chip stands in
              // for the tail crumb.
              <CurrentCrumb
                label={currentDrive?.label ?? driveRoot ?? ''}
                onEdit={() => setEditingPath(true)}
              />
            ) : null}
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
                    <CurrentCrumb label={crumb.label} onEdit={() => setEditingPath(true)} />
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
        )}

        {/* Subfolder listing */}
        <div className="flex max-h-[320px] min-h-[220px] flex-col overflow-y-auto px-5 pb-3 pt-2">
          {listing.kind === 'loading' ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-text-300">
              {t('Loading…')}
            </div>
          ) : listing.kind === 'error' ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-text-300">
              {t(listing.summary)}
            </div>
          ) : listing.entries.length === 0 ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-text-300">
              {t('No subfolders.')}
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
        <div
          data-testid="grant-access-footer"
          className={cn(dialogFooterClassName, 'flex-col items-stretch gap-2.5')}
        >
          {isHome ? (
            <div className="flex items-start gap-2 rounded-lg bg-bg-200 px-3 py-2 text-xs leading-[18px] text-text-100">
              <Info className="mt-px size-3.5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
              <span>{t("Your home folder itself can't be granted — pick a subfolder.")}</span>
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
              <span>{t('Directory could not be accessed.')}</span>
            </div>
          ) : null}
          <div className="flex items-center gap-2.5">
            <RadioGroup.Root
              aria-label={t('Access level')}
              value={access}
              disabled={isGranting}
              onValueChange={(value) => setAccess(value as GrantedLocalRootAccess)}
              orientation="horizontal"
              className="flex items-center gap-2.5"
            >
              <AccessRadio label={t('Read-only')} value="ro" selected={access === 'ro'} />
              <AccessRadio label={t('Read & write')} value="rw" selected={access === 'rw'} />
            </RadioGroup.Root>
            <span className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              className={dialogCancelButtonClassName}
              data-testid="grant-access-cancel"
              disabled={isGranting}
              onClick={() => onOpenChange(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              type="button"
              data-testid="grant-access-grant"
              disabled={isHome || isGranting}
              onClick={() => setGrantConfirmationOpen(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/80 disabled:bg-primary disabled:text-primary-foreground disabled:opacity-40"
            >
              {t('Grant this folder')}
            </Button>
          </div>
        </div>
      </Dialog.Content>
      <ConfirmActionDialog
        open={grantConfirmationOpen}
        title={t('Grant folder access')}
        description={t(
          'Changing Notebook file access will stop active Notebook kernels. Continue?'
        )}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Grant this folder')}
        loadingLabel={t('Working…')}
        loading={isGranting}
        testId="grant-folder-access-confirmation"
        onCancel={() => setGrantConfirmationOpen(false)}
        onConfirm={() => void handleGrant()}
      />
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
}): React.JSX.Element => {
  const grantingRef = useRef(false)
  const handleGrantingChange = useCallback((granting: boolean): void => {
    grantingRef.current = granting
  }, [])

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && grantingRef.current) return
        onOpenChange(nextOpen)
      }}
    >
      <Dialog.Portal>
        {open ? (
          <GrantFolderAccessDialogContent
            onOpenChange={onOpenChange}
            onGranted={onGranted}
            onGrantingChange={handleGrantingChange}
          />
        ) : null}
      </Dialog.Portal>
    </Dialog.Root>
  )
}
