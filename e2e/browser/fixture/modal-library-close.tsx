import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { LiteratureLibraryPage } from '@/pages/literature/LiteratureLibraryPage'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import {
  literatureItemInputSchema,
  type LiteratureCatalogCommand
} from '../../../src/shared/literature'

initI18n('en')
const commands: LiteratureCatalogCommand[] = []
Object.assign(window, { modalLibrary: { commands } })
const reference = {
  id: 'audit-paper',
  metadataRevision: 1,
  item: literatureItemInputSchema.parse({
    title: 'Audit trashed reference',
    itemType: 'journalArticle'
  }),
  projectIds: [],
  collectionIds: [],
  attachments: [],
  createdAt: 1,
  updatedAt: 1,
  deletedAt: 1
}
window.api = {
  platform: 'darwin',
  literature: {
    onChanged: () => () => {},
    search: async (request: { scope: string }) => ({
      entries: request.scope === 'library' ? [reference] : [],
      totalCount: request.scope === 'library' ? 1 : 0
    }),
    transact: async (command: LiteratureCatalogCommand) => {
      commands.push(command)
      return { kind: 'item', id: reference.id }
    },
    jobs: async () => ({ jobs: [], summaries: [] }),
    citationStyles: async () => ({ styles: [] })
  },
  tags: {
    snapshot: async () => ({ revision: 1, tags: [], assignments: [] }),
    onChanged: () => () => {}
  }
} as unknown as Window['api']
useNavigationStore.setState({ view: 'library' })
useProjectStore.setState({ projects: [], isLoaded: true })
useTagStore.setState({ status: 'ready', revision: 1, tags: [], assignments: [] })
createRoot(document.getElementById('root')!).render(<LiteratureLibraryPage />)
