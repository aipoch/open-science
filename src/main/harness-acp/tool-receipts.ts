import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

export const HARNESS_RECEIPTS = 'open-science/tool-receipts'
export const HARNESS_INVOCATION = 'open-science/invocation'
export const HARNESS_RECEIPT_METHOD = '_open-science/tool-receipt'
export const receiptQuerySchema = z
  .object({
    invocationId: z.string().min(1).max(512),
    name: z.string().min(1).max(64),
    arguments: z.record(z.string(), z.unknown())
  })
  .strict()
export const receiptResponseSchema = z
  .object({
    status: z.enum(['unknown', 'completed']),
    result: CallToolResultSchema.optional()
  })
  .strict()
export type ReceiptQuery = z.infer<typeof receiptQuerySchema>
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)])
        )
      : value
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Host-owned evidence only. A started receipt is never permission to repeat a side effect. */
export class HarnessToolReceipts {
  constructor(private readonly directory: string) {}

  private async assertActive(scope: string): Promise<void> {
    try {
      await stat(join(this.directory, hash(scope), 'deleted'))
    } catch (error) {
      if (missing(error)) return
      throw error
    }
    throw new Error('Tool receipt scope was permanently deleted')
  }

  async deleteScope(scope: string): Promise<void> {
    const directory = join(this.directory, hash(scope))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await this.publish(directory, 'deleted', true)
    for (const name of await readdir(directory)) {
      if (name !== 'deleted') await rm(join(directory, name), { recursive: true, force: true })
    }
  }

  private location(scope: string, query: ReceiptQuery): { directory: string; fingerprint: string } {
    receiptQuerySchema.parse(query)
    return {
      directory: join(this.directory, hash(scope), hash(query.invocationId)),
      fingerprint: hash(JSON.stringify([query.name, canonical(query.arguments)]))
    }
  }

  private async publish(directory: string, name: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value)
    if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
      throw new Error('Tool receipt exceeds storage budget')
    const temporary = join(directory, `${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(serialized)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, join(directory, name))
      if (process.platform !== 'win32') {
        const dir = await open(directory, 'r')
        try {
          await dir.sync()
        } finally {
          await dir.close()
        }
      }
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async begin(scope: string, query: ReceiptQuery): Promise<void> {
    const { directory, fingerprint } = this.location(scope, query)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await this.assertActive(scope)
    // Exclusive claim survives process death; neither duplicate calls nor incomplete writes replay.
    const claim = await open(join(directory, 'claim'), 'wx', 0o600)
    await claim.close()
    await this.publish(directory, 'started.json', { fingerprint })
  }

  async complete(scope: string, query: ReceiptQuery, result: unknown): Promise<void> {
    await this.assertActive(scope)
    const { directory, fingerprint } = this.location(scope, query)
    const started = JSON.parse(await readFile(join(directory, 'started.json'), 'utf8'))
    if (started.fingerprint !== fingerprint) throw new Error('Tool receipt identity mismatch')
    await this.publish(directory, 'result.json', {
      fingerprint,
      result: CallToolResultSchema.parse(result)
    })
  }

  async read(scope: string, query: ReceiptQuery): Promise<z.infer<typeof receiptResponseSchema>> {
    await this.assertActive(scope)
    const { directory, fingerprint } = this.location(scope, query)
    const path = join(directory, 'result.json')
    try {
      if ((await stat(path)).size > 32 * 1024 * 1024)
        throw new Error('Tool receipt exceeds storage budget')
      const saved = JSON.parse(await readFile(path, 'utf8'))
      if (saved.fingerprint !== fingerprint) throw new Error('Tool receipt identity mismatch')
      return { status: 'completed', result: CallToolResultSchema.parse(saved.result) }
    } catch (error) {
      if (missing(error)) return { status: 'unknown' }
      throw error
    }
  }
}
