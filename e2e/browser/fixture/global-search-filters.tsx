import '@/assets/main.css'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalSearchDialog } from '@/components/global-search/GlobalSearchDialog'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { useProjectStore } from '@/stores/project-store'
import { useNavigationStore } from '@/stores/navigation-store'

// Stub only native boundaries; the dialog, filter controls, state, and layout are production code.
const nativeApi = {
  platform: 'darwin',
  sessions: {
    searchMessages: async () => ({ items: [], totalCount: 0, isComplete: true })
  },
  projectFiles: {
    getOverview: async () => ({
      totalCount: 0,
      uploadCount: 0,
      artifactCount: 0,
      artifactGroupCount: 0,
      isIndexComplete: true
    }),
    searchArtifacts: async () => ({
      primary: { items: [], totalCount: 0 },
      other: [],
      isIndexComplete: true
    })
  },
  literature: { search: async () => ({ entries: [], totalCount: 0 }) }
} satisfies { [Key in keyof typeof window.api]?: Partial<(typeof window.api)[Key]> }
window.api = nativeApi as unknown as typeof window.api
const params = new URLSearchParams(location.search)
const locale = params.get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
document.documentElement.classList.toggle('dark', params.has('dark'))
useProjectStore.setState({
  isLoaded: true,
  projects: ['Literature', 'Protein analysis', 'Climate observations'].map((name, index) => ({
    id: `project-${index}`,
    name,
    description: '',
    isExample: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }))
})
useNavigationStore.setState({ view: 'workspace', activeProjectId: 'project-0' })

export function Fixture(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return <GlobalSearchDialog open={open} onOpenChange={setOpen} isSessionPersistenceReady />
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
