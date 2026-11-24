import { z } from 'zod'
import {
  DurableJsonRecoveryBarrierError,
  readDurableJsonFile,
  writeDurableJsonFile,
  type DurableJsonFileDependencies
} from '@aipoch/durable-files'
import {
  MAX_SYNTHESIS_NOTE_BYTES,
  synthesisStoredExcerptSchema,
  synthesisStoredBlockSchema,
  synthesisMutationReceiptSchema,
  synthesisStoredNoteSchema,
  type SynthesisStoredNote,
  type SynthesisMutationReceipt
} from '../../shared/literature-synthesis'
import { withDataRootWrite } from '../storage/migration-state'

const MAX_BYTES = 16 * 1024 * 1024
const envelopeSchema = z
  .object({ version: z.literal(1), notes: z.array(synthesisStoredNoteSchema).max(200) })
  .extend({ deletedMutations: z.array(synthesisMutationReceiptSchema).max(200).default([]) })
  .strict()
// Version 1 originally persisted derived source status. Accept it only when reading old files.
const readEnvelopeSchema = envelopeSchema.extend({
  notes: z
    .array(
      synthesisStoredNoteSchema.extend({
        blocks: z
          .array(
            z.union([
              synthesisStoredBlockSchema,
              synthesisStoredExcerptSchema
                .extend({ sourceStatus: z.enum(['current', 'changed', 'unavailable']) })
                .transform(({ type, id, snapshot }) => ({ type, id, snapshot }))
            ])
          )
          .max(200)
      })
    )
    .max(200)
})
const operations = new Map<string, Promise<unknown>>()

/** One bounded, atomic application-owned file. Read afresh inside the queue so revisions survive restart. */
export class LiteratureSynthesisStore {
  constructor(
    private readonly path: () => string,
    private readonly files: Partial<DurableJsonFileDependencies> = {}
  ) {}

  run<T>(
    operation: (
      notes: SynthesisStoredNote[],
      deletedMutations: SynthesisMutationReceipt[]
    ) => {
      result: T
      notes?: SynthesisStoredNote[]
      deletedMutations?: SynthesisMutationReceipt[]
    }
  ): Promise<T> {
    return withDataRootWrite(async () => {
      const path = this.path()
      const previous = operations.get(path) ?? Promise.resolve()
      const task = previous
        .catch(() => undefined)
        .then(async () => {
          const read = await readDurableJsonFile(
            path,
            (text) => {
              const value = JSON.parse(text)
              if (value.version !== 1)
                throw new DurableJsonRecoveryBarrierError('Unsupported synthesis storage version.')
              const envelope = readEnvelopeSchema.parse(value)
              for (const note of envelope.notes)
                if (Buffer.byteLength(JSON.stringify(note)) > MAX_SYNTHESIS_NOTE_BYTES)
                  throw new DurableJsonRecoveryBarrierError('Synthesis note size limit exceeded.')
              return envelope
            },
            this.files,
            { maxBytes: MAX_BYTES }
          )
          const notes = read.status === 'found' ? read.value.notes : []
          const deletedMutations = read.status === 'found' ? read.value.deletedMutations : []
          const next = operation(notes, deletedMutations)
          if (next.notes || next.deletedMutations) {
            const nextNotes = next.notes ?? notes
            for (const note of nextNotes)
              if (Buffer.byteLength(JSON.stringify(note)) > MAX_SYNTHESIS_NOTE_BYTES)
                throw new Error('Synthesis note size limit exceeded. Remove some excerpts or text.')
            const contents = JSON.stringify(
              envelopeSchema.parse({
                version: 1,
                notes: nextNotes,
                deletedMutations: next.deletedMutations ?? deletedMutations
              })
            )
            if (Buffer.byteLength(contents) > MAX_BYTES)
              throw new Error('Synthesis note storage limit exceeded.')
            await writeDurableJsonFile(path, contents, this.files)
          }
          return next.result
        })
      operations.set(path, task)
      void task
        .finally(() => {
          if (operations.get(path) === task) operations.delete(path)
        })
        .catch(() => undefined)
      return task
    })
  }
}
