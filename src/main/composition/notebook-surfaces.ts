import {
  createOfficePreviewCommands,
  type OfficePreviewCommands
} from '../office-preview/application-commands'
import type { ApplicationModuleBuilder } from '../application-runtime'
import {
  createOfficePreviewElectronSurfaces,
  installManagedPreviewElectronAdapter,
  registerRuntimeIpcHandlers
} from '../desktop-surface-declarations'
import { join } from 'node:path'
import { type DiagnosticOperation } from '../diagnostics/operation'

import { getRuntimeRoot } from '../notebook/repository'

import { createRuntimeWorkflows } from '../notebook/runtime-workflows'
import { broadcastToRenderers } from '../renderer-broadcast'
import { resolveDataRoot } from '../storage-root'
import type { composeBackgroundResults } from './background-results'
import type { composeManagedFiles } from './managed-files'
import { registerNotebookEnvironmentComposition } from './notebook-environment'
import type { composeNotebookRuntime } from './notebook-runtime'
import type { composeSettingsBootstrap } from './settings-bootstrap'

export async function composeNotebookSurfaces({
  modules,
  reportOfficePreviewState,
  surfaceAdapters,
  declareElectronAdapter,
  settingsBootstrap,
  backgroundResults,
  managedFiles,
  notebookRuntime,
  managedPreviewProtocol,
  composition
}: {
  modules: ApplicationModuleBuilder
  reportOfficePreviewState?: (
    clientId: string,
    state: import('../../shared/office-preview').OfficePreviewRuntimeState
  ) => void
  surfaceAdapters: import('../runtime-electron-wiring').NamedElectronSurfaceAdapter[]
  declareElectronAdapter: (name: string, install: () => void | (() => void)) => void
  settingsBootstrap: Awaited<ReturnType<typeof composeSettingsBootstrap>>
  backgroundResults: Awaited<ReturnType<typeof composeBackgroundResults>>
  managedFiles: ReturnType<typeof composeManagedFiles>
  notebookRuntime: Awaited<ReturnType<typeof composeNotebookRuntime>>
  managedPreviewProtocol?: import('../managed-preview-protocol').PreviewProtocolRegistrar
  composition: DiagnosticOperation
}): Promise<{
  officePreviewCommands: OfficePreviewCommands
  runtimeWorkflows: ReturnType<typeof createRuntimeWorkflows>
  notebookEnvironmentLifecycle: Awaited<ReturnType<typeof registerNotebookEnvironmentComposition>>
}> {
  // Runtime Settings UI: discover managed/external environments and pick an interpreter file. The
  // runtime root MUST match the executor/service's
  // (getRuntimeRoot(<dataRoot>)); read lazily so a data-root switch is reflected without re-register.
  const runtimeWorkflows = createRuntimeWorkflows({
    settingsService: settingsBootstrap.settingsService,
    onPolicyChanged: () => broadcastToRenderers('runtime:policy-changed', undefined),
    ...(settingsBootstrap.notebookNetworkSandbox.supportsWindowsRuntimeAccess
      ? {
          setWindowsRuntimeAccess: (executable: string, authorized: boolean) =>
            settingsBootstrap.notebookNetworkSandbox.setWindowsRuntimeAccess(executable, authorized)
        }
      : {}),
    runtimeRoot: () => getRuntimeRoot(resolveDataRoot()),
    micromambaRunner: notebookRuntime.micromambaRunner,
    // WS10: revoke a disabled runtime from any live session bound to it (mark binding unavailable).
    onRuntimeDisabled: (language, envId, force) =>
      notebookRuntime.notebookService.revokeRuntime(language, envId, {
        force,
        waitForDrain:
          settingsBootstrap.notebookNetworkSandbox.supportsWindowsRuntimeAccess && language === 'r'
      }),
    // WS11: live-session usage of a runtime, for the disable-impact warning.
    describeRuntimeUsage: (language, envId) =>
      notebookRuntime.notebookService.describeRuntimeUsage(language, envId)
  })
  declareElectronAdapter('notebook-runtime', () => registerRuntimeIpcHandlers(runtimeWorkflows))
  declareElectronAdapter('managed-preview', () =>
    installManagedPreviewElectronAdapter(
      managedFiles.previewResources,
      managedPreviewProtocol,
      managedFiles.managedPreviewOwners
    )
  )
  const officePreviewCommands = await modules.add({}, () => {
    const commands = createOfficePreviewCommands(
      managedFiles.previewResources,
      managedFiles.managedPreviewOwners,
      (clientId, state) => reportOfficePreviewState?.(clientId, state)
    )
    return { name: 'office-preview', capability: commands, dispose: () => commands.dispose() }
  })
  surfaceAdapters.push(
    ...createOfficePreviewElectronSurfaces({
      commands: officePreviewCommands,
      previewResources: managedFiles.previewResources,
      runtimeHtmlPath: join(__dirname, '../renderer/office-preview.html')
    })
  )

  const notebookEnvironmentLifecycle = await registerNotebookEnvironmentComposition({
    settingsService: settingsBootstrap.settingsService,
    provisioningRoot: notebookRuntime.provisioningRoot,
    notebookNetworkSandbox: settingsBootstrap.notebookNetworkSandbox,
    micromambaRunner: notebookRuntime.micromambaRunner,
    notebookService: notebookRuntime.notebookService,
    notebookCommands: notebookRuntime.notebookCommands,
    notebookRunResultDelivery: backgroundResults.notebookRunResultDelivery,
    markNotebookResultAuthorityReady: backgroundResults.markNotebookResultAuthorityReady,
    declareElectronAdapter
  })
  composition.phase('notebook-provisioner')
  return { officePreviewCommands, runtimeWorkflows, notebookEnvironmentLifecycle }
}
