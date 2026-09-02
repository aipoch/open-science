import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { strToU8, zipSync, type Zippable } from 'fflate'

import {
  SPECIALIST_PACKAGE_SCHEMA_VERSION,
  type ContributionTemplateExportResult
} from '../../../shared/specialist-package'
import { englishNativeTranslator, type NativeTranslator } from '../../locale/main-process-messages'

export const CONTRIBUTION_TEMPLATE_FILENAME = 'openscience-specialist-template.zip'

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
  generatePackageId?: () => string
  translate?: NativeTranslator
}

const assertValidAppVersion = (appVersion: string): void => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(appVersion)
  if (!match) throw new Error('Application version must be SemVer.')
}

export const buildDeterministicSpecialistZip = (
  files: Readonly<Record<string, Uint8Array>>
): Uint8Array => {
  const zipOptions = { mtime: new Date(1980, 0, 1) }
  const entries: Zippable = {}
  for (const [path, bytes] of Object.entries(files).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    entries[path] = [bytes, zipOptions]
  }
  return zipSync(entries, { level: 6 })
}

export const buildContributionTemplateZip = (input: {
  appVersion: string
  readme: string
  packageId?: string
}): Uint8Array => {
  assertValidAppVersion(input.appVersion)
  const manifest = {
    schema_version: SPECIALIST_PACKAGE_SCHEMA_VERSION,
    id: input.packageId ?? randomUUID(),
    version: '0.1.0',
    exported_with_app_version: input.appVersion
  }
  const specialist = {
    name: '',
    description: '',
    system_prompt: '',
    skill_ids: [],
    connector_ids: []
  }
  return buildDeterministicSpecialistZip({
    'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    'specialist.json': strToU8(`${JSON.stringify(specialist, null, 2)}\n`),
    'README.txt': strToU8(input.readme)
  })
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
      await dependencies.writeFile(destination.filePath, archive)
      return { saved: true }
    } catch {
      throw new Error('Could not save contribution template.')
    }
  }
