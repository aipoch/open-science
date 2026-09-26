import '@/assets/main.css'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { HomePage } from '@/pages/home/HomePage'
import { WorkspaceSidebarView } from '@/pages/workspace/WorkspaceSidebar'
import { ComposerYourFilesMenu } from '@/pages/workspace/ComposerYourFilesMenu'
import { BookmarksPopover } from '@/pages/workspace/bookmarks/BookmarksPopover'
import { BookmarksContext } from '@/pages/workspace/bookmarks/bookmark-context'
import { subscribeBookmarkReveal } from '@/pages/workspace/annotations/annotation-reveal'
import { PdfOutlineSidebar } from '@/pages/workspace/previews/renderers/PdfOutlineSidebar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { useGrantedFoldersStore } from '@/stores/granted-folders-store'
import { SpecialistMarketplace } from '@/pages/settings/SpecialistMarketplace'
import { TagsPanel } from '@/pages/settings/TagsPanel'
import { ComputePanel } from '@/pages/settings/ComputePanel'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { useMarketplaceStore } from '@/stores/marketplace-store'
import { useTagStore } from '@/stores/tag-store'
import { useComputeStore } from '@/stores/compute-store'
import type { Bookmark } from '../../../src/shared/bookmarks'

initI18n('en')
const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle('dark', params.has('dark'))
const now = Date.now()
const noop = (): void => {}
const session: ChatSession = {
  id: 'session-1',
  projectId: 'project-1',
  title: 'Analysis session',
  cwd: '/fixture',
  status: 'idle',
  messages: [],
  createdAt: now,
  updatedAt: now
}
const bookmark: Bookmark = {
  id: 'bookmark-1',
  projectId: 'project-1',
  sessionId: session.id,
  version: 1,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
  note: 'Review this result',
  target: {
    kind: 'text',
    source: { kind: 'agent-message', sessionId: session.id, messageId: 'message-1' },
    quote: 'A useful result'
  }
}
// Native boundaries only; all hit testing, controls, menus and styles are production code.
window.api = {
  platform: 'darwin',
  projectFiles: { onChanged: () => noop },
  github: { getStars: async () => 1000 },
  compute: { deletionStatus: async () => ({ blockedByJobs: false }) },
  localFs: {
    listDir: async (path: string) => ({
      entries:
        path === '/fixture' ? [{ name: 'nested', isDirectory: true, size: 0, mtimeMs: now }] : [],
      truncated: false,
      resolvedPath: path
    })
  }
} as unknown as typeof window.api
useProjectStore.setState({
  isLoaded: true,
  projects: [
    {
      id: 'project-1',
      name: 'P1',
      description: '',
      isExample: false,
      createdAt: now,
      updatedAt: now
    }
  ]
})
useSessionStore.setState({ sessions: [session] })
useGrantedFoldersStore.setState({
  loaded: true,
  roots: [{ id: 'root-1', name: 'Data', path: '/fixture', access: 'ro' }]
})

useSettingsStore.setState({
  skillsLoaded: true,
  connectorsLoaded: true,
  loadSkills: async () => {},
  loadConnectors: async () => {},
  skills: [
    {
      id: 'analysis',
      name: 'analysis',
      displayName: 'Analysis',
      description: 'Analyze data',
      source: 'featured',
      enabled: true,
      updatedAt: new Date(now).toISOString()
    }
  ]
})
useSpecialistStore.setState({ items: [], isLoaded: true, load: async () => {} })
useTagStore.setState({
  status: 'ready',
  revision: 1,
  tags: [{ id: 'tag-favorite', systemKey: 'favorite', createdAt: 1, updatedAt: 1 }],
  assignments: [
    { tagId: 'tag-favorite', resourceType: 'catalog.skill', resourceId: 'analysis', createdAt: 1 }
  ]
})
useMarketplaceStore.setState({
  refresh: async () => {},
  snapshot: {
    sources: [],
    failures: [],
    specialists: [
      {
        sourceId: 'fixture',
        sourceName: 'Fixture market',
        sourceTrust: 'official',
        id: 'researcher',
        displayName: 'Researcher',
        summary: 'Focused research',
        publisher: { id: 'fixture', name: 'Fixture' },
        version: '1.0.0'
      }
    ]
  }
})
useComputeStore.setState({
  isLoaded: true,
  loadHosts: async () => {},
  hosts: [
    {
      id: 'host-1',
      providerId: 'ssh:fixture',
      displayName: 'Compute host',
      shape: 'direct_ssh',
      executionMode: 'direct_ssh',
      sshAlias: 'fixture',
      sshOverrides: undefined,
      scratchRoot: undefined,
      scratchPinned: false,
      concurrencyLimit: undefined,
      probeResult: undefined,
      detailsDoc: '',
      detailsUpdatedAt: undefined,
      detailsUpdatedBy: undefined,
      createdAt: 1,
      updatedAt: 1
    }
  ]
})

export function Fixture(): React.JSX.Element {
  const [actions, setActions] = useState<string[]>([])
  const [openSessionActionsId, setOpenSessionActionsId] = useState<string | null>(null)
  const record = (action: string): void => setActions((current) => [...current, action])
  useEffect(() => {
    useNavigationStore.setState({
      openProject: () => {
        record('project')
        return true
      },
      openSession: () => {
        record('recent')
        return true
      }
    })
    useGrantedFoldersStore.setState({
      remove: async () => {
        record('remove-folder')
        if (params.has('pending')) await new Promise(() => {})
        return useGrantedFoldersStore.getState().roots
      }
    })
    useTagStore.setState({
      setAssignment: async () => {
        record('remove-tag')
        if (params.has('pending')) await new Promise(() => {})
      }
    })
    return subscribeBookmarkReveal(() => {
      record('bookmark')
      return 'revealed'
    })
  }, [])
  const surface = params.get('surface') ?? 'home'
  return (
    <>
      <output
        data-testid="actions"
        className="fixed bottom-0 right-0 z-50 bg-background text-foreground"
      >
        {actions.join(',')}
      </output>
      {surface === 'home' ? (
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={noop} />
      ) : null}
      {surface === 'marketplace' ? (
        <div className="p-8">
          <SpecialistMarketplace
            view={{ kind: 'marketplace' }}
            onNavigate={() => record('specialist')}
          />
        </div>
      ) : null}
      {surface === 'tags' ? (
        <div className="p-8">
          <TagsPanel
            view={{ kind: 'list', tagId: 'tag-favorite' }}
            onNavigate={noop}
            onOpenResource={() => record('tag-resource')}
          />
        </div>
      ) : null}
      {surface === 'compute' ? (
        <div className="p-8">
          <ComputePanel onNavigate={() => record('host')} />
        </div>
      ) : null}
      {surface === 'sidebar' ? (
        <div className="h-[700px] w-72">
          <WorkspaceSidebarView
            projectName="P1"
            sessions={[session]}
            activeSessionId={undefined}
            now={now}
            canCreateConversation
            canMutateConversations
            canDeleteConversations
            canDownloadArtifacts
            isFilesOpen={false}
            onGoHome={noop}
            onNewConversation={noop}
            onOpenFiles={noop}
            onOpenSession={() => record('session')}
            openSessionActionsId={openSessionActionsId}
            onSessionActionsOpenChange={(sessionId, open) => {
              setOpenSessionActionsId((current) =>
                open ? sessionId : current === sessionId ? null : current
              )
            }}
            onRenameSession={noop}
            onDownloadArtifacts={noop}
            onViewNotebook={noop}
            onTogglePin={() => record('pin')}
            onDeleteSession={noop}
            onOpenSettings={noop}
            onOpenProjectSettings={noop}
            onNewProject={noop}
          />
        </div>
      ) : null}
      {surface === 'folders' ? (
        <div className="p-8">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button">Files menu</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <ComposerYourFilesMenu onInsertFileReference={() => record('attach')} />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
      {surface === 'bookmarks' ? (
        <div className="p-8">
          <BookmarksContext.Provider
            value={{
              scoped: true,
              available: true,
              bookmarks: [bookmark],
              total: 1,
              loading: false,
              retryLoad: noop,
              create: async () => bookmark,
              updateNote: async () => {
                record('edit-bookmark')
                return bookmark
              },
              remove: async () => {
                record('delete-bookmark')
                return true
              }
            }}
          >
            <BookmarksPopover />
          </BookmarksContext.Provider>
        </div>
      ) : null}
      {surface === 'pdf' ? (
        <div className="flex h-[600px]">
          <PdfOutlineSidebar
            document={{
              getPage: async () => {
                throw new Error('Outline must not render thumbnails')
              }
            }}
            items={[
              {
                id: 'chapter',
                title: 'Chapter',
                pageNumber: 1,
                children: [{ id: 'child', title: 'Nested section', pageNumber: 2, children: [] }]
              }
            ]}
            pageCount={3}
            currentPage={1}
            width={260}
            onWidthChange={noop}
            onClose={noop}
            onNavigate={(page) => record(`page-${page}`)}
          />
        </div>
      ) : null}
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
