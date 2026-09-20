import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import { StoragePanel } from '@/pages/settings/StoragePanel'
import type { StorageInfo } from '../../../src/shared/storage'

initI18n('en')
const info: StorageInfo = {
  dataRoot: '/current/OpenScience',
  isDefault: false,
  defaultDataRoot: '/home/user/OpenScience',
  defaultParent: '/home/user',
  dataRootMissing: false,
  legacyDataMovePrompt: false,
  cleanupPending: true,
  canAutoSelectDataDrive: false,
  usage: {
    totalBytes: 4096,
    categories: [
      {
        key: 'workspaces',
        bytes: 4096,
        children: [{ name: 'retained-workspace', bytes: 4096, retainedAfterDelete: true }]
      }
    ]
  },
  availableBytes: 1_000_000_000
}
let inspections = 0
let adoptions = 0
Object.assign(window, {
  storageRegression: {
    get adoptions() {
      return adoptions
    }
  }
})
window.api = {
  platform: 'darwin',
  storage: {
    getStatus: async () => info,
    getInfo: async () => info,
    inspectDataRoot: async () => {
      inspections += 1
      if (inspections === 1) throw new Error('Fixture IPC rejection')
      return { kind: 'adopt', dataRoot: '/candidate/OpenScience' }
    },
    pickDirectory: async () => '/candidate',
    setDataRootAndRelaunch: async () => {
      adoptions += 1
      if (adoptions === 1) throw new Error('Fixture IPC rejection')
      return { ok: true }
    }
  }
} as unknown as typeof window.api
createRoot(document.getElementById('root')!).render(
  <main className="mx-auto max-w-3xl bg-card text-foreground">
    <StoragePanel />
  </main>
)
