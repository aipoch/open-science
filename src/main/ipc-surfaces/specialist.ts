import { readFile, stat, writeFile } from 'node:fs/promises'
import { app, dialog } from 'electron'
import { registerSpecialistIpcHandlers } from '../specialist/ipc'
import {
  createContributionTemplateExporter,
  resolveContributionTemplateReadmePath
} from '../specialist/package/contribution-template'
import {
  selectSpecialistArchive,
  saveSpecialistPackageReport,
  saveSpecialistExport
} from '../specialist/package/electron-adapter'
import type { NamedElectronSurfaceAdapter } from '../runtime-electron-wiring'
import type { NativeTranslator } from '../locale/main-process-messages'
import { createElectronSurfaceAdapter } from './adapter'

type Registrar = Parameters<typeof registerSpecialistIpcHandlers>
type SpecialistOwners = {
  specialistService: Registrar[0]
  sessionBindingService: Registrar[1]
  sessionSpecialistReconfiguration: Registrar[2]
  onProfilesChanged: NonNullable<Registrar[3]>
  specialistPackageService: NonNullable<Registrar[5]>['service']
  marketplaceService: NonNullable<Registrar[6]>
  specialistApplicationOwner: NonNullable<Registrar[7]>
  translate: NativeTranslator
}

export const createSpecialistElectronSurface = ({
  specialistService,
  sessionBindingService,
  sessionSpecialistReconfiguration,
  onProfilesChanged,
  specialistPackageService,
  marketplaceService,
  specialistApplicationOwner,
  translate
}: SpecialistOwners): NamedElectronSurfaceAdapter =>
  createElectronSurfaceAdapter('specialist', () =>
    registerSpecialistIpcHandlers(
      specialistService,
      sessionBindingService,
      sessionSpecialistReconfiguration,
      // A specialist capability edit (skills/connectors/enabled) must reach live sessions on the next
      // turn: reconnect so the agent respawns (re-provisioning skills) and resumes with the updated
      // specialist whitelist in the session _meta.
      onProfilesChanged,
      createContributionTemplateExporter({
        appVersion: app.getVersion(),
        translate,
        showSaveDialog: (options) => dialog.showSaveDialog(options),
        readReadme: () => readFile(resolveContributionTemplateReadmePath(app.getAppPath()), 'utf8'),
        writeFile: (filePath, bytes) => writeFile(filePath, bytes)
      }),
      {
        service: specialistPackageService,
        selectArchive: () =>
          selectSpecialistArchive(
            {
              showOpenDialog: (options) => dialog.showOpenDialog(options),
              readFile,
              getFileSize: async (filePath) => (await stat(filePath)).size
            },
            translate
          ),
        saveReport: (report) =>
          saveSpecialistPackageReport(
            {
              showSaveDialog: (options) => dialog.showSaveDialog(options),
              writeFile: (filePath, contents) => writeFile(filePath, contents, 'utf8')
            },
            report,
            translate
          ),
        saveExport: (archive) =>
          saveSpecialistExport(
            {
              showSaveDialog: (options) => dialog.showSaveDialog(options),
              writeFile: (filePath, bytes) => writeFile(filePath, bytes)
            },
            archive,
            translate
          )
      },
      marketplaceService,
      specialistApplicationOwner
    )
  )
