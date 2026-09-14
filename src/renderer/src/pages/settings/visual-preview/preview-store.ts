// Settings visual-preview seam (design-review scaffolding; OFF by default).
//
// Enter preview mode:
//   - Electron: run `localStorage.setItem('open-science:visual-preview', 'settings-ux')` in the
//     renderer DevTools console, then close and reopen Settings.
//   - Web dev server: open the app with `?visual-preview=settings-ux` in the URL, then open Settings.
// Exit preview mode:
//   - Remove the flag (`localStorage.removeItem('open-science:visual-preview')`) or drop the URL
//     query parameter, then close and reopen Settings. With the flag gone every panel reads the real
//     stores and calls the real API again; nothing from this module is consulted.
//
// `window.api` is frozen by the contextBridge (contextIsolation), so it cannot be monkey-patched.
// This module is the only seam: a module-level observable store holding fixture data. Panels in
// preview mode read fixtures and simulate mutations locally (in-memory updates + artificial latency
// + console.log). No code path in preview mode calls the real API for the demonstrated flows.

import { useSyncExternalStore } from 'react'

import type {
  ComputeHost,
  ComputeHostDeletionBlocker,
  ComputeHostDeletionStatus
} from '../../../../../shared/compute'
import type { RemoteAccessSnapshot } from '../../../../../shared/remote-access'
import type { DeviceCredentialView } from '../../../../../shared/settings'
import type { Project } from '../../../../../shared/projects'
import type { ChatSession } from '@/stores/session-store'

export const SETTINGS_VISUAL_PREVIEW_FLAG = 'open-science:visual-preview'
export const SETTINGS_VISUAL_PREVIEW_VALUE = 'settings-ux'

export const isSettingsVisualPreview = (): boolean => {
  try {
    if (
      window.localStorage.getItem(SETTINGS_VISUAL_PREVIEW_FLAG) === SETTINGS_VISUAL_PREVIEW_VALUE
    ) {
      return true
    }
  } catch {
    // Storage can be unavailable (private mode); fall through to the URL query.
  }
  try {
    return (
      new URLSearchParams(window.location.search).get('visual-preview') ===
      SETTINGS_VISUAL_PREVIEW_VALUE
    )
  } catch {
    return false
  }
}

export const exitSettingsVisualPreview = (): void => {
  try {
    window.localStorage.removeItem(SETTINGS_VISUAL_PREVIEW_FLAG)
  } catch {
    // Ignore: exit is best-effort.
  }
  const url = new URL(window.location.href)
  if (url.searchParams.has('visual-preview')) {
    url.searchParams.delete('visual-preview')
    window.location.assign(url.toString())
  }
}

export type SettingsPreviewCompute = {
  status: 'loading' | 'error' | 'ready'
  hosts: ComputeHost[]
  deletionStatus: ComputeHostDeletionStatus
}

export type SettingsPreviewState = {
  compute: SettingsPreviewCompute
  remote: { snapshot: RemoteAccessSnapshot }
  credentials: { deviceCredentials: DeviceCredentialView[] }
  archived: {
    projects: Project[]
    sessions: ChatSession[]
    canDeleteProjects: boolean
  }
}

const now = Date.now()
const DAY = 86_400_000

const previewComputeHost = (overrides: Partial<ComputeHost>): ComputeHost => ({
  id: 'preview-host-1',
  providerId: 'ssh:preview-gpu-cluster',
  displayName: 'gpu-cluster（示例）',
  shape: 'direct_ssh',
  executionMode: 'direct_ssh',
  sshAlias: 'gpu-cluster',
  sshOverrides: undefined,
  scratchRoot: undefined,
  scratchPinned: false,
  concurrencyLimit: undefined,
  probeResult: {
    ok: true,
    probedAt: new Date(now - 3_600_000).toISOString(),
    exitCode: 0,
    errorTail: null
  },
  detailsDoc: '',
  detailsUpdatedAt: undefined,
  detailsUpdatedBy: undefined,
  createdAt: now - 30 * DAY,
  updatedAt: now - 3_600_000,
  ...overrides
})

const previewBlockingJob = (
  overrides: Partial<ComputeHostDeletionBlocker>
): ComputeHostDeletionBlocker => ({
  jobId: 'preview-job-running',
  projectId: 'preview-project',
  sessionId: 'preview-session',
  status: 'running',
  harvested: false,
  intent: '分子动力学批量模拟（示例作业）',
  createdAt: now - 7_200_000,
  ...overrides
})

const buildInitialPreviewState = (): SettingsPreviewState => ({
  compute: {
    status: 'ready',
    hosts: [
      previewComputeHost({}),
      previewComputeHost({
        id: 'preview-host-2',
        providerId: 'ssh:preview-workstation',
        displayName: 'lab-workstation（示例）',
        sshAlias: 'lab-workstation',
        probeResult: undefined,
        createdAt: now - 10 * DAY
      })
    ],
    deletionStatus: {
      blockedByJobs: true,
      blockingJobs: [
        previewBlockingJob({}),
        previewBlockingJob({
          jobId: 'preview-job-finished',
          status: 'success',
          harvested: true,
          intent: '蛋白质对接结果汇总（示例作业）',
          createdAt: now - 2 * DAY
        })
      ]
    }
  },
  remote: {
    snapshot: {
      canManage: true,
      canManagePairing: true,
      mode: 'remoteit-public',
      enabled: true,
      lifecycle: 'running',
      accessUrl: 'https://preview.open-science.connect.remote.it/',
      remoteIt: { installed: true, registered: true, loggedIn: true },
      pendingRequests: [
        {
          id: 'preview-request-1',
          code: '482 913',
          browser: 'Chrome',
          platform: 'macOS',
          address: '203.0.113.24',
          requestedAt: now - 120_000,
          expiresAt: now + 272_000
        },
        {
          id: 'preview-request-2',
          code: '105 738',
          browser: 'Firefox',
          platform: 'Windows',
          address: '198.51.100.7',
          requestedAt: now - 300_000,
          expiresAt: now + 95_000
        }
      ],
      trustedBrowsers: [
        {
          id: 'preview-browser-1',
          browser: 'Chrome',
          platform: 'macOS',
          createdAt: now - 40 * DAY,
          lastSeenAt: now - 3_600_000,
          expiresAt: now + 140 * DAY
        },
        {
          id: 'preview-browser-2',
          browser: 'Edge',
          platform: 'Windows',
          createdAt: now - 90 * DAY,
          lastSeenAt: now - DAY,
          expiresAt: now + 90 * DAY
        }
      ]
    }
  },
  credentials: {
    deviceCredentials: [
      {
        id: 'preview-credential-in-use',
        displayName: '共享 OAuth 凭据（使用中·示例）',
        kind: 'oauth',
        status: 'connected',
        needsSecret: false,
        resourceUri: 'https://api.preview.example/',
        consumerCount: 2,
        consumerNames: ['Crossref（示例连接器）', 'OpenAlex（示例连接器）'],
        createdAt: now - 60 * DAY,
        updatedAt: now - DAY
      },
      {
        id: 'preview-credential-free',
        displayName: '闲置 API 凭据（示例）',
        kind: 'api_key',
        status: 'stored',
        needsSecret: false,
        consumerCount: 0,
        consumerNames: [],
        createdAt: now - 20 * DAY,
        updatedAt: now - 2 * DAY
      }
    ]
  },
  archived: {
    projects: [
      {
        id: 'preview-project-archived',
        name: '已归档的调研项目（示例）',
        description: '',
        isExample: false,
        createdAt: now - 120 * DAY,
        updatedAt: now - 30 * DAY,
        archivedAt: now - 30 * DAY
      },
      {
        id: 'preview-project-active',
        name: '进行中的项目（示例）',
        description: '',
        isExample: false,
        createdAt: now - 100 * DAY,
        updatedAt: now - DAY
      }
    ],
    sessions: [
      {
        id: 'preview-session-in-archived-project',
        projectId: 'preview-project-archived',
        title: '归档项目里的会话（示例）',
        cwd: '/workspace/preview',
        status: 'idle',
        messages: [],
        createdAt: now - 60 * DAY,
        updatedAt: now - 30 * DAY,
        archivedAt: now - 30 * DAY
      },
      {
        id: 'preview-session-individually-archived',
        projectId: 'preview-project-active',
        title: '单独归档的会话（示例）',
        cwd: '/workspace/preview',
        status: 'idle',
        messages: [],
        createdAt: now - 50 * DAY,
        updatedAt: now - 10 * DAY,
        archivedAt: now - 10 * DAY
      }
    ],
    // False so the archived panel demonstrates the disabled Delete buttons with their explanation
    // tooltip ("Retry project recovery before deleting projects.").
    canDeleteProjects: false
  }
})

let previewState: SettingsPreviewState = buildInitialPreviewState()
const previewListeners = new Set<() => void>()

const notifyPreviewListeners = (): void => {
  previewListeners.forEach((listener) => listener())
}

export const getSettingsPreviewState = (): SettingsPreviewState => previewState

export const setSettingsPreviewState = (patch: Partial<SettingsPreviewState>): void => {
  previewState = { ...previewState, ...patch }
  notifyPreviewListeners()
}

export const setSettingsPreviewCompute = (patch: Partial<SettingsPreviewCompute>): void => {
  previewState = { ...previewState, compute: { ...previewState.compute, ...patch } }
  notifyPreviewListeners()
}

export const resetSettingsPreviewState = (): void => {
  previewState = buildInitialPreviewState()
  notifyPreviewListeners()
}

export const subscribeSettingsPreview = (listener: () => void): (() => void) => {
  previewListeners.add(listener)
  return () => previewListeners.delete(listener)
}

// React binding for the seam. Returns null when the preview flag is off so panels can branch on a
// single value; the flag is read once per store notification and is stable for a Settings session.
export const useSettingsPreviewState = (): SettingsPreviewState | null =>
  useSyncExternalStore(subscribeSettingsPreview, () =>
    isSettingsVisualPreview() ? previewState : null
  )

const PREVIEW_LATENCY_MS = 600

// Simulates one API call in preview mode: artificial latency + a console trail, never a real IPC.
export const simulatePreviewCall = async (label: string): Promise<void> => {
  console.log(`[settings-visual-preview] simulated call: ${label} (no real API request was made)`)
  await new Promise((resolve) => window.setTimeout(resolve, PREVIEW_LATENCY_MS))
}

// Preview retry for the Compute panel: fails again while the "failure" scenario is armed, otherwise
// recovers to the fixture host list so the reviewer can see both directions.
export const retryPreviewComputeLoad = async (): Promise<void> => {
  setSettingsPreviewCompute({ status: 'loading' })
  await simulatePreviewCall('compute.list (retry)')
  setSettingsPreviewCompute({ status: 'ready' })
}
