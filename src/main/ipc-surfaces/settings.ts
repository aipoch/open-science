import type { NativeTranslator } from '../locale/main-process-messages'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { registerSettingsIpcHandlers, type SettingsIpcOptions } from '../settings/ipc'
import { createSettingsExportFiles, createSettingsFileCommands } from '../settings/file-commands'
import { createElectronSurfaceAdapter } from './adapter'

type SettingsOwners = Pick<
  SettingsIpcOptions,
  'service' | 'workflows' | 'snapshotCommits' | 'listAppIconPreviews'
> & { translate: NativeTranslator; fileCommands?: SettingsIpcOptions['fileCommands'] }

export const createSettingsElectronSurface = ({
  translate,
  ...owners
}: SettingsOwners): NamedElectronSurfaceAdapter =>
  createElectronSurfaceAdapter('settings', () =>
    registerSettingsIpcHandlers({
      ...owners,
      fileCommands:
        owners.fileCommands ??
        createSettingsFileCommands(owners.service, createSettingsExportFiles(translate))
    })
  )
