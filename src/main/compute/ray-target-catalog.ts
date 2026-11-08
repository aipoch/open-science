import { randomUUID } from 'node:crypto'
import { isAbsolute, join, posix } from 'node:path'
import { resolveRayJobsEndpoint } from '@aipoch/compute/node'
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import type { RayTarget, RayTargetConfig } from '../../shared/compute'

const text = z.string().trim().min(1).max(255)
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !Array.from(path).some((c) => c.charCodeAt(0) < 32))
const endpoint = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    try {
      return resolveRayJobsEndpoint(value)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid Ray Dashboard endpoint.' })
      return z.NEVER
    }
  })
export const rayTargetConfigSchema = z.strictObject({
  displayName: text,
  endpoint,
  sharedRoot: absolutePath.refine(isAbsolute, 'The local shared directory must be absolute.'),
  remoteRoot: absolutePath.refine(
    (path) => posix.isAbsolute(path) && !path.split('/').includes('..'),
    'The driver directory must be an absolute POSIX path.'
  ),
  cpus: z.number().nonnegative(),
  gpus: z.number().nonnegative()
})
const catalog = z.strictObject({
  version: z.literal(1),
  targets: z.array(rayTargetConfigSchema.extend({ id: z.uuidv4() })).max(256)
})
type Entry = z.infer<typeof catalog>['targets'][number]
const project = (entry: Entry): RayTarget => ({
  ...entry,
  providerId: 'ray:' + entry.id
})

export class RayTargetCatalog {
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
  async list(): Promise<RayTarget[]> {
    return (await this.entries(join(this.configRoot(), 'compute-ray-targets.json'))).map(project)
  }
  private mutate<T>(operation: (entries: Entry[]) => T): Promise<T> {
    const run = this.tail.then(async () => {
      const path = join(this.configRoot(), 'compute-ray-targets.json')
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
  create(request: RayTargetConfig): Promise<RayTarget> {
    const entry = { ...rayTargetConfigSchema.parse(request), id: randomUUID() }
    return this.mutate((entries) => {
      entries.push(entry)
      return project(entry)
    })
  }
  update(providerId: string, request: unknown): Promise<void> {
    const config = rayTargetConfigSchema.parse(request)
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
