// "Your files" submenu in the composer + menu: a lazy file tree over the folders the user granted
// the app access to ("Grant folder access"). Roots and subdirectories expand in place (children are
// listDir'd on first expand); a file row's send action inserts a linked-folder reference into the
// composer draft. The "Grant folder…" header action reuses the Files tab's grant dialog; all list
// mutations flow through the granted-folders store, so the tree reflects them immediately.
import { ArrowUpRight, ChevronRight, File, Folder, FolderPlus, X } from 'lucide-react'
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
  const roots = useGrantedFoldersStore((state) => state.roots)
  const loaded = useGrantedFoldersStore((state) => state.loaded)
  const refresh = useGrantedFoldersStore((state) => state.refresh)
  const remove = useGrantedFoldersStore((state) => state.remove)

  // Expansion and listing state are keyed by absolute directory path; both survive collapse so
  // re-expanding a directory never re-reads it.
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({})
  const [listings, setListings] = useState<Record<string, DirListing>>({})
  const [grantDialogOpen, setGrantDialogOpen] = useState(false)

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
  // surface already loaded it (or when the bridge is unavailable, e.g. tests/web).
  const handleSubOpenChange = (open: boolean): void => {
    if (!open || loaded || !window.api?.localFs) return
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
  }

  // Recursive rows for one expanded directory: subdirectories expand further, files are inert
  // leaf rows whose hover-revealed trailing button is the menu item — selecting it inserts the
  // reference and closes the menu naturally.
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
          {listing.summary}
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
                  className="group flex items-center gap-1.5 rounded-md py-1 pr-1.5 text-[13px] text-text-000 hover:bg-bg-200"
                  style={{ paddingLeft: indentForDepth(depth) }}
                >
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    data-testid={`your-files-dir-${root.id}-${relativePath}`}
                    onClick={() => toggleDir(childPath)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
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
              className="group relative flex min-h-8 items-center gap-1.5 rounded-lg py-1 pl-2 pr-1.5 text-[12px] hover:bg-muted"
              style={{ paddingLeft: indentForDepth(depth) }}
            >
              <File
                className="size-3.5 shrink-0 text-text-100"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate font-mono">{entry.name}</span>
              {/* asChild keeps the send action a real button while staying the menu item, so
                  selecting it runs the same select-and-close path the row item used before. */}
              <DropdownMenuItem
                asChild
                onSelect={() => sendFile(root, entry, relativePath)}
                className="flex size-[22px] min-h-0 shrink-0 items-center justify-center rounded-[5px] p-0 text-text-100 opacity-0 transition-opacity hover:bg-bg-300 hover:text-text-000 group-hover:opacity-100 data-[highlighted]:bg-bg-300 data-[highlighted]:text-text-000 data-[highlighted]:opacity-100"
              >
                <button
                  type="button"
                  data-testid={`your-files-send-${root.id}-${relativePath}`}
                  aria-label={`Insert ${relativePath}`}
                >
                  <ArrowUpRight className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
                </button>
              </DropdownMenuItem>
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
          <span className="min-w-0 flex-1 text-[13px] font-medium leading-5">Your files</span>
          <ChevronRight className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="max-h-[340px] w-[300px] overflow-y-auto">
          {/* Header: the grant action stays one click away even when no root is granted yet. */}
          <div className="flex items-center justify-end px-1.5 pb-1 pt-0.5">
            <button
              type="button"
              data-testid="your-files-grant-folder"
              onClick={() => setGrantDialogOpen(true)}
              className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium text-text-100 hover:bg-bg-200 hover:text-text-000"
            >
              <FolderPlus className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
              Grant folder…
            </button>
          </div>
          {loaded && roots.length === 0 ? (
            <div className="px-2 py-1.5 text-[12px] leading-4 text-text-300">
              No folders granted yet.
            </div>
          ) : null}
          {roots.map((root) => {
            const isExpanded = expandedDirs[root.path] === true
            return (
              <div key={root.id} data-testid={`your-files-root-${root.id}`}>
                <div className="group flex items-center gap-1.5 rounded-md py-1 pr-1.5 pl-1.5 text-[13px] text-text-000 hover:bg-bg-200">
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    data-testid={`your-files-root-toggle-${root.id}`}
                    onClick={() => toggleDir(root.path)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
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
                    aria-label={`Remove access to ${root.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      event.preventDefault()
                      void remove(root.id).catch(() => undefined)
                    }}
                    className="hidden size-[22px] shrink-0 items-center justify-center rounded-[5px] text-text-100 hover:bg-bg-300 hover:text-text-000 group-hover:inline-flex"
                  >
                    <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
                {isExpanded ? renderDirRows(root, root.path, '', 1) : null}
              </div>
            )
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {/* Hosted here so a fresh grant is one click from the tree; the dialog updates the store on
          success, which re-renders the root list above. */}
      <GrantFolderAccessDialog open={grantDialogOpen} onOpenChange={setGrantDialogOpen} />
    </>
  )
}
