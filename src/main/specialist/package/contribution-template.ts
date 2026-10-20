import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { buildContributionTemplateZip } from '@aipoch/specialists/node'
import { type ContributionTemplateExportResult } from '../../../shared/specialist'
import { englishNativeTranslator, type NativeTranslator } from '../../locale/main-process-messages'

export const CONTRIBUTION_TEMPLATE_FILENAME = 'open-science-specialist-template.zip'

export const resolveContributionTemplateReadmePath = (appPath: string): string =>
  join(appPath, 'resources', 'specialists', 'template', 'v1', 'README.txt').replace(
    /([/\\])app\.asar([/\\])/,
    '$1app.asar.unpacked$2'
  )

type ContributionTemplateExporterDependencies = {
  appVersion: string
  showSaveDialog: (options: {
    title: string
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePath?: string }>
  readReadme: () => Promise<string>
  writeFile: (filePath: string, bytes: Uint8Array) => Promise<void>
  publishUserFile: (
    destinationPath: string,
    write: (temporaryPath: string) => Promise<unknown>
  ) => Promise<void>
  generatePackageId?: () => string
  translate?: NativeTranslator
}

export const createContributionTemplateExporter =
  (
    dependencies: ContributionTemplateExporterDependencies
  ): (() => Promise<ContributionTemplateExportResult>) =>
  async () => {
    const destination = await dependencies.showSaveDialog({
      title: (dependencies.translate ?? englishNativeTranslator)('Save contribution template'),
      defaultPath: CONTRIBUTION_TEMPLATE_FILENAME,
      filters: [
        {
          name: (dependencies.translate ?? englishNativeTranslator)('ZIP archive'),
          extensions: ['zip']
        }
      ]
    })
    if (destination.canceled || !destination.filePath) return { saved: false }

    try {
      const readme = await dependencies.readReadme()
      const archive = buildContributionTemplateZip({
        appVersion: dependencies.appVersion,
        readme,
        packageId: (dependencies.generatePackageId ?? randomUUID)()
      })
      await dependencies.publishUserFile(destination.filePath, (temporaryPath) =>
        dependencies.writeFile(temporaryPath, archive)
      )
      return { saved: true }
    } catch {
      throw new Error('Could not save contribution template.')
    }
  }
