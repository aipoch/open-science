import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import {
  literatureJobSchema,
  literatureJobRowSchema,
  type LiteratureJob,
  type LiteratureJobRow
} from '../../shared/literature-jobs'
import {
  readDurableJsonFile,
  recoverDurableJsonDirectory,
  writeDurableJsonFile,
  DurableJsonRecoveryBarrierError
} from '../storage/durable-json-file'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const controlSchema = literatureJobRowSchema
  .pick({ id: true, status: true, checked: true, candidateId: true })
  .extend({ payload: hash.optional() })
  .strict()
const headerSchema = literatureJobSchema
  .omit({ rows: true })
  .extend({
    version: z.literal(3),
    epoch: z.string().uuid(),
    rows: z.array(controlSchema).min(1).max(1000)
  })
  .strict()
const deltaSchema = z
  .object({ updatedAt: z.number().int().nonnegative(), row: controlSchema })
  .strict()
const payloadSchema = literatureJobRowSchema.omit({
  id: true,
  status: true,
  checked: true,
  candidateId: true
})
const indexSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), jobs: z.array(literatureJobSchema).max(50) }).strict(),
  z.object({ version: z.literal(2), jobIds: z.array(z.string().uuid()).max(50) }).strict(),
  z.object({ version: z.literal(3), jobIds: z.array(z.string().uuid()).max(50) }).strict()
])
type Control = z.infer<typeof controlSchema>
type Record = { epoch: string; rows: Control[] }
const missing = (): never => {
  throw new DurableJsonRecoveryBarrierError('Literature task checkpoint is missing or invalid.')
}

// A command atomically publishes a small base snapshot and a new row-checkpoint epoch.
// The worker replaces one row checkpoint at a time inside that epoch. Large immutable payloads
// are separate, so reading task summaries never loads abstracts or metadata previews.
export class LiteratureBatchJobJournal {
  private records = new Map<string, Record>()
  private hydrated = new WeakSet<LiteratureJobRow>()
  constructor(private readonly path: string) {}

  private directory(id: string): string {
    return join(`${this.path}.d`, z.string().uuid().parse(id))
  }
  private headerPath(id: string): string {
    return join(this.directory(id), 'task.json')
  }
  private payloadPath(id: string, digest: string): string {
    return join(this.directory(id), 'payloads', `${hash.parse(digest)}.json`)
  }
  private async required<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const result = await readDurableJsonFile(
      path,
      (text) => schema.parse(JSON.parse(text)),
      {},
      { maxBytes: 128 * 1024 * 1024 }
    )
    return result.status === 'found' ? result.value : missing()
  }
  async load(): Promise<LiteratureJob[]> {
    const stored = await readDurableJsonFile(
      this.path,
      (text) => {
        const value = JSON.parse(text)
        if (![1, 2, 3].includes(value?.version))
          throw new DurableJsonRecoveryBarrierError('Unsupported Literature job journal version.')
        return indexSchema.parse(value)
      },
      {},
      { maxBytes: 128 * 1024 * 1024 }
    )
    if (stored.status === 'missing') return []
    if (stored.value.version !== 3) {
      const jobs =
        stored.value.version === 1
          ? stored.value.jobs
          : await Promise.all(
              stored.value.jobIds.map(async (id) => {
                const job = await this.required(
                  join(`${this.path}.d`, `${id}.json`),
                  literatureJobSchema
                )
                if (job.id !== id) missing()
                return job
              })
            )
      // Legacy data remains authoritative until every new task snapshot and the v3 index commit.
      for (const job of jobs) await this.save(job)
      await this.saveIndex(jobs)
      if (stored.value.version === 2) {
        for (const job of jobs)
          await rm(join(`${this.path}.d`, `${job.id}.json`), { force: true }).catch(() => undefined)
      }
      return jobs
    }
    return Promise.all(
      stored.value.jobIds.map(async (id) => {
        const header = await this.required(this.headerPath(id), headerSchema)
        if (header.id !== id) missing()
        const { epoch, rows } = header
        const fields = literatureJobSchema.omit({ rows: true }).strip().parse(header)
        let updatedAt = fields.updatedAt
        const directory = join(this.directory(id), epoch)
        await recoverDurableJsonDirectory(
          directory,
          (path, contents) => {
            if (!/^(0|[1-9]\d*)\.json$/.test(basename(path))) missing()
            return deltaSchema.parse(JSON.parse(contents))
          },
          {},
          { maxBytes: 1024 * 1024 }
        )
        const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        })
        // Ignore durable writer temporary/backup files; only exact row indices are authoritative.
        for (const name of files.filter((name) => /^(0|[1-9]\d*)\.json$/.test(name))) {
          const index = Number(name.slice(0, -5))
          if (index >= rows.length) missing()
          const delta = await this.required(join(directory, name), deltaSchema)
          if (delta.row.id !== rows[index].id) missing()
          rows[index] = delta.row
          updatedAt = Math.max(updatedAt, delta.updatedAt)
        }
        this.records.set(id, { epoch, rows })
        return {
          ...fields,
          updatedAt,
          rows: rows.map((row) => controlSchema.omit({ payload: true }).strip().parse(row))
        }
      })
    )
  }
  async hydrate(job: LiteratureJob, rows = job.rows): Promise<void> {
    const record = this.records.get(job.id)
    for (const row of rows) {
      if (this.hydrated.has(row)) continue
      const digest = record?.rows.find((control) => control.id === row.id)?.payload
      if (digest) {
        const payload = await this.required(this.payloadPath(job.id, digest), payloadSchema)
        Object.assign(row, payload)
      }
      this.hydrated.add(row)
    }
  }
  async readRow(job: LiteratureJob, row: LiteratureJobRow): Promise<LiteratureJobRow> {
    const copy = { ...row }
    if (!this.hydrated.has(row)) await this.hydrate(job, [copy])
    return copy
  }
  controlSnapshot(job: LiteratureJob): LiteratureJob {
    const { rows, ...fields } = job
    return {
      ...structuredClone(fields),
      rows: rows.map(({ id, status, checked, candidateId }) => ({
        id,
        status,
        checked,
        candidateId
      }))
    }
  }
  release(row: LiteratureJobRow): void {
    delete row.item
    delete row.metadata
    delete row.candidates
    delete row.message
    delete row.notices
    this.hydrated.delete(row)
  }
  private async control(
    jobId: string,
    row: LiteratureJobRow,
    previous?: Control,
    payloadChanged = true
  ): Promise<Control> {
    const { id, status, checked, candidateId, ...payload } = row
    let digest = previous?.payload
    if (payloadChanged) {
      const contents = JSON.stringify(payload)
      digest = contents === '{}' ? undefined : createHash('sha256').update(contents).digest('hex')
      if (digest && digest !== previous?.payload) {
        await mkdir(join(this.directory(jobId), 'payloads'), { recursive: true })
        await writeDurableJsonFile(this.payloadPath(jobId, digest), contents)
      }
    }
    return { id, status, checked, candidateId, payload: digest }
  }
  async save(job: LiteratureJob, payloadChanged = true, resetReview = false): Promise<void> {
    const previous = this.records.get(job.id)
    const rows: Control[] = []
    for (let index = 0; index < job.rows.length; index++) {
      let row = job.rows[index]
      const reset = resetReview && row.status !== 'done'
      if (reset) {
        // Retry keeps the item snapshot but discards the previous review. Read and rewrite
        // one immutable payload at a time; unchanged completed rows keep their digest.
        const { item } = await this.readRow(job, row)
        row = {
          ...row,
          item,
          metadata: undefined,
          candidates: undefined,
          message: undefined,
          notices: undefined
        }
      }
      rows.push(await this.control(job.id, row, previous?.rows[index], reset || payloadChanged))
    }
    const epoch = randomUUID()
    await mkdir(this.directory(job.id), { recursive: true })
    await writeDurableJsonFile(
      this.headerPath(job.id),
      JSON.stringify({ ...job, version: 3, epoch, rows })
    )
    this.records.set(job.id, { epoch, rows })
    await this.prunePayloads(job.id, rows).catch(() => undefined)
    // The new header is the commit point. Cleanup cannot turn a successful command into failure.
    if (previous)
      await rm(join(this.directory(job.id), previous.epoch), {
        recursive: true,
        force: true
      }).catch(() => undefined)
  }
  private async prunePayloads(id: string, rows: Control[]): Promise<void> {
    const retained = new Set(rows.flatMap((row) => (row.payload ? [`${row.payload}.json`] : [])))
    const directory = join(this.directory(id), 'payloads')
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const name of names) {
      if (/^[a-f0-9]{64}\.json$/.test(name) && !retained.has(name))
        await rm(join(directory, name), { force: true })
    }
  }
  async saveRow(job: LiteratureJob, row: LiteratureJobRow): Promise<void> {
    const record = this.records.get(job.id) ?? missing()
    const index = job.rows.indexOf(row)
    if (index < 0) missing()
    const control = await this.control(job.id, row, record.rows[index])
    const directory = join(this.directory(job.id), record.epoch)
    await mkdir(directory, { recursive: true })
    await writeDurableJsonFile(
      join(directory, `${index}.json`),
      JSON.stringify({ updatedAt: job.updatedAt, row: control })
    )
    record.rows[index] = control
  }
  saveIndex(jobs: LiteratureJob[]): Promise<void> {
    return writeDurableJsonFile(
      this.path,
      JSON.stringify({ version: 3, jobIds: jobs.map((job) => job.id) })
    )
  }
  async remove(id: string): Promise<void> {
    this.records.delete(id)
    await rm(this.directory(id), { recursive: true, force: true })
    await rm(join(`${this.path}.d`, `${id}.json`), { force: true })
  }
}
