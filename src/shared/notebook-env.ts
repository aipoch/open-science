import type { InstallRequest as EnvironmentInstallRequest } from '@aipoch/environment'

export type EnvironmentRequestContext = { projectId?: string; sessionId?: string }
// RPC/session identity is resolved and authorized by the host before invoking environment.
export type InstallRequest = Omit<EnvironmentInstallRequest, 'cwd' | 'context'> &
  EnvironmentRequestContext & { workspaceCwd?: string }

import type { InstallResult as EnvironmentInstallResult } from '@aipoch/environment'
import type { EnvironmentInfo } from '@aipoch/environment/contracts'
import type { NotebookLanguage } from './notebook-language-contract'
import type { RuntimeTargetReceipt } from './notebook-runtime'
export type InstallResult = EnvironmentInstallResult & { target?: RuntimeTargetReceipt }

// Canonical wire shapes for the notebook runtime provisioning surface (contract §4). Renderer,
// preload, and the main provisioner (Plan A) all import these so there is one source of truth.
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
