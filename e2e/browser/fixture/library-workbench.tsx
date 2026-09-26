import '@/assets/main.css'
import { LibraryReferenceActionsContext } from '@/pages/workspace/previews/library-reference-actions'
import { useSessionStore, type ChatSession } from '@/stores/session-store'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n, prepareI18nLocale } from '@/i18n'
import LibraryPreview from '@/pages/workspace/previews/LibraryPreview'
import { literatureItemInputSchema } from '../../../src/shared/literature'
import type {
  LiteratureCatalogSearchRequest,
  LiteratureItemView
} from '../../../src/shared/literature'

const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'populated'
const locale = params.has('zh') ? 'zh-Hans' : 'en'
document.documentElement.classList.toggle('dark', params.has('dark'))
let reads = 0
let subscriptions = 0
let notify: (() => void) | undefined
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
  attachments: [],
  collectionIds: [],
  projectIds: ['fixture-project']
}
window.api = {
  literature: {
    get: async () => entry,
    search: async (request: LiteratureCatalogSearchRequest) => {
      reads += 1
      if (mode === 'error') throw new Error('Fixture read failure')
      if (mode === 'loading') return new Promise(() => {})
      const entries = mode === 'empty' || request.query ? [] : [entry]
      return { entries, totalCount: entries.length }
    },
    onChanged: (listener: () => void) => {
      subscriptions += 1
      notify = listener
      return () => {
        subscriptions -= 1
        notify = undefined
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
  libraryFixture: { counts: () => ({ reads, subscriptions }), notify: () => notify?.() }
})

export function Fixture(): React.JSX.Element {
  const [added, setAdded] = useState('')
  const [active, setActive] = useState(true)
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
        <div className="min-h-0 min-w-0 flex-1">
          <LibraryPreview projectId="fixture-project" isActive={active} />
        </div>
      </div>
    </LibraryReferenceActionsContext.Provider>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
