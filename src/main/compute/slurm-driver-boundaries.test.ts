import { describe, expect, it } from 'vitest'
import type { ComputeJob } from '../../shared/compute'
import type { ComputeConnectionLease } from './connection-broker'
import {
  buildSlurmScript,
  cancelSlurmJob,
  dispatchSlurmJob,
  pollSlurmJobs,
  recoverSlurmJob
} from './slurm-driver'

const job = (command: string): Pick<ComputeJob, 'job_id' | 'command' | 'timeout_seconds'> => ({
  job_id: 'test-job',
  command,
  timeout_seconds: 3
})
const handle = {
  driver: 'slurm' as const,
  version: 1 as const,
  scheduler_job_id: '123',
  workdir: '~/.openscience/jobs/test-job',
  stdout_path: '~/.openscience/jobs/test-job/stdout',
  stderr_path: '~/.openscience/jobs/test-job/stderr'
}
const entry = {
  job: { ...job('true'), remote_workdir: handle.workdir } as ComputeJob,
  handle
}
const success = (stdout: string): Awaited<ReturnType<ComputeConnectionLease['run']>> => ({
  stdout,
  stderr: '',
  exitCode: 0,
  timedOut: false,
  truncated: false
})

describe('Slurm lifecycle boundaries', () => {
  it('adopts a receipt only after scheduler-owned name and workdir metadata match', async () => {
    const connection = {
      run: async () =>
        success(
          'receipt|123\n' +
            'expected|/home/researcher/.openscience/jobs/test-job\n' +
            'active|123|openscience-test-job|/home/researcher/.openscience/jobs/test-job\n'
        )
    } as unknown as ComputeConnectionLease

    await expect(recoverSlurmJob(entry.job, connection)).resolves.toMatchObject({
      scheduler_job_id: '123'
    })
  })

  it('rejects a tampered receipt that lacks matching scheduler ownership metadata', async () => {
    const connection = {
      run: async () =>
        success(
          'receipt|999\n' +
            'expected|/home/researcher/.openscience/jobs/test-job\n' +
            'active|999|other-job|/shared/other/job\n'
        )
    } as unknown as ComputeConnectionLease

    await expect(recoverSlurmJob(entry.job, connection)).resolves.toBeUndefined()
  })

  it('adopts an unreceipted candidate only when its exact canonical workdir matches', async () => {
    const connection = {
      run: async () =>
        success(
          'expected|/home/researcher/.openscience/jobs/test-job\n' +
            'active|123|openscience-test-job|/home/researcher/.openscience/jobs/test-job\n'
        )
    } as unknown as ComputeConnectionLease

    await expect(recoverSlurmJob(entry.job, connection)).resolves.toMatchObject({
      scheduler_job_id: '123'
    })
  })

  it('does not adopt a name-matching candidate owned by another workdir', async () => {
    const connection = {
      run: async () =>
        success(
          'expected|/home/researcher/.openscience/jobs/test-job\n' +
            'active|123|openscience-test-job|/shared/other/.openscience/jobs/test-job\n'
        )
    } as unknown as ComputeConnectionLease

    await expect(recoverSlurmJob(entry.job, connection)).resolves.toBeUndefined()
  })

  it('does not settle cancellation while the scheduler still reports running', async () => {
    const connection = {
      run: async (command: string) =>
        success(command.startsWith('squeue ') ? '123|RUNNING|None\n' : '')
    } as unknown as ComputeConnectionLease
    expect(await cancelSlurmJob(handle, connection)).toBe(false)
  })
  it('retains a user time limit and resources before the first executable line', () => {
    const script = buildSlurmScript(
      job('#SBATCH --partition=cpu\n#SBATCH --time=00:05:00\necho done'),
      handle.workdir
    )
    const lines = script.split('\n')
    const executable = lines.findIndex((line) => line.trim() && !line.trim().startsWith('#'))
    const header = lines.slice(0, executable).filter((line) => line.startsWith('#SBATCH'))
    expect(header).toContain('#SBATCH --partition=cpu')
    expect(header.filter((line) => line.startsWith('#SBATCH --time='))).toEqual([
      '#SBATCH --time=00:05:00'
    ])
    expect(script).not.toContain('#SBATCH --chdir=~')
    expect(script.indexOf('#SBATCH --partition=cpu')).toBeLessThan(script.indexOf('timeout '))
  })

  it.each([
    '--array=1-3',
    '--wrap=hostname',
    '--clusters=other',
    '--output=/tmp/out',
    '--mem=128M --output=/tmp/out',
    '--partition=cpu --array=1-4',
    '--partition=debug -A other -t 10',
    '--job-name=other'
  ])('rejects lifecycle-breaking directive %s', (directive) => {
    expect(() => buildSlurmScript(job(`#SBATCH ${directive}\necho done`), handle.workdir)).toThrow()
  })

  it('names an app-owned option and gives a usable correction', () => {
    expect(() =>
      buildSlurmScript(job('#SBATCH --time=00:05:00 --job-name=custom\necho done'), handle.workdir)
    ).toThrow(
      'Slurm directive --job-name is managed by Open-Science. Remove it; Open-Science assigns the Job name used for tracking and recovery.'
    )
  })

  it('identifies multiple resource options and explains the supported form', () => {
    expect(() =>
      buildSlurmScript(job('#SBATCH --partition=debug -A other -t 10\necho done'), handle.workdir)
    ).toThrow(
      'Slurm directive contains multiple options (--partition, -A, -t). Put each resource option on its own line using #SBATCH --option=value and long option names.'
    )
  })

  it('uses a persisted sbatch rejection to distinguish remote exit 255 from SSH failure', async () => {
    const diagnostic =
      "sbatch: option '--cpus=1' is ambiguous; possibilities: '--cpus-per-gpu' '--cpus-per-task'"
    const receipt = Buffer.from(`255\n${diagnostic}\n`, 'utf8').toString('base64')
    const connection = {
      run: async (command: string) =>
        command.includes('base64 <')
          ? success(`${receipt}\n`)
          : { ...success(''), exitCode: 255, stderr: `${diagnostic}\n` }
    } as unknown as ComputeConnectionLease

    await expect(dispatchSlurmJob(entry.job, connection, handle.workdir)).rejects.toMatchObject({
      code: 'dispatch_failed',
      message: diagnostic
    })
  })

  it('keeps an unreceipted remote exit 255 ambiguous', async () => {
    const connection = {
      run: async (command: string) =>
        command.includes('base64 <') || command.includes("printf 'expected|")
          ? success('')
          : { ...success(''), exitCode: 255, stderr: 'Connection closed' }
    } as unknown as ComputeConnectionLease

    await expect(dispatchSlurmJob(entry.job, connection, handle.workdir)).rejects.toMatchObject({
      code: 'host_unreachable'
    })
  })

  it('preserves ordinary shell continuation semantics for the user workload', () => {
    const script = buildSlurmScript(job('false; printf done'), handle.workdir)
    expect(script).toContain('false; printf done')
    expect(script).not.toContain('set -e')
    expect(script).not.toContain('pipefail')
  })

  it('keeps a missing accounting row uncertain', async () => {
    const connection = { run: async () => success('') } as unknown as ComputeConnectionLease
    expect((await pollSlurmJobs([entry], connection)).get('123')).toMatchObject({ kind: 'unknown' })
  })

  it('never treats a signal exit as a successful zero exit', async () => {
    const connection = {
      run: async (command: string) =>
        success(command.startsWith('sacct ') ? '123|COMPLETED|0:9\n' : '')
    } as unknown as ComputeConnectionLease
    const result = (await pollSlurmJobs([entry], connection)).get('123')
    expect(result?.kind).toBe('terminal')
    if (result?.kind === 'terminal') expect(result.exitCode).not.toBe(0)
  })

  it('surfaces an accounting command failure as an actionable error', async () => {
    const connection = {
      run: async (command: string) =>
        command.startsWith('sacct ')
          ? { ...success(''), exitCode: 1, stderr: 'Accounting storage is disabled' }
          : success('')
    } as unknown as ComputeConnectionLease
    await expect(pollSlurmJobs([entry], connection)).rejects.toThrow(
      /Accounting storage is disabled/
    )
  })
})
