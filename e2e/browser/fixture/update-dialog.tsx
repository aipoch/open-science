import '@/assets/main.css'
import { createRoot } from 'react-dom/client'
import { UpdateDialog } from '@/components/UpdateDialog'
import { initI18n, prepareI18nLocale } from '@/i18n'
import { useUpdateStore } from '@/stores/update-store'
import type { UpdateStatus } from '../../../src/shared/update'

const params = new URLSearchParams(location.search)
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
      useUpdateStore.setState({ status: { ...status, state: 'downloading', progress: 50 } })
      await new Promise((resolve) => setTimeout(resolve, 150))
      useUpdateStore.setState({ status: { ...status, state: 'ready' } })
    },
    apply: async () => {
      useUpdateStore.setState({ status: { ...status, state: 'applying' } })
    },
    cancel: async () => {
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
              : 'ready',
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
    getAppInfo: async () => ({ name: 'Open-Science', version: '0.28.0', copyright: '' }),
    getStatus: async () => status,
    getManualInstall: async () => ({
      kind: 'blocked',
      identity: 'fixture-blocked',
      platform: 'darwin',
      arch: 'arm64'
    }),
    revealManualInstaller: async () => ({
      kind: 'blocked',
      identity: 'fixture-blocked',
      platform: 'darwin',
      arch: 'arm64'
    }),
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
  window.api = { update } as typeof window.api
  useUpdateStore.getState().init()
}
void Promise.resolve(prepareI18nLocale(locale)).then(() => {
  initI18n(locale)
  createRoot(document.getElementById('root')!).render(<UpdateDialog />)
})

// Browser fixtures test presentation and bridge calls; installer eligibility remains main-owned.
if (params.has('manual')) {
  if (params.has('dark')) document.documentElement.classList.add('dark')
  const platform =
    params.get('platform') === 'darwin'
      ? 'darwin'
      : params.get('platform') === 'linux'
        ? 'linux'
        : 'win32'
  const info: import('../../../src/shared/update').ManualInstallInfo = {
    kind: 'local',
    identity: 'manual-fixture-2',
    platform,
    arch: 'x64',
    version: '0.29.0',
    format: platform === 'darwin' ? 'zip' : platform === 'linux' ? 'deb' : 'nsis',
    fileName: `Open-Science-${'long-file-name-'.repeat(12)}setup.exe`,
    size: 314 * 1024 * 1024
  }
  let checks = 0,
    reveals = 0
  let status: UpdateStatus = {
    state: params.has('download-failed') ? 'error' : 'ready',
    current: '0.28.0',
    latest: '0.29.0',
    applyKind: params.has('runtime') ? 'restart' : 'installer',
    notes,
    error: 'The automatic installation could not finish.',
    manualInstall:
      params.has('website') || params.has('download-failed')
        ? {
            ...info,
            kind: 'website',
            reason: params.has('download-failed') ? 'download-failed' : 'not-standalone'
          }
        : info,
    ...(params.has('runtime') && !params.has('download-failed')
      ? {
          reason: 'install-failed' as const,
          recovery: {
            phase: 'preparing' as const,
            runtime: 'running' as const,
            installation: 'unchanged' as const,
            canCancel: true,
            canRetryInstall: true,
            canRecover: false
          }
        }
      : {})
  }
  window.api = {
    update: {
      getManualInstall: async () => {
        document.body.dataset.manualChecks = String(++checks)
        await new Promise((resolve) => setTimeout(resolve, 150))
        return params.has('website') || params.has('download-failed')
          ? {
              ...info,
              kind: 'website',
              reason: params.has('download-failed') ? 'download-failed' : 'not-standalone'
            }
          : info
      },
      revealManualInstaller: async () => {
        document.body.dataset.manualReveals = String(++reveals)
        await new Promise((resolve) => setTimeout(resolve, 150))
        return params.has('invalid') ? { ...info, kind: 'website', reason: 'unavailable' } : info
      },
      cancel: async () => status
    }
  } as typeof window.api
  useUpdateStore.setState({ status, cancel: async () => {} })
  document.addEventListener('manual-fixture-target-change', () => {
    status = {
      ...status,
      latest: '0.30.0',
      manualInstall: { ...info, identity: 'manual-fixture-3' }
    }
    useUpdateStore.setState({ status })
  })
}
