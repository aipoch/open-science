import type { NotebookRunRecord } from '../../../../shared/notebook'
import { isLocalPathRoot, validateLocalPath } from '../../../../shared/local-fs'

// A diagnostic is a navigation suggestion, never proof of a sandbox denial or authority to grant.
// Consume the existing runtime annotation rather than treating every EPERM as a folder failure.
export const notebookFolderAccessPath = (
  run: NotebookRunRecord,
  platform: string
): string | undefined => {
  if (
    run.status !== 'failed' &&
    !(run.status === 'completed' && typeof run.exitCode === 'number' && run.exitCode !== 0)
  )
    return undefined
  if (run.shellRuntime?.kind === 'wsl2-bash') return undefined
  const diagnostics = [
    run.text.stderr,
    run.text.traceback,
    ...run.outputs.flatMap((output) =>
      output.type === 'stream' && output.name === 'stderr'
        ? [output.text]
        : output.type === 'error'
          ? [output.message ?? '', output.traceback ?? '']
          : []
    )
  ]
  const paths = new Set<string>()
  for (const text of diagnostics) {
    for (const block of text.matchAll(
      /<sandbox_violations>\r?\n([\s\S]*?)\r?\n<\/sandbox_violations>/g
    )) {
      for (const line of block[1].split(/\r?\n/)) {
        const match =
          /^OPEN_SCIENCE_FILESYSTEM_ACCESS_BLOCKED: (.+) Filesystem access failed; native permissions, read-only mounts, or the sandbox may be responsible\./.exec(
            line
          )
        if (!match) continue
        const path = match[1]
        if (validateLocalPath(path, platform) !== undefined || isLocalPathRoot(path, platform)) {
          return undefined
        }
        paths.add(path)
      }
    }
  }
  return paths.size === 1 ? [...paths][0] : undefined
}
