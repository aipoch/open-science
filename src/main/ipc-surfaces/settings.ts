import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { dialog } from 'electron'
import { CONNECTOR_TEMPLATE_MAX_BYTES } from '../../shared/settings'
import type { NativeTranslator } from '../locale/main-process-messages'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import { registerSettingsIpcHandlers, type SettingsIpcOptions } from '../settings/ipc'
import { showSettingsSaveDialog } from '../settings/save-dialog'
import { saveSkillExport } from '../skills/export'
import { publishUserFile } from '../user-file-publisher'
import { createElectronSurfaceAdapter } from './adapter'

type SettingsOwners = Pick<
  SettingsIpcOptions,
  'service' | 'workflows' | 'snapshotCommits' | 'listAppIconPreviews'
> & { translate: NativeTranslator }

export const createSettingsElectronSurface = ({
  service,
  workflows,
  snapshotCommits,
  listAppIconPreviews,
  translate
}: SettingsOwners): NamedElectronSurfaceAdapter =>
  createElectronSurfaceAdapter('settings', () =>
    registerSettingsIpcHandlers({
      service,
      workflows,
      snapshotCommits,
      listAppIconPreviews,
      connectorTemplateFiles: {
        select: async () => {
          const selected = await dialog.showOpenDialog({
            title: translate('Import Connector configuration'),
            properties: ['openFile'],
            filters: [{ name: translate('Connector configuration'), extensions: ['json'] }]
          })
          const filePath = selected.filePaths[0]
          if (selected.canceled || !filePath) return { cancelled: true as const }
          if ((await stat(filePath)).size > CONNECTOR_TEMPLATE_MAX_BYTES) {
            throw new Error('Connector configuration files must be 256 KiB or smaller')
          }
          return {
            cancelled: false as const,
            fileName: basename(filePath),
            contents: await readFile(filePath, 'utf8')
          }
        },
        save: async (suggestedFileName, contents, sender) => {
          const selected = await showSettingsSaveDialog(sender, {
            title: translate('Export Connector configuration'),
            defaultPath: suggestedFileName,
            filters: [{ name: translate('Connector configuration'), extensions: ['json'] }]
          })
          if (selected.canceled || !selected.filePath) return false
          await publishUserFile(selected.filePath, (temporaryPath) =>
            writeFile(temporaryPath, contents, 'utf8')
          )
          return true
        }
      },
      skillExportFiles: {
        save: (archive, sender) =>
          saveSkillExport(
            {
              showSaveDialog: (options) => showSettingsSaveDialog(sender, options),
              writeFile: (filePath, bytes) => writeFile(filePath, bytes)
            },
            archive,
            translate
          )
      }
    })
  )
