import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionPackageRequestSchema } from '../../shared/session-package'

const publicationBrand = Symbol('session-package-publication')
export type SessionPackagePublication = Readonly<{ [publicationBrand]: true }>
type PublicationIdentity = Readonly<{ projectId: string; sessionId: string; importId: string }>
const publications = new WeakMap<SessionPackagePublication, PublicationIdentity>()

// Main only: the package owner has checked the committed native witness and retained receipt.
// This lease allows its exact durable Session to be adopted while the public catalog stays fenced.
export async function withSessionPackagePublication<Result>(
  identity: PublicationIdentity,
  work: (publication: SessionPackagePublication) => Promise<Result>
): Promise<Result> {
  sessionPackageRequestSchema.parse({
    projectId: identity.projectId,
    sessionId: identity.sessionId
  })
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(identity.importId))
    throw new Error('Invalid Session package publication identity.')
  const publication: SessionPackagePublication = Object.freeze({ [publicationBrand]: true })
  publications.set(
    publication,
    Object.freeze({
      projectId: identity.projectId,
      sessionId: identity.sessionId,
      importId: identity.importId
    })
  )
  try {
    return await work(publication)
  } finally {
    publications.delete(publication)
  }
}

export function resolveSessionPackagePublication(
  publication: SessionPackagePublication,
  identity: { projectId: string; sessionId: string }
): PublicationIdentity {
  const granted = publications.get(publication)
  if (
    !granted ||
    granted.projectId !== identity.projectId ||
    granted.sessionId !== identity.sessionId
  )
    throw new Error(
      'Session package publication authority is unavailable or belongs to another Session.'
    )
  return granted
}

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
