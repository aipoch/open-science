import { join, posix, relative, sep } from 'node:path'

import { getNotebookSessionRoot } from '../notebook/repository'

/** Returns the validated local output directory inside a Session workspace for one Compute Job. */
export const getJobHarvestDir = (
  storageRoot: string,
  project: string,
  sessionId: string,
  jobId: string
): string => join(getNotebookSessionRoot(storageRoot, project, sessionId), 'hpc', jobId)

/** Returns a workspace-relative logical path, independent of the host filesystem separator. */
export const workspaceRelativePath = (workspaceCwd: string, path: string): string =>
  relative(workspaceCwd, path).split(sep).join(posix.sep)
