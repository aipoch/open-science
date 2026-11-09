import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ComputeJob } from '../../shared/compute'
const target = z.strictObject({
  endpoint: z.string().url(),
  sharedRoot: z.string().min(1),
  remoteRoot: z.string().min(1),
  sessionName: z.string().min(1),
  cpus: z.number().nonnegative(),
  gpus: z.number().nonnegative()
})
export type RayJobTarget = z.infer<typeof target>
const file = z.strictObject({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
const journal = z.strictObject({
  version: z.literal(1),
  jobId: z.string(),
  providerId: z.string(),
  nonce: z.uuid(),
  target,
  directory: z.strictObject({ dev: z.string(), ino: z.string() }).optional(),
  packageSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  launch: z.literal(true).optional(),
  timedOut: z.literal(true).optional(),
  published: z.array(file).optional()
})
export type RayJobJournal = z.infer<typeof journal>
export function initialRayJournal(
  jobId: string,
  providerId: string,
  binding: RayJobTarget
): string {
  const { endpoint, sharedRoot, remoteRoot, sessionName, cpus, gpus } = binding
  return JSON.stringify(
    journal.parse({
      version: 1,
      jobId,
      providerId,
      nonce: randomUUID(),
      target: { endpoint, sharedRoot, remoteRoot, sessionName, cpus, gpus }
    })
  )
}
export function readRayJournal(job: ComputeJob): RayJobJournal {
  const record = journal.parse(JSON.parse(job.remote_handle ?? 'null'))
  if (
    job.execution_mode !== 'ray_jobs' ||
    job.job_id !== record.jobId ||
    job.provider_id !== record.providerId ||
    (record.launch && (!record.directory || !record.packageSha256))
  )
    throw new Error('Invalid Ray job binding.')
  return record
}
export function withRayPublication(
  job: ComputeJob,
  files: readonly z.infer<typeof file>[]
): string {
  return JSON.stringify(journal.parse({ ...readRayJournal(job), published: files }))
}
