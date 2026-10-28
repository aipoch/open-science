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
const projects = [project]
useProjectStore.setState({ projects, isLoaded: true })
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
    useCaseCatalog: async (mode) =>
      mode === 'cached' ? [] : parseUseCases(await (await fetch(USE_CASE_MANIFEST_URL)).json()),
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

export const Fixture = (): React.JSX.Element => {
  const view = useNavigationStore((state) => state.view)
  const projectId = useNavigationStore((state) => state.activeProjectId)
  return (
    <>
      {view === 'home' ? (
        <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={noop} />
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
