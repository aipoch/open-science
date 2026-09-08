import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { initI18n } from '@/i18n'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { HomePage } from '@/pages/home/HomePage'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useTagStore } from '@/stores/tag-store'
import { useMemoryStore } from '@/stores/memory-store'
import { useUpdateStore } from '@/stores/update-store'
import { TooltipProvider } from '@/components/ui/tooltip'

// Native boundaries only. Components, navigation, i18n, CSS and browser geometry are production code.
// Missing APIs fail normally: do not use a catch-all proxy that could hide accidental dependencies.
const unsubscribe = (): (() => void) => () => undefined
const nativeApi = {
  platform: 'darwin',
  settings: {},
  notifications: { getDesktopAvailability: async () => 'supported' },
  cli: {
    getStatus: async () => ({ installed: false, target: '/test/open-science', onPath: true })
  },
  logs: {
    getStatus: async () => ({
      configured: false,
      path: null,
      existing: false,
      lastWriteSucceeded: null,
      lastFailureCategory: null
    })
  },
  projectFiles: { onChanged: unsubscribe },
  github: { getStars: async () => 1000 }
} satisfies { [Key in keyof typeof window.api]?: Partial<(typeof window.api)[Key]> }
window.api = nativeApi as unknown as typeof window.api
initI18n('en')
useSettingsStore.setState({
  isLoaded: true,
  onboardingCompletedAt: 1,
  load: async () => true,
  setReasoningEffort: async (reasoningEffort) => useSettingsStore.setState({ reasoningEffort })
})
useProjectStore.setState({ isLoaded: true })
useTagStore.setState({ load: async () => undefined, listen: unsubscribe })
useMemoryStore.setState({ listen: unsubscribe })
useUpdateStore.setState({
  appInfo: { name: 'Open Science', version: '0.0.0', copyright: 'Test fixture' },
  status: { state: 'up-to-date', current: '0.0.0', latest: '0.0.0' }
})

export function Fixture(): React.JSX.Element {
  useTranslation()
  const open = useSettingsStore((state) => state.isSettingsOpen)
  return (
    <TooltipProvider>
      <HomePage canDeleteProjects hasCompleteSessionCatalog onOpenGlobalSearch={() => undefined} />
      <SettingsPage
        open={open}
        onClose={() => useSettingsStore.getState().closeSettings()}
        onOpenSession={() => undefined}
      />
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
