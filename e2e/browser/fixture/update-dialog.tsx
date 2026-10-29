import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { UpdateDialog } from '@/components/UpdateDialog'
import { AppVersionSection } from '@/pages/settings/AppVersionSection'
import { dismissSettingsManualUpdateGuide } from '@/pages/settings/settings-manual-update-guide'
import * as Dialog from '@/components/ui/dialog'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { useUpdateStore } from '@/stores/update-store'
import type { UpdateInstaller, UpdateStatus } from '../../../src/shared/update'

const params = new URLSearchParams(location.search)
const actions = { download: 0, apply: 0, cancel: 0, recover: 0, check: 0, reveal: 0 }
const platform =
  params.get('platform') === 'win32'
    ? 'win32'
    : params.get('platform') === 'linux'
      ? 'linux'
      : 'darwin'
const installer: UpdateInstaller | null = params.has('package')
  ? {
      platform,
      format: platform === 'darwin' ? 'zip' : platform === 'win32' ? 'exe' : 'deb',
      fileName:
        platform === 'darwin'
          ? 'Open-Science-1.0.12-mac-arm64.zip'
          : platform === 'win32'
            ? 'Open-Science-1.0.12-setup.exe'
            : 'Open-Science-1.0.12.deb'
    }
  : null
const manualApi = {
  getInstaller: async () => installer,
  revealInstaller: async () => {
    actions.reveal += 1
    return 'revealed' as const
  }
}
window.api = { platform, update: manualApi } as unknown as typeof window.api
;(window as unknown as { updateFixture: unknown }).updateFixture = {
  actions,
  setStatus: (next: Partial<UpdateStatus>) =>
    useUpdateStore.setState({ status: { ...useUpdateStore.getState().status, ...next } })
}
if (params.has('dark')) document.documentElement.classList.add('dark')
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
if (params.has('continuous')) {
  const status: UpdateStatus = {
    state: 'available',
    localPath: installer ? '/fixture/current-update-package' : undefined,
    current: '1.0.11',
    latest: '1.0.12',
    applyKind: 'restart',
    notes,
    localizedNotes,
    totalBytes: 314.5 * 1024 * 1024
  }
  useUpdateStore.setState({
    status,
    download: async () => {
      actions.download += 1
      useUpdateStore.setState({ status: { ...status, state: 'downloading', progress: 50 } })
      await new Promise((resolve) => setTimeout(resolve, 150))
      useUpdateStore.setState({ status: { ...status, state: 'ready' } })
    },
    check: async () => {
      actions.check += 1
    },
    recover: async () => {
      actions.recover += 1
    },
    apply: async () => {
      actions.apply += 1
      useUpdateStore.setState({ status: { ...status, state: 'applying' } })
    },
    cancel: async () => {
      actions.cancel += 1
      useUpdateStore.setState({ status })
    }
  })
}
// Pin actual updater states for visual and keyboard acceptance without timing races.
if (params.has('continuous') && params.has('stage')) {
  const stage = params.get('stage')
  const status = useUpdateStore.getState().status
  useUpdateStore.setState({
    status: {
      ...status,
      state:
        stage === 'checking'
          ? 'checking'
          : stage === 'installing'
            ? 'applying'
            : stage === 'downloading'
              ? 'downloading'
              : stage === 'check-error' || stage === 'download-error' || stage === 'unknown'
                ? 'error'
                : 'ready',
      latest: stage === 'check-error' ? undefined : status.latest,
      error:
        stage === 'check-error'
          ? 'Could not reach the update server.'
          : stage === 'download-error'
            ? 'Download connection was interrupted.'
            : stage === 'save-error'
              ? 'Your changes could not be saved.'
              : undefined,
      reason: stage === 'save-error' ? 'install-failed' : undefined,
      progress: stage === 'downloading' ? 50 : undefined,
      downloadedBytes: stage === 'downloading' ? (status.totalBytes ?? 0) / 2 : undefined,
      recovery:
        stage === 'installing'
          ? {
              phase: 'handoff',
              runtime: 'stopped-clean',
              installation: 'pending',
              canCancel: false,
              canRetryInstall: false,
              canRecover: false
            }
          : stage === 'unknown'
            ? {
                phase: 'install-check',
                runtime: 'stopped-clean',
                installation: 'unknown',
                canCancel: false,
                canRetryInstall: false,
                canRecover: true
              }
            : stage === 'save-error'
              ? {
                  phase: 'preparing',
                  runtime: 'running',
                  installation: 'unchanged',
                  canCancel: true,
                  canRetryInstall: true,
                  canRecover: false
                }
              : undefined
    }
  })
}
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
    ...manualApi,
    getAppInfo: async () => ({ name: 'Open-Science', version: '0.28.0', copyright: '' }),
    getStatus: async () => status,
    check: async () => status,
    recheck: async () => status,
    recover: async () => status,
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
  window.api = { platform, update } as typeof window.api
  useUpdateStore.getState().init()
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(
    params.has('settings') ? (
      <Dialog.Root defaultOpen>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content
            data-slot="settings-dialog"
            className="fixed inset-4 overflow-auto rounded-xl bg-card p-5"
            onEscapeKeyDown={(event) => {
              dismissSettingsManualUpdateGuide(event)
            }}
          >
            <Dialog.Title>General</Dialog.Title>
            <Dialog.Description>Settings</Dialog.Description>
            <button type="button">Appearance</button>
            <AppVersionSection />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    ) : (
      <UpdateDialog />
    )
  )
})
