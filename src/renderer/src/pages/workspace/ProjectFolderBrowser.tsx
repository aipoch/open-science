import { ArrowLeft, File, Folder, FolderOpen, LoaderCircle, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProjectFolderNotice } from '@/components/ProjectFolderNotice'
import { isDesktopRenderer } from '@/lib/interface-scale'
import { errorDetail } from '@/lib/error-detail'
import { projectFolderFailure, type ProjectFolderProblem } from '@/lib/project-folder-error'
import { cn, formatByteSize } from '@/lib/utils'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { createPreviewFileItemFromProjectFolder } from './preview-file-item'
import type { ProjectFolderListing } from '../../../../shared/project-folder-files'

const problemFor = (error: unknown): ProjectFolderProblem =>
  projectFolderFailure(error) ?? { kind: 'unavailable', diagnostics: errorDetail(error) ?? '' }

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
  const [searchDraft, setSearchDraft] = useState('')
  const [query, setQuery] = useState('')
  const [listing, setListing] = useState<ProjectFolderListing>()
  const [problem, setProblem] = useState<ProjectFolderProblem>()
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const load = useCallback(
    (cursor?: string): void => {
      const version = ++generation.current
      setBusy(true)
      setProblem(undefined)
      void window.api.projects
        .listFolder({ projectId, relativePath, query, limit: 100, ...(cursor ? { cursor } : {}) })
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
    [projectId, relativePath, query]
  )
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchDraft.trim()), 180)
    return () => clearTimeout(timer)
  }, [searchDraft])
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
    setListing(undefined)
    setRelativePath(path)
    setSearchDraft('')
    setQuery('')
  }
  const childPath = (name: string): string =>
    relativePath ? `${relativePath}${separator}${name}` : name
  const parentPath = relativePath.slice(0, Math.max(0, relativePath.lastIndexOf(separator)))
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={busy}
      data-testid="project-folder-browser"
    >
      <div className="flex shrink-0 items-center gap-2 border-y border-border-300/60 px-4 py-2">
        <Search className="size-3.5 shrink-0 text-text-300" aria-hidden="true" />
        <Input
          type="search"
          aria-label={t('Search project files')}
          placeholder={t('Search files')}
          maxLength={256}
          value={searchDraft}
          onChange={(event) => setSearchDraft(event.target.value)}
          className="h-[30px] min-w-0 border-0 bg-transparent px-0 shadow-none"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('Refresh files')}
          onClick={() => load()}
          disabled={busy}
        >
          <RefreshCw
            className={cn('size-3.5', busy && 'animate-spin motion-reduce:animate-none')}
            aria-hidden="true"
          />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <div className="space-y-2 py-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Folder className="size-4 shrink-0 text-primary" aria-hidden="true" />
            {rootPath.split(separator).at(-1) || t('Project folder')}
          </p>
          <p className="break-all font-mono text-xs text-muted-foreground">{rootPath}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!isDesktopRenderer()}
            onClick={() => {
              void window.api.localFs
                .reveal(rootPath)
                .catch((error: unknown) => setProblem(problemFor(error)))
            }}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            {window.api.platform === 'darwin' ? t('Reveal in Finder') : t('Reveal in folder')}
          </Button>
        </div>
        {relativePath ? (
          <div className="flex items-center gap-2 border-y border-border py-2">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t('Go up one level')}
              onClick={() => navigate(parentPath)}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">
              {relativePath}
            </span>
          </div>
        ) : null}
        {problem ? (
          <div className="py-3">
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
        ) : null}
        {!problem && !listing && busy ? (
          <p role="status" className="py-6 text-center text-sm text-muted-foreground">
            <LoaderCircle
              className="mx-auto mb-2 size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t('Loading...')}
          </p>
        ) : null}
        {!problem &&
          listing?.entries.map((entry) => (
            <button
              key={entry.name}
              type="button"
              className={cn(
                'flex w-full items-center gap-2 border-b border-border-300/40 py-3 text-left text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                entry.name === 'node_modules' && 'opacity-50'
              )}
              onClick={() =>
                entry.isDirectory
                  ? navigate(childPath(entry.name))
                  : usePreviewWorkbenchStore.getState().openFileDialog(
                      createPreviewFileItemFromProjectFolder({
                        ...entry,
                        projectId,
                        path: childPath(entry.name)
                      })
                    )
              }
            >
              {entry.isDirectory ? (
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              ) : (
                <File className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1 break-all">{entry.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {entry.isDirectory ? '' : formatByteSize(entry.size)}
              </span>
            </button>
          ))}
        {!problem && listing?.entries.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {query ? t('No files match “{{query}}”', { query }) : t('No files yet')}
          </p>
        ) : null}
        {!problem && listing?.nextCursor ? (
          <div className="flex justify-center py-3">
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
        ) : null}
      </div>
    </div>
  )
}
