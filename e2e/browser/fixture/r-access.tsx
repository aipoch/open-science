import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { RuntimesPanel } from '@/pages/settings/RuntimesPanel'
import type { NotebookNetworkStatus } from '../../../src/shared/notebook-network'

const fixtureLocale =
  new URLSearchParams(location.search).get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
const installLibraryScenario =
  new URLSearchParams(location.search).get('scenario') === 'install-library'
const localeReady = Promise.resolve(prepareI18nLocale(fixtureLocale)).then(() =>
  initI18n(fixtureLocale)
)
let protection: NotebookNetworkStatus = {
  kind: 'setupRequired',
  platform: 'win32',
  reasons: ['windowsProfileMissing']
}
if (installLibraryScenario) protection = { kind: 'ready', warnings: [] }
const environments = {
  python: [],
  r: [
    {
      language: 'r',
      provenance: installLibraryScenario ? 'user-own' : 'app-managed',
      ...(installLibraryScenario ? { personalRLibraries: ['D:\\R\\personal-library'] } : {}),
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
    getEnablement: async () => ({
      enabled: { [environments.r[0].envId]: true },
      installAuthorized: {}
    }),
    setInstallAuthorized: async () => {
      throw new Error(
        "Error invoking remote method 'runtime:set-install-authorized': Error: Select an existing personal library visible to this R runtime."
      )
    },
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
void localeReady.then(() => {
  createRoot(document.getElementById('root')!).render(<Fixture />)
})
