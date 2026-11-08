import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ComputeJob } from '../../shared/compute'

export const MODAL_CREATION_UNCONFIRMED =
  'Modal creation could not be confirmed. Check the Modal dashboard before abandoning this job; it may still be running and billed.'
const target = z.strictObject({
  environmentName: z.string().min(1),
  appName: z.string().min(1),
  appId: z.string().min(1),
  image: z.string().min(1),
  cpus: z.number().positive(),
  memoryMiB: z.number().int().positive(),
  gpu: z.string().min(1).optional()
})
export type ModalJobTarget = z.infer<typeof target>
const file = z.strictObject({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
const journal = z.strictObject({
  version: z.literal(1),
  jobId: z.string(),
  providerId: z.string(),
  target,
  nonce: z.uuid(),
  // An empty receipt means the create may have reached the service; never repeat such a POST.
  volume: z.strictObject({ id: z.string().min(1).optional() }).optional(),
  sandbox: z.strictObject({ id: z.string().min(1).optional() }).optional(),
  launchNotStarted: z.literal(true).optional(),
  published: z.array(file).optional()
})
export type ModalJobJournal = z.infer<typeof journal>
export function initialModalJournal(
  jobId: string,
  providerId: string,
  approved: ModalJobTarget
): string {
  const { environmentName, appName, appId, image, cpus, memoryMiB, gpu } = approved
  return JSON.stringify(
    journal.parse({
      version: 1,
      jobId,
      providerId,
      target: { environmentName, appName, appId, image, cpus, memoryMiB, gpu },
      nonce: randomUUID()
    })
  )
}
export function readModalJournal(job: ComputeJob): ModalJobJournal {
  const record = journal.parse(JSON.parse(job.remote_handle ?? 'null'))
  if (
    job.execution_mode !== 'modal_sandbox' ||
    record.jobId !== job.job_id ||
    record.providerId !== job.provider_id ||
    (record.sandbox && !record.volume?.id)
  )
    throw new Error('Invalid Modal job binding.')
  return record
}
// Called only when the local deadline or the helper proves Sandbox.create was never invoked.
export function withUnstartedModalLaunch(journal: ModalJobJournal): string | undefined {
  if (journal.sandbox?.id) throw new Error('Modal Sandbox already exists.')
  if (!journal.volume?.id) return undefined
  return JSON.stringify({ ...journal, sandbox: undefined, launchNotStarted: true })
}

export function withModalPublication(
  job: ComputeJob,
  files: readonly z.infer<typeof file>[]
): string {
  return JSON.stringify(journal.parse({ ...readModalJournal(job), published: files }))
}
