import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionPackageRequestSchema } from '../../shared/session-package'

export const isImportedResearchSession = async (
  dataRoot: string,
  projectId: string,
  sessionId: string
): Promise<boolean> => {
  sessionPackageRequestSchema.parse({ projectId, sessionId })
  try {
    await lstat(join(dataRoot, 'artifacts', projectId, sessionId, '.session-package'))
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}

export const assertResearchSessionWritable = async (
  dataRoot: string,
  projectId: string,
  sessionId: string
): Promise<void> => {
  if (await isImportedResearchSession(dataRoot, projectId, sessionId))
    throw new Error('Imported research history is read-only.')
}

// The private import directory is a visibility fence, not a Session lifecycle status. Removing it
// after durable file publication and the SQLite commit makes the imported catalog visible.
export const isSessionPackagePending = async (
  configRoot: string,
  projectId: string
): Promise<boolean> => {
  const match = /^import-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/.exec(projectId)
  if (!match) return false
  try {
    await lstat(join(configRoot, 'session-package-imports', match[1]))
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}
