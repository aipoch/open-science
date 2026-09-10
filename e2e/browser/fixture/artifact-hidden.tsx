import '@/assets/main.css'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import { initI18n } from '@/i18n'
import { ArtifactHideButton, HiddenArtifactFiles } from '@/pages/workspace/HiddenArtifactFiles'
import { ProjectFilesFilterMenu } from '@/pages/workspace/project-files-presentation-owner'
import { DownloadProjectArtifactsDialog } from '@/pages/workspace/DownloadProjectArtifactsDialog'
import type { ProjectFileItem, ProjectFilesChangedEvent } from '../../../src/shared/project-files'

// Entirely in memory: no dev server API, filesystem, or existing user profile is used.
let hidden = false
const listeners = new Set<(event: ProjectFilesChangedEvent) => void>()
const file = {
  id: 'secret',
  source: 'artifact',
  sourceFileId: 'secret',
  sourceVersionId: 'v1',
  name: 'result.txt',
  sessionId: 'session',
  projectId: 'project',
  path: 'artifact://secret',
  mimeType: 'text/plain',
  size: 14,
  mtimeMs: 1
} as ProjectFileItem
window.api = {
  projectFiles: {
    onChanged: (listener: (event: ProjectFilesChangedEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setArtifactHidden: async (request: { hidden: boolean }) => {
      hidden = request.hidden
      for (const listener of listeners)
        listener({
          projectId: 'project',
          kind: 'reset',
          sources: ['artifact'],
          artifactVisibilityChanged: true
        })
    },
    getHiddenArtifactIds: async () => (hidden ? [{ fileId: 'secret', versionIds: ['v1'] }] : []),
    listFiles: async () => ({
      items: hidden ? [{ ...file, hidden: true }] : [],
      totalCount: hidden ? 1 : 0
    }),
    readHiddenArtifact: async () => ({
      content: 'private result',
      encoding: 'utf8',
      size: 14,
      truncated: false
    }),
    readExportFiles: async (request: { category?: string }) =>
      request.category === 'hidden'
        ? hidden
          ? [{ ...file, hidden: true }]
          : []
        : hidden
          ? []
          : [file],
    getOverview: async () => ({
      totalCount: hidden ? 0 : 1,
      hiddenArtifactCount: hidden ? 1 : 0,
      uploadCount: 0,
      artifactCount: hidden ? 0 : 1,
      artifactGroupCount: hidden ? 0 : 1,
      isIndexComplete: true
    })
  },
  saveProjectArtifacts: async () => ({ saved: false })
} as unknown as typeof window.api

export const App = (): React.JSX.Element => {
  const [isHidden, setHidden] = useState(hidden)
  const [filter, setFilter] = useState('all')
  const [exportOpen, setExportOpen] = useState(false)
  useEffect(() => {
    const listener = (): void => setHidden(hidden)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  const options = [
    { id: 'all', label: 'All artifacts', count: isHidden ? 0 : 1, kind: 'all' as const },
    { id: 'hidden', label: 'Hidden', count: isHidden ? 1 : 0, kind: 'hidden' as const }
  ]
  return (
    <TooltipProvider>
      <main className="m-4 flex h-[75vh] flex-col rounded-xl bg-bg-000 p-4 text-text-100 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <ProjectFilesFilterMenu
            label={filter === 'hidden' ? 'Hidden' : 'Artifacts'}
            options={options}
            selectedOptionId={filter}
            onSelect={setFilter}
            showAllSessions={false}
            onShowAllSessionsChange={() => undefined}
            sessionOptionCount={0}
            canLoadMoreOptions={false}
            onLoadMoreOptions={() => undefined}
            onBrowseRemoteHost={() => undefined}
            onBrowseLocal={() => undefined}
            onAddFolder={() => undefined}
            onSelectGrantedRoot={() => undefined}
            onGrantedRootMutation={async () => undefined}
            localMachineName="Test computer"
            isLocalSelected={false}
            selectedLocalRootId={undefined}
          />
          <button onClick={() => setExportOpen(true)}>Download project artifacts</button>
        </div>
        {filter === 'hidden' ? (
          <HiddenArtifactFiles projectId="project" query="" />
        ) : !isHidden ? (
          <div className="mt-6 flex items-center justify-between">
            <span>result.txt</span>
            <ArtifactHideButton projectId="project" fileId="secret" name="result.txt" />
          </div>
        ) : (
          <p className="mt-6">No visible artifacts</p>
        )}
        <DownloadProjectArtifactsDialog
          project={
            exportOpen
              ? {
                  id: 'project',
                  name: 'Temporary project',
                  description: '',
                  isExample: false,
                  createdAt: 1,
                  updatedAt: 1
                }
              : undefined
          }
          onClose={() => setExportOpen(false)}
        />
      </main>
    </TooltipProvider>
  )
}
void initI18n('en')
createRoot(document.getElementById('root')!).render(<App />)
