export type RemoteHandle = {
  driver?: 'direct_ssh'
  pid: number
  exit_code_path: string
  stdout_path: string
  stderr_path: string
  workdir: string
}

export type SlurmRemoteHandle = {
  driver: 'slurm'
  version: 1
  scheduler_job_id: string
  stdout_path: string
  stderr_path: string
  workdir: string
}

export type ComputeRemoteHandle = RemoteHandle | SlurmRemoteHandle

export const toBase64 = (content: string): string => Buffer.from(content).toString('base64')
