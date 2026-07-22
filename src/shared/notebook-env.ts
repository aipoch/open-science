import type { NotebookLanguage } from './notebook'

// Canonical wire shapes for the notebook runtime provisioning surface (contract §4). Renderer,
// preload, and the main provisioner (Plan A) all import these so there is one source of truth.
export type ProvisionScope = 'python' | 'r'
export type ProvisionOperationScope = ProvisionScope | 'upgrade'
export type ProvisionProgress = {
  phase: string
  message: string
  progress: number
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
  // True when crash-recovery quarantined the language's app-managed default prefix (an interrupted
  // worker couldn't be confirmed stopped). The env may still read as ready, so the UI needs this
  // explicit signal to surface the Reset affordance instead of a normal, healthy-looking card.
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
  | { action: 'create'; language: NotebookLanguage; name: string; packages?: string[] }
  | { action: 'list' }
  | { action: 'remove'; name: string }

// create/list/remove all return the full current env set so the caller/UI can refresh in one shot.
export type ManageEnvironmentsResult = { environments: EnvironmentInfo[] }
