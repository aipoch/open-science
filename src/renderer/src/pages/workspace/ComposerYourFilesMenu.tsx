// "Your files" submenu in the composer + menu: a lazy file tree over the folders the user granted
// the app access to ("Grant folder access"). Roots and subdirectories expand in place (children are
// listDir'd on first expand); a file row's send action inserts a linked-folder reference into the
// composer draft. The "Grant folder…" header action reuses the Files tab's grant dialog; all list
// mutations flow through the granted-folders store, so the tree reflects them immediately.
import { ArrowUpRight, Check, ChevronRight, File, Folder, FolderPlus, X } from 'lucide-react'
import { useState } from 'react'

import type { LinkedFolderFileReference } from '../../../../shared/artifacts'
import type { GrantedLocalRoot, LocalDirEntry } from '../../../../shared/local-fs'
import { describeLocalListingError } from '../../../../shared/local-fs'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { useGrantedFoldersStore } from '@/stores/granted-folders-store'

import { GrantFolderAccessDialog } from './GrantFolderAccessDialog'
import { grantedRootAccessBadgeClassName } from './granted-root-access-badge'

type DirListing =
  | { kind: 'loading' }
  | { kind: 'ok'; entries: LocalDirEntry[] }
  | { kind: 'error'; summary: string }

// Row indentation per tree depth: the base padding plus a fixed step per level (prototype step 6).
const indentForDepth = (depth: number): number => 6 + depth * 18

export const ComposerYourFilesMenu = ({
  onInsertFileReference
}: {
  onInsertFileReference: (reference: LinkedFolderFileReference) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const roots = useGrantedFoldersStore((state) => state.roots)
  const loaded = useGrantedFoldersStore((state) => state.loaded)
  const refresh = useGrantedFoldersStore((state) => state.refresh)
  const remove = useGrantedFoldersStore((state) => state.remove)

  // Expansion and listing state are keyed by absolute directory path; both survive collapse so
  // re-expanding a directory never re-reads it.
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({})
  const [listings, setListings] = useState<Record<string, DirListing>>({})
  const [grantDialogOpen, setGrantDialogOpen] = useState(false)
  const [rootRemoveStates, setRootRemoveStates] = useState<Record<string, 'removing' | 'error'>>({})
  // Files inserted during this submenu session, keyed `${rootId}:${relativePath}`. Purely local:
  // the set resets when the submenu closes, so the green check marks "added this time".
  const [addedKeys, setAddedKeys] = useState<ReadonlySet<string>>(new Set())

  const loadDir = (path: string): void => {
    if (!window.api?.localFs) return
    setListings((previous) => ({ ...previous, [path]: { kind: 'loading' } }))
    window.api.localFs
      .listDir(path)
      .then((listing) => {
        setListings((previous) => ({
          ...previous,
          [path]: { kind: 'ok', entries: listing.entries }
        }))
      })
      .catch((error: unknown) => {
        setListings((previous) => ({
          ...previous,
          [path]: {
            kind: 'error',
            summary: describeLocalListingError((error as Error).message ?? '', path).summary
          }
        }))
      })
  }

  const toggleDir = (path: string): void => {
    const nextExpanded = !expandedDirs[path]
    setExpandedDirs((previous) => ({ ...previous, [path]: nextExpanded }))
    if (nextExpanded && listings[path] === undefined) loadDir(path)
  }

  // The submenu opening is the first moment the list is needed; skip the fetch when another
  // surface already loaded it (or when the bridge is unavailable, e.g. tests/web). Closing the
  // submenu also clears the "added" check marks — they only ever mean "added this time".
  const handleSubOpenChange = (open: boolean): void => {
    if (!open) {
      setAddedKeys(new Set())
      return
    }
    if (loaded || !window.api?.localFs) return
    void refresh().catch(() => undefined)
  }

  const sendFile = (root: GrantedLocalRoot, entry: LocalDirEntry, relativePath: string): void => {
    onInsertFileReference({
      id: crypto.randomUUID(),
      name: entry.name,
      source: 'linked-folder',
      rootId: root.id,
      relativePath,
      mimeType: undefined
    })
    setAddedKeys((previous) => new Set(previous).add(`${root.id}:${relativePath}`))
  }

  const removeRoot = (rootId: string): void => {
    setRootRemoveStates((previous) => ({ ...previous, [rootId]: 'removing' }))
    void remove(rootId)
      .then(() => {
        setRootRemoveStates((previous) => {
          const next = { ...previous }
          delete next[rootId]
          return next
        })
      })
      .catch(() => {
        setRootRemoveStates((previous) => ({ ...previous, [rootId]: 'error' }))
      })
  }

  // Recursive rows for one expanded directory: subdirectories expand further, files are inert
  // leaf rows whose hover-revealed trailing button inserts the reference. The select is
  // preventDefault'd so the menu stays open; the button then flips to a green check (local state,
  // cleared on submenu close) marking the file as added.
  const renderDirRows = (
    root: GrantedLocalRoot,
    dirPath: string,
    relBase: string,
    depth: number
  ): React.JSX.Element | null => {
    const listing = listings[dirPath]
    if (!listing || listing.kind === 'loading') return null
    if (listing.kind === 'error') {
      return (
        <div
          className="py-1 pr-1.5 text-[11px] leading-4 text-text-300"
          style={{ paddingLeft: indentForDepth(depth) }}
        >
          {t(listing.summary)}
        </div>
      )
    }
    return (
      <>
        {listing.entries.map((entry) => {
          const childPath = `${dirPath.replace(/\/+$/, '')}/${entry.name}`
          const relativePath = relBase === '' ? entry.name : `${relBase}/${entry.name}`
          if (entry.isDirectory) {
            const isExpanded = expandedDirs[childPath] === true
            return (
              <div key={childPath}>
                <div
                  className="group flex items-center gap-1.5 rounded-md py-1 pr-1.5 text-[13px] text-text-000 hover:bg-bg-200 [@media(pointer:coarse)]:py-0"
                  style={{ paddingLeft: indentForDepth(depth) }}
                >
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    data-testid={`your-files-dir-${root.id}-${relativePath}`}
                    onClick={() => toggleDir(childPath)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left [@media(pointer:coarse)]:min-h-11"
                  >
                    <ChevronRight
                      className={cn(
                        'size-3.5 shrink-0 text-text-300 transition-transform',
                        isExpanded && 'rotate-90'
                      )}
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    <Folder
                      className="size-4 shrink-0 text-text-100"
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  </button>
                </div>
                {isExpanded ? renderDirRows(root, childPath, relativePath, depth + 1) : null}
              </div>
            )
          }
          return (
            <div
              key={childPath}
              data-testid={`your-files-file-${root.id}-${relativePath}`}
              title={relativePath}
              // Same metrics as the directory rows above: identical padding, text size, icon size,
              // and hover background so every tree row has one consistent height and hover style.
              className="group relative flex items-center gap-0.5 rounded-md py-1 pr-1.5 text-[13px] text-text-000 hover:bg-bg-200 [@media(pointer:coarse)]:min-h-11"
              style={{ paddingLeft: indentForDepth(depth) }}
            >
              <File
                className="size-4 shrink-0 text-text-100"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
              {/* asChild keeps the send action a real button while staying the menu item.
                  preventDefault keeps the menu open; the button then flips to a green check
                  (addedKeys, local until the submenu closes) instead of closing on select. */}
              {(() => {
                const isAdded = addedKeys.has(`${root.id}:${relativePath}`)
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuItem
                        asChild
                        onSelect={(event) => {
                          event.preventDefault()
                          if (!isAdded) sendFile(root, entry, relativePath)
                        }}
                        className={cn(
                          // min-h-0/p-0/transparent backgrounds cancel the DropdownMenuItem base
                          // chrome — this is a bare icon, not a full-size menu row.
                          'relative flex min-h-0 shrink-0 items-center justify-center p-0 opacity-100 transition-opacity hover:bg-transparent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[highlighted]:bg-transparent [@media(pointer:coarse)]:size-11',
                          isAdded
                            ? 'text-mention-chip-foreground'
                            : 'text-text-100 hover:text-text-000 data-[highlighted]:text-text-000 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:hover)]:data-[highlighted]:opacity-100'
                        )}
                      >
                        <button
                          type="button"
                          data-testid={`your-files-send-${root.id}-${relativePath}`}
                          aria-label={
                            isAdded
                              ? t('{{path}} added to conversation', { path: relativePath })
                              : t('Add {{path}} to conversation as attachment', {
                                  path: relativePath
                                })
                          }
                        >
                          {isAdded ? (
                            <Check className="size-4" strokeWidth={2.2} aria-hidden="true" />
                          ) : (
                            <ArrowUpRight className="size-4" strokeWidth={1.8} aria-hidden="true" />
                          )}
                        </button>
                      </DropdownMenuItem>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {isAdded
                        ? t('Added to conversation')
                        : t('Add to conversation as attachment')}
                    </TooltipContent>
                  </Tooltip>
                )
              })()}
            </div>
          )
        })}
      </>
    )
  }

  return (
    <>
      <DropdownMenuSub onOpenChange={handleSubOpenChange}>
        <DropdownMenuSubTrigger
          data-testid="composer-your-files-trigger"
          className="items-center gap-2"
        >
          <Folder className="size-4 shrink-0 text-text-200" strokeWidth={2} aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[13px] font-medium leading-5">
            {t('Your files')}
          </span>
          <ChevronRight className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-[340px] w-[300px] overflow-y-auto">
          {/* One provider for every row tooltip inside the portaled submenu. */}
          <TooltipProvider delayDuration={200}>
            {/* Header: the grant action stays one click away even when no root is granted yet. */}
            <div className="flex items-center justify-end px-1.5 pb-1 pt-0.5">
              <button
                type="button"
                data-testid="your-files-grant-folder"
                onClick={() => setGrantDialogOpen(true)}
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-text-100 hover:bg-bg-200 hover:text-text-000"
              >
                <FolderPlus className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                {t('Grant folder…')}
              </button>
            </div>
            {loaded && roots.length === 0 ? (
              <div className="px-2 py-1.5 text-[12px] leading-4 text-text-300">
                {t('No folders granted yet.')}
              </div>
            ) : null}
            {roots.map((root) => {
              const isExpanded = expandedDirs[root.path] === true
              const removeState = rootRemoveStates[root.id]
              return (
                <div key={root.id} data-testid={`your-files-root-${root.id}`}>
                  {/* Fixed height + opacity-based reveal for the × action: hover only changes the
                      background, so the row (and the list below it) never shifts. */}
                  <div className="group flex h-[30px] items-center gap-1.5 rounded-md pr-1.5 pl-1.5 text-[13px] text-text-000 hover:bg-bg-200 [@media(pointer:coarse)]:h-11">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      data-testid={`your-files-root-toggle-${root.id}`}
                      onClick={() => toggleDir(root.path)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left [@media(pointer:coarse)]:min-h-11"
                    >
                      <ChevronRight
                        className={cn(
                          'size-3.5 shrink-0 text-text-300 transition-transform',
                          isExpanded && 'rotate-90'
                        )}
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                      <Folder
                        className="size-4 shrink-0 text-text-100"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{root.name}</span>
                    </button>
                    <span className={grantedRootAccessBadgeClassName(root.access)}>
                      {root.access}
                    </span>
                    {/* Plain button (not a menu item) so removing access never closes the menu. */}
                    <button
                      type="button"
                      data-testid={`your-files-remove-${root.id}`}
                      aria-label={t('Remove access to {{name}}', { name: root.name })}
                      disabled={removeState === 'removing'}
                      onClick={(event) => {
                        event.stopPropagation()
                        event.preventDefault()
                        removeRoot(root.id)
                      }}
                      className="relative flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-text-100 opacity-100 transition-opacity duration-150 hover:bg-bg-300 hover:text-text-000 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:size-11"
                    >
                      <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
                    </button>
                  </div>
                  {removeState === 'error' ? (
                    <div
                      role="alert"
                      className="flex items-center justify-between gap-2 px-2 py-1 text-[11px] leading-4 text-danger-000"
                    >
                      <span>{t('Could not remove folder access.')}</span>
                      <button
                        type="button"
                        onClick={() => removeRoot(root.id)}
                        className="shrink-0 rounded px-1.5 py-0.5 font-medium hover:bg-danger-900 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                      >
                        {t('Retry')}
                      </button>
                    </div>
                  ) : null}
                  {isExpanded ? renderDirRows(root, root.path, '', 1) : null}
                </div>
              )
            })}
          </TooltipProvider>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {/* Hosted here so a fresh grant is one click from the tree; the dialog updates the store on
          success, which re-renders the root list above. */}
      <GrantFolderAccessDialog open={grantDialogOpen} onOpenChange={setGrantDialogOpen} />
    </>
  )
}
