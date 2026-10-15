import type { ManagedRuntimeDiagnostics } from '../../shared/managed-execution'
import type { ManagedResearchRuntime } from './managed-research-environment'
import type { ResearchMaterialAuthority } from './research-materials'

export type ManagedPublicRuntime = Omit<ManagedResearchRuntime, 'executable' | 'readOnlyRoots'>

export type ManagedRuntimeInventory = {
  available: boolean
  runtimes: Array<ManagedPublicRuntime & { runtimeId: string }>
  diagnostics?: ManagedRuntimeDiagnostics
}

/** The material authority needed by inspection and admission, independent of execution ownership. */
export type ManagedExecutionMaterialAccess = {
  materials(request: {
    projectId: string
    sourceSessionId: string
    targetSessionId: string
    versionIds?: string[]
    expectedSourceIdentity?: string
    signal?: AbortSignal
  }): Promise<ResearchMaterialAuthority>
  withWritableSession<T>(
    scope: { projectId: string; sessionId: string },
    operation: () => Promise<T>
  ): Promise<T>
}

export type ManagedExecutionPreparationPort = {
  runtimes(): Promise<ManagedRuntimeInventory>
  prepare(value: unknown, signal?: AbortSignal): Promise<unknown>
}
