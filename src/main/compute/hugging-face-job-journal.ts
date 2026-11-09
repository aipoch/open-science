import { z } from 'zod'
import type { ComputeJob } from '../../shared/compute'

const target = z.strictObject({
  account: z.string().min(1),
  namespace: z.string().min(1),
  flavor: z.string().min(1),
  image: z.string().min(1),
  bucket: z.string().min(1),
  rateMicroUsdPerMinute: z.number().int().nonnegative()
})
export type HostedJobTarget = z.infer<typeof target>
const mount = z.strictObject({ bucket: z.string().min(1), prefix: z.string().min(1) })
const file = z.strictObject({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  xetHash: z.string().min(1).optional()
})
const discardedFile = file.omit({ sha256: true }).extend({ xetHash: z.string().min(1) })
const journal = z.strictObject({
  version: z.literal(1),
  jobId: z.string(),
  providerId: z.string(),
  target,
  staging: z.literal(true).optional(),
  // The mounts and launch fence are written atomically before sending the POST.
  launch: z
    .strictObject({ inputs: mount, outputs: mount, remoteId: z.string().min(1).optional() })
    .optional(),
  launchNotStarted: z.literal(true).optional(),
  published: z.array(file).optional(),
  discardedOutputs: z.array(discardedFile).optional()
})
export type HostedJobJournal = z.infer<typeof journal>
export function initialHostedJournal(
  jobId: string,
  providerId: string,
  binding: HostedJobTarget
): string {
  return JSON.stringify(journal.parse({ version: 1, jobId, providerId, target: binding }))
}
export function readHostedJournal(job: ComputeJob): HostedJobJournal {
  const result = journal.parse(JSON.parse(job.remote_handle ?? 'null'))
  if (
    job.execution_mode !== 'hugging_face_jobs' ||
    result.jobId !== job.job_id ||
    result.providerId !== job.provider_id
  )
    throw new Error('HF job binding does not belong to this execution.')
  if (
    result.launch &&
    (!result.staging ||
      result.launch.inputs.bucket !== result.target.bucket ||
      result.launch.outputs.bucket !== result.target.bucket ||
      result.launch.inputs.prefix !== 'open-science/' + job.job_id + '/inputs' ||
      result.launch.outputs.prefix !== 'open-science/' + job.job_id + '/outputs')
  )
    throw new Error('HF submission mounts do not belong to this execution.')
  return result
}
export function withHostedPublication(
  job: ComputeJob,
  files: readonly z.infer<typeof file>[],
  discardedOutputs: readonly z.infer<typeof discardedFile>[] = []
): string {
  return JSON.stringify(
    journal.parse({ ...readHostedJournal(job), published: files, discardedOutputs })
  )
}
