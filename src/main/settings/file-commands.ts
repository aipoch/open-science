import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { CONNECTOR_TEMPLATE_MAX_BYTES } from '../../shared/settings'
import type {
  ConnectorTemplateSelectionResult,
  ExportCustomServerTemplateRequest,
  ExportCustomServerTemplateResult,
  ExportSkillRequest,
  ExportSkillResult,
  SelectCustomServerTemplateRequest
} from '../../shared/settings'
import type { ApplicationInvocation } from '../application-command-router'
import { requireDesktopCaller } from '../caller-context'
import { desktopFileInteraction } from '../desktop-interaction'
import type { NativeTranslator } from '../locale/main-process-messages'
import { saveSkillExport, type SkillExportArchive } from '../skills/export'
import { publishUserFile } from '../user-file-publisher'
import { connectorTemplateExportSelection } from './connector-template'
import type { SettingsService } from './service'

type Invocation = ApplicationInvocation<readonly unknown[]>
export type SettingsExportFiles = {
  selectTemplate(
    invocation: Invocation
  ): Promise<{ cancelled: true } | { cancelled: false; fileName: string; contents: string }>
  saveTemplate(fileName: string, contents: string, invocation: Invocation): Promise<boolean>
  saveSkill(archive: SkillExportArchive, invocation: Invocation): Promise<ExportSkillResult>
}
const assertCaller = ({ callerContext, callerLease }: Invocation): void => {
  requireDesktopCaller(callerContext)
  callerLease.signal.throwIfAborted()
  if (!callerLease.isCurrent()) throw new Error('Settings export caller is no longer current.')
}

export function createSettingsExportFiles(translate: NativeTranslator): SettingsExportFiles {
  const publish =
    (invocation: Invocation): typeof publishUserFile =>
    (destination, write, options) => {
      assertCaller(invocation)
      return publishUserFile(
        destination,
        async (temporaryPath) => {
          await write(temporaryPath)
          assertCaller(invocation)
        },
        {
          ...options,
          validateDestination: async () => {
            await options?.validateDestination?.()
            assertCaller(invocation)
          }
        }
      )
    }
  return {
    selectTemplate: async (invocation) => {
      const selected = await desktopFileInteraction().chooseFiles(
        {
          title: translate('Import Connector configuration'),
          properties: ['openFile'],
          filters: [{ name: translate('Connector configuration'), extensions: ['json'] }]
        },
        invocation.callerContext.clientId
      )
      assertCaller(invocation)
      const filePath = selected.filePaths[0]
      if (selected.canceled || !filePath) return { cancelled: true }
      if ((await stat(filePath)).size > CONNECTOR_TEMPLATE_MAX_BYTES)
        throw new Error('Connector configuration files must be 256 KiB or smaller')
      const contents = await readFile(filePath, 'utf8')
      assertCaller(invocation)
      return { cancelled: false, fileName: basename(filePath), contents }
    },
    saveTemplate: async (fileName, contents, invocation) => {
      const selected = await desktopFileInteraction().chooseSavePath(
        {
          title: translate('Export Connector configuration'),
          defaultPath: fileName,
          filters: [{ name: translate('Connector configuration'), extensions: ['json'] }]
        },
        invocation.callerContext.clientId
      )
      assertCaller(invocation)
      if (selected.canceled || !selected.filePath) return false
      await publish(invocation)(selected.filePath, (temporaryPath) =>
        writeFile(temporaryPath, contents, 'utf8')
      )
      return true
    },
    saveSkill: (archive, invocation) =>
      saveSkillExport(
        {
          showSaveDialog: (options) =>
            desktopFileInteraction().chooseSavePath(options, invocation.callerContext.clientId),
          writeFile: (path, bytes) => writeFile(path, bytes),
          publishUserFile: publish(invocation)
        },
        archive,
        translate
      )
  }
}

export function createSettingsFileCommands(
  service: Pick<
    SettingsService,
    'buildSkillExport' | 'previewCustomServerTemplateImport' | 'buildCustomServerTemplateExport'
  >,
  files: SettingsExportFiles
): {
  exportSkill(
    invocation: ApplicationInvocation<readonly [ExportSkillRequest]>
  ): Promise<ExportSkillResult>
  selectTemplate(
    invocation: ApplicationInvocation<readonly [SelectCustomServerTemplateRequest?]>
  ): Promise<ConnectorTemplateSelectionResult>
  exportTemplate(
    invocation: ApplicationInvocation<readonly [ExportCustomServerTemplateRequest]>
  ): Promise<ExportCustomServerTemplateResult>
} {
  return {
    exportSkill: async (invocation) => {
      assertCaller(invocation)
      const archive = await service.buildSkillExport(invocation.args[0].id)
      assertCaller(invocation)
      return files.saveSkill(archive, invocation)
    },
    selectTemplate: async (invocation) => {
      assertCaller(invocation)
      const request = invocation.args[0]
      const selected = request
        ? { cancelled: false as const, fileName: request.fileName, contents: request.contents }
        : await files.selectTemplate(invocation)
      assertCaller(invocation)
      if (selected.cancelled) return selected
      const preview = await service.previewCustomServerTemplateImport(selected.contents)
      assertCaller(invocation)
      return { cancelled: false, fileName: selected.fileName, preview }
    },
    exportTemplate: async (invocation) => {
      assertCaller(invocation)
      const request = invocation.args[0]
      const result = await service.buildCustomServerTemplateExport(request.id)
      const selected = connectorTemplateExportSelection(result, request.format ?? 'open-science')
      if (
        !result.preview.ready ||
        !selected.digest ||
        !selected.suggestedFileName ||
        !selected.contents
      )
        throw new Error('Connector configuration is not safe to export')
      if (selected.digest !== request.expectedDigest)
        throw new Error('Connector configuration changed after preview; review it again')
      assertCaller(invocation)
      return {
        saved: await files.saveTemplate(selected.suggestedFileName, selected.contents, invocation)
      }
    }
  }
}
export type SettingsFileCommands = ReturnType<typeof createSettingsFileCommands>
