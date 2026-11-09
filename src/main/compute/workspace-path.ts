import { lstat, realpath, readdir } from 'node:fs/promises'
import { createComputeOutputPreviewKey, type ComputeJob } from '../../shared/compute'
import { join, posix, relative, sep } from 'node:path'

import { readJobArchiveReceipt } from './job-archive-receipt'
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

export async function listArchivedJobFiles(
  job: ComputeJob,
  storageRoot: string
): Promise<{ featured_files: string[]; hidden_files: string[] }> {
  const result = { featured_files: [] as string[], hidden_files: [] as string[] }
  if (
    !['success', 'failed', 'timeout'].includes(job.status) ||
    job.harvested_at == null ||
    job.harvest_error
  )
    return result
  const scope = { projectId: job.project_id, sessionId: job.session_id, jobId: job.job_id }
  try {
    createComputeOutputPreviewKey({ ...scope, path: 'hpc/' + scope.jobId + '/featured/file' })
  } catch {
    return result
  }
  const root = await realpath(storageRoot).catch(() => undefined)
  if (!root) return result
  const workspace = getNotebookSessionRoot(root, scope.projectId, scope.sessionId)
  const receipt = await readJobArchiveReceipt(
    root,
    scope,
    job.producer_run_id,
    job.file_evidence
  ).catch(() => new Map<string, { sizeBytes?: number }>())
  if (receipt) {
    for (const [path, entry] of receipt) {
      const full = join(workspace, ...path.split('/'))
      if ((await realpath(full).catch(() => null)) !== full) continue
      const st = await lstat(full).catch(() => null)
      if (
        st?.isFile() &&
        st.nlink === 1 &&
        (entry.sizeBytes === undefined || entry.sizeBytes === st.size)
      ) {
        result[path.split('/')[2] === 'featured' ? 'featured_files' : 'hidden_files'].push(path)
      }
    }
    result.featured_files.sort()
    result.hidden_files.sort()
    return result
  }
  const scan = async (dir: string, dest: string[]): Promise<void> => {
    if ((await realpath(dir).catch(() => null)) !== dir) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await scan(full, dest)
      else if (entry.isFile()) {
        const path = workspaceRelativePath(workspace, full)
        try {
          createComputeOutputPreviewKey({ ...scope, path })
        } catch {
          continue
        }
        const st = await lstat(full).catch(() => null)
        if (st?.isFile() && st.nlink === 1) dest.push(path)
      }
    }
  }
  for (const kind of ['featured', 'hidden'] as const) {
    await scan(join(workspace, 'hpc', scope.jobId, kind), result[`${kind}_files`])
    result[`${kind}_files`].sort()
  }
  return result
}
