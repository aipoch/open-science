import { z } from 'zod'

const rngWord = z.number().int().min(0).max(4294967295)
export const pythonRandomStateSchema = z.union([
  z
    .object({
      state: z.literal('available'),
      standard: z
        .object({
          words: z
            .array(rngWord)
            .length(625)
            .refine((words) => words[624]! <= 624),
          gaussian: z.number().finite().nullable()
        })
        .strict(),
      numpy: z
        .object({
          words: z.array(rngWord).length(624),
          position: z.number().int().min(0).max(624),
          hasGaussian: z.number().int().min(0).max(1),
          gaussian: z.number().finite()
        })
        .strict()
        .optional()
    })
    .strict(),
  z
    .object({
      state: z.literal('unavailable'),
      reason: z.enum(['modified-rng', 'invalid-state', 'capture-failed'])
    })
    .strict()
])

const rKinds = [
  'Wichmann-Hill',
  'Marsaglia-Multicarry',
  'Super-Duper',
  'Mersenne-Twister',
  'Knuth-TAOCP',
  'user-supplied',
  'Knuth-TAOCP-2002',
  "L'Ecuyer-CMRG"
] as const
const rNormals = [
  'Buggy Kinderman-Ramage',
  'Ahrens-Dieter',
  'Box-Muller',
  'user-supplied',
  'Inversion',
  'Kinderman-Ramage'
] as const
const rSamples = ['Rounding', 'Rejection'] as const
export const rRandomStateSchema = z.union([
  z
    .object({
      state: z.literal('available'),
      kinds: z.tuple([z.enum(rKinds), z.enum(rNormals), z.enum(rSamples)]),
      // R stores unsigned RNG words as signed integers, including the NA bit pattern.
      seed: z.array(z.number().int().min(-2147483647).max(2147483647).nullable()).min(3).max(626)
    })
    .strict()
    .refine(({ kinds, seed }) => {
      const kind = rKinds.indexOf(kinds[0])
      const normal = rNormals.indexOf(kinds[1])
      const sample = rSamples.indexOf(kinds[2])
      return (
        kind !== 5 &&
        normal !== 2 &&
        normal !== 3 &&
        seed.length === [4, 3, 3, 626, 102, 0, 102, 7][kind] &&
        seed[0] === kind + 100 * normal + 10000 * sample
      )
    }, 'Unsupported or inconsistent R random state'),
  z
    .object({
      state: z.literal('unavailable'),
      reason: z.enum(['unsupported-rng', 'invalid-seed', 'seed-unavailable'])
    })
    .strict()
])

// Deliberately excludes arbitrary environment variables, paths and credentials.
const observation = z
  .object({
    locale: z.string().max(1024),
    timezone: z.string().max(256),
    threadLimits: z
      .object({
        OMP_NUM_THREADS: z.string().max(32).optional(),
        OPENBLAS_NUM_THREADS: z.string().max(32).optional(),
        MKL_NUM_THREADS: z.string().max(32).optional(),
        VECLIB_MAXIMUM_THREADS: z.string().max(32).optional(),
        NUMEXPR_NUM_THREADS: z.string().max(32).optional()
      })
      .strict(),
    randomLibraries: z.array(z.string().max(128)).max(16),
    rRandomState: rRandomStateSchema.optional(),
    pythonRandomState: pythonRandomStateSchema.optional()
  })
  .strict()
export const notebookExecutionContextSchema = z
  .object({
    schemaVersion: z.literal(1),
    before: observation,
    after: observation,
    // Ordered attached-package names and syntactic call bindings only. No user
    // values, namespace contents, library paths or serialized R objects.
    rPackages: z
      .object({
        before: z.array(z.string().max(128)).max(128),
        after: z.array(z.string().max(128)).max(128),
        reads: z
          .array(z.object({ name: z.string().max(256), package: z.string().max(128) }).strict())
          .max(256),
        complete: z.boolean()
      })
      .strict()
      .optional()
  })
  .strict()
export type NotebookExecutionContext = z.infer<typeof notebookExecutionContextSchema>
