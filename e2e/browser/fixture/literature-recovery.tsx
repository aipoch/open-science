import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { LiteratureLibraryPage } from '@/pages/literature/LiteratureLibraryPage'
import { LiteratureBatchLookupDialog } from '@/pages/literature/LiteratureBatchLookupDialog'
import { LiteratureMetadataEditor } from '@/pages/literature/LiteratureMetadataEditor'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import {
  literatureItemInputSchema,
  type LiteratureCatalogCommand
} from '../../../src/shared/literature'
import type { LiteratureJobView, LiteratureJobRequest } from '../../../src/shared/literature-jobs'

initI18n('en')
const parent = {
  id: 'parent',
  revision: 1,
  name: 'Parent',
  description: '',
  itemCount: 0,
  createdAt: 1,
  updatedAt: 1
}
let collections = [
  parent,
  { ...parent, id: 'child', name: 'Review', parentId: 'parent' },
  { ...parent, id: 'root', name: 'review' }
]
const commands: Array<LiteratureCatalogCommand | LiteratureJobRequest> = []
const job: LiteratureJobView = {
  id: '9323d39a-2ae2-49c8-8826-a589c78f1f5d',
  mode: 'metadata',
  phase: 'search',
  state: 'review',
  createdAt: 1,
  updatedAt: 1,
  rows: [
    {
      id: 'failed',
      status: 'error',
      checked: true,
      item: { id: 'failed', metadataRevision: 1, item: { title: 'Network failure' } },
      failures: [{ code: 'network', source: 'crossref', phase: 'search', retryable: true }]
    },
    {
      id: 'ready',
      status: 'ready',
      checked: false,
      item: { id: 'ready', metadataRevision: 1, item: { title: 'Review retained' } }
    }
  ]
}
Object.assign(window, { literatureRecovery: { commands, job } })
window.api = {
  platform: 'darwin',
  literature: {
    onChanged: () => () => {},
    search: async (request: { scope: string }) => ({
      entries: request.scope === 'collections' ? collections : []
    }),
    transact: async (command: LiteratureCatalogCommand) => {
      commands.push(command)
      if (command.kind === 'update-collection')
        collections = collections.map((collection) =>
          collection.id === command.collectionId
            ? { ...collection, name: command.name, revision: collection.revision + 1 }
            : collection
        )
      if (command.kind === 'delete-collection')
        collections = collections
          .filter(({ id }) => id !== command.collectionId)
          .map((collection) => ({ ...collection, parentId: undefined }))
      return { kind: 'collection', id: 'child' }
    },
    jobs: async (request: LiteratureJobRequest) => {
      if (request.action === 'list') return { jobs: [], summaries: [] }
      commands.push(request)
      if (request.action === 'retry-failed') {
        job.rows[0] = { ...job.rows[0], status: 'ready', failures: undefined }
        job.updatedAt++
      }
      return { jobs: [structuredClone(job)] }
    },
    citationStyles: async () => ({ styles: [] })
  },
  tags: {
    snapshot: async () => ({ revision: 1, tags: [], assignments: [] }),
    onChanged: () => () => {}
  }
} as unknown as typeof window.api
useNavigationStore.setState({ view: 'library', pendingLiteratureCollectionId: 'parent' })
useProjectStore.setState({ projects: [], isLoaded: true })
useTagStore.setState({ status: 'ready', revision: 1, tags: [], assignments: [] })
const mode = new URLSearchParams(location.search).get('mode')
createRoot(document.getElementById('root')!).render(
  mode === 'batch' ? (
    <LiteratureBatchLookupDialog
      itemIds={['failed', 'ready']}
      initialItems={[]}
      mode="metadata"
      jobId={job.id}
      fieldLabel={(field) => field}
      onClose={() => {}}
      onChanged={() => {}}
    />
  ) : mode === 'editor' ? (
    <LiteratureMetadataEditor
      item={literatureItemInputSchema.parse({
        title: 'Seasonal reference',
        itemType: 'journalArticle'
      })}
      saving={false}
      onCancel={() => {}}
      onSave={(item) => Object.assign(window, { savedLiteratureItem: item })}
    />
  ) : (
    <LiteratureLibraryPage />
  )
)
