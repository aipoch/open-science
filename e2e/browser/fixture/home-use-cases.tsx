import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkspaceSidebar } from '@/pages/workspace/WorkspaceSidebar'
import { PreviewPanelSurface } from '@/pages/workspace/PreviewPanel'
import {
  createProjectMarketplacePreviewItem,
  PROJECT_MARKETPLACE_PREVIEW_ID,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { SharingMarketplacePage } from '@/pages/marketplace/SharingMarketplacePage'
import { parseUseCases, USE_CASE_MANIFEST_URL } from '../../../src/shared/use-cases'
import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { HomePage } from '@/pages/home/HomePage'
import {
  SessionPackageOperation,
  PackageOperationIndicator
} from '@/components/SessionPackageOperation'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import type { PackageOperationSnapshot } from '../../../src/shared/session-package'
import type { Project } from '../../../src/shared/projects'

const query = new URLSearchParams(location.search)
const locale = query.has('zh') ? 'zh-Hans' : 'en'
document.documentElement.classList.toggle('dark', query.has('dark'))
const project: Project = {
  id: 'research',
  name: 'Research project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 2
}
// Long lists exercise the actual homepage layout and scrolling boundary.
const projects = query.has('long')
  ? Array.from({ length: 30 }, (_, index) => ({
      ...project,
      id: index === 0 ? project.id : `research-${index}`,
      name: index === 0 ? project.name : `Research project ${index + 1}`
    }))
  : [project]
useProjectStore.setState({ projects, isLoaded: true })
// Running sessions populate the shared scrolling status-card region.
if (query.has('updates')) {
  const now = Date.now()
  useSessionStore.setState({
    sessions: Array.from({ length: query.has('many-updates') ? 8 : 2 }, (_, index) => ({
      id: `running-${index}`,
      projectId: project.id,
      title: `Running research ${index + 1}`,
      cwd: '',
      status: 'running' as const,
      messages: [],
      createdAt: now,
      updatedAt: now,
      activeRun: { promptMessageId: `prompt-${index}`, startedAt: now }
    }))
  })
}
const noop = (): void => {}
let finishImport: (value: { projectId: string; sessionId: string } | null) => void = noop
// Only the native transport is replaced. Selection, confirmation, navigation and replay use production owners.
const nativeApi = {
  platform: 'darwin',
  github: { getStars: async () => 5400 },
  projectFiles: {
    getOverview: async () => ({
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    }),
    onChanged: () => noop
  },
  projects: { list: async () => projects },
  sessions: {
    useCaseCatalog: async (mode) => {
      if (mode === 'cached') return []
      const response = await fetch(USE_CASE_MANIFEST_URL, {
        ...(mode === 'reload' ? { cache: 'no-store' as const } : {})
      })
      if (!response.ok) throw new Error('Catalog unavailable')
      return parseUseCases(await response.json())
    },
    useCaseIntroduction: async (slug) => {
      const response = await fetch(new URL(`${slug}/intro.md`, USE_CASE_MANIFEST_URL))
      if (!response.ok) throw new Error('Introduction unavailable')
      return response.status === 204 ? null : response.text()
    },
    importPackage: async (target, source) => {
      if (
        Object.keys(target ?? {}).length ||
        !source ||
        typeof source !== 'object' ||
        !('useCase' in source)
      )
        throw new Error('Expected a catalog source with deferred destination')
      const operation: PackageOperationSnapshot = {
        id: 'example-import',
        kind: 'import',
        state: query.has('download') ? 'running' : 'awaiting-selection',
        ...(query.has('download')
          ? { useCaseDownload: { slug: source.useCase, completedBytes: 35, totalBytes: 100 } }
          : {}),
        importRequestId: 'catalog',
        importFilename: `${source.useCase}.science`,
        progress: { phase: query.has('download') ? 'copying' : 'selecting' }
      }
      // Native downloads publish their owner before handing off to project selection.
      if (!operation.useCaseDownload)
        usePackageOperationStore.getState().receive({
          ...operation,
          state: 'running',
          useCaseDownload: { slug: source.useCase, completedBytes: 0 }
        })
      usePackageOperationStore.getState().receive(operation)
      return new Promise<{ projectId: string; sessionId: string } | null>((resolve) => {
        finishImport = resolve
      })
    },
    packageOperation: async (request) => {
      const current = usePackageOperationStore.getState().operation
      if (!current || request.action === 'snapshot') return current
      if (request.action === 'select-project') {
        usePackageOperationStore.getState().receive({
          ...current,
          importTarget: request.target,
          progress: { phase: 'confirming' },
          importPreview: {
            title: 'Imported example',
            projectName: 'Research project',
            branchCount: 1,
            messageCount: 2,
            fileCount: 0,
            totalBytes: 512,
            omissions: []
          }
        })
      } else if (request.action === 'confirm-import') {
        const projectId = current.importTarget?.projectId ?? 'new-project'
        if (!projects.some((project) => project.id === projectId))
          projects.push({
            ...project,
            id: projectId,
            name: current.importTarget?.projectName ?? 'New project'
          })
        useProjectStore.setState({ projects: [...projects] })
        useSessionStore.setState({
          sessions: [
            {
              id: 'imported',
              projectId,
              title: 'Imported example',
              cwd: '',
              status: 'idle',
              messages: [],
              createdAt: 1,
              updatedAt: 2
            }
          ]
        })
        const identity = { projectId, sessionId: 'imported' }
        usePackageOperationStore
          .getState()
          .receive({ ...current, state: 'succeeded', result: { imported: identity } })
        finishImport(identity)
      } else if (request.action === 'cancel') {
        usePackageOperationStore.getState().receive({ ...current, state: 'cancelled' })
        finishImport(null)
      }
      return usePackageOperationStore.getState().operation
    }
  }
} satisfies { [Key in keyof typeof window.api]?: Partial<(typeof window.api)[Key]> }
window.api = nativeApi as unknown as typeof window.api

if (query.has('panel')) {
  useNavigationStore.setState({ view: 'workspace', activeProjectId: project.id })
  usePreviewWorkbenchStore.getState().activateProject(project.id)
}

// Sidebar and workbench are real; the conversation draft is a lightweight sibling for layout checks.
const WorkspaceMarketFixture = (): React.JSX.Element => {
  const activeItem = usePreviewWorkbenchStore((state) => state.activeItemId)
  return (
    <TooltipProvider>
      <div className="flex h-svh min-h-0">
        <div className="w-60 shrink-0">
          <WorkspaceSidebar
            projectName="Research project"
            sessions={[]}
            activeSessionId={undefined}
            canCreateConversation
            canMutateConversations
            canDeleteConversations
            onGoHome={() => useNavigationStore.getState().goHome('user')}
            onNewConversation={noop}
            isFilesOpen={false}
            onOpenFiles={noop}
            isMarketplaceOpen={activeItem === PROJECT_MARKETPLACE_PREVIEW_ID}
            onOpenMarketplace={() =>
              usePreviewWorkbenchStore
                .getState()
                .upsertAndActivateItem(createProjectMarketplacePreviewItem())
            }
            onOpenSession={noop}
            onRenameSession={noop}
            canDownloadArtifacts={false}
            onDownloadArtifacts={noop}
            onViewNotebook={noop}
            onTogglePin={noop}
            onDeleteSession={noop}
            onOpenSettings={noop}
            onOpenProjectSettings={noop}
            onNewProject={noop}
          />
        </div>
        <div className="min-w-0 flex-1 p-6">
          <textarea
            aria-label="Conversation draft"
            defaultValue="Keep my draft"
            className="w-full"
          />
        </div>
        <div className="h-full w-[560px] shrink-0 border-l border-border" data-workspace-preview>
          <PreviewPanelSurface />
        </div>
      </div>
    </TooltipProvider>
  )
}

export const Fixture = (): React.JSX.Element => {
  const view = useNavigationStore((state) => state.view)
  const projectId = useNavigationStore((state) => state.activeProjectId)
  return (
    <>
      {query.has('panel') ? (
        <>
          {view === 'workspace' && <WorkspaceMarketFixture />}
          {view === 'home' && (
            <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={noop} />
          )}
          {view === 'marketplace' && <SharingMarketplacePage />}
        </>
      ) : view === 'home' ? (
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={noop} />
      ) : view === 'marketplace' ? (
        <SharingMarketplacePage />
      ) : (
        <>
          <button onClick={() => useNavigationStore.getState().goHome('user')}>Back to Home</button>
          <PackageOperationIndicator />
        </>
      )}
      <SessionPackageOperation />
      <output data-testid="navigation">
        {view}:{projectId}
      </output>
    </>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
