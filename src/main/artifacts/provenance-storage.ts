import { assertProjectRecordPath, getProjectRecordRoot } from '../storage/data-location-identity'
import { PENDING_DIR } from './storage-layout'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const storageKey = (...segments: string[]): string => segments.join('/')

const resolveStorageKey = (root: string, key: string): string => {
  if (!key || isAbsolute(key) || key.includes('\\')) {
    throw new Error('Invalid provenance storage key.')
  }
  const segments = key.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid provenance storage key.')
  }

  const effectiveRoot = provenanceStorageRoot(root, key)
  const candidate = resolve(effectiveRoot, ...segments)
  const relativePath = relative(resolve(effectiveRoot), candidate)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error('Invalid provenance storage key.')
  }
  return effectiveRoot === root ? candidate : assertProjectRecordPath(effectiveRoot, candidate)
}

// Logical keys remain stable when a project folder is moved or selected again.
const provenanceStorageRoot = (root: string, key: string): string => {
  const segments = key.split('/')
  const [kind, projectId, scope, artifactSubtree] = segments
  // Ownership receipts live beside project directories in the supplied evidence root.
  if (
    kind === 'execution-file-evidence' &&
    !scope &&
    /^\.project-ownership-.+\.json$/u.test(projectId)
  )
    return root
  // Durable Notebook trees travel with records. Working projections remain managed even when
  // an imported archive contains data/handoff files beneath the same logical Session prefix.
  let notebookTail = segments.slice(3)
  if (notebookTail[0] === 'frames') notebookTail = notebookTail.slice(2)
  const notebookRecord =
    kind === 'notebooks' &&
    (!notebookTail.length || notebookTail[0] === 'run.json' || notebookTail[0] === '.run-records')
  const artifactRecord = kind === 'artifacts' && artifactSubtree !== PENDING_DIR
  return projectId && (artifactRecord || kind === 'execution-file-evidence' || notebookRecord)
    ? (getProjectRecordRoot(root, projectId) ?? root)
    : root
}

const readOptionalFile = async (path: string): Promise<Buffer | undefined> =>
  readFile(path).catch((error: unknown) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return undefined
    }
    throw error
  })

export { readOptionalFile, resolveStorageKey, storageKey, provenanceStorageRoot }

// The configured root may itself use a platform alias (/var -> /private/var). Below that owned
// root, reject links at every level so a Notebook directory cannot include unrelated local data.
export const assertRegularStoragePath = async (root: string, key: string): Promise<void> => {
  resolveStorageKey(root, key)
  root = provenanceStorageRoot(root, key)
  const segments = key.split('/')
  for (let length = 1; length <= segments.length; length++) {
    const info = await lstat(join(root, ...segments.slice(0, length)))
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error('Session package source contains a link or special file.')
  }
}
