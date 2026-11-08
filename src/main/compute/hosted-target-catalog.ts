import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import type { HostedTarget, HostedTargetConfig } from '../../shared/compute'

const text = z.string().trim().min(1).max(255)
const image = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:_/@-]*$/)
const targetFields = z.strictObject({
  displayName: text,
  namespace: z
    .string()
    .max(96)
    .regex(/^[\w-]+$/),
  image,
  flavor: z
    .string()
    .max(96)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/),
  bucket: z
    .string()
    .max(256)
    .regex(/^[\w-]+\/[\w.-]+$/)
    .refine((value) => !['.', '..'].includes(value.split('/')[1])),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(7 * 24 * 3600)
})
const hasPayerBucket = (entry: HostedTargetConfig): boolean =>
  entry.bucket.split('/')[0] === entry.namespace
const bucketError = {
  path: ['bucket'],
  message: 'The private Bucket must belong to the billing namespace.'
}
export const hostedTargetConfigSchema = targetFields.refine(hasPayerBucket, bucketError)
const catalog = z.strictObject({
  version: z.literal(1),
  targets: z
    .array(targetFields.extend({ id: z.uuidv4() }).refine(hasPayerBucket, bucketError))
    .max(256)
})
type Entry = z.infer<typeof catalog>['targets'][number]
const project = (entry: Entry): HostedTarget => ({
  ...entry,
  providerId: 'hf-jobs:' + entry.id
})

export class HostedTargetCatalog {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly configRoot: () => string) {}
  private async entries(path: string): Promise<Entry[]> {
    const result = await readDurableJsonFile(
      path,
      (data) => catalog.parse(JSON.parse(data)),
      {},
      { maxBytes: 4 * 1024 * 1024 }
    )
    return result.status === 'found' ? result.value.targets : []
  }
  async list(): Promise<HostedTarget[]> {
    return (await this.entries(join(this.configRoot(), 'compute-hosted-targets.json'))).map(project)
  }
  private mutate<T>(operation: (entries: Entry[]) => T): Promise<T> {
    const run = this.tail.then(async () => {
      const path = join(this.configRoot(), 'compute-hosted-targets.json')
      const entries = await this.entries(path)
      const result = operation(entries)
      await writeDurableJsonFile(
        path,
        JSON.stringify(catalog.parse({ version: 1, targets: entries }))
      )
      return result
    })
    this.tail = run.catch(() => undefined)
    return run
  }
  create(request: HostedTargetConfig): Promise<HostedTarget> {
    const entry = { ...hostedTargetConfigSchema.parse(request), id: randomUUID() }
    return this.mutate((entries) => {
      entries.push(entry)
      return project(entry)
    })
  }
  update(providerId: string, request: unknown): Promise<void> {
    const config = hostedTargetConfigSchema.parse(request)
    return this.mutate((entries) => {
      const index = entries.findIndex((entry) => project(entry).providerId === providerId)
      if (index < 0) throw new Error('Compute target no longer exists.')
      entries[index] = { ...config, id: entries[index].id }
    })
  }
  remove(providerId: string): Promise<void> {
    return this.mutate((entries) => {
      const index = entries.findIndex((entry) => project(entry).providerId === providerId)
      if (index >= 0) entries.splice(index, 1)
    })
  }
}
