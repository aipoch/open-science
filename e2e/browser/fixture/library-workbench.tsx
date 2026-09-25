import '@/assets/main.css'
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
Object.assign(window, {
  libraryFixture: { counts: () => ({ reads, subscriptions }), notify: () => notify?.() }
})

export function Fixture(): React.JSX.Element {
  const [active, setActive] = useState(true)
  return (
    <div className="flex h-screen min-w-0 flex-col bg-background">
      <button
        className="shrink-0 border-b border-border p-2 text-sm"
        onClick={() => setActive(!active)}
      >
        Toggle preview visibility
      </button>
      <div className="min-h-0 min-w-0 flex-1">
        <LibraryPreview projectId="fixture-project" isActive={active} />
      </div>
    </div>
  )
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
