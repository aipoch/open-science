import type { ComputeRemoteHandle, RemoteHandle } from './remote-job-contract'

export const parseRemoteJobWorkdir = (
  jobId: string,
  raw: string | undefined,
  fallback?: string
): string | null => {
  const workdir = raw ?? fallback
  const hasTraversal = workdir?.split('/').some((part) => part === '.' || part === '..')
  if (
    !workdir ||
    !/^[A-Za-z0-9_-]+$/.test(jobId) ||
    /[\0\r\n]/.test(workdir) ||
    hasTraversal ||
    !workdir.endsWith(`/.openscience/jobs/${jobId}`)
  ) {
    return null
  }
  return workdir
}

// Validates the complete persisted handle shape against the separately durable workdir. Polling and
// termination never trust paths or process ids supplied only by a damaged JSON projection.
export const parseRemoteJobHandle = (
  raw: string | undefined,
  expectedWorkdir: string | undefined
): ComputeRemoteHandle | null => {
  if (!raw) return null
  try {
    const handle = JSON.parse(raw) as Partial<RemoteHandle> | null
    if (
      handle &&
      typeof handle === 'object' &&
      (handle as Record<string, unknown>).driver === 'slurm'
    ) {
      const slurm = handle as Record<string, unknown>
      if (
        slurm.version !== 1 ||
        typeof slurm.scheduler_job_id !== 'string' ||
        !/^\d+(?:_[0-9]+)?$/.test(slurm.scheduler_job_id) ||
        typeof expectedWorkdir !== 'string' ||
        slurm.workdir !== expectedWorkdir ||
        slurm.stdout_path !== `${expectedWorkdir}/stdout` ||
        slurm.stderr_path !== `${expectedWorkdir}/stderr`
      ) {
        return null
      }
      return handle as ComputeRemoteHandle
    }
    if (
      !handle ||
      typeof handle !== 'object' ||
      !Number.isSafeInteger(handle.pid) ||
      (handle.pid ?? 0) <= 1 ||
      typeof expectedWorkdir !== 'string' ||
      expectedWorkdir.length === 0 ||
      handle.workdir !== expectedWorkdir ||
      handle.exit_code_path !== `${expectedWorkdir}/exit_code` ||
      handle.stdout_path !== `${expectedWorkdir}/stdout` ||
      handle.stderr_path !== `${expectedWorkdir}/stderr`
    ) {
      return null
    }
    return handle as RemoteHandle
  } catch {
    return null
  }
}

export const parseSlurmSchedulerJobId = (
  raw: string | undefined,
  expectedWorkdir: string | undefined
): string | undefined => {
  const handle = parseRemoteJobHandle(raw, expectedWorkdir)
  return handle?.driver === 'slurm' ? handle.scheduler_job_id : undefined
}
