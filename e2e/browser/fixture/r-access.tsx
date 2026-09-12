import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { initI18n } from '@/i18n'
import { RuntimesPanel } from '@/pages/settings/RuntimesPanel'
import type { NotebookNetworkStatus } from '../../../src/shared/notebook-network'

initI18n(new URLSearchParams(location.search).get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en')
let protection: NotebookNetworkStatus = {
  kind: 'setupRequired',
  platform: 'win32',
  reasons: ['windowsProfileMissing']
}
const environments = {
  python: [],
  r: [
    {
      language: 'r',
      provenance: 'app-managed',
      condaEnv: 'default-r',
      envId: 'C:\\OpenScience\\runtime\\envs\\default-r\\bin\\R.exe',
      interpreterPath: 'C:\\OpenScience\\runtime\\envs\\default-r\\bin\\R.exe',
      label: 'R 4.4.1',
      version: '4.4.1',
      runnable: true
    }
  ]
}
window.api = {
  platform: 'win32',
  settings: {
    getNotebookNetworkStatus: async () => protection,
    getWsl2BashPreviewStatus: async () => ({ available: false, reason: 'assets-unavailable' }),
    getLocalShellRuntimePreference: async () => undefined
  },
  runtime: {
    listEnvironments: async () => environments,
    getEnablement: async () => ({ enabled: {}, installAuthorized: {} }),
    getAgentEnvironmentCreationEnabled: async () => true,
    listPackageCounts: async () => ({}),
    setSandboxAccess: async (_language: string, _envId: string, authorized: boolean) => {
      if (authorized && protection.kind !== 'ready') {
        throw new Error('Enable protected mode before verifying R access.')
      }
      return { cancelled: false }
    }
  },
  notebookEnv: {
    getStatus: async () => ({ pythonReady: false, rReady: true, version: 0, provisioning: false }),
    onProgress: () => () => {}
  }
} as unknown as typeof window.api

export function Fixture(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <main className="mx-auto max-w-3xl space-y-4 bg-card p-6 text-foreground">
      <p className="text-xs text-muted-foreground">
        Production Runtimes panel · simulated Windows runtime and protection state
      </p>
      <RuntimesPanel
        title={t('Notebook runtimes')}
        description={t('Enable the environments each notebook language may run in.')}
        onOpenNetworkProtection={() => {
          protection = { kind: 'ready', warnings: [] }
        }}
      />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
