import { SessionExportBlockedError, type SessionExportBlocker } from '../archive/availability-error'
import { validateResearchFilms } from './research-films'
import { validatePackageLiteratureSession } from './literature'
import { join } from 'node:path'
import { decodeSessionFile, type PersistedChatSession } from '../../shared/session-persistence'
import { hasCurrentRunningDelegatedAttempt } from '../../shared/delegated-work-projection'
import type {
  PackageProgress,
  SessionPackageManifest,
  SessionPackagePreview
} from '../../shared/session-package'
import type { PackageWebOmission } from '../../shared/session-package-web'
import { readPackageArchive, readPackageJson } from './archive'
import { parseNativeRecords } from './native-snapshot'
import { validatePackageRecords } from './validation'

const unsettledHistory = (session: PersistedChatSession): SessionExportBlocker | undefined => {
  const context = session.runtimeContext
  if (context?.permission?.state === 'pending' || session.status === 'waiting-permission')
    return 'permission'
  if (context?.plan?.approval === 'pending' || session.status === 'waiting-plan-approval')
    return 'plan'
  if (
    session.status === 'waiting-for-user' ||
    context?.delegatedWork?.questionRequests?.some((question) => question.status === 'pending')
  )
    return 'question'
  if (hasCurrentRunningDelegatedAttempt({ runtimeContext: context })) return 'delegated'
  if (session.activeRun || session.status === 'running') return 'agent'
  if (
    session.status.startsWith('waiting-') ||
    context?.delegatedWork?.messageCommands?.some(
      (command) =>
        command.receipt.status === 'queued' ||
        (command.receipt.status === 'uncertain' && command.receipt.resolution === 'pending')
    ) ||
    (context?.plan?.delivery && ['queued', 'delivering'].includes(context.plan.delivery.state))
  )
    return 'pending'
  return undefined
}

export const assertSettledHistory = (session: PersistedChatSession): void => {
  const reason = unsettledHistory(session)
  if (reason) throw new SessionExportBlockedError(reason)
}

export const readSession = async (directory: string): Promise<PersistedChatSession> => {
  const decoded = decodeSessionFile(await readPackageJson(join(directory, 'session.json')), {
    preserveRuntimeState: true,
    preserveLegacyUploadPaths: true
  })
  if (decoded.status !== 'ok')
    throw new Error('Session package contains an invalid or unsupported Session.')
  if (unsettledHistory(decoded.session))
    throw new Error('Wait for the Session to finish before exporting it.')
  return decoded.session
}
export const preview = (
  manifest: SessionPackageManifest,
  session: PersistedChatSession,
  webOmissions?: PackageWebOmission[]
): SessionPackagePreview => ({
  title: manifest.source.title,
  projectName: manifest.source.projectName,
  branchCount: session.conversationGraph?.branches.length ?? 1,
  messageCount: session.conversationGraph?.messages.length ?? session.messages.length,
  fileCount: manifest.inventory.filter(
    (entry) => entry.kind === 'file' || entry.kind === 'notebook'
  ).length,
  totalBytes: manifest.inventory.reduce((total, entry) => total + entry.sizeBytes, 0),
  ...(webOmissions?.length ? { webOmissions } : {}),
  omissions: [
    ...manifest.omissions,
    ...manifest.excludedFiles.map((file) => ({
      kind: 'excluded' as const,
      description: file.filename
    }))
  ]
})

export const inspectSessionPackage = async (
  path: string,
  directory: string,
  signal: AbortSignal,
  temporaryRoot?: string,
  onProgress?: (progress: PackageProgress) => void
): Promise<SessionPackagePreview> => {
  const manifest = await readPackageArchive(path, directory, signal, onProgress)
  onProgress?.({ phase: 'validating', importStage: 'prepare-preview' })
  const session = await readSession(directory)
  if (manifest.source.projectId !== session.projectId || manifest.source.sessionId !== session.id)
    throw new Error('Session package source identity mismatch.')
  const records = parseNativeRecords(await readPackageJson(join(directory, 'records.json')))
  validateResearchFilms(records, manifest, session)
  validatePackageLiteratureSession(records, session)
  await validatePackageRecords(
    directory,
    manifest,
    records,
    signal,
    manifest.source,
    temporaryRoot,
    onProgress
  )
  onProgress?.({ phase: 'validating', importStage: 'validate-preview', stageProgress: 1 })
  return preview(manifest, session, records.webEvidence?.omissions)
}
