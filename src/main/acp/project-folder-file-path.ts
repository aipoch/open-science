import { lstat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

// Some ACP adapters normalize a model's filename against the stable provider cwd before asking
// the client to do I/O. Existing managed Session files retain their identity; a new normalized
// filename addresses the owning Project folder. No unrelated absolute path is rewritten.
export async function mapProjectFolderAcpPath(
  cwd: string,
  root: string,
  path: string
): Promise<string> {
  if (!isAbsolute(path) || path.split(/[\\/]/).includes('..')) return path
  const prefix = resolve(cwd) + sep
  const target = resolve(path)
  if (!target.startsWith(prefix)) return path
  const exists = await lstat(target).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    }
  )
  return exists ? path : join(root, target.slice(prefix.length))
}
