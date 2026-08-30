import type { RemoteHandle } from './job-dispatcher'

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
): RemoteHandle | null => {
  if (!raw) return null
  try {
    const handle = JSON.parse(raw) as Partial<RemoteHandle> | null
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
