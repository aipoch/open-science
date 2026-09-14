import { join } from 'node:path'
import { decodeSessionFile, type PersistedChatSession } from '../../shared/session-persistence'
import { hasCurrentRunningDelegatedAttempt } from '../../shared/delegated-work-projection'
import type { SessionPackageManifest, SessionPackagePreview } from '../../shared/session-package'
import { readPackageArchive, readPackageJson } from './archive'
import { parseNativeRecords } from './native-snapshot'
import { validatePackageRecords } from './validation'

export const assertSettledHistory = (session: PersistedChatSession): void => {
  const context = session.runtimeContext
  if (
    session.status !== 'idle' ||
    hasCurrentRunningDelegatedAttempt(session) ||
    context?.sideChatRelays?.length ||
    context?.delegatedWork?.messageCommands?.some(
      (command) =>
        command.receipt.status === 'queued' ||
        (command.receipt.status === 'uncertain' && command.receipt.resolution === 'pending')
    ) ||
    context?.delegatedWork?.questionRequests?.some((question) => question.status === 'pending') ||
    (context?.plan?.delivery && ['queued', 'delivering'].includes(context.plan.delivery.state))
  )
    throw new Error('Wait for the Session to finish before exporting it.')
}

export const readSession = async (directory: string): Promise<PersistedChatSession> => {
  const decoded = decodeSessionFile(await readPackageJson(join(directory, 'session.json')), {
    preserveRuntimeState: true,
    preserveLegacyUploadPaths: true
  })
  if (decoded.status !== 'ok')
    throw new Error('Session package contains an invalid or unsupported Session.')
  assertSettledHistory(decoded.session)
  return decoded.session
}
export const preview = (
  manifest: SessionPackageManifest,
  session: PersistedChatSession
): SessionPackagePreview => ({
  title: manifest.source.title,
  projectName: manifest.source.projectName,
  branchCount: session.conversationGraph?.branches.length ?? 1,
  messageCount: session.conversationGraph?.messages.length ?? session.messages.length,
  fileCount: manifest.inventory.filter(
    (entry) => entry.kind === 'file' || entry.kind === 'notebook'
  ).length,
  totalBytes: manifest.inventory.reduce((total, entry) => total + entry.sizeBytes, 0),
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
  temporaryRoot?: string
): Promise<SessionPackagePreview> => {
  const manifest = await readPackageArchive(path, directory, signal)
  const session = await readSession(directory)
  if (manifest.source.projectId !== session.projectId || manifest.source.sessionId !== session.id)
    throw new Error('Session package source identity mismatch.')
  await validatePackageRecords(
    directory,
    manifest,
    parseNativeRecords(await readPackageJson(join(directory, 'records.json'))),
    signal,
    manifest.source,
    temporaryRoot
  )
  return preview(manifest, session)
}
