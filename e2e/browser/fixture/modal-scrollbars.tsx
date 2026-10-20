import { LiteratureRendererProvider } from '@/pages/literature/public/host'
import { literatureRendererHost } from '@/lib/literature-renderer-host'
import '@/assets/main.css'
import { JobDetailModal } from '@/components/JobDetailModal'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import * as Dialog from '@/components/ui/dialog'
import { dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { ScrollArea } from '@/components/ui/scroll-area'
import { initI18n } from '@/i18n'
import { LiteratureLibraryPage } from '@/pages/literature/public/page'
import { ReportErrorDialog } from '@/pages/workspace/ReportErrorDialog'
import { GrantFolderAccessDialog } from '@/pages/workspace/GrantFolderAccessDialog'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionJobStore } from '@/stores/session-job-store'
import { useTagStore } from '@/stores/tag-store'
import { makeJob } from '@/test-utils/compute-job'
import { literatureItemInputSchema } from '@aipoch/literature-library/contracts'
import { createRoot } from 'react-dom/client'

const mode = new URLSearchParams(location.search).get('mode')

initI18n('en')
const reference = {
  id: 'scroll-reference',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  projectIds: [],
  collectionIds: [],
  attachments: [],
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Metabolism in Tumour-Induced Bone Disease',
    abstract: 'Long reference content for testing Windows dialog scrolling. '.repeat(30),
    issuedYear: 2026,
    containerTitle: 'Current Osteoporosis Reports',
    language: 'en',
    creators: [
      { nameMode: 'person', givenName: 'Renee T.', familyName: 'Ormsby', creatorType: 'author' }
    ],
    identifiers: [{ scheme: 'doi', value: '10.1007/s11914-026-00956-3', isPrimary: true }]
  })
}
window.api = {
  platform: 'win32',
  literature: {
    onChanged: () => () => {},
    search: async ({ scope }: { scope: string }) => ({
      entries:
        scope === 'library'
          ? [
              reference,
              { ...reference, id: 'second', item: { ...reference.item, title: 'Second reference' } }
            ]
          : scope === 'inbox'
            ? [
                {
                  id: 'candidate',
                  state: 'pending',
                  createdAt: 1,
                  updatedAt: 1,
                  candidate: {
                    item: reference.item,
                    source: { provider: 'Agent search', sourceUrl: '', rawMetadata: {} },
                    origin: { kind: 'agent', projectId: 'project-0', sessionId: 'session' }
                  }
                }
              ]
            : []
    }),
    get: async () => reference,
    sources: async () => [],
    jobs: async () => ({ jobs: [], summaries: [] }),
    citationStyles: async () => ({ styles: [] })
  },
  tags: {
    snapshot: async () => ({ revision: 1, tags: [], assignments: [] }),
    onChanged: () => () => {}
  }
} as unknown as typeof window.api
if (mode === 'folder-grant') {
  window.api = {
    platform: 'darwin',
    localFs: {
      getRoots: async () => ({ home: '/Users/researcher', machineName: 'Test Mac' }),
      listDrives: async () => [{ path: '/', label: 'Macintosh HD' }],
      listGrantedRoots: async () => [],
      listDir: async (path: string) => ({
        resolvedPath: path,
        truncated: false,
        entries: Array.from({ length: 20 }, (_, index) => ({
          name: `Research folder ${index + 1}`,
          isDirectory: true,
          size: 0,
          mtimeMs: 0
        }))
      }),
      grantRoot: async () => {
        throw new Error(
          'Notebook cleanup is incomplete; folder access changes are unavailable until cleanup is verified.\n'.repeat(
            new URLSearchParams(location.search).has('longError') ? 30 : 1
          )
        )
      }
    }
  } as unknown as typeof window.api
}
useNavigationStore.setState({
  view: 'library',
  pendingLiteratureItemId: mode ? undefined : reference.id
})
useProjectStore.setState({
  projects: Array.from({ length: 15 }, (_, index) => ({
    id: `project-${index}`,
    name: `Research project ${index + 1}`,
    description: '',
    isExample: false,
    createdAt: 1,
    updatedAt: 1
  })),
  isLoaded: true
})
useTagStore.setState({ status: 'ready', revision: 1, tags: [], assignments: [] })
useSessionJobStore.setState({
  jobsById: new Map(
    Array.from({ length: 30 }, (_, index) => {
      const job = makeJob({
        job_id: `job-${index}`,
        session_id: 'scroll-session',
        status: 'success',
        intent: `Research computation ${index + 1}`
      })
      return [job.job_id, job]
    })
  )
})
createRoot(document.getElementById('root')!).render(
  <LiteratureRendererProvider host={literatureRendererHost}>
    {mode === 'folder-grant' ? (
      <GrantFolderAccessDialog
        open
        onOpenChange={() => {}}
        initialPath="/Users/researcher/Library/CloudStorage/OneDrive-Personal/Research/Experiment/Figures/notebooks"
      />
    ) : mode === 'scroll-area' ? (
      <Dialog.Root open>
        <Dialog.Portal>
          <Dialog.Content
            className={dialogPanelClassName('flex flex-col p-0')}
            style={{ width: 420, height: 380 }}
          >
            <Dialog.Title>Shared scroll area</Dialog.Title>
            <Dialog.Description>Positioned content stays inside the viewport.</Dialog.Description>
            <ScrollArea className="min-h-0 flex-1" type="always">
              <div style={{ height: 1200 }}>Long content</div>
              <input className="sr-only" aria-label="Upload fixture" type="file" />
              <button>Last action</button>
            </ScrollArea>
            <button>Footer action</button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    ) : mode === 'confirm' ? (
      <ConfirmActionDialog
        open
        title="Confirm action"
        description={'Long confirmation description. '.repeat(150)}
        cancelLabel="Cancel"
        confirmLabel="Confirm"
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    ) : mode === 'jobs' ? (
      <JobDetailModal open sessionId="scroll-session" onClose={() => {}} />
    ) : mode === 'report' ? (
      <ReportErrorDialog
        open
        error={'Long error details\n'.repeat(100)}
        subject={{}}
        onClose={() => {}}
      />
    ) : (
      <LiteratureLibraryPage />
    )}
  </LiteratureRendererProvider>
)
