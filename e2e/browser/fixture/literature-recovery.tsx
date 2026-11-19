import type { LiteratureRelatedRequest } from '@aipoch/literature-discovery/contracts'
import { LiteratureRendererProvider } from '@/pages/literature/public/host'
import { literatureRendererHost } from '@/lib/literature-renderer-host'
import '@/assets/main.css'
import { initI18n } from '@/i18n'
import { LiteratureMetadataEditor } from '@/pages/literature/detail/LiteratureMetadataEditor'
import { LiteratureLibraryPage } from '@/pages/literature/public/page'
import { LiteratureBatchLookupDialog } from '@/pages/literature/workflows/LiteratureBatchLookupDialog'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import { useSettingsStore } from '@/stores/settings-store'
import type { LiteratureJobRequest, LiteratureJobView } from '@aipoch/literature-discovery/jobs'
import {
  literatureItemInputSchema,
  literatureRecordImportRequestSchema,
  type LiteratureItemView,
  type LiteratureCatalogCommand
} from '@aipoch/literature-library/contracts'
import { createRoot } from 'react-dom/client'
import { citationGraphResult } from './citation-graph-data'

initI18n('en')
const params = new URLSearchParams(location.search)
const mode = params.get('mode')
document.documentElement.classList.toggle('dark', params.has('dark'))
let foreignFields: Record<string, unknown> = {}
if (params.has('foreign-metadata')) {
  const frame = document.createElement('iframe')
  frame.hidden = true
  document.body.append(frame)
  const foreignJson = (frame.contentWindow as unknown as { JSON: JSON }).JSON
  foreignFields = foreignJson.parse(
    '{"nested":{"scores":[0,1,2],"flag":false,"none":null}}'
  ) as Record<string, unknown>
}
const linkReferences: string[] = []
const pendingLinkLookups: Array<() => void> = []
Object.assign(window, {
  literatureLink: {
    references: linkReferences,
    completeLookup: (index: number): void => pendingLinkLookups[index]()
  }
})
let citationUnavailable = params.has('citation-unavailable')
Object.assign(window, {
  recoverCitationSource: (): void => {
    citationUnavailable = false
  }
})
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
let fileItem: LiteratureItemView = {
  id: 'drop-reference',
  metadataRevision: 1,
  item: literatureItemInputSchema.parse({
    title: 'A reference with supporting PDFs',
    itemType: 'journalArticle',
    abstract: 'Original paper, translation, and supplementary material.'
  }),
  attachments: [
    {
      id: 'original',
      kind: 'fullText',
      title: '',
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      versions: [
        {
          id: 'original-v1',
          versionNumber: 1,
          filename: 'original.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          checksum: 'a'.repeat(64),
          pageCount: 1,
          availability: 'available',
          createdAt: 1
        }
      ]
    }
  ],
  projectIds: [],
  collectionIds: [],
  createdAt: 1,
  updatedAt: 1
}
const fileRequests: object[] = []
let failedCitationPage = false
Object.assign(window, { literatureFiles: { requests: fileRequests } })
window.api = {
  platform: 'darwin',
  saveManagedFile: async (request: object) => {
    fileRequests.push(request)
    return { saved: true }
  },
  uploads: {
    stageLocalFile: async (file: File) => ({
      id: file.name,
      sessionId: '.pending',
      name: file.name,
      originalName: file.name,
      path: `/managed/${file.name}`,
      mimeType: 'application/pdf',
      size: file.size
    }),
    claimLocalFile: async () => {},
    deleteUpload: async () => {},
    abortTransfer: async () => {}
  },
  literature: {
    overviewBatch: async () => null,
    lookupMetadata: async (reference: string) => {
      linkReferences.push(reference)
      if (!params.has('citation-graph') || params.has('hold-paper-details'))
        await new Promise<void>((resolve) => pendingLinkLookups.push(resolve))
      const arxiv = reference.startsWith('arxiv:')
      const scheme = arxiv
        ? 'arxiv'
        : reference.startsWith('pmcid:')
          ? 'pmcid'
          : reference.startsWith('pmid:')
            ? 'pmid'
            : 'doi'
      return literatureItemInputSchema.parse({
        itemType: arxiv ? 'preprint' : 'journalArticle',
        title: arxiv
          ? 'A linked reference with a deliberately long title for reviewing metadata in a narrow window'
          : scheme === 'doi'
            ? 'Reproducible analysis of open research datasets'
            : 'Open access methods for biomedical literature review',
        abstract: 'Metadata supplied by the browser fixture, with no external provider requests.',
        issuedYear: 2024,
        containerTitle: 'Journal of Reproducible Scientific Research',
        typeFields: { volume: '18', issue: '4', pages: '1–16', ...foreignFields },
        creators: [
          {
            creatorType: 'author',
            nameMode: 'person',
            familyName: 'Researcher',
            givenName: 'Alice Alexandra'
          },
          {
            creatorType: 'author',
            nameMode: 'person',
            familyName: 'Scientist',
            givenName: 'Bob Benjamin'
          },
          {
            creatorType: 'author',
            nameMode: 'person',
            familyName: 'Collaborator',
            givenName: 'Carol Catherine'
          }
        ],
        identifiers: [
          {
            scheme,
            value: scheme === 'doi' ? reference : reference.slice(reference.indexOf(':') + 1),
            isPrimary: true
          },
          arxiv || scheme === 'pmid'
            ? { scheme: 'doi', value: '10.1234/identity-review', isPrimary: true }
            : { scheme: 'pmid', value: '2097408', isPrimary: true }
        ]
      })
    },
    cancelRelated: async () => {},
    related: async (request: LiteratureRelatedRequest) => {
      fileRequests.push(request)
      if (params.has('citation-loading'))
        await new Promise<void>((resolve) =>
          Object.assign(window, { finishCitationLookup: resolve })
        )
      if (params.has('citation-graph')) {
        if (params.has('fail-next-page') && request.offset && !failedCitationPage) {
          failedCitationPage = true
          return {
            itemId: request.itemId,
            metadataRevision: request.expectedMetadataRevision,
            provider: 'europe-pmc',
            direction: request.direction,
            state: 'unavailable',
            records: [],
            issue: 'response-invalid'
          }
        }
        return citationGraphResult(
          request,
          params.has('empty-references'),
          params.has('mutual-paper')
        )
      }
      if (citationUnavailable)
        return {
          itemId: fileItem.id,
          metadataRevision: fileItem.metadataRevision,
          direction: request.direction,
          state: 'unavailable',
          provider: 'europe-pmc',
          issue: 'unavailable',
          records: []
        }
      return {
        itemId: fileItem.id,
        metadataRevision: fileItem.metadataRevision,
        direction: request.direction,
        state: 'ready',
        provider: 'europe-pmc',
        seed: { paperId: 'europe-pmc:MED:31020319', item: fileItem.item },
        nextOffset: request.offset === 0 ? 20 : undefined,
        resolutionToken: '00000000-0000-4000-8000-000000000000',
        records: [
          {
            paperId: `europe-pmc:MED:${request.offset ? '100300' : request.direction === 'references' ? '100100' : '100200'}`,
            item: literatureItemInputSchema.parse({
              itemType: 'journalArticle',
              title: request.offset
                ? 'Another related paper'
                : request.direction === 'references'
                  ? 'A foundational reference'
                  : 'A follow-up study',
              issuedYear: 2025,
              abstract: 'An example abstract from Europe PMC.',
              containerTitle: 'Example Journal',
              url: 'https://europepmc.org/article/MED/100100'
            })
          }
        ]
      }
    },
    studySnapshot: async (request: { expectedSourceKey: string }) => ({
      sourceKey: request.expectedSourceKey,
      issue: 'not-generated' as const
    }),
    get: async () => fileItem,
    importPdf: async (request: { itemId: string; attachment: { name: string } }) => {
      fileRequests.push(request)
      const name = request.attachment.name
      fileItem = {
        ...fileItem,
        attachments: [
          ...fileItem.attachments,
          {
            ...fileItem.attachments[0],
            id: name,
            versions: [{ ...fileItem.attachments[0].versions[0], id: name, filename: name }]
          }
        ]
      }
      return { item: fileItem }
    },
    importRecords: async (request: {
      mode: 'preview' | 'commit'
      content?: string
      items?: unknown[]
    }) => {
      literatureRecordImportRequestSchema.parse(request)
      fileRequests.push(request)
      return {
        format: 'items',
        items: [fileItem.item],
        entries: [
          {
            index: 0,
            title: fileItem.item.title,
            status: 'ready',
            warnings: [],
            item: fileItem.item
          }
        ],
        errors: [],
        truncated: false,
        scannedEntries: 1,
        ...(request.mode === 'commit'
          ? {
              imported: { itemIds: [fileItem.id], createdCount: 1, reusedCount: 0 }
            }
          : {})
      }
    },
    onChanged: () => () => {},
    search: async (request: { scope: string }) => ({
      entries:
        request.scope === 'collections'
          ? mode === 'files'
            ? []
            : collections
          : (mode === 'files' ||
                (mode === 'links' &&
                  commands.some(
                    (command) => 'kind' in command && command.kind === 'create-item'
                  ))) &&
              request.scope === 'library'
            ? [fileItem]
            : []
    }),
    transact: async (command: LiteratureCatalogCommand) => {
      commands.push(command)
      if (mode === 'links' && command.kind === 'create-item') {
        fileItem = {
          ...fileItem,
          id: 'linked-item',
          item: command.item,
          attachments: [],
          collectionIds: [],
          projectIds: []
        }
        return { kind: 'item', id: fileItem.id, state: 'present' }
      }
      if (command.kind === 'stage-candidate') {
        const saveMode = new URLSearchParams(location.search).get('citation-save')
        if (saveMode) {
          await new Promise<void>((resolve) =>
            Object.assign(window, { finishCitationStage: resolve })
          )
          if (
            saveMode === 'failure' &&
            commands.filter((entry) => 'kind' in entry && entry.kind === 'stage-candidate')
              .length === 2
          )
            throw new Error('Staging failed')
        }
        return { kind: 'candidate', id: 'found-paper', state: 'pending' }
      }
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
useNavigationStore.setState({
  view: 'library',
  pendingLiteratureCollectionId: mode === 'files' || mode === 'links' ? undefined : 'parent'
})
useProjectStore.setState({ projects: [], isLoaded: true })
useTagStore.setState({ status: 'ready', revision: 1, tags: [], assignments: [] })
useSettingsStore.setState({
  encryptionAvailable: true,
  connectorsLoaded: true
})
createRoot(document.getElementById('root')!).render(
  <LiteratureRendererProvider host={literatureRendererHost}>
    {mode === 'batch' ? (
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
    )}
  </LiteratureRendererProvider>
)
