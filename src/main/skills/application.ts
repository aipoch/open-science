import { randomUUID } from 'node:crypto'
import type { ApplicationModule } from '../application-runtime'
import type { ManagedFileVersionService } from '../managed-file-versions/service'
import type { UploadRepository } from '../uploads/repository'
import type {
  ConversationSkillImportApprovalRequest,
  ScannedSkillView,
  ImportSkillResult
} from '../../shared/settings'
import {
  ConversationSkillImporter,
  SkillImportApprovalBroker,
  type ConversationSkillImporterOptions
} from './conversation-import'

export type SkillApplicationDeps = {
  settings: {
    previewSkillArchive: ConversationSkillImporterOptions['previewBundle']
    importSkillArchiveBatch: ConversationSkillImporterOptions['importBundle']
    scanRepoSkills: (
      request: { repo: string },
      signal?: AbortSignal
    ) => Promise<{ skills: ScannedSkillView[] }>
    importSkill: (request: { url: string }, signal?: AbortSignal) => Promise<ImportSkillResult>
  }
  uploads: Pick<UploadRepository, 'resolveManagedUpload' | 'resolveSessionUpload'>
  managedFileVersions?: Pick<ManagedFileVersionService, 'openVersion'>
  broadcastSkillImportApproval: (request: ConversationSkillImportApprovalRequest) => void
  onSkillImportSettled: (id: string) => void
  onSkillImportLifecycleSettled: (id: string, state: 'resolved' | 'expired' | 'cancelled') => void
  onSkillsChanged?: () => void
  skillImportApprovals?: SkillImportApprovalBroker
}
export const createSkillApplicationModule = (
  deps: SkillApplicationDeps
): ApplicationModule<{
  skillImporter: ConversationSkillImporter
  skillImportApprovals: SkillImportApprovalBroker
}> => {
  const skillImportApprovals =
    deps.skillImportApprovals ??
    new SkillImportApprovalBroker({
      generateId: () => randomUUID(),
      broadcast: deps.broadcastSkillImportApproval,
      onSettled: deps.onSkillImportSettled,
      onLifecycleSettled: deps.onSkillImportLifecycleSettled
    })
  const skillImporter = new ConversationSkillImporter({
    uploads: deps.uploads,
    managedFileVersions: deps.managedFileVersions,
    createCancellationGuard: (sessionId, turnToken, attachmentUri) =>
      skillImportApprovals.createCancellationGuard(sessionId, turnToken, attachmentUri),
    createSessionCancellationGuard: (sessionId) =>
      skillImportApprovals.createSessionCancellationGuard(sessionId),
    previewBundle: (bundle) => deps.settings.previewSkillArchive(bundle),
    importBundle: (bundle, items) => deps.settings.importSkillArchiveBatch(bundle, items),
    scanGitHub: async (url, signal) =>
      (await deps.settings.scanRepoSkills({ repo: url }, signal)).skills,
    importGitHub: (url, signal) => deps.settings.importSkill({ url }, signal),
    requestApproval: (request, cancellation) => skillImportApprovals.request(request, cancellation),
    onSkillsChanged: deps.onSkillsChanged
  })

  return {
    name: 'skill-application',
    capability: { skillImporter, skillImportApprovals },
    dispose: async () => {
      skillImportApprovals.cancelAll()
    }
  }
}
