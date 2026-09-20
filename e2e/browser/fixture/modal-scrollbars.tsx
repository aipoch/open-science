import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { LiteratureLibraryPage } from '@/pages/literature/LiteratureLibraryPage'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import { literatureItemInputSchema } from '../../../src/shared/literature'
import * as Dialog from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { dialogPanelClassName } from '@/components/ui/dialog-chrome'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { JobDetailModal } from '@/components/JobDetailModal'
import { useSessionJobStore } from '@/stores/session-job-store'
import { makeJob } from '@/test-utils/compute-job'
import { ReportErrorDialog } from '@/pages/workspace/ReportErrorDialog'

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
  mode === 'scroll-area' ? (
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
  )
)
