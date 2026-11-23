import { ChevronRight, Ellipsis, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ProjectFolderNotice } from '@/components/ProjectFolderNotice'
import { isDesktopRenderer } from '@/lib/interface-scale'
import { errorDetail } from '@/lib/error-detail'
import { projectFolderFailure, type ProjectFolderProblem } from '@/lib/project-folder-error'
import { cn } from '@/lib/utils'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { DirectoryBrowser, DirectoryListing, DirectoryLoading } from './directory-browser'
import type { LocalDirEntry } from '../../../../shared/local-fs'
import { createPreviewFileItemFromProjectFolder } from './preview-file-item'
import type { ProjectFolderListing } from '../../../../shared/project-folder-files'

const problemFor = (error: unknown): ProjectFolderProblem =>
  projectFolderFailure(error) ?? { kind: 'unavailable', diagnostics: errorDetail(error) ?? '' }

const FolderCrumb = ({
  name,
  isRoot = false,
  currentPath,
  onSelect
}: {
  name: string
  isRoot?: boolean
  currentPath?: string
  onSelect?: () => void
}): React.JSX.Element => (
  <li
    className={cn(
      'flex min-w-0 items-center gap-0.5',
      currentPath === undefined ? 'max-w-[32%]' : isRoot ? 'max-w-full' : 'max-w-[60%] shrink-0'
    )}
  >
    {!isRoot ? <ChevronRight className="size-3 shrink-0 text-text-300" aria-hidden="true" /> : null}
    {currentPath === undefined ? (
      <button
        type="button"
        title={name}
        className="truncate rounded-sm px-1 py-0.5 text-sm text-text-200 hover:bg-muted hover:text-foreground focus-visible:keyboard-focus focus-visible:outline-offset-[-2px]"
        onClick={onSelect}
      >
        {name}
      </button>
    ) : (
      <span
        aria-current="page"
        title={currentPath}
        className="truncate px-1 py-0.5 text-sm font-medium"
      >
        {name}
      </span>
    )}
  </li>
)

const FolderAncestorItems = ({
  segments,
  onSelect
}: {
  segments: string[]
  onSelect: (depth: number) => void
}): React.JSX.Element => (
  <>
    {segments.slice(0, -2).map((name, index) => (
      <DropdownMenuItem key={`${index}:${name}`} title={name} onSelect={() => onSelect(index + 1)}>
        <Folder className="mr-2 size-4 shrink-0 text-text-300" aria-hidden="true" />
        <span className="truncate">{name}</span>
      </DropdownMenuItem>
    ))}
  </>
)

export const ProjectFolderBrowser = ({
  projectId,
  rootPath,
  onEntryCountChange
}: {
  projectId: string
  rootPath: string
  onEntryCountChange: (count: number) => void
}): React.JSX.Element => {
  const { t } = useTranslation()
  const separator = window.api.platform === 'win32' ? '\\' : '/'
  const [relativePath, setRelativePath] = useState('')
  const [listing, setListing] = useState<ProjectFolderListing>()
  const [problem, setProblem] = useState<ProjectFolderProblem>()
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const breadcrumb = useRef<HTMLElement>(null)
  const selectedAncestor = useRef<string | null>(null)
  const load = useCallback(
    (cursor?: string): void => {
      const version = ++generation.current
      setBusy(true)
      setProblem(undefined)
      void window.api.projects
        .listFolder({ projectId, relativePath, limit: 100, ...(cursor ? { cursor } : {}) })
        .then((page) => {
          if (generation.current !== version) return
          setListing((previous) =>
            cursor && previous ? { ...page, entries: [...previous.entries, ...page.entries] } : page
          )
        })
        .catch((error: unknown) => {
          if (generation.current === version) setProblem(problemFor(error))
        })
        .finally(() => {
          if (generation.current === version) setBusy(false)
        })
    },
    [projectId, relativePath]
  )
  useEffect(() => {
    // Directory selection begins an external filesystem request and its loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
    return () => {
      generation.current += 1
    }
  }, [load])
  useEffect(() => {
    const refresh = (): void => load()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [load])
  useEffect(() => {
    onEntryCountChange(listing?.totalCount ?? 0)
  }, [listing?.totalCount, onEntryCountChange])
  const navigate = (path: string): void => {
    generation.current += 1
    setListing(undefined)
    setRelativePath(path)
    breadcrumb.current?.focus()
  }
  const childPath = (name: string): string =>
    relativePath ? `${relativePath}${separator}${name}` : name
  const openEntry = (entry: LocalDirEntry): void => {
    const path = childPath(entry.name)
    if (entry.isDirectory) {
      navigate(path)
      return
    }
    usePreviewWorkbenchStore
      .getState()
      .openFileDialog(createPreviewFileItemFromProjectFolder({ ...entry, projectId, path }))
  }
  const rootName =
    rootPath
      .split(separator === '\\' ? /[\\/]/ : '/')
      .filter(Boolean)
      .at(-1) ?? rootPath
  const segments = relativePath ? relativePath.split(separator) : []
  const parent = segments.at(-2)
  const current = segments.at(-1)
  const folderPath = relativePath
    ? `${rootPath.endsWith(separator) ? rootPath : rootPath + separator}${relativePath}`
    : rootPath
  const revealLabel =
    window.api.platform === 'darwin' ? t('Reveal in Finder') : t('Reveal in folder')
  const refreshLabel = t('Refresh files')
  const parentFoldersLabel = t('Show parent folders')
  return (
    <DirectoryBrowser
      busy={busy}
      testId="project-folder-browser"
      toolbar={
        <>
          <div className="min-w-0 flex-1 space-y-0.5">
            <nav
              ref={breadcrumb}
              tabIndex={-1}
              aria-label={t('Folder path')}
              className="flex items-center gap-1.5 rounded-sm focus-visible:keyboard-focus"
            >
              <Folder className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <ol className="flex min-w-0 flex-1 items-center gap-0.5">
                <FolderCrumb
                  name={rootName}
                  isRoot
                  currentPath={current === undefined ? folderPath : undefined}
                  onSelect={() => navigate('')}
                />
                {segments.length > 2 ? (
                  <li className="flex shrink-0 items-center gap-0.5">
                    <ChevronRight className="size-3 shrink-0 text-text-300" aria-hidden="true" />
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="text-text-200"
                          aria-label={parentFoldersLabel}
                          title={parentFoldersLabel}
                        >
                          <Ellipsis className="size-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        aria-label={parentFoldersLabel}
                        className="w-max max-w-[min(22rem,calc(100vw-1rem))]"
                        onCloseAutoFocus={(event) => {
                          const target = selectedAncestor.current
                          if (target === null) return
                          // Navigation can remove the trigger, so return focus to the breadcrumb.
                          event.preventDefault()
                          selectedAncestor.current = null
                          navigate(target)
                        }}
                      >
                        <FolderAncestorItems
                          segments={segments}
                          onSelect={(depth) => {
                            selectedAncestor.current = segments.slice(0, depth).join(separator)
                          }}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                ) : null}
                {parent !== undefined ? (
                  <FolderCrumb
                    name={parent}
                    onSelect={() => navigate(segments.slice(0, -1).join(separator))}
                  />
                ) : null}
                {current !== undefined ? (
                  <FolderCrumb name={current} currentPath={folderPath} />
                ) : null}
              </ol>
            </nav>
            {!relativePath ? (
              <p className="truncate text-xs text-muted-foreground" title={rootPath}>
                {rootPath}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-text-300"
              aria-label={refreshLabel}
              title={refreshLabel}
              onClick={() => load()}
              disabled={busy}
            >
              <RefreshCw
                className={cn('size-3.5', busy && 'animate-spin motion-reduce:animate-none')}
                aria-hidden="true"
              />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-text-300"
              aria-label={revealLabel}
              title={revealLabel}
              disabled={!isDesktopRenderer()}
              onClick={() => {
                void window.api.localFs
                  .reveal(rootPath)
                  .catch((error: unknown) => setProblem(problemFor(error)))
              }}
            >
              <FolderOpen className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </>
      }
    >
      {problem ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ProjectFolderNotice problem={problem} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => load()}
            disabled={busy}
          >
            {t('Retry')}
          </Button>
        </div>
      ) : listing ? (
        <DirectoryListing
          entries={listing.entries}
          onOpenEntry={openEntry}
          footer={
            listing.nextCursor ? (
              <div className="flex shrink-0 justify-center py-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => load(listing.nextCursor)}
                >
                  {busy ? t('Loading...') : t('Load more')}
                </Button>
              </div>
            ) : undefined
          }
        />
      ) : (
        <DirectoryLoading />
      )}
    </DirectoryBrowser>
  )
}
