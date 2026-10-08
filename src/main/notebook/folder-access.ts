import { isLocalPathRoot, validateLocalPath } from '../../shared/local-fs'

const ACCESS_BLOCK_PATTERN =
  /^OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED:\s*(.+?)\s+Filesystem access failed;/gm

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// Read only complete annotations in the execution contract's stderr, never arbitrary result data.
// Diagnostics remain untrusted navigation suggestions, not proof of a sandbox denial or authority
// to grant access. The user must confirm the folder and mode in the normal grant dialog.
export const notebookFolderAccessPath = (
  result: unknown,
  platform: NodeJS.Platform = process.platform
): string | undefined => {
  const outer = record(result)
  if (!outer) return undefined
  const run = record(outer.run) ?? outer
  if (run.exitCode === 0 || (typeof run.status === 'string' && run.status !== 'failed'))
    return undefined
  const stderr = record(run.text)?.stderr ?? run.stderr
  if (typeof stderr !== 'string') return undefined
  const paths = new Set<string>()
  for (const block of stderr.matchAll(
    /^<sandbox_violations>\r?\n([\s\S]*?)\r?\n<\/sandbox_violations>\s*$/gm
  )) {
    for (const match of block[1].matchAll(ACCESS_BLOCK_PATTERN)) {
      const path = match[1]?.trim()
      if (
        !path ||
        validateLocalPath(path, platform) !== undefined ||
        isLocalPathRoot(path, platform)
      )
        return undefined
      paths.add(path)
    }
  }
  return paths.size === 1 ? [...paths][0] : undefined
}
