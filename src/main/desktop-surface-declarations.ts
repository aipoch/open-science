import type { NamedElectronSurfaceAdapter } from './runtime-electron-wiring'

// Only desktop transport construction lives behind this catalog. Entries are bound by desktop
// wiring; the core merely declares adapters, and a Node entry never installs them.
export type DesktopSurfaceFactories = {
  createElectronSurfaceAdapter: (typeof import('./ipc-surfaces/adapter'))['createElectronSurfaceAdapter']
  createConnectorApprovalElectronSurface: (typeof import('./ipc-surfaces/connector-approvals'))['createConnectorApprovalElectronSurface']
  createCoreElectronSurfaces: (typeof import('./ipc-surfaces/core'))['createCoreElectronSurfaces']
  createNotificationElectronSurface: (typeof import('./ipc-surfaces/notifications'))['createNotificationElectronSurface']
  createDesktopUtilitiesElectronSurface: (typeof import('./ipc-surfaces/desktop-utilities'))['createDesktopUtilitiesElectronSurface']
  registerReviewerIpcHandlers: (typeof import('./reviewer/ipc'))['registerReviewerIpcHandlers']
  registerSideChatIpcHandlers: (typeof import('./side-chat/ipc'))['registerSideChatIpcHandlers']
  registerLocalModelIpcHandlers: (typeof import('./local-models/ipc'))['registerLocalModelIpcHandlers']
  registerBackgroundResultDeliveryIpcHandlers: (typeof import('./background-result-delivery/ipc'))['registerBackgroundResultDeliveryIpcHandlers']
  createSettingsElectronSurface: (typeof import('./ipc-surfaces/settings'))['createSettingsElectronSurface']
  registerNotebookIpcHandlers: (typeof import('./notebook/ipc'))['registerNotebookIpcHandlers']
  registerApplicationCommandElectronAdapter: (typeof import('./application-command-electron-adapter'))['registerApplicationCommandElectronAdapter']
  registerStorageIpcHandlers: (typeof import('./storage/ipc'))['registerStorageIpcHandlers']
  registerUpdateIpcHandlers: (typeof import('./update/ipc'))['registerUpdateIpcHandlers']
  registerNotebookEnvIpcHandlers: (typeof import('./notebook/env-ipc'))['registerNotebookEnvIpcHandlers']
  createOfficePreviewElectronSurfaces: (typeof import('./ipc-surfaces/office-preview'))['createOfficePreviewElectronSurfaces']
  installManagedPreviewElectronAdapter: (typeof import('./managed-preview-ipc'))['installManagedPreviewElectronAdapter']
  registerRuntimeIpcHandlers: (typeof import('./notebook/runtime-ipc'))['registerRuntimeIpcHandlers']
  createArtifactElectronSurface: (typeof import('./ipc-surfaces/artifacts'))['createArtifactElectronSurface']
  createSessionPersistenceElectronSurface: (typeof import('./ipc-surfaces/session-persistence'))['createSessionPersistenceElectronSurface']
  createUploadElectronSurface: (typeof import('./ipc-surfaces/uploads'))['createUploadElectronSurface']
  createSpecialistElectronSurface: (typeof import('./ipc-surfaces/specialist'))['createSpecialistElectronSurface']
}

let installed: DesktopSurfaceFactories | undefined
export function bindDesktopSurfaceFactories(factories: DesktopSurfaceFactories): void {
  if (installed && installed !== factories)
    throw new Error('Desktop surface factories are already bound.')
  installed = factories
}
function desktop(): DesktopSurfaceFactories {
  if (!installed) throw new Error('Electron transport installation is unavailable in this host.')
  return installed
}

export const createElectronSurfaceAdapter = (
  ...args: Parameters<DesktopSurfaceFactories['createElectronSurfaceAdapter']>
): ReturnType<DesktopSurfaceFactories['createElectronSurfaceAdapter']> => ({
  name: args[0],
  install: () =>
    desktop()
      .createElectronSurfaceAdapter(...args)
      .install()
})

export const createConnectorApprovalElectronSurface = (
  ...args: Parameters<DesktopSurfaceFactories['createConnectorApprovalElectronSurface']>
): ReturnType<DesktopSurfaceFactories['createConnectorApprovalElectronSurface']> => ({
  name: 'connector-approvals',
  install: () =>
    desktop()
      .createConnectorApprovalElectronSurface(...args)
      .install()
})

export const createCoreElectronSurfaces = (
  ...args: Parameters<DesktopSurfaceFactories['createCoreElectronSurfaces']>
): ReturnType<DesktopSurfaceFactories['createCoreElectronSurfaces']> => {
  let surfaces: NamedElectronSurfaceAdapter[] | undefined
  return [
    'permission-grants',
    'project-files',
    'managed-file-versions',
    'local-fs',
    'preview-state',
    'lifecycle'
  ].map((name, index) => ({
    name,
    install: () => {
      surfaces ??= desktop().createCoreElectronSurfaces(...args)
      return surfaces[index]!.install()
    }
  }))
}

export const createNotificationElectronSurface = (
  ...args: Parameters<DesktopSurfaceFactories['createNotificationElectronSurface']>
): ReturnType<DesktopSurfaceFactories['createNotificationElectronSurface']> => ({
  name: 'task-notifications',
  install: () =>
    desktop()
      .createNotificationElectronSurface(...args)
      .install()
})

export const createDesktopUtilitiesElectronSurface = (
  ...args: Parameters<DesktopSurfaceFactories['createDesktopUtilitiesElectronSurface']>
): ReturnType<DesktopSurfaceFactories['createDesktopUtilitiesElectronSurface']> => ({
  name: 'desktop-utilities',
  install: () =>
    desktop()
      .createDesktopUtilitiesElectronSurface(...args)
      .install()
})

export const registerReviewerIpcHandlers = (
  ...args: Parameters<DesktopSurfaceFactories['registerReviewerIpcHandlers']>
): ReturnType<DesktopSurfaceFactories['registerReviewerIpcHandlers']> =>
  desktop().registerReviewerIpcHandlers(...args)

export const registerSideChatIpcHandlers = (
  ...args: Parameters<DesktopSurfaceFactories['registerSideChatIpcHandlers']>
): ReturnType<DesktopSurfaceFactories['registerSideChatIpcHandlers']> =>
  desktop().registerSideChatIpcHandlers(...args)

export const registerLocalModelIpcHandlers = (
  ...args: Parameters<DesktopSurfaceFactories['registerLocalModelIpcHandlers']>
): ReturnType<DesktopSurfaceFactories['registerLocalModelIpcHandlers']> =>
  desktop().registerLocalModelIpcHandlers(...args)

export const registerBackgroundResultDeliveryIpcHandlers = (
  ...args: Parameters<DesktopSurfaceFactories['registerBackgroundResultDeliveryIpcHandlers']>
): ReturnType<DesktopSurfaceFactories['registerBackgroundResultDeliveryIpcHandlers']> =>
  desktop().registerBackgroundResultDeliveryIpcHandlers(...args)

export const createSettingsElectronSurface = (
  ...args: Parameters<DesktopSurfaceFactories['createSettingsElectronSurface']>
): ReturnType<DesktopSurfaceFactories['createSettingsElectronSurface']> => ({
  name: 'settings',
  install: () =>
    desktop()
      .createSettingsElectronSurface(...args)
      .install()
})

export const registerNotebookIpcHandlers = (
  ...args: Parameters<DesktopSurfaceFactories['registerNotebookIpcHandlers']>
): ReturnType<DesktopSurfaceFactories['registerNotebookIpcHandlers']> =>
  desktop().registerNotebookIpcHandlers(...args)

export const registerApplicationCommandElectronAdapter = (
  ...args: Parameters<DesktopSurfaceFactories['registerApplicationCommandElectronAdapter']>
): ReturnType<DesktopSurfaceFactories['registerApplicationCommandElectronAdapter']> =>
  desktop().registerApplicationCommandElectronAdapter(...args)

export const registerStorageIpcHandlers = (
  ...args: Parameters<DesktopSurfaceFactories['registerStorageIpcHandlers']>
): ReturnType<DesktopSurfaceFactories['registerStorageIpcHandlers']> =>
  desktop().registerStorageIpcHandlers(...args)

export const registerUpdateIpcHandlers = (
  ...args: Parameters<DesktopSurfaceFactories['registerUpdateIpcHandlers']>
): ReturnType<DesktopSurfaceFactories['registerUpdateIpcHandlers']> =>
  desktop().registerUpdateIpcHandlers(...args)

export const registerNotebookEnvIpcHandlers = (
  ...args: Parameters<DesktopSurfaceFactories['registerNotebookEnvIpcHandlers']>
): ReturnType<DesktopSurfaceFactories['registerNotebookEnvIpcHandlers']> =>
  desktop().registerNotebookEnvIpcHandlers(...args)

export const createOfficePreviewElectronSurfaces = (
  ...args: Parameters<DesktopSurfaceFactories['createOfficePreviewElectronSurfaces']>
): ReturnType<DesktopSurfaceFactories['createOfficePreviewElectronSurfaces']> => {
  let surfaces: NamedElectronSurfaceAdapter[] | undefined
  return ['office-preview-runtime', 'office-preview'].map((name, index) => ({
    name,
    install: () => {
      surfaces ??= desktop().createOfficePreviewElectronSurfaces(...args)
      return surfaces[index]!.install()
    }
  }))
}

export const installManagedPreviewElectronAdapter = (
  ...args: Parameters<DesktopSurfaceFactories['installManagedPreviewElectronAdapter']>
): ReturnType<DesktopSurfaceFactories['installManagedPreviewElectronAdapter']> =>
  desktop().installManagedPreviewElectronAdapter(...args)

export const registerRuntimeIpcHandlers = (
  ...args: Parameters<DesktopSurfaceFactories['registerRuntimeIpcHandlers']>
): ReturnType<DesktopSurfaceFactories['registerRuntimeIpcHandlers']> =>
  desktop().registerRuntimeIpcHandlers(...args)

export const createArtifactElectronSurface = (
  ...args: Parameters<DesktopSurfaceFactories['createArtifactElectronSurface']>
): ReturnType<DesktopSurfaceFactories['createArtifactElectronSurface']> => ({
  name: 'artifacts',
  install: () =>
    desktop()
      .createArtifactElectronSurface(...args)
      .install()
})

export const createSessionPersistenceElectronSurface = (
  ...args: Parameters<DesktopSurfaceFactories['createSessionPersistenceElectronSurface']>
): ReturnType<DesktopSurfaceFactories['createSessionPersistenceElectronSurface']> => ({
  name: 'session-persistence',
  install: () =>
    desktop()
      .createSessionPersistenceElectronSurface(...args)
      .install()
})

export const createUploadElectronSurface = (
  ...args: Parameters<DesktopSurfaceFactories['createUploadElectronSurface']>
): ReturnType<DesktopSurfaceFactories['createUploadElectronSurface']> => ({
  name: 'uploads',
  install: () =>
    desktop()
      .createUploadElectronSurface(...args)
      .install()
})

export const createSpecialistElectronSurface = (
  ...args: Parameters<DesktopSurfaceFactories['createSpecialistElectronSurface']>
): ReturnType<DesktopSurfaceFactories['createSpecialistElectronSurface']> => ({
  name: 'specialist',
  install: () =>
    desktop()
      .createSpecialistElectronSurface(...args)
      .install()
})
