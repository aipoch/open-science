import { posix, relative, sep } from 'node:path'

/** Returns a workspace-relative logical path, independent of the host filesystem separator. */
export const workspaceRelativePath = (workspaceCwd: string, path: string): string =>
  relative(workspaceCwd, path).split(sep).join(posix.sep)
