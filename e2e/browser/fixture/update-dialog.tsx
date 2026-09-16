import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { UpdateDialog } from '@/components/UpdateDialog'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { useUpdateStore } from '@/stores/update-store'
import type { UpdateStatus } from '../../../src/shared/update'

const params = new URLSearchParams(location.search)
const locale = params.get('locale') === 'zh-Hans' ? 'zh-Hans' : 'en'
const notes = Array.from(
  { length: params.has('short') ? 1 : 35 },
  (_, index) =>
    `- Release note ${index + 1}: Improved research workflows and application stability.`
).join('\n')
const localizedNotes = {
  'zh-Hans': Array.from(
    { length: params.has('short') ? 1 : 35 },
    (_, index) => `- 更新内容 ${index + 1}：改进科研工作流程，提升应用的稳定性与使用体验。`
  ).join('\n')
}
useUpdateStore.setState({
  isDialogOpen: true,
  status: {
    state: 'downloading',
    current: '0.28.0',
    latest: '0.29.0',
    notes,
    localizedNotes,
    progress: 99,
    downloadProgress: {
      phase: 'downloading',
      transferred: 47.2 * 1024 * 1024,
      total: 47.9 * 1024 * 1024,
      percent: 99,
      bytesPerSecond: 6.5 * 1024 * 1024,
      attempt: 0
    }
  }
})
if (params.has('refused-restart')) {
  let status: UpdateStatus = {
    state: 'ready',
    current: '0.28.0',
    latest: '0.29.0',
    applyKind: 'restart',
    notes,
    localizedNotes
  }
  let onStatus: ((status: UpdateStatus) => void) | undefined
  const update: typeof window.api.update = {
    getAppInfo: async () => ({ name: 'Open-Science', version: '0.28.0', copyright: '' }),
    getStatus: async () => status,
    check: async () => status,
    download: async () => status,
    onStatus: (listener) => {
      onStatus = listener
      return () => {
        onStatus = undefined
      }
    },
    onProgress: () => () => {},
    apply: async (options) => {
      status = { ...status, state: 'applying', error: undefined, legacyShellRecovery: undefined }
      onStatus?.(status)
      if (params.has('legacy') && options?.legacyShellRecoveryToken === 'reviewed-fixture')
        return status
      // Replay the fast install-gate refusal captured in the user log through the public bridge.
      await new Promise((resolve) => setTimeout(resolve, 4))
      status = {
        ...status,
        state: 'ready',
        error: 'Could not fully stop background processes before updating. Please try again.',
        ...(params.has('legacy')
          ? { legacyShellRecovery: { token: 'reviewed-fixture', count: 2 } }
          : {})
      }
      onStatus?.(status)
      return status
    },
    cancel: async () => status
  }
  window.api = { update } as typeof window.api
  useUpdateStore.getState().init()
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<UpdateDialog />)
})
