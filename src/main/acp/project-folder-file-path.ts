import { realpath } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const canonicalPath = promisify(realpath.native)

// Some ACP adapters normalize a model's filename against the stable provider cwd before asking
// the client to do I/O. Existing managed Session files retain their identity; a new normalized
// filename addresses the owning Project folder. No unrelated absolute path is rewritten.
export async function mapProjectFolderAcpPath(
  cwd: string,
  root: string,
  path: string
): Promise<string> {
  if (!isAbsolute(path) || path.split(/[\\/]/).includes('..')) return path
  const workspace = resolve(cwd)
  const target = resolve(path)
  const suffix = relative(workspace, target)
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) return path
  // Windows relative() folds case, even on directories that distinguish case on disk.
  const workspaceSpelling = resolve(target.slice(0, -suffix.length))
  if (workspaceSpelling !== workspace) {
    try {
      if ((await canonicalPath(workspaceSpelling)) !== (await canonicalPath(workspace))) return path
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
      throw error
    }
  }
  const exists = await lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    }
  )
  return exists ? path : join(root, suffix)
}
