import type { SkillExportArchive } from '@aipoch/skills/sources'
import { englishNativeTranslator, type NativeTranslator } from '../locale/main-process-messages'
import { publishUserFile } from '../user-file-publisher'
import { buildSkillExportArchive as buildArchive } from '@aipoch/skills/sources'
import { validateSkillHelper } from './helper-validation'
export { skillExportFileName } from '@aipoch/skills/sources'
export const buildSkillExportArchive: typeof buildArchive = (skill, storageRoot) =>
  buildArchive(skill, storageRoot, validateSkillHelper)
export type { SkillExportArchive } from '@aipoch/skills/sources'

type SkillExportDialog = {
  showSaveDialog: (options: {
    title: string
    defaultPath: string
    filters: Array<{ name: string; extensions: string[] }>
  }) => Promise<{ canceled: boolean; filePath?: string }>
  writeFile: (filePath: string, bytes: Uint8Array) => Promise<unknown>
  publishUserFile?: typeof publishUserFile
}

export const saveSkillExport = async (
  adapter: SkillExportDialog,
  archive: SkillExportArchive,
  translate: NativeTranslator = englishNativeTranslator
): Promise<{ saved: boolean }> => {
  const selected = await adapter.showSaveDialog({
    title: translate('Export Skill'),
    defaultPath: archive.fileName,
    filters: [{ name: translate('Skill ZIP'), extensions: ['zip'] }]
  })
  if (selected.canceled || !selected.filePath) return { saved: false }
  await (adapter.publishUserFile ?? publishUserFile)(selected.filePath, async (temporaryPath) => {
    await adapter.writeFile(temporaryPath, archive.archiveBytes)
  })
  return { saved: true }
}
