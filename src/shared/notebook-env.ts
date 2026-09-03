import type { NotebookLanguage } from './notebook'

// Canonical wire shapes for the notebook runtime provisioning surface (contract §4). Renderer,
// preload, and the main provisioner (Plan A) all import these so there is one source of truth.
export type ProvisionScope = 'python' | 'r'
export type ProvisionOperationScope = ProvisionScope | 'upgrade'
export type ProvisionProgress = {
  phase: string
  message: string
  progress: number
  // Correlates renderer-requested provision/repair progress with the originating IPC call. Automatic
  // maintenance omits it so its terminal event cannot accidentally settle a queued explicit request.
  operationId?: string
  // Explicit at process boundaries so an automatic R provision is not inferred as a global upgrade.
  scope?: ProvisionOperationScope
  // Present for a provision triggered by one notebook run; other sessions remain visible and usable.
  sessionId?: string
  // `language` attributes an event to the env it concerns so the Settings UI can show python and R
  // provisioning independently — the provisioner serializes the two runs, but neither card should look
  // cancelled when the other is requested (undefined for language-agnostic events: upgrade/restore).
  language?: NotebookLanguage
  // Present during the pack-download phase so the UI can show speed/ETA/resume detail alongside the
  // coarse `progress` fraction.
  download?: import('./download-progress').DownloadProgress
}
export type RuntimeBundleSource = {
  kind: 'official' | 'override'
  baseUrl: string
}
export type ProvisionStatus = {
  pythonReady: boolean
  rReady: boolean
  version: number
  provisioning: boolean
  bundleSource?: RuntimeBundleSource
  // True when recovery quarantined the language's app-managed default prefix, or an explicit repair
  // left its durable marker armed after failing. The env may still read as ready or may be absent, so
  // the UI needs this signal to surface Reset instead of a healthy card or an ordinary setup retry.
  pythonRecoveryBlocked?: boolean
  rRecoveryBlocked?: boolean
}

// One named environment as surfaced by manage_environments(action:"list") and the UI's env selector.
export type EnvironmentInfo = {
  name: string
  language: NotebookLanguage
  ready: boolean
  isDefault: boolean
  sizeBytes?: number
}

// manage_environments tool request — discriminated on action (design D2).
export type ManageEnvironmentsRequest =
  | {
      action: 'create'
      language: NotebookLanguage
      name: string
      packages?: string[]
      projectId?: string
      sessionId?: string
      workspaceCwd?: string
    }
  | { action: 'list' }
  | { action: 'remove'; name: string }

export type CreatedEnvironmentReceipt = {
  name: string
  language: NotebookLanguage
  // Canonical executable identity accepted by notebook_bind_runtime/notebook_switch_runtime.
  runtimeId: string
  runnable: boolean
  detail?: string
}

export type RemovedEnvironmentReceipt = {
  name: string
}

// Mutation receipts describe only the completed operation. action:"list" is the sole full-snapshot
// contract; callers that need a refreshed inventory request it explicitly after the mutation.
export type ManageEnvironmentsResult =
  | {
      created: CreatedEnvironmentReceipt
      environments?: never
      removed?: never
    }
  | {
      environments: EnvironmentInfo[]
      created?: never
      removed?: never
    }
  | {
      removed: RemovedEnvironmentReceipt
      environments?: never
      created?: never
    }
