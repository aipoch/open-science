import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readDurableJsonFile, writeDurableJsonFile } from '@aipoch/durable-files'
import { z } from 'zod'
import type { ModalTarget, ModalTargetConfig } from '../../shared/compute'

const text = z.string().trim().min(1).max(255)
const image = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9.:_/@-]*$/)
const name = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\w.-]+$/)
export const modalTargetConfigSchema = z.strictObject({
  displayName: text,
  appName: name,
  environmentName: name,
  image,
  cpus: z.number().positive(),
  memoryMiB: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  gpu: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[\w.-]+(?::[1-9]\d*)?$/)
    .optional()
})
const catalog = z.strictObject({
  version: z.literal(1),
  targets: z.array(modalTargetConfigSchema.extend({ id: z.uuidv4() })).max(256)
})
type Entry = z.infer<typeof catalog>['targets'][number]
const project = (entry: Entry): ModalTarget => ({
  ...entry,
  providerId: 'modal:' + entry.id
})

export class ModalTargetCatalog {
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
  async list(): Promise<ModalTarget[]> {
    return (await this.entries(join(this.configRoot(), 'compute-modal-targets.json'))).map(project)
  }
  private mutate<T>(operation: (entries: Entry[]) => T): Promise<T> {
    const run = this.tail.then(async () => {
      const path = join(this.configRoot(), 'compute-modal-targets.json')
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
  create(request: ModalTargetConfig): Promise<ModalTarget> {
    const entry = { ...modalTargetConfigSchema.parse(request), id: randomUUID() }
    return this.mutate((entries) => {
      entries.push(entry)
      return project(entry)
    })
  }
  update(providerId: string, request: unknown): Promise<void> {
    const config = modalTargetConfigSchema.parse(request)
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
