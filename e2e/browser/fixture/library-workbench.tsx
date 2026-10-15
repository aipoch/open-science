import { LiteratureCandidateSessionContext } from '@/pages/workspace/literature-candidate-session-context'
import { LiteratureRendererProvider } from '@/pages/literature/public/host'
import { literatureRendererHost } from '@/lib/literature-renderer-host'
import '@/assets/main.css'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { WorkspaceLiteratureToolCard } from '@/pages/workspace/WorkspaceLiteratureToolCard'
import { WorkspaceToolSummaryCard } from '@/pages/workspace/WorkspaceToolSummaryCard'
import { buildLiteratureLibraryToolSummary } from '@/pages/workspace/literature-tool-presentation'
import LibraryPreview from '@/pages/workspace/previews/LibraryPreview'
import {
  LibraryPreviewNavigationContext,
  LibraryReferenceActionsContext
} from '@/pages/workspace/previews/library-reference-actions'
import {
  createProjectLibraryPreviewItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import type {
  LiteratureCatalogCommand,
  LiteratureCatalogSearchRequest,
  LiteratureInboxCandidateView,
  LiteratureItemView
} from '@aipoch/literature-library/contracts'
import { literatureItemInputSchema } from '@aipoch/literature-library/contracts'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'populated'
const locale = params.has('zh') ? 'zh-Hans' : 'en'
document.documentElement.classList.toggle('dark', params.has('dark'))
let reads = 0
let subscriptions = 0
const listeners = new Set<() => void>()
const entry: LiteratureItemView = {
  id: 'sample-paper',
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  item: literatureItemInputSchema.parse({
    itemType: 'journalArticle',
    title: 'Example reference: assessing reproducibility across scientific workflows',
    abstract: 'Sample abstract for layout testing. '.repeat(35),
    containerTitle: 'Example journal',
    issuedYear: 2026,
    creators: [
      { creatorType: 'author', nameMode: 'organization', literalName: 'Example research group' }
    ]
  }),
  attachments: params.has('unavailable-pdf')
    ? ['missing-reference.pdf', 'additional-missing-reference.pdf', 'available-reference.pdf'].map(
        (filename, index) => ({
          id: `fixture-attachment-${index}`,
          kind: 'fullText' as const,
          title: '',
          sortOrder: index,
          createdAt: 1,
          updatedAt: 1,
          versions: [
            {
              id: `fixture-version-${index}`,
              versionNumber: 1,
              filename,
              contentType: 'application/pdf',
              sizeBytes: 1024,
              checksum: 'a'.repeat(64),
              createdAt: 1,
              pageCount: 1,
              ...(index < 2 ? { availability: 'unavailable' as const } : {})
            }
          ]
        })
      )
    : [],
  collectionIds: [],
  projectIds: ['fixture-project']
}
const inbox = params.has('inbox')
const candidates: LiteratureInboxCandidateView[] = [
  [
    'Dose and timing effects of caffeine on subsequent sleep',
    'Gardiner et al.',
    2025,
    'Sleep',
    '39377163'
  ],
  [
    'Caffeine effects on sleep taken 0, 3, or 6 hours before going to bed',
    'Drake et al.',
    2013,
    'Journal of Clinical Sleep Medicine',
    '24235903'
  ],
  [
    'Caffeine intake alters recovery sleep after sleep deprivation',
    'Pauchon et al.',
    2024,
    'Sleep Medicine',
    '39458438'
  ],
  [
    'Habitual caffeine intake and insomnia (UK Biobank / HypnoLaus)',
    'Stucky et al.',
    2025,
    'Sleep',
    '41109744'
  ]
].map(([title, author, year, journal, pmid], index) => ({
  id: `inbox-${index}`,
  state: 'pending',
  createdAt: 100 - index,
  updatedAt: 100 - index,
  candidate: {
    item: literatureItemInputSchema.parse({
      itemType: 'journalArticle',
      title,
      issuedYear: year,
      containerTitle: journal,
      creators: [{ creatorType: 'author', nameMode: 'organization', literalName: author }],
      identifiers: [{ scheme: 'pmid', value: pmid }],
      abstract:
        locale === 'zh-Hans'
          ? '界面演示摘要：用于检查文献标题、来源、项目关联与审核操作在窄面板中的排版。此处为测试数据，不代表原文研究结论。'
          : 'Sample abstract for interface testing. This text tests metadata and review actions in a narrow panel; it is not a summary of the research.'
    }),
    source: { provider: 'pubmed', rawMetadata: {} },
    origin: { kind: 'agent', projectId: 'fixture-project' }
  },
  ...(index === 0
    ? {
        pdfs: [
          {
            id: 'fixture-pdf',
            filename: 'reference.pdf',
            sizeBytes: 1024,
            pageCount: 8,
            sourceUrl: 'https://example.org/reference.pdf'
          }
        ]
      }
    : {})
}))
const cardReferences: LiteratureItemView[] = params.has('card-design')
  ? Array.from({ length: 6 }, (_, index) => ({
      ...entry,
      id: `imported-${index}`,
      item: {
        ...candidates[index % candidates.length].candidate.item,
        title: `${candidates[index % candidates.length].candidate.item.title} — sample ${index + 1}`
      }
    }))
  : [entry]
if (params.has('card-design'))
  candidates.push(
    ...cardReferences.map((reference) => ({
      ...candidates[0],
      id: reference.id,
      state: 'accepted' as const
    }))
  )
useProjectStore.setState({
  projects: [
    { id: 'fixture-project', name: locale === 'zh-Hans' ? '咖啡因与睡眠' : 'Caffeine and sleep' }
  ] as never,
  isLoaded: true
})
usePreviewWorkbenchStore.getState().activateProject('fixture-project')
if (inbox && !params.has('card'))
  usePreviewWorkbenchStore
    .getState()
    .upsertAndActivateItem(createProjectLibraryPreviewItem({ section: 'inbox' }))
window.api = {
  literature: {
    getCandidateStates: async ({ candidateIds }: { candidateIds: string[] }) => ({
      candidates: candidates
        .filter(({ id }) => candidateIds.includes(id))
        .map(({ id, state }) => ({
          candidateId: id,
          state,
          ...(state === 'accepted'
            ? { acceptedItemId: id.startsWith('imported-') ? id : entry.id }
            : {})
        }))
    }),
    get: async (id: string) => cardReferences.find((reference) => reference.id === id),
    search: async (request: LiteratureCatalogSearchRequest) => {
      reads += 1
      if (mode === 'error') throw new Error('Fixture read failure')
      if (mode === 'loading') return new Promise(() => {})
      const filtered =
        request.scope === 'inbox'
          ? candidates.filter(
              (candidate) =>
                candidate.state === request.inboxState &&
                (!request.query ||
                  candidate.candidate.item.title
                    .toLowerCase()
                    .includes(request.query.toLowerCase()))
            )
          : cardReferences.filter(
              (reference) => !request.itemIds || request.itemIds.includes(reference.id)
            )
      const entries =
        mode === 'empty' || (request.scope !== 'inbox' && request.query) ? [] : filtered
      return { entries, totalCount: entries.length }
    },
    transact: async (command: LiteratureCatalogCommand) => {
      if (command.kind === 'accept-candidate' || command.kind === 'dismiss-candidate') {
        const candidate = candidates.find(({ id }) => id === command.candidateId)!
        candidate.state = command.kind === 'accept-candidate' ? 'accepted' : 'dismissed'
      } else if (command.kind === 'settle-candidates') {
        for (const id of command.candidateIds)
          candidates.find((candidate) => candidate.id === id)!.state = command.state
      } else if (command.kind === 'restore-candidates') {
        for (const id of command.candidateIds)
          candidates.find((candidate) => candidate.id === id)!.state = 'pending'
      }
      listeners.forEach((listener) => listener())
      return { kind: 'candidate', id: 'fixture', state: 'pending' }
    },
    onChanged: (listener: () => void) => {
      subscriptions += 1
      listeners.add(listener)
      return () => {
        subscriptions -= 1
        listeners.delete(listener)
      }
    }
  }
} as unknown as typeof window.api
useSessionStore.setState({
  sessions: Array.from(
    { length: 35 },
    (_, index) =>
      ({
        id: `session-${index}`,
        projectId: 'fixture-project',
        cwd: '/fixture-project',
        title:
          ['Literature review', 'Compare findings', 'Endometrial cancer — follow-up'][index % 3] +
          (index > 2 ? ` ${index}` : ''),
        number: index + 1,
        updatedAt: Date.now() - index * 86400000,
        createdAt: 1,
        messages: [],
        status: 'idle'
      }) as ChatSession
  )
})
Object.assign(window, {
  libraryFixture: {
    counts: () => ({ reads, subscriptions }),
    notify: () => listeners.forEach((listener) => listener())
  }
})

export function Fixture(): React.JSX.Element {
  const scope = usePreviewWorkbenchStore((state) => {
    const item = state.items.find(({ id }) => id === 'tool:project:library')
    return item?.type === 'tool' ? item.libraryScopeRequest : undefined
  })
  const [added, setAdded] = useState('')
  const [active, setActive] = useState(true)
  if (params.has('card-design'))
    return (
      <main className="mx-auto max-w-xl space-y-3 p-4">
        <WorkspaceLiteratureToolCard
          summary={buildLiteratureLibraryToolSummary(
            'save',
            {},
            { results: candidates.map(({ id }) => ({ kind: 'candidate', id, state: 'pending' })) }
          )}
        />
        <WorkspaceLiteratureToolCard
          summary={buildLiteratureLibraryToolSummary(
            'save',
            {},
            {
              results: candidates
                .filter(({ state }) => state === 'pending')
                .map(({ id }) => ({ kind: 'candidate', id, state: 'pending' }))
            }
          )}
        />
      </main>
    )
  if (params.has('density')) {
    return (
      <main className="mx-auto max-w-2xl space-y-3 bg-bg-10 p-4">
        <div className="space-y-2 rounded-xl bg-bg-100 p-2" data-testid="reading-stack">
          {[0, 1, 2].map((index) => (
            <WorkspaceLiteratureToolCard
              key={index}
              summary={{ action: 'read', documentNames: [], documentCount: 1 }}
            />
          ))}
        </div>
        <WorkspaceLiteratureToolCard
          summary={{
            action: 'read',
            documentNames: ['long-reference-name-for-a-randomized-controlled-trial.pdf'],
            documentCount: 1,
            pageStart: 10,
            pageEnd: 12,
            passageCount: 3,
            retrievalMode: 'bm25',
            query: 'Primary outcome and limitations of the study',
            pdfElements: {
              incomplete: true,
              caption: 'Evidence requires checking the original PDF.'
            }
          }}
        />
        <WorkspaceLiteratureToolCard
          summary={buildLiteratureLibraryToolSummary(
            'save',
            {},
            { results: candidates.map(({ id }) => ({ kind: 'candidate', id, state: 'pending' })) }
          )}
        />
        <WorkspaceLiteratureToolCard
          isApproval
          summary={{
            action: 'format',
            libraryScope: 'items',
            documentNames: [],
            documentCount: 0,
            itemCount: 12,
            styleId: 'apa',
            locale: 'en-US',
            error: 'Fixture error: reference metadata is incomplete.'
          }}
        />
        <WorkspaceToolSummaryCard
          summary={{
            title: 'Notebook runtime',
            subtitle: 'Python',
            fields: [{ label: 'Runtime', value: '/example/runtime/python', expandable: true }],
            rows: [{ title: 'Analysis', status: 'Completed', detail: 'Output is available.' }],
            note: 'Existing variables and history remain available.'
          }}
        />
      </main>
    )
  }
  return (
    <LibraryReferenceActionsContext.Provider
      value={{
        projectId: 'fixture-project',
        currentSessionId: 'session-0',
        canAddToCurrent: true,
        add: (references, sessionId) =>
          setAdded(
            `${sessionId ?? 'new'}: ${references.map((reference) => '@' + reference.item.title).join(' ')}`
          )
      }}
    >
      <LibraryPreviewNavigationContext.Provider
        value={(scope) =>
          usePreviewWorkbenchStore
            .getState()
            .upsertAndActivateItem(createProjectLibraryPreviewItem(scope))
        }
      >
        <div className="flex h-screen min-w-0 flex-col bg-background">
          <button
            className="shrink-0 border-b border-border p-2 text-sm"
            onClick={() => setActive(!active)}
          >
            Toggle preview visibility
          </button>
          {added && (
            <div role="status" className="border-b border-border p-3 text-xs">
              {added}
            </div>
          )}
          <div className="flex min-h-0 min-w-0 flex-1">
            {params.has('card') && (
              <div className="w-1/2 min-w-0 border-r border-border p-6">
                <p className="mb-4 text-sm text-muted-foreground">
                  {locale === 'zh-Hans'
                    ? '消息卡片 · 示例文献'
                    : 'Message card · sample literature'}
                </p>
                <WorkspaceLiteratureToolCard
                  summary={buildLiteratureLibraryToolSummary(
                    'save',
                    {},
                    {
                      results: candidates.map(({ id }) => ({
                        kind: 'candidate',
                        id,
                        state: 'pending'
                      }))
                    }
                  )}
                />
              </div>
            )}
            <div className="min-h-0 min-w-0 flex-1">
              <LibraryPreview projectId="fixture-project" isActive={active} scopeRequest={scope} />
            </div>
          </div>
        </div>
      </LibraryPreviewNavigationContext.Provider>
    </LibraryReferenceActionsContext.Provider>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(
    <LiteratureRendererProvider host={literatureRendererHost}>
      <LiteratureCandidateSessionContext.Provider value={{ sessionId: 'session-0' }}>
        <Fixture />
      </LiteratureCandidateSessionContext.Provider>
    </LiteratureRendererProvider>
  )
})
