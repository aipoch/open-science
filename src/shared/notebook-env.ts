import type { NotebookLanguage } from './notebook'

// Canonical wire shapes for the notebook runtime provisioning surface (contract §4). Renderer,
// preload, and the main provisioner (Plan A) all import these so there is one source of truth.
export type ProvisionProgress = { phase: string; message: string; progress: number }
export type ProvisionStatus = {
  pythonReady: boolean
  rReady: boolean
  version: number
  provisioning: boolean
}

// Which environment a provisioning run targets — the explicit provision(lang) requests the renderer
// can make. The "upgrade" (auto additive upgrade) state is inferred by the renderer from
// `(provisioning && pythonReady)` and is not part of this wire type (contract §4).
export type ProvisionScope = 'python' | 'r'

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
