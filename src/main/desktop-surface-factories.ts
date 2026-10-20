import { createElectronSurfaceAdapter } from './ipc-surfaces/adapter'
import { createConnectorApprovalElectronSurface } from './ipc-surfaces/connector-approvals'
import { createCoreElectronSurfaces } from './ipc-surfaces/core'
import { createNotificationElectronSurface } from './ipc-surfaces/notifications'
import { createDesktopUtilitiesElectronSurface } from './ipc-surfaces/desktop-utilities'
import { registerReviewerIpcHandlers } from './reviewer/ipc'
import { registerSideChatIpcHandlers } from './side-chat/ipc'
import { registerLocalModelIpcHandlers } from './local-models/ipc'
import { registerBackgroundResultDeliveryIpcHandlers } from './background-result-delivery/ipc'
import { createSettingsElectronSurface } from './ipc-surfaces/settings'
import { registerNotebookIpcHandlers } from './notebook/ipc'
import { registerApplicationCommandElectronAdapter } from './application-command-electron-adapter'
import { registerStorageIpcHandlers } from './storage/ipc'
import { registerUpdateIpcHandlers } from './update/ipc'
import { registerNotebookEnvIpcHandlers } from './notebook/env-ipc'
import { createOfficePreviewElectronSurfaces } from './ipc-surfaces/office-preview'
import { installManagedPreviewElectronAdapter } from './managed-preview-ipc'
import { registerRuntimeIpcHandlers } from './notebook/runtime-ipc'
import { createArtifactElectronSurface } from './ipc-surfaces/artifacts'
import { createSessionPersistenceElectronSurface } from './ipc-surfaces/session-persistence'
import { createUploadElectronSurface } from './ipc-surfaces/uploads'
import { createSpecialistElectronSurface } from './ipc-surfaces/specialist'
import { bindDesktopSurfaceFactories } from './desktop-surface-declarations'

export const bindElectronSurfaceFactories = (): void => bindDesktopSurfaceFactories(factories)

const factories = {
  createElectronSurfaceAdapter,
  createConnectorApprovalElectronSurface,
  createCoreElectronSurfaces,
  createNotificationElectronSurface,
  createDesktopUtilitiesElectronSurface,
  registerReviewerIpcHandlers,
  registerSideChatIpcHandlers,
  registerLocalModelIpcHandlers,
  registerBackgroundResultDeliveryIpcHandlers,
  createSettingsElectronSurface,
  registerNotebookIpcHandlers,
  registerApplicationCommandElectronAdapter,
  registerStorageIpcHandlers,
  registerUpdateIpcHandlers,
  registerNotebookEnvIpcHandlers,
  createOfficePreviewElectronSurfaces,
  installManagedPreviewElectronAdapter,
  registerRuntimeIpcHandlers,
  createArtifactElectronSurface,
  createSessionPersistenceElectronSurface,
  createUploadElectronSurface,
  createSpecialistElectronSurface
}
