import { join } from 'node:path'
import { z } from 'zod'
import { sha256 } from './provenance-canonical'
import { parseNotebookEnvironmentLock } from '../notebook/environment-lock'
import { readDurableJsonFile } from '../storage/durable-json-file'

const identity = z.string().min(1).max(200)
export const reproducibilitySourceSchema = z
  .object({
    sourceScope: z
      .object({
        projectId: identity,
        appSessionId: identity,
        artifactId: identity,
        versionId: identity
      })
      .strict(),
    entityIds: z
      .record(z.string().min(1).max(512), z.string().min(1).max(512))
      .refine((value) => Object.keys(value).length <= 10000),
    lockChecksums: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000),
    omittedOutputChecksums: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000)
  })
  .strict()

export type ReproducibilitySource = z.infer<typeof reproducibilitySourceSchema>

export const REPRODUCIBILITY_SOURCE_FILE = 'reproducibility-source.json'
export const readReproducibilitySource = async (
  versionDirectory: string
): Promise<ReproducibilitySource | undefined> => {
  const record = await readDurableJsonFile(
    join(versionDirectory, REPRODUCIBILITY_SOURCE_FILE),
    (contents) => reproducibilitySourceSchema.parse(JSON.parse(contents)),
    undefined,
    { maxBytes: 1024 * 1024 }
  )
  return record.status === 'found' ? record.value : undefined
}

// Imported lock evidence stays with its Version; it never becomes an installed runtime lock.
export const readReproducibilityEnvironmentLock = async (
  directory: string,
  checksum: string
): Promise<string | undefined> => {
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid environment lock checksum.')
  const record = await readDurableJsonFile(
    join(directory, `${checksum}.json`),
    (contents) => {
      if (sha256(contents) !== checksum) throw new Error('Environment lock checksum mismatch.')
      parseNotebookEnvironmentLock(contents)
      return contents
    },
    undefined,
    { maxBytes: 4 * 1024 * 1024 }
  )
  return record.status === 'found' ? record.value : undefined
}
