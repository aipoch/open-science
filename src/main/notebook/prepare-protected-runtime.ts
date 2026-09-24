import { mkdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'

/** Linux bind mounts need real sources. Initialize app-owned roots before workload launch. */
export async function prepareProtectedRuntime(root: string): Promise<void> {
  for (const name of ['envs', 'approval-plans']) {
    const path = join(root, name)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Protected Runtime storage must be an ordinary directory.')
  }
}
