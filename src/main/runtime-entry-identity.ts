import { realpathSync } from 'node:fs'
import { resolve, win32 } from 'node:path'

export function normalizeRuntimeEntry(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    canonical = platform === 'win32' ? win32.resolve(path) : resolve(path)
  }
  return platform === 'win32' ? canonical.replaceAll('\\', '/').toLowerCase() : canonical
}
